/**
 * runAnalysis.ts — orquestador del análisis de zona para la PWA.
 *
 * Es el MISMO pipeline que `analyzeZone` de la app nativa (app/(tabs)/index.tsx ~998-1325),
 * portado sin estado de UI y llamando a las mismas funciones del núcleo: analyzeZoneLocal,
 * fetch*Grid (SatelliteEngine), fuseAnalysisPoints, enrichPointsWithDeepData y
 * computeZoneProspectivity. Si el pipeline nativo cambia, cambiarlo aquí también.
 *
 * DIFERENCIAS DELIBERADAS con la nativa (v1):
 *  - SIN ranking por IA: el ranking nativo (analyzeSpectralCandidatesBatch) usa un prompt que
 *    vive en ClaudeServices.ts y no puede ir al bundle web. El score es el espectral base.
 *    Queda marcado en analysis_meta.ranking_ia = false.
 *  - Sin waypoints (la PWA no tiene muestras de campo): analyzeZoneLocal recibe [].
 *  - Sin caché local ni cola offline: si no hay respuesta del servidor, se dice tal cual.
 */
import {
  fetchMiningSpectralGrid, fetchMiningAsterGrid, fetchAsterCoverage, fetchStructuralGrid,
  fetchEmitGrid, fetchThermalGrid, computeAdaptiveCellSize,
  type MiningSpectralResult, type AsterSpectralResult, type StructuralResult,
  type EmitSpectralResult, type ThermalResult,
} from '../app/core/SatelliteEngine';
import { analyzeZoneLocal, enrichPointsWithDeepData } from '../app/core/GeologicalEngine';
import { fuseAnalysisPoints, computeZoneProspectivity } from '../app/core/ConsensusFusion';
import { isThermalMaterial } from '../app/core/materialsCatalog';
import { getAreaLevel, areaBlockMessage } from '../app/core/areaLimits';
import { newAnalisisId, setCurrentAnalisis, logAnalisisZona } from '../app/core/costTelemetry';
import { type RockSource } from '../app/core/lithologyService';
import { getDrySeasonDates, polygonAreaHa, type Coordinate } from './geo';
import { getGeeFailure, resetGeeFailure } from './geeAuth';
import { displayScore } from '../app/core/displayScore';

export type AnalysisInput = {
  coords: Coordinate[];
  mineral: string;
  terrain: string;
  depth: string;
  rockType: string;
  rockSource: RockSource;
  /** Lo que propuso la carta geológica (telemetría: mide su tasa de acierto). */
  rockProposed: string | null;
  deepAnalysis: boolean;
};

export type AnalysisMeta = {
  origen: 'pwa';
  /** false: la PWA v1 no re-ordena con IA (ver cabecera). */
  ranking_ia: false;
  fecha: string;
  area_ha: number;
  cell_size_m: number;
  analisis_profundo: boolean;
  /** Qué fuentes respondieron de verdad (no las que se intentaron). */
  fuentes: { s2: boolean; aster: boolean; emit: boolean; s1: boolean; thermal: boolean };
  s2: { cloud_cover: number; images_used: number; coverage_pct: number; source_label: string };
  notas: string[];
};

export type AnalysisOutput = {
  finalPoints: any[];
  zp: any;
  areaHa: number;
  satdataSource: string;
  acquisitionDate: string;
  meta: AnalysisMeta;
};

export type AnalysisErrorCode = 'AREA_BLOCK' | 'NO_DATA' | 'NO_POINTS' | 'GEE_UNAUTHORIZED' | 'GEE_RATE_LIMIT' | 'GEE_UNAVAILABLE' | 'CANCELLED';
export class AnalysisError extends Error {
  constructor(public code: AnalysisErrorCode, message: string) { super(message); this.name = 'AnalysisError'; }
}

export async function runAnalysis(
  input: AnalysisInput,
  onStep: (label: string) => void,
  isCancelled: () => boolean,
): Promise<AnalysisOutput> {
  const { coords, mineral, terrain, depth, rockType, rockSource, deepAnalysis } = input;
  const check = () => { if (isCancelled()) throw new AnalysisError('CANCELLED', 'Análisis cancelado.'); };

  // Tope duro de superficie (areaLimits.ts): mismo cálculo y mismos umbrales que la app.
  const areaHa = polygonAreaHa(coords);
  if (getAreaLevel(areaHa) === 'block') throw new AnalysisError('AREA_BLOCK', areaBlockMessage(areaHa));

  const cellSizeM = computeAdaptiveCellSize(areaHa);
  const notas: string[] = [];
  resetGeeFailure();

  // ── Sentinel-2 ────────────────────────────────────────────────────────────
  onStep('Consultando Sentinel-2…');
  let satData: MiningSpectralResult;
  try {
    const centLat = coords.reduce((s, c) => s + c.latitude, 0) / coords.length;
    const centLng = coords.reduce((s, c) => s + c.longitude, 0) / coords.length;
    satData = await fetchMiningSpectralGrid(coords, { cell_size_m: cellSizeM, ...getDrySeasonDates(centLat, centLng) });
  } catch {
    satData = {
      cells: [], cellIndex: new Map(), acquisition_date: '', cloud_cover: 0, images_used: 0, cell_size_m: 500,
      coverage_pct: 0, data_source: 'NO_DATA_OFFLINE', source_label: 'Sin datos',
    };
  }
  check();

  if (satData.data_source === 'NO_DATA_OFFLINE') {
    // SatelliteEngine convierte TODO fallo en "sin datos"; el envoltorio de fetch sabe si fue
    // el servidor quien rechazó (cuota, sesión o verificación) para no culpar al internet del usuario.
    const fail = getGeeFailure();
    if (fail?.status === 429) throw new AnalysisError('GEE_RATE_LIMIT', 'El servidor de satélites recibió demasiadas peticiones. Espera un minuto e intenta de nuevo.');
    if (fail?.status === 401) throw new AnalysisError('GEE_UNAUTHORIZED', 'Tu sesión no es válida o expiró. Cierra sesión, vuelve a entrar e intenta de nuevo.');
    if (fail?.status === 503) throw new AnalysisError('GEE_UNAVAILABLE', 'No se pudo verificar tu sesión en el servidor de satélites en este momento. Intenta de nuevo en un minuto.');
    throw new AnalysisError('NO_DATA', 'No se obtuvieron datos satelitales reales para esta zona. Revisa tu conexión e intenta de nuevo. No se muestran datos simulados.');
  }

  const analisisId = newAnalisisId();
  setCurrentAnalisis(analisisId);
  const data = analyzeZoneLocal(coords, mineral, terrain, depth, rockType, [], satData);
  if (!data.success || !data.top_points || data.top_points.length === 0) {
    throw new AnalysisError('NO_POINTS', data.error === 'NO_DATA_OFFLINE'
      ? 'No se obtuvieron datos satelitales para esta zona.'
      : 'No se encontraron puntos en la zona. Prueba con un polígono más grande.');
  }

  let finalPoints: any[] = data.top_points;
  let asterResult: AsterSpectralResult | null = null;
  let emitResult: EmitSpectralResult | null = null;
  let structuralResult: StructuralResult | null = null;
  let thermalResult: ThermalResult | null = null;

  // ── ASTER + EMIT + estructural (opcional) y fusión de consenso ──────────────
  if (deepAnalysis) {
    try {
      onStep('Consultando ASTER…');
      const cLat = coords.reduce((s, c) => s + c.latitude, 0) / coords.length;
      const cLng = coords.reduce((s, c) => s + c.longitude, 0) / coords.length;
      const coverage = await fetchAsterCoverage(cLat, cLng);
      if (coverage.coverage_ok) {
        const aster = await fetchMiningAsterGrid(coords, { cell_size_m: cellSizeM });
        if (aster.has_coverage && aster.data_source !== 'NO_DATA_OFFLINE') asterResult = aster;
        else notas.push('ASTER: sin datos utilizables en esta zona.');
      } else {
        notas.push('ASTER: sin cobertura en esta zona; análisis con Sentinel-2 y las demás fuentes.');
      }
    } catch { notas.push('ASTER: no respondió.'); }
    check();

    try {
      onStep('Consultando EMIT hiperespectral…');
      const emit = await fetchEmitGrid(coords.map(c => ({ lat: c.latitude, lng: c.longitude })), { cell_size_m: cellSizeM });
      if (emit.data_source !== 'NO_DATA_OFFLINE') emitResult = emit;
      else notas.push('EMIT: sin datos para esta zona.');
    } catch { notas.push('EMIT: no respondió.'); }
    check();

    try {
      onStep('Consultando Sentinel-1 + DEM…');
      const structural = await fetchStructuralGrid(coords.map(c => ({ lat: c.latitude, lng: c.longitude })), { cell_size_m: cellSizeM });
      if (structural.data_source !== 'NO_DATA_OFFLINE') structuralResult = structural;
      else notas.push('Sentinel-1/DEM: sin datos para esta zona.');
    } catch { notas.push('Sentinel-1/DEM: no respondió.'); }
    check();

    if (asterResult || emitResult || structuralResult) {
      finalPoints = fuseAnalysisPoints(finalPoints, satData, asterResult, emitResult, structuralResult, mineral) as any[];
    }

    // Etapa B: enriquecer índices con dato REAL de ASTER/EMIT (sin cobertura → sin cambios).
    const deepWeights = data.weights_used;
    if (deepWeights && (((asterResult?.cells?.length ?? 0) > 0) || ((emitResult?.cells?.length ?? 0) > 0))) {
      enrichPointsWithDeepData(finalPoints as any, asterResult?.cells, emitResult?.cells, deepWeights);
      if (data.all_points) enrichPointsWithDeepData(data.all_points as any, asterResult?.cells, emitResult?.cells, deepWeights);
      if (data.top_points) enrichPointsWithDeepData(data.top_points as any, asterResult?.cells, emitResult?.cells, deepWeights);
      // Sin ranking por IA (la PWA no lo hace) → se re-ordena por base_score enriquecido, como la nativa.
      finalPoints.sort((a: any, b: any) => displayScore(b) - displayScore(a));
      finalPoints.forEach((p: any, idx: number) => { p.rank = idx + 1; });
    }
  }

  // ── Índice de sílice térmico: por familia, FUERA del análisis profundo (como la nativa) ──
  if (isThermalMaterial(mineral)) {
    try {
      onStep('Consultando índice de sílice térmico…');
      const thermal = await fetchThermalGrid(coords.map(c => ({ lat: c.latitude, lng: c.longitude })), { cell_size_m: cellSizeM });
      if (thermal.data_source !== 'NO_DATA_OFFLINE') thermalResult = thermal;
      else notas.push('Térmico: sin datos para esta zona.');
    } catch { notas.push('Térmico: no respondió.'); }
    check();
  }

  onStep('Calculando favorabilidad…');
  const zp = computeZoneProspectivity(finalPoints, satData, {
    metal: mineral,
    thermal: thermalResult ? { quality_ok: thermalResult.quality_ok, rock_pct: thermalResult.rock_pct } : null,
  });

  // Telemetría de costos (mejor esfuerzo; nunca bloquea).
  logAnalisisZona({
    analisisId, hectareas: data.area_ha, material: mineral,
    fuentes: { s2: true, aster: !!asterResult, emit: !!emitResult, s1: !!structuralResult, dem: !!structuralResult, thermal: !!thermalResult },
    roca: { propuesta: input.rockProposed, final: rockType, origen: rockSource },
  });

  return {
    finalPoints, zp, areaHa,
    satdataSource: satData.data_source,
    acquisitionDate: satData.acquisition_date,
    meta: {
      origen: 'pwa', ranking_ia: false, fecha: new Date().toISOString(),
      area_ha: Math.round(areaHa * 100) / 100, cell_size_m: cellSizeM, analisis_profundo: deepAnalysis,
      fuentes: { s2: true, aster: !!asterResult, emit: !!emitResult, s1: !!structuralResult, thermal: !!thermalResult },
      s2: { cloud_cover: satData.cloud_cover, images_used: satData.images_used, coverage_pct: satData.coverage_pct, source_label: satData.source_label },
      notas,
    },
  };
}

import { MiningSpectralResult, AsterSpectralResult, AsterSpectralCell, StructuralResult, StructuralCell, EmitSpectralResult, EmitSpectralCell, findNearestCell } from './SatelliteEngine';
import { cellAnomalyScore } from './spectralHelpers';
import { METAL_WEIGHTS, SYNTHETIC_INDEX_KEYS, SYNTHETIC_REQUIRES_DEEP_THRESHOLD } from './GeologicalEngine';
import { evidenceCeiling } from './materialsCatalog';
import { prospectivityFromSignal } from './theme';

export type ConsensusLevel = 'PRIORITY_TARGET' | 'TRIPLE_SPECTRAL' | 'CONFIRMED' | 'SINGLE' | 'VEGETATION' | 'NO_DATA';

export interface ConsensusPoint {
  lat: number;
  lng: number;
  rank: number;
  base_score: number;
  score: number;
  s2Score: number;
  asterScore: number | null;
  emitScore: number | null;
  structuralScore: number | null;
  near_lineament: boolean;
  evidence: string;
  consensus: ConsensusLevel;
  supportedBy: ('S2' | 'ASTER' | 'EMIT')[];
  // pass-through fields from AnalysisPoint
  id: string;
  indices?: any;
  indices_analizados?: any[];
  analisis_integral?: string;
  geologia_interpretada?: string;
  recomendacion?: string;
}

function clamp01(v: number): number { return Math.max(0, Math.min(1, v)); }

function emitAnomalyScore(cell: EmitSpectralCell, metal: string): number {
  const fe   = clamp01((cell.ferric_emit   - 1.0) / 2.0);
  const al   = clamp01( cell.al_clay_emit  / 0.3);
  const mg   = clamp01( cell.mg_clay_emit  / 0.3);
  const carb = clamp01((cell.carbonate_emit - 1.0) / 1.5);

  const weights: Record<string, [number, number, number, number]> = {
    oro:    [0.35, 0.20, 0.15, 0.30],
    plata:  [0.25, 0.35, 0.15, 0.25],
    cobre:  [0.40, 0.15, 0.20, 0.25],
    tierras_raras:  [0.10, 0.20, 0.50, 0.20],
    hierro: [0.60, 0.10, 0.10, 0.20],
  };
  const w = weights[metal] ?? [0.25, 0.25, 0.25, 0.25];
  return Math.round((fe * w[0] + al * w[1] + mg * w[2] + carb * w[3]) * 100);
}

function asterAnomalyScore(cell: AsterSpectralCell, metal: string): number {
  const fe   = cell.iron_oxide_aster ?? 1.0;
  const al   = cell.alunite_bd       ?? 0.0;
  const mg   = cell.chlorite_bd      ?? 0.0;
  const ferr = cell.ferroso_aster    ?? 1.0;

  const feNorm   = clamp01((fe   - 1.0) / 2.0);
  const alNorm   = clamp01( al   / 0.3);
  const mgNorm   = clamp01( mg   / 0.3);
  const ferrNorm = clamp01((ferr - 1.0) / 1.5);

  const weights: Record<string, [number, number, number, number]> = {
    oro:    [0.30, 0.20, 0.15, 0.35],
    plata:  [0.20, 0.35, 0.20, 0.25],
    cobre:  [0.35, 0.15, 0.20, 0.30],
    tierras_raras:  [0.10, 0.25, 0.45, 0.20],
    hierro: [0.55, 0.10, 0.10, 0.25],
  };

  const w = weights[metal] ?? [0.25, 0.25, 0.25, 0.25];
  return Math.round((feNorm * w[0] + alNorm * w[1] + mgNorm * w[2] + ferrNorm * w[3]) * 100);
}

export function fuseAnalysisPoints(
  points: Array<{ lat: number; lng: number; rank: number; base_score: number; score?: number; [key: string]: any }>,
  s2Data: MiningSpectralResult,
  asterData: AsterSpectralResult | null,
  emitData: EmitSpectralResult | null,
  structuralData: StructuralResult | null,
  metal: string
): ConsensusPoint[] {
  const order: Record<ConsensusLevel, number> = {
    PRIORITY_TARGET: 0, TRIPLE_SPECTRAL: 1, CONFIRMED: 2, SINGLE: 3, VEGETATION: 4, NO_DATA: 5,
  };

  const fused: ConsensusPoint[] = points.map(p => {
    const s2Cell         = s2Data.cells.length         ? findNearestCell(p.lat, p.lng, s2Data.cells)         : null;
    const asterCell      = asterData?.cells.length      ? findNearestCell(p.lat, p.lng, asterData.cells)      : null;
    const emitCell       = emitData?.cells.length       ? findNearestCell(p.lat, p.lng, emitData.cells)       : null;
    const structuralCell = structuralData?.cells.length ? findNearestCell(p.lat, p.lng, structuralData.cells) : null;

    const s2Score        = s2Cell         ? cellAnomalyScore(s2Cell, metal) : 0;
    const asterScore     = asterCell      ? asterAnomalyScore(asterCell, metal) : null;
    const emitScore      = emitCell       ? emitAnomalyScore(emitCell, metal)   : null;
    const structuralScore = structuralCell
      ? Math.round(structuralCell.lineament_density * 100)
      : null;
    const nearLineament  = structuralCell?.near_lineament ?? false;
    const masked         = s2Cell?.masked_by_vegetation ?? false;

    // Build evidence string
    const evidenceParts: string[] = [];
    if (s2Score >= 35)                                 evidenceParts.push('S2 \u2713');
    if (asterScore !== null && asterScore >= 35)       evidenceParts.push('ASTER \u2713');
    if (emitScore !== null && emitScore >= 65)         evidenceParts.push('EMIT \u2713');
    if (nearLineament)                                 evidenceParts.push('Estructura \u2713');
    const evidence = evidenceParts.join(' \u00B7 ') || 'sin anomal\u00EDa';

    let consensus:   ConsensusLevel;
    let supportedBy: ('S2' | 'ASTER' | 'EMIT')[];

    const tripleSpectral = s2Score >= 65 && asterScore !== null && asterScore >= 65 && emitScore !== null && emitScore >= 65;
    const dualSpectral   = s2Score >= 65 && asterScore !== null && asterScore >= 65;

    if (masked) {
      consensus   = 'VEGETATION';
      supportedBy = [];
    } else if ((tripleSpectral || dualSpectral) && nearLineament) {
      // Highest tier: multi-spectral confirmation + structural control
      consensus   = 'PRIORITY_TARGET';
      supportedBy = tripleSpectral ? ['S2', 'ASTER', 'EMIT'] : ['S2', 'ASTER'];
    } else if (tripleSpectral) {
      consensus   = 'TRIPLE_SPECTRAL';
      supportedBy = ['S2', 'ASTER', 'EMIT'];
    } else if (dualSpectral) {
      consensus   = 'CONFIRMED';
      supportedBy = ['S2', 'ASTER'];
    } else if (s2Score >= 35 || (asterScore !== null && asterScore >= 35) || (emitScore !== null && emitScore >= 35)) {
      consensus   = 'SINGLE';
      supportedBy = s2Score >= 35 ? ['S2'] : (asterScore !== null && asterScore >= 35 ? ['ASTER'] : ['EMIT']);
    } else {
      consensus   = 'NO_DATA';
      supportedBy = [];
    }

    const topSpectral = Math.max(s2Score, asterScore ?? 0, emitScore ?? 0);
    let boostedScore: number;
    if (consensus === 'PRIORITY_TARGET') {
      boostedScore = Math.min(100, Math.round(topSpectral * 1.25));
    } else if (consensus === 'TRIPLE_SPECTRAL') {
      boostedScore = Math.min(100, Math.round(topSpectral * 1.20));
    } else if (consensus === 'CONFIRMED') {
      boostedScore = Math.min(100, Math.round(topSpectral * 1.15));
    } else {
      boostedScore = p.score ?? p.base_score;
    }

    return {
      ...p,
      score: boostedScore,
      s2Score, asterScore, emitScore,
      structuralScore, near_lineament: nearLineament,
      evidence,
      consensus, supportedBy,
    } as ConsensusPoint;
  });

  fused.sort((a, b) => order[a.consensus] - order[b.consensus] || b.score - a.score);
  fused.forEach((p, i) => { p.rank = i + 1; });

  return fused;
}

// ═════════════════════════════════════════════════════════════════════════════
// ÍNDICE DE FAVORABILIDAD EXPLORATORIA (Zone Prospectivity)
// ─────────────────────────────────────────────────────────────────────────────
// Diseño "council": separa SEÑAL (qué tan fuerte/extensa es la firma de
// alteración) de CONFIANZA (qué tan fiable es esa lectura). NUNCA se combinan en
// un solo porcentaje, NUNCA se usa la palabra "probabilidad".
//   • SEÑAL  → usa base_score CRUDO (sin boost de consenso, para no contar el
//              consenso dos veces; el boost 1.15/1.20/1.25 ya vive en boostedScore).
//   • CONFIANZA → única sede del consenso multi-sensor + cobertura + vegetación +
//              proxies sintéticos + nubes + antigüedad de la imagen.
// ═════════════════════════════════════════════════════════════════════════════

export interface ZoneProspectivity {
  // Salidas separadas (NUNCA un solo % combinado)
  signal: number;            // 0-100 SEÑAL espectral (sin boost de consenso)
  /** 0-100 CONFIANZA ya CAPADA por el techo de evidencia del material. */
  confidence: number;
  confidence_label: 'ALTA' | 'MEDIA' | 'BAJA';
  /**
   * 0-100 calidad de la ADQUISICIÓN (cobertura, sensores, consenso, limpieza, nubes)
   * antes de aplicar el techo. NO es confianza y no debe rotularse como tal: mide si
   * la imagen fue buena, no si el material se puede ver con ella. Se conserva porque
   * explica el "por qué" — cuando confidence < acquisition_quality, el problema es el
   * material, no la toma.
   */
  acquisition_quality: number;
  /** Material para el que se calculó. Necesario para re-aplicar el techo al mostrar. */
  metal?: string;
  /** Nivel del techo aplicado ('alta' | 'media' | 'contexto') y su motivo. */
  ceiling_level?: 'alta' | 'media' | 'contexto';
  ceiling_note?: string;
  /**
   * Gate térmico con el que se calculó. Se PERSISTE junto al resto del objeto para
   * que al reabrir un análisis no haya que recalcularlo (y para no perder una subida
   * legítima). Ausente = análisis viejo o sin térmico → se trata como "sin evidencia".
   */
  thermal_gate?: { quality_ok: boolean; rock_pct?: number } | null;
  band: 'FUERTE' | 'MODERADA' | 'DEBIL';
  band_label: string;        // p.ej. "FAVORABILIDAD FUERTE"
  band_color: string;        // color invertido (alto = verde)
  relative_percentile?: number; // rango ordinal vs zonas previas (solo si ≥3)
  // Trazabilidad / "por qué"
  n_points: number;
  top_score: number;
  consensus_breakdown: Partial<Record<ConsensusLevel, number>>;
  n_sensors: number;
  vegetation_pct: number;        // % puntos enmascarados por vegetación (NDVI>0.55)
  simulated_pct: number;         // % puntos sin celda satelital (fuera de cobertura)
  synthetic_weight_pct: number;  // % del peso del metal que recae en proxies sintéticos
  coverage_pct: number;
  cloud_cover: number;
  data_source: string;
  cache_age_days?: number;
  reasons_plus: string[];
  reasons_minus: string[];
}

// ─── Constantes tuneables (heurísticas, SIN calibración de campo) ────────────
// Aprobadas por el dueño como ajustables/documentadas. No son tasas de éxito.
export const PROSPECTIVITY_SIGNAL_THRESHOLDS = { strong: 65, moderate: 35 } as const;
export const CONFIDENCE_LABEL_THRESHOLDS = { alta: 66, media: 40 } as const;

/**
 * Traducción del techo de evidencia (nivel del catálogo) a tope NUMÉRICO de confianza.
 *
 * Se capa el NÚMERO, no la etiqueta, y la etiqueta se deriva del número como siempre.
 * Así no pueden discrepar: capar solo la etiqueta dejaría una barra al 85% rotulada
 * BAJA, que es otra contradicción distinta.
 *
 * Los valores salen de CONFIDENCE_LABEL_THRESHOLDS (un punto por debajo del umbral
 * siguiente), de modo que mover un umbral mueve el tope solo.
 */
export const CEILING_MAX_CONFIDENCE: Record<'alta' | 'media' | 'contexto', number> = {
  alta:     100,
  media:    CONFIDENCE_LABEL_THRESHOLDS.alta  - 1,   // 65 → etiqueta MEDIA
  contexto: CONFIDENCE_LABEL_THRESHOLDS.media - 1,   // 39 → etiqueta BAJA
};

function labelFor(confidence: number): 'ALTA' | 'MEDIA' | 'BAJA' {
  return confidence >= CONFIDENCE_LABEL_THRESHOLDS.alta  ? 'ALTA'
       : confidence >= CONFIDENCE_LABEL_THRESHOLDS.media ? 'MEDIA'
       : 'BAJA';
}
export const CONFIDENCE_WEIGHTS = { coverage: 0.30, sensors: 0.25, consensus: 0.20, cleanliness: 0.15, clouds: 0.10 } as const;
export const SENSOR_CONFIDENCE_SCORE: Record<number, number> = { 0: 0, 1: 40, 2: 70, 3: 90, 4: 100 };
export const CACHED_STALE_DAYS = 90;
export const CACHED_STALE_PENALTY = 10;
export const SIGNAL_STRONG_REASON_MIN = 50;

export interface ZoneProspectivityOpts {
  metal?: string;
  /** Señales de zonas previas del usuario, para el rango relativo ordinal. */
  previousSignals?: number[];
  /**
   * Gate del índice de sílice térmico, cuando corrió para este material.
   *
   * SOLO afecta a la REDACCIÓN de las razones, nunca al cálculo: el térmico es
   * evidencia paralela que mueve la CONFIANZA, no el score. Sin esto, el desglose
   * decía "el cálculo de sílice usa proxies sintéticos (100%)" a secas incluso
   * cuando había una medición térmica real detrás — contradiciendo al badge que sí
   * la reconocía y subía a "Media".
   */
  thermal?: { quality_ok: boolean; rock_pct?: number } | null;
}

export function computeZoneProspectivity(
  points: Array<{
    lat: number; lng: number; rank?: number; base_score?: number;
    consensus?: ConsensusLevel; asterScore?: number | null; emitScore?: number | null;
    structuralScore?: number | null; near_lineament?: boolean; [k: string]: any;
  }>,
  satData: MiningSpectralResult,
  opts: ZoneProspectivityOpts = {}
): ZoneProspectivity {
  const clampPct = (v: number) => Math.max(0, Math.min(100, v));
  const metal = (opts.metal || 'oro').toLowerCase();

  // Fracción del peso del metal que recae en índices sintéticos (no medición real).
  //
  // EXCLUYE los índices que ASTER/EMIT ya enriqueció con dato real, igual que hace
  // computeAllMetalScores. Antes aquí se sumaban en crudo, así que para la MISMA zona
  // los dos módulos daban un % sintético distinto —p. ej. el carbonato del zinc medido
  // por EMIT contaba como sintético aquí y como real allá— y el techo se habría
  // aplicado con un número que no era el que ve el usuario en la tarjeta del metal.
  const enrichedKeys = new Set<string>();
  for (const p of points) for (const k of ((p as any).enriched_indices || [])) enrichedKeys.add(k);

  const w = METAL_WEIGHTS[metal] || {};
  let syntheticWeight = 0;
  for (const k of SYNTHETIC_INDEX_KEYS) {
    if (enrichedKeys.has(k)) continue;   // ya tiene dato real medido → no es sintético
    syntheticWeight += (w as any)[k] || 0;
  }
  const synthetic_weight_pct = Math.round(syntheticWeight * 100);
  const requires_deep = syntheticWeight > SYNTHETIC_REQUIRES_DEEP_THRESHOLD;

  const coverage_pct = clampPct(satData?.coverage_pct ?? 0);
  const cloud_cover  = clampPct(satData?.cloud_cover ?? 0);
  const data_source  = satData?.data_source ?? '';
  const cache_age_days = satData?.cache_age_days;

  const valid = points.filter(p => Number.isFinite(p.base_score));
  const n_points = valid.length;

  if (n_points === 0) {
    const b0 = prospectivityFromSignal(0);
    return {
      signal: 0, confidence: 0, confidence_label: 'BAJA', acquisition_quality: 0,
      metal, thermal_gate: opts.thermal ?? null,
      band: b0.band, band_label: b0.label, band_color: b0.color,
      n_points: 0, top_score: 0, consensus_breakdown: {}, n_sensors: 1,
      vegetation_pct: 0, simulated_pct: 0, synthetic_weight_pct,
      coverage_pct, cloud_cover, data_source, cache_age_days,
      reasons_plus: [], reasons_minus: ['Sin puntos analizables en la zona'],
    };
  }

  // ── SEÑAL: media ponderada por rango de base_score CRUDO (premia los picos) ──
  let num = 0, den = 0, top_score = 0;
  valid.forEach((p, i) => {
    const rank = (p.rank && p.rank > 0) ? p.rank : (i + 1);
    const sc = Math.max(0, Math.min(100, p.base_score as number));
    const wi = 1 / rank;
    num += sc * wi; den += wi;
    if (sc > top_score) top_score = sc;
  });
  const signal = clampPct(Math.round(den > 0 ? num / den : 0));

  // ── Vegetación / sin cobertura (ambos = punto totalmente simulado en el motor) ──
  const cells = satData?.cells ?? [];
  let masked = 0, noCell = 0;
  for (const p of valid) {
    const cell = cells.length ? findNearestCell(p.lat, p.lng, cells) : null;
    if (!cell) noCell++;
    else if (cell.masked_by_vegetation) masked++;
  }
  const vegetation_pct = Math.round((masked / n_points) * 100);
  const simulated_pct  = Math.round((noCell / n_points) * 100);

  // ── Consenso (solo informativo / alimenta CONFIANZA, no la SEÑAL) ──
  const consensus_breakdown: Partial<Record<ConsensusLevel, number>> = {};
  let strongConsensus = 0, hasConsensusField = false;
  for (const p of valid) {
    if (p.consensus) {
      hasConsensusField = true;
      consensus_breakdown[p.consensus] = (consensus_breakdown[p.consensus] || 0) + 1;
      if (p.consensus === 'CONFIRMED' || p.consensus === 'TRIPLE_SPECTRAL' || p.consensus === 'PRIORITY_TARGET') strongConsensus++;
    }
  }

  // ── Nº de sensores con señal REAL (S2 siempre; +ASTER +EMIT +Estructura) ──
  let n_sensors = 1;
  if (valid.some(p => p.asterScore != null)) n_sensors++;
  if (valid.some(p => p.emitScore != null)) n_sensors++;
  if (valid.some(p => p.near_lineament || p.structuralScore != null)) n_sensors++;

  // ── CONFIANZA (única sede del consenso) ──
  const coberturaScore = coverage_pct;
  const sensoresScore  = SENSOR_CONFIDENCE_SCORE[Math.min(4, n_sensors)] ?? 40;
  const consensoScore  = hasConsensusField ? clampPct(100 * (strongConsensus / n_points)) : 0;
  const limpiezaScore  = clampPct(100 - vegetation_pct - simulated_pct - synthetic_weight_pct);
  const nubesScore     = clampPct(100 - cloud_cover);
  let acquisition_quality = Math.round(
    CONFIDENCE_WEIGHTS.coverage    * coberturaScore +
    CONFIDENCE_WEIGHTS.sensors     * sensoresScore +
    CONFIDENCE_WEIGHTS.consensus   * consensoScore +
    CONFIDENCE_WEIGHTS.cleanliness * limpiezaScore +
    CONFIDENCE_WEIGHTS.clouds      * nubesScore
  );
  if (data_source === 'SENTINEL2_CACHED' && (cache_age_days ?? 0) > CACHED_STALE_DAYS) {
    acquisition_quality -= CACHED_STALE_PENALTY;
  }
  acquisition_quality = clampPct(acquisition_quality);

  // ── TECHO DE EVIDENCIA ──────────────────────────────────────────────────────
  // Hasta aquí solo se ha medido la calidad de la TOMA. Un promedio ponderado no
  // puede vetar: con cobertura, sensores, consenso y nubes perfectos se llega a 85
  // sobre un umbral de ALTA de 66, así que la sílice sin una sola medición real
  // salía "ALTA". El techo del material —la misma función que gobierna el badge de
  // la pantalla— es quien pone el min().
  const ceiling = evidenceCeiling(metal, {
    requiresDeep: requires_deep,
    syntheticWeightPct: synthetic_weight_pct,
    thermal: opts.thermal ?? null,
  });
  const confidence = Math.min(acquisition_quality, CEILING_MAX_CONFIDENCE[ceiling.level]);
  const confidence_label = labelFor(confidence);

  const bandInfo = prospectivityFromSignal(signal);

  // ── Rango relativo ordinal (solo si ≥3 zonas previas; nunca "promedio regional" inventado) ──
  let relative_percentile: number | undefined;
  const prev = (opts.previousSignals ?? []).filter(s => Number.isFinite(s));
  if (prev.length >= 3) {
    const below = prev.filter(s => s <= signal).length;
    relative_percentile = Math.round((below / prev.length) * 100);
  }

  // ── "Por qué" — solo desde datos reales ──
  const reasons_plus: string[] = [];
  const reasons_minus: string[] = [];
  if (signal >= SIGNAL_STRONG_REASON_MIN)               reasons_plus.push('Firma de óxido de hierro / arcillas clara');
  if (valid.some(p => p.near_lineament))                reasons_plus.push('Coincide con falla / lineamiento');
  if (n_sensors >= 2)                                   reasons_plus.push(`${n_sensors} satélites coinciden`);
  if (hasConsensusField && strongConsensus / n_points >= 0.3) reasons_plus.push('Anomalía extensa y consistente');

  if (vegetation_pct > 20)        reasons_minus.push(`Parte cubierta de vegetación (${vegetation_pct}%)`);
  if (simulated_pct > 0)          reasons_minus.push(`${simulated_pct}% sin dato satelital directo (estimado)`);
  // El proxy ÓPTICO de sílice sigue siendo sintético (eso no cambia, y el score
  // tampoco). Pero si el índice térmico midió de verdad sobre roca expuesta, decirlo
  // "a secas" era engañoso: había medición real detrás. Se matiza la redacción; el
  // número y el peso quedan intactos.
  const thermalMeasured = opts.thermal?.quality_ok === true;
  if (synthetic_weight_pct > 0) {
    reasons_minus.push(
      thermalMeasured
        ? `El proxy óptico de ${metal} es sintético (${synthetic_weight_pct}%); la confianza se respalda con medición térmica real sobre roca expuesta (${opts.thermal?.rock_pct ?? 0}%)`
        : `Parte del cálculo de ${metal} usa proxies sintéticos (${synthetic_weight_pct}%)`
    );
  }
  // Cuando el techo MUERDE, se dice por qué. Sin esta línea el usuario vería una
  // adquisición impecable etiquetada BAJA sin explicación, que es la queja legítima:
  // el problema no fue la imagen, fue que el material no se puede ver con ella.
  if (confidence < acquisition_quality) {
    reasons_minus.push(
      `Toma de buena calidad (${acquisition_quality}/100), pero la confianza queda limitada por la evidencia disponible para ${metal}` +
      (ceiling.note ? `: ${ceiling.note}` : '')
    );
  }
  if (n_sensors === 1)            reasons_minus.push('Una sola fuente satelital');
  if (cloud_cover > 20)           reasons_minus.push(`Nubosidad ${Math.round(cloud_cover)}%`);
  if (data_source === 'SENTINEL2_CACHED' && (cache_age_days ?? 0) > CACHED_STALE_DAYS) reasons_minus.push(`Imagen de hace ${cache_age_days} días`);
  reasons_minus.push('Sin verificación de campo aún');

  return {
    signal, confidence, confidence_label, acquisition_quality,
    metal, ceiling_level: ceiling.level, ceiling_note: ceiling.note,
    thermal_gate: opts.thermal ?? null,
    band: bandInfo.band, band_label: bandInfo.label, band_color: bandInfo.color,
    relative_percentile,
    n_points, top_score: Math.round(top_score),
    consensus_breakdown, n_sensors,
    vegetation_pct, simulated_pct, synthetic_weight_pct,
    coverage_pct, cloud_cover, data_source, cache_age_days,
    reasons_plus, reasons_minus,
  };
}

/**
 * Re-aplica el techo de evidencia a un ZoneProspectivity YA CALCULADO.
 *
 * Por qué hace falta si computeZoneProspectivity ya lo aplica: el objeto se PERSISTE
 * serializado (columna `prospectivity` en SQLite y en Supabase), y tanto la pantalla
 * como el PDF y el Excel leen el valor guardado tal cual. Los análisis hechos antes de
 * este cambio llevan grabado `confidence_label: 'ALTA'` sin techo; arreglar solo el
 * cálculo los dejaría mintiendo igual al reabrirlos, y el PDF se regenera desde ahí.
 *
 * Es IDEMPOTENTE: aplicarla a un objeto ya capado no lo cambia. Por eso puede ir en
 * todos los puntos de despliegue sin coordinar quién la llamó antes.
 *
 * Registros VIEJOS: no guardaban `thermal_gate`, así que aquí se trata como "sin
 * evidencia térmica". Consecuencia deliberada y aprobada: un análisis de sílice cuyo
 * térmico sí midió sobre roca en su día bajará de ALTA a BAJA, porque ese dato no se
 * conservó y no se puede reconstruir. Preferimos perder una subida legítima antes que
 * mantener una afirmación que ya no podemos respaldar. Los análisis nuevos sí
 * persisten el gate y conservan su nivel.
 */
export function applyEvidenceCeiling(
  zp: ZoneProspectivity | null | undefined,
  fallbackMetal?: string,
): ZoneProspectivity | null {
  if (!zp) return null;

  const metal = (zp.metal || fallbackMetal || 'oro').toLowerCase();
  // `acquisition_quality` no existe en los registros viejos: allí `confidence` ES la
  // calidad de la toma sin capar, así que sirve de origen.
  const acquisition_quality = typeof zp.acquisition_quality === 'number'
    ? zp.acquisition_quality
    : zp.confidence;

  const synthetic_weight_pct = zp.synthetic_weight_pct ?? 0;
  const ceiling = evidenceCeiling(metal, {
    requiresDeep: synthetic_weight_pct > SYNTHETIC_REQUIRES_DEEP_THRESHOLD * 100,
    syntheticWeightPct: synthetic_weight_pct,
    thermal: zp.thermal_gate ?? null,
  });

  const confidence = Math.min(acquisition_quality, CEILING_MAX_CONFIDENCE[ceiling.level]);
  if (confidence === zp.confidence && zp.acquisition_quality === acquisition_quality) {
    return zp;   // ya estaba capado: no se toca (idempotencia sin copia inútil)
  }

  const reasons_minus = [...(zp.reasons_minus ?? [])];
  const alreadyExplained = reasons_minus.some(r => r.startsWith('Toma de buena calidad'));
  if (confidence < acquisition_quality && !alreadyExplained) {
    reasons_minus.push(
      `Toma de buena calidad (${acquisition_quality}/100), pero la confianza queda limitada por la evidencia disponible para ${metal}` +
      (ceiling.note ? `: ${ceiling.note}` : '')
    );
  }

  return {
    ...zp,
    metal,
    acquisition_quality,
    confidence,
    confidence_label: labelFor(confidence),
    ceiling_level: ceiling.level,
    ceiling_note: ceiling.note,
    reasons_minus,
  };
}

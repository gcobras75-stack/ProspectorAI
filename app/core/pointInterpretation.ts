/**
 * Contexto de interpretación de UN punto para el Ing. Villegas (IA).
 *
 * Construye el texto que se envía a askClaudeInterpretacionPunto. Carga SOLO
 * valores reales y medidos; los datos ausentes se declaran como ausentes, para
 * que el prompt anti-alucinación no pueda rellenar huecos. Compartido por
 * SelectedPointModal y ResultsPanel (NIVEL 1) para no duplicar la lógica.
 */
import { INDEX_GLOSSARY, S2_REAL_INDEX_KEYS, NON_S2_INDEX_KEYS } from './indexGlossary';
import { isSaturated, saturatedKeys } from './saturation';
import { anomalyFromPct } from './spectralHelpers';
import { findNearestCell, type MiningSpectralResult } from './SatelliteEngine';
import { materialLabel, materialAiFrame } from './materialsCatalog';

export interface PointInterpOptions {
  selectedMineral: string;
  terrainType: string;
  allPoints?: any[];
  satelliteData: MiningSpectralResult | null;
}

export function buildPointInterpretationContext(p: any, opts: PointInterpOptions): string {
  const { selectedMineral, terrainType, allPoints, satelliteData } = opts;

  const realScore = Math.round(p.base_score || p.score || 0);
  const idx = p.indices ?? null;
  const measuredKeys = idx ? S2_REAL_INDEX_KEYS.filter(k => typeof idx[k] === 'number') : [];
  const { level: primLevel } = anomalyFromPct(realScore);
  const nearestCell = satelliteData?.cells?.length
    ? findNearestCell(p.lat, p.lng, satelliteData.cells)
    : null;

  const total = allPoints?.length ?? 0;
  const rank = p.rank ?? '—';

  // Los índices topados en 1.00 viajan marcados como saturados: el modelo NO debe
  // leerlos como "máxima anomalía", sino como techo del sensor pendiente de
  // contraste regional (ver app/core/saturation.ts).
  const idxLines = measuredKeys.length
    ? measuredKeys.map(k => {
        const info = INDEX_GLOSSARY[k];
        const v = Math.max(0, Math.min(1, Number(idx[k]) || 0));
        const sat = isSaturated(idx[k]);
        return `  • ${info?.label ?? k}: ${v.toFixed(2)}${sat ? '  (saturado: true)' : ''}`;
      }).join('\n')
    : '  (sin índices espectrales medidos en este punto)';

  const satKeys = saturatedKeys(idx, measuredKeys);
  const satNote = satKeys.length
    ? `\nVALORES SATURADOS (topados en 1.00): ${satKeys.map(k => INDEX_GLOSSARY[k]?.label ?? k).join(', ')}. ` +
      `Un índice saturado NO significa "máxima anomalía": significa que el sensor no distingue más allá de ese techo. ` +
      `En temporada seca el suelo desnudo eleva los índices de alteración de forma generalizada. ` +
      `La confirmación requiere análisis de contraste regional (en construcción) y verificación de campo. Dilo así, con honestidad.`
    : '';

  const missing = NON_S2_INDEX_KEYS.map(k => INDEX_GLOSSARY[k]?.label).filter(Boolean).join(', ');

  const consensusRaw: string = p.consensus ?? p.consensus_level ?? '';
  const consensusMap: Record<string, string> = {
    PRIORITY_TARGET: 'OBJETIVO PRIORITARIO (S2 + ASTER + estructura)',
    TRIPLE_SPECTRAL: 'TRIPLE (S2 + ASTER + EMIT)',
    CONFIRMED: 'CONFIRMADO (S2 + ASTER)',
    SINGLE: 'INDIVIDUAL (una sola fuente)',
  };
  const consensusText = consensusMap[consensusRaw] || consensusRaw || 'No especificado';

  const sources: string[] = [];
  sources.push(p.s2Score != null ? 'Sentinel-2 ✓' : 'Sentinel-2: sin dato');
  sources.push(p.asterScore != null ? 'ASTER ✓' : 'ASTER: sin dato');
  sources.push(p.emitScore != null ? 'EMIT ✓' : 'EMIT: sin dato');
  if (p.near_lineament) sources.push('Estructura/lineamiento ✓');

  const source = satelliteData?.source_label ?? 'Sentinel-2';
  const cellM = satelliteData?.cell_size_m;
  const imgDate = satelliteData?.acquisition_date;
  const vegNote = nearestCell?.masked_by_vegetation === true
    ? '\nADVERTENCIA: la celda más cercana está enmascarada por vegetación (NDVI alto) — la señal mineral puede estar atenuada.'
    : '';

  const frame = materialAiFrame(selectedMineral);

  return `[INTERPRETACIÓN DE PUNTO — datos reales del análisis]
Punto #${rank} de ${total} en el ranking del análisis.
Coordenadas: Lat ${p.lat.toFixed(6)}, Lng ${p.lng.toFixed(6)}
Terreno: ${terrainType}  |  Material objetivo: ${materialLabel(selectedMineral)}
MARCO GEOLÓGICO (interpreta según esto, NO asumas alteración de oro si no corresponde): ${frame.aiFrame}
Intensidad de ${frame.signalWord} (índices reales S2): ${primLevel} (${realScore}%)
Nivel de consenso: ${consensusText}
Fuentes que respaldan el punto: ${sources.join(', ')}

Índices espectrales MEDIDOS (Sentinel-2 — multiespectral, valores reales 0–1):
${idxLines}
Índices SIN dato directo en este punto (requieren ASTER/EMIT, no medidos): ${missing || 'ninguno'}${satNote}${vegNote}

Contexto del proyecto:
Fuente satelital: ${source}${imgDate ? ` · imagen ${imgDate}` : ''}${cellM ? ` · malla ${cellM} m/celda` : ''}${total ? ` · ${total} puntos en el análisis` : ''}

Dame tu INTERPRETACIÓN EXPERTA PROFUNDA de este punto siguiendo la estructura a)–e). Usa SOLO los valores de arriba; si un dato no está, dilo explícitamente.`;
}

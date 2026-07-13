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
import { findNearestCell, type MiningSpectralResult, type ThermalResult } from './SatelliteEngine';
import { materialLabel, materialAiFrame, isThermalMaterial, THERMAL_VEG_NOTE } from './materialsCatalog';
import { rockSourceLabel, type RockProposal, type RockSource } from './lithologyService';

export interface PointInterpOptions {
  selectedMineral: string;
  terrainType: string;
  allPoints?: any[];
  satelliteData: MiningSpectralResult | null;
  /** Índice de sílice térmico. Solo existe para sílice/granito/cantera/pómez. */
  thermalData?: ThermalResult | null;
  /** Tipo de roca en uso y de dónde salió. El modelo DEBE saberlo para calibrar. */
  rockType?: string;
  rockSource?: RockSource;
  rockProposal?: RockProposal | null;
}

export function buildPointInterpretationContext(p: any, opts: PointInterpOptions): string {
  const { selectedMineral, terrainType, allPoints, satelliteData, thermalData, rockType, rockSource, rockProposal } = opts;

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

  // ── Tipo de roca: QUÉ es y DE DÓNDE viene ───────────────────────────────────
  // Una carta regional (Macrostrat/GLiM, escala continental) NO es verdad de campo:
  // acierta la familia litológica dominante, pero puede errar en un afloramiento
  // concreto. El modelo tiene que saber si el dato lo midió alguien o lo dedujo un
  // mapa, y modular su certeza en consecuencia. Antes ni siquiera se le decía.
  let rockBlock = '';
  if (rockType) {
    const origen = rockSourceLabel(rockSource ?? 'default');
    if (rockSource === 'macrostrat' || rockSource === 'glim' || rockSource === 'sgm') {
      const unidad = rockProposal?.unit_name ? ` (unidad: ${rockProposal.unit_name})` : '';
      rockBlock =
        `
Tipo de roca: ${rockType} — PROPUESTO por ${origen}${unidad}, NO verificado en campo. ` +
        `Es una carta a escala regional: acierta la litología dominante de la zona, pero puede no ` +
        `describir el afloramiento exacto de este punto. Úsala como contexto, dilo si tu ` +
        `interpretación depende mucho de ella, y sugiere verificarla en campo.`;
    } else if (rockSource === 'usuario') {
      rockBlock = `
Tipo de roca: ${rockType} — INDICADO POR EL USUARIO (observación directa, más fiable que la carta).`;
    } else {
      rockBlock = `
Tipo de roca: ${rockType} — valor por defecto, NADIE lo confirmó. No lo tomes como dato.`;
    }
  }

  // ── Índice de sílice térmico (emisividad ASTER GED) ──────────────────────────
  // Solo se inyecta si la ruta corrió para este material. Si el gate del servidor
  // dice que no es concluyente (vegetación), se le ORDENA al modelo decirlo: no
  // puede leer un índice tapado por árboles como si midiera roca.
  let thermalBlock = '';
  if (isThermalMaterial(selectedMineral) && thermalData && thermalData.cells.length > 0) {
    const nearest = findNearestCell(p.lat, p.lng, thermalData.cells as any) as any;
    if (nearest && nearest.silica_index != null) {
      const fmt = (v: any) => (typeof v === 'number' ? v.toFixed(4) : 'sin dato');
      const lines = [
        `  • Índice de sílice (cuarzo, reststrahlen 8-9.5 µm): ${fmt(nearest.silica_index)}`,
        `  • Índice de carbonato (descarta caliza/mármol): ${fmt(nearest.carbonate_index)}`,
        `  • Índice máfico (roca pobre en sílice): ${fmt(nearest.mafic_index)}`,
      ];
      const body = lines.join('\n');
      if (thermalData.quality_ok && nearest.masked_by_vegetation !== true) {
        thermalBlock =
          `\n\nÍNDICE DE SÍLICE TÉRMICO (ASTER, MEDIDO sobre roca expuesta — ` +
          `${thermalData.rock_pct}% de la zona es roca):\n${body}\n` +
          `Referencia medida: arena de cuarzo casi puro ≈ 1.042 · basalto (máfico) ≈ 0.997. ` +
          `Úsalo como evidencia REAL para ${materialLabel(selectedMineral)}. ` +
          `Un carbonato alto con sílice baja apunta a caliza/mármol, no a cuarzo.`;
      } else {
        thermalBlock =
          `\n\nÍNDICE DE SÍLICE TÉRMICO (ASTER — NO CONCLUYENTE):\n${body}\n` +
          `Solo ${thermalData.rock_pct}% de la zona es roca expuesta. ${THERMAL_VEG_NOTE} ` +
          `OBLIGATORIO: NO uses estos números como evidencia de sílice y DI EXPLÍCITAMENTE que ` +
          `la vegetación impide medir la firma térmica del cuarzo aquí. ` +
          `Un valor bajo NO significa "poca sílice": significa "no medido".`;
      }
    }
  }

  return `[INTERPRETACIÓN DE PUNTO — datos reales del análisis]
Punto #${rank} de ${total} en el ranking del análisis.
Coordenadas: Lat ${p.lat.toFixed(6)}, Lng ${p.lng.toFixed(6)}
Terreno: ${terrainType}  |  Material objetivo: ${materialLabel(selectedMineral)}${rockBlock}
MARCO GEOLÓGICO (interpreta según esto, NO asumas alteración de oro si no corresponde): ${frame.aiFrame}
Intensidad de ${frame.signalWord} (índices reales S2): ${primLevel} (${realScore}%)
Nivel de consenso: ${consensusText}
Fuentes que respaldan el punto: ${sources.join(', ')}${thermalBlock}

Índices espectrales MEDIDOS (Sentinel-2 — multiespectral, valores reales 0–1):
${idxLines}
Índices SIN dato directo en este punto (requieren ASTER/EMIT, no medidos): ${missing || 'ninguno'}${satNote}${vegNote}

Contexto del proyecto:
Fuente satelital: ${source}${imgDate ? ` · imagen ${imgDate}` : ''}${cellM ? ` · malla ${cellM} m/celda` : ''}${total ? ` · ${total} puntos en el análisis` : ''}

Dame tu INTERPRETACIÓN EXPERTA PROFUNDA de este punto siguiendo la estructura a)–e). Usa SOLO los valores de arriba; si un dato no está, dilo explícitamente.`;
}

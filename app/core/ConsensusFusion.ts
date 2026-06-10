import { MiningSpectralResult, AsterSpectralResult, AsterSpectralCell, StructuralResult, StructuralCell, EmitSpectralResult, EmitSpectralCell, findNearestCell } from './SatelliteEngine';
import { cellAnomalyScore } from './spectralHelpers';

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
    litio:  [0.10, 0.20, 0.50, 0.20],
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
    litio:  [0.10, 0.25, 0.45, 0.20],
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

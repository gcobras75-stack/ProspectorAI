import { MiningSpectralResult, AsterSpectralResult, AsterSpectralCell, findNearestCell } from './SatelliteEngine';
import { cellAnomalyScore } from './spectralHelpers';

export type ConsensusLevel = 'CONFIRMED' | 'SINGLE' | 'VEGETATION' | 'NO_DATA';

export interface ConsensusPoint {
  lat: number;
  lng: number;
  rank: number;
  base_score: number;
  score: number;
  s2Score: number;
  asterScore: number | null;
  consensus: ConsensusLevel;
  supportedBy: ('S2' | 'ASTER')[];
  // pass-through fields from AnalysisPoint
  id: string;
  indices?: any;
  indices_analizados?: any[];
  analisis_integral?: string;
  geologia_interpretada?: string;
  recomendacion?: string;
}

function clamp01(v: number): number { return Math.max(0, Math.min(1, v)); }

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
  metal: string
): ConsensusPoint[] {
  const order: Record<ConsensusLevel, number> = { CONFIRMED: 0, SINGLE: 1, VEGETATION: 2, NO_DATA: 3 };

  const fused: ConsensusPoint[] = points.map(p => {
    const s2Cell    = s2Data.cells.length    ? findNearestCell(p.lat, p.lng, s2Data.cells)    : null;
    const asterCell = asterData?.cells.length ? findNearestCell(p.lat, p.lng, asterData.cells) : null;

    const s2Score    = s2Cell    ? cellAnomalyScore(s2Cell, metal) : 0;
    const asterScore = asterCell ? asterAnomalyScore(asterCell, metal) : null;
    const masked     = s2Cell?.masked_by_vegetation ?? false;

    let consensus:   ConsensusLevel;
    let supportedBy: ('S2' | 'ASTER')[];

    if (masked) {
      consensus   = 'VEGETATION';
      supportedBy = [];
    } else if (s2Score >= 65 && asterScore !== null && asterScore >= 65) {
      consensus   = 'CONFIRMED';
      supportedBy = ['S2', 'ASTER'];
    } else if (s2Score >= 35 || (asterScore !== null && asterScore >= 35)) {
      consensus   = 'SINGLE';
      supportedBy = s2Score >= 35 ? ['S2'] : ['ASTER'];
    } else {
      consensus   = 'NO_DATA';
      supportedBy = [];
    }

    const boostedScore = consensus === 'CONFIRMED'
      ? Math.min(100, Math.round(Math.max(s2Score, asterScore ?? 0) * 1.15))
      : (p.score ?? p.base_score);

    return {
      ...p,
      score: boostedScore,
      s2Score, asterScore,
      consensus, supportedBy,
    } as ConsensusPoint;
  });

  fused.sort((a, b) => order[a.consensus] - order[b.consensus] || b.score - a.score);
  fused.forEach((p, i) => { p.rank = i + 1; });

  return fused;
}

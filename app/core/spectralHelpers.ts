/**
 * spectralHelpers.ts
 *
 * Pure helper functions for tap-point and panel anomaly display.
 * No React Native imports — safe to use in any component.
 */

import type { MiningSpectralCell } from './SatelliteEngine';

// ─── Metal display metadata ───────────────────────────────────────────────────

export const TAP_METAL_META: Record<string, { label: string; icon: string; color: string }> = {
  oro:    { label: 'ORO',    icon: '🥇', color: '#B7950B' },
  plata:  { label: 'PLATA',  icon: '🥈', color: '#626567' },
  cobre:  { label: 'COBRE',  icon: '🟤', color: '#A04000' },
  litio:  { label: 'LITIO',  icon: '⚡', color: '#1E8449' },
  hierro: { label: 'HIERRO', icon: '🔴', color: '#922B21' },
};

// ─── Normalisation helpers ────────────────────────────────────────────────────

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ─── Real spectral anomaly from a Sentinel-2 cell ────────────────────────────
// Normalises raw satellite ratios to 0-100, applies per-metal hydrothermal
// proxy weights. No simulated data — only call with a real cell.

export function cellAnomalyScore(cell: MiningSpectralCell, metal: string): number {
  const normIron = clamp01((cell.iron_oxide - 0.5) / 2.5); // gossan proxy
  const normClay = clamp01((cell.clay       - 0.5) / 2.0); // hydrothermal clay
  const normFerr = clamp01((cell.ferroso    - 0.3) / 2.7); // ferrous iron

  switch (metal) {
    case 'oro':    return Math.round((normIron * 0.50 + normClay * 0.30 + normFerr * 0.20) * 100);
    case 'plata':  return Math.round((normClay * 0.60 + normIron * 0.40)                   * 100);
    case 'cobre':  return Math.round((normFerr * 0.50 + normIron * 0.30 + normClay * 0.20) * 100);
    case 'litio':  return Math.round((normClay * 0.80 + normFerr * 0.20)                   * 100);
    case 'hierro': return Math.round((normIron * 0.70 + normFerr * 0.30)                   * 100);
    default:       return Math.round((normIron * 0.40 + normClay * 0.40 + normFerr * 0.20) * 100);
  }
}

// ─── Anomaly level helpers ────────────────────────────────────────────────────

export function anomalyFromPct(pct: number): { level: 'ALTA' | 'MEDIA' | 'BAJA'; color: string } {
  if (pct >= 65) return { level: 'ALTA',  color: '#E53935' };
  if (pct >= 35) return { level: 'MEDIA', color: '#FFA000' };
  return             { level: 'BAJA',  color: '#546E7A' };
}

export function tapMessage(pct: number): { text: string; color: string } {
  if (pct >= 65) return { text: '⭐ Anomalía significativa',           color: '#E53935' };
  if (pct >= 35) return { text: '🟡 Señal moderada — registrar zona', color: '#FFA000' };
  return              { text: '⚫ Sin anomalía detectable',            color: '#546E7A' };
}

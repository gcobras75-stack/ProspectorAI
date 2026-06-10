/**
 * theme.ts — ProspectorAI Design Tokens
 *
 * Single source of truth for colors, typography, spacing, radii, shadows,
 * and touch targets. All components import from here — never hardcode values.
 *
 * Design principle: one hand, under the sun, on a hillside.
 * Minimum 14pt for informative text. Touch targets ≥44pt always.
 */

// ─── COLORS ──────────────────────────────────────────────────────────────────

export const Colors = {
  // Identity
  primary:       '#FFD700',   // gold — primary actions, active badges, borders
  primaryDim:    '#B8960C',   // gold darkened — pressed state
  primarySoft:   'rgba(255,215,0,0.15)', // gold tinted bg — banners, highlights

  // Surfaces (dark theme)
  bg:            '#000000',   // true black — map overlay backgrounds
  surface:       '#0A0A0A',   // main background
  surface2:      '#141414',   // cards, modals, bottom sheets
  surface3:      '#1E1E1E',   // dividers, inner borders
  surface4:      '#2A2A2A',   // inactive chips, secondary buttons

  // Text
  text:          '#FFFFFF',   // primary text
  textSub:       '#AAAAAA',   // secondary / muted text (≥14pt contexts)
  textDim:       '#555555',   // timestamps, metadata (11pt contexts only)
  textDisabled:  '#333333',   // disabled state

  // Borders
  border:        '#2A2A2A',   // subtle card border
  borderActive:  '#FFD700',   // gold — active/focused border

  // Semantic — analysis results
  anomalyHigh:   '#E53935',   // high anomaly (≥65%)
  anomalyMed:    '#FFA000',   // medium anomaly (35–64%)
  anomalyLow:    '#546E7A',   // low anomaly (<35%)

  // Semantic — consensus tiers
  priorityTarget:'#FFD700',   // PRIORITY_TARGET — gold
  tripleSpectral:'#00BCD4',   // TRIPLE_SPECTRAL — cyan
  confirmed:     '#00E676',   // CONFIRMED — green
  single:        '#FFA000',   // SINGLE — amber

  // Semantic — status
  success:       '#4CAF50',   // success, online, ready
  warning:       '#FF9800',   // warning, stale cache
  danger:        '#E53935',   // error, destructive
  info:          '#2196F3',   // informational, PDF

  // Field mode (light theme — high contrast under sun)
  fieldBg:       '#F0F0F0',
  fieldSurface:  '#FFFFFF',
  fieldBorder:   '#CCCCCC',
  fieldText:     '#000000',
  fieldTextSub:  '#444444',
  fieldPrimary:  '#1A1A1A',   // dark actions on light bg

  // Heatmap (map overlay cells)
  heatHigh:      'rgba(255, 68, 68, 0.65)',
  heatMed:       'rgba(255,165,  0, 0.55)',
  heatLow:       'rgba(255,221, 68, 0.40)',
  heatMin:       'rgba( 68,255, 68, 0.35)',
} as const;

// ─── TYPOGRAPHY ──────────────────────────────────────────────────────────────
// Rule: nothing informative below 14pt. 11pt only for pure metadata (coords,
// timestamps, grid size). Never use fontSize < 11 in production UI.

export const Typography = {
  // Metadata / coordinates / timestamps only
  micro:  { fontSize: 11, lineHeight: 15 } as const,

  // Smallest informative text — labels, chips, badges
  caption:{ fontSize: 12, lineHeight: 16 } as const,

  // Body — MINIMUM for any informative text read in the field
  body:   { fontSize: 14, lineHeight: 20 } as const,
  bodyBold:{ fontSize: 14, fontWeight: '700' as const, lineHeight: 20 },

  // Slightly larger body — sub-titles, section labels
  subTitle:{ fontSize: 15, lineHeight: 21 } as const,

  // Buttons, primary actions — bold and large enough to tap without reading closely
  action: { fontSize: 15, fontWeight: '900' as const, lineHeight: 20 },

  // Card titles, modal section headers
  title:  { fontSize: 17, fontWeight: '700' as const, lineHeight: 23 },

  // Screen titles, score heroes
  hero:   { fontSize: 22, fontWeight: '900' as const, lineHeight: 28 },

  // Font families
  mono:   { fontFamily: 'monospace' } as const,
} as const;

// ─── SPACING ─────────────────────────────────────────────────────────────────

export const Spacing = {
  xxs:  2,
  xs:   4,
  sm:   8,
  md:  12,
  lg:  16,
  xl:  24,
  xxl: 32,
  xxxl:48,
} as const;

// ─── BORDER RADII ────────────────────────────────────────────────────────────

export const Radii = {
  xs:   4,
  sm:   6,
  md:  10,
  lg:  16,
  xl:  24,
  pill:999,
} as const;

// ─── TOUCH TARGETS ───────────────────────────────────────────────────────────
// All interactive elements must meet the minimum. No exceptions.

export const Touch = {
  min:     44,  // WCAG 2.5.5 minimum — every interactive element
  standard:55,  // standard toolbar button
  fab:     56,  // floating action button (primary actions)
  field:   64,  // field mode — gloved hands, sun, movement
  small:   44,  // smallest allowed (labels, chips with padding)
} as const;

// ─── SHADOWS ─────────────────────────────────────────────────────────────────

export const Shadows = {
  // For dark surfaces — subtle lift
  card: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 4,
    elevation: 4,
  },
  // Floating elements (bottom sheets, FABs)
  float: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.6,
    shadowRadius: 8,
    elevation: 8,
  },
  // Gold glow — primary FAB, active elements
  glow: {
    shadowColor: '#FFD700',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 6,
  },
} as const;

// ─── ANIMATION ───────────────────────────────────────────────────────────────
// Sober and fast — never block the user.

export const Animation = {
  fast:    150,  // state changes, toggles
  normal:  200,  // sheet slides, card transitions — MAX for field use
  slow:    300,  // only for onboarding/first-time flows
} as const;

// ─── CONSENSUS BADGE CONFIG ──────────────────────────────────────────────────
// Single lookup used by ResultsPanel, RankingItem, PDF, etc.

export const ConsensusBadge = {
  PRIORITY_TARGET: { label: '🎯 OBJ.',   sub: 'S2+ASTER+Estr.', color: Colors.priorityTarget },
  TRIPLE_SPECTRAL: { label: '🌈 3×',     sub: 'S2+ASTER+EMIT',  color: Colors.tripleSpectral },
  CONFIRMED:       { label: '✅ CONF.',   sub: 'S2+ASTER',       color: Colors.confirmed },
  SINGLE:          { label: 'SINGLE',    sub: 'alteración',     color: Colors.single },
  VEGETATION:      { label: '🌿 VEG.',   sub: 'sin lectura',    color: Colors.anomalyLow },
  NO_DATA:         { label: 'SIN DATA',  sub: '',               color: Colors.textDim },
} as const;

// ─── ANOMALY LEVEL CONFIG ────────────────────────────────────────────────────

export const AnomalyLevel = {
  high: { label: 'ALTA',  color: Colors.anomalyHigh, minPct: 65 },
  med:  { label: 'MEDIA', color: Colors.anomalyMed,  minPct: 35 },
  low:  { label: 'BAJA',  color: Colors.anomalyLow,  minPct:  0 },
} as const;

export function anomalyFromPct(pct: number) {
  if (pct >= AnomalyLevel.high.minPct) return AnomalyLevel.high;
  if (pct >= AnomalyLevel.med.minPct)  return AnomalyLevel.med;
  return AnomalyLevel.low;
}

// ─── CONVENIENCE RE-EXPORT ───────────────────────────────────────────────────

const Theme = { Colors, Typography, Spacing, Radii, Touch, Shadows, Animation, ConsensusBadge, AnomalyLevel, anomalyFromPct };
export default Theme;

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

// ─── Constants ────────────────────────────────────────────────────────────────

export const GLOBAL_MAX_SCORES: Record<string, Record<string, number>> = {
  oro:    { sierra: 92, playa: 78 },
  plata:  { sierra: 71, playa: 45 },
  cobre:  { sierra: 88, playa: 40 },
  litio:  { sierra: 85, playa: 30 },
  hierro: { sierra: 95, playa: 70 },
};

export const METAL_COLORS: Record<string, string> = {
  oro:    '#FFD700',
  plata:  '#B0BEC5',
  cobre:  '#FF7043',
  litio:  '#69F0AE',
  hierro: '#EF5350',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getContextMessage(pct: number): { text: string; color: string } {
  if (pct >= 80) return { text: '⭐ Anomalía significativa — visita prioritaria', color: '#FFD700' };
  if (pct >= 60) return { text: '✅ Señal positiva — vale explorar',              color: '#00C853' };
  if (pct >= 40) return { text: '📊 Señal moderada — zona con potencial',          color: '#FFA500' };
  if (pct >= 20) return { text: '⚠️  Señal débil — baja prioridad',               color: '#FF7043' };
  return             { text: '❌ Sin anomalía detectable',                         color: '#666'    };
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface ScoreCardProps {
  metal: string;          // 'oro' | 'plata' | 'cobre' | 'litio' | 'hierro'
  terrain: string;        // 'sierra' | 'playa'
  metalLabel: string;
  metalIcon: string;
  pointScore: number;     // 0-100, calculated for this polygon
  globalMax?: number;     // override lookup (pass ms.score_maximo)
  regionalAvg?: number;   // optional, average score across polygon points (0-100)
  guideMineral?: string[];
  warning?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ScoreCard({
  metal,
  terrain,
  metalLabel,
  metalIcon,
  pointScore,
  globalMax: globalMaxProp,
  regionalAvg,
  guideMineral,
  warning,
}: ScoreCardProps) {
  const terrainKey = terrain === 'playa' ? 'playa' : 'sierra';
  const terrainLabel = terrain === 'playa' ? 'Playa' : 'Sierra';

  const globalMax  = globalMaxProp ?? GLOBAL_MAX_SCORES[metal]?.[terrainKey] ?? 100;
  const color      = METAL_COLORS[metal] ?? '#FFD700';
  const pct        = Math.round((pointScore / globalMax) * 100);
  const { text: msgText, color: msgColor } = getContextMessage(pct);

  // Bar widths as % strings (tracks represent 0–100 scale)
  const maxBarW  = `${globalMax}%` as const;
  const ptBarW   = `${Math.min(pointScore, globalMax)}%` as const;

  return (
    <View style={styles.card}>

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <Text style={styles.metalTitle}>
          {metalIcon}  {metalLabel.toUpperCase()} — {terrainLabel}
        </Text>
        <View style={[styles.pctBadge, { borderColor: color, backgroundColor: `${color}22` }]}>
          <Text style={[styles.pctBadgeText, { color }]}>{pct}%</Text>
        </View>
      </View>

      {/* ── MAX bar ──────────────────────────────────────────────────────── */}
      <View style={styles.barSection}>
        <View style={styles.barLabelRow}>
          <Text style={styles.barLabelSmall}>Máximo posible en el mundo</Text>
          <Text style={styles.barValueSmall}>{globalMax}/100</Text>
        </View>
        <View style={styles.track}>
          {/* achievable ceiling marker */}
          <View style={[styles.maxFill, { width: maxBarW }]} />
        </View>
      </View>

      {/* ── POINT bar ────────────────────────────────────────────────────── */}
      <View style={styles.barSection}>
        <View style={styles.barLabelRow}>
          <Text style={styles.barLabelMain}>Score de este polígono</Text>
          <Text style={[styles.barValueBig, { color }]}>{pointScore}</Text>
        </View>
        <View style={styles.track}>
          {/* achievable zone (lighter background up to globalMax) */}
          <View style={[styles.achievableZone, { width: maxBarW }]} />
          {/* point fill */}
          <View style={[styles.pointFill, { width: ptBarW, backgroundColor: color }]} />
        </View>
      </View>

      {/* ── Stats ────────────────────────────────────────────────────────── */}
      <View style={styles.statsRow}>
        <Text style={[styles.statsMain, { color }]}>
          📊 Aprovechando el {pct}% del potencial máximo
        </Text>
        {regionalAvg !== undefined && (
          <Text style={styles.statsSub}>
            {pointScore >= regionalAvg
              ? `📍 Por encima del promedio regional (${Math.round(regionalAvg)}/100)`
              : `📍 Por debajo del promedio regional (${Math.round(regionalAvg)}/100)`}
          </Text>
        )}
      </View>

      {/* ── Contextual message ───────────────────────────────────────────── */}
      <View style={[styles.msgBox, { borderLeftColor: msgColor }]}>
        <Text style={[styles.msgText, { color: msgColor }]}>{msgText}</Text>
      </View>

      {/* ── Guide minerals ───────────────────────────────────────────────── */}
      {guideMineral && guideMineral.length > 0 && (
        <Text style={styles.guideText}>
          Buscar en campo:{' '}
          <Text style={{ color: '#00FFFF' }}>{guideMineral.join(' · ')}</Text>
        </Text>
      )}

      {/* ── Warning ──────────────────────────────────────────────────────── */}
      {warning && (
        <Text style={styles.warningText}>⚠️ {warning}</Text>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#0C0C0C',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#252525',
    padding: 13,
    marginBottom: 10,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 11,
  },
  metalTitle: {
    color: '#FFFFFF',
    fontWeight: '900',
    fontSize: 13,
    letterSpacing: 0.4,
    flex: 1,
  },
  pctBadge: {
    borderWidth: 1.5,
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 3,
    marginLeft: 8,
  },
  pctBadgeText: {
    fontWeight: '900',
    fontSize: 13,
  },
  barSection: {
    marginBottom: 9,
  },
  barLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 4,
  },
  barLabelSmall: {
    color: '#555',
    fontSize: 10,
    letterSpacing: 0.2,
  },
  barLabelMain: {
    color: '#888',
    fontSize: 10,
    letterSpacing: 0.2,
  },
  barValueSmall: {
    color: '#4A4A4A',
    fontSize: 10,
    fontWeight: '600',
  },
  barValueBig: {
    fontSize: 22,
    fontWeight: '900',
    lineHeight: 24,
  },
  track: {
    width: '100%',
    height: 8,
    backgroundColor: '#111',
    borderRadius: 4,
    overflow: 'hidden',
  },
  maxFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: '#383838',
    borderRadius: 4,
    borderRightWidth: 1.5,
    borderRightColor: '#5A5A5A',
  },
  achievableZone: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: '#1E1E1E',
  },
  pointFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 4,
    opacity: 0.92,
  },
  statsRow: {
    marginTop: 2,
    marginBottom: 8,
  },
  statsMain: {
    fontSize: 11,
    fontWeight: '700',
  },
  statsSub: {
    color: '#666',
    fontSize: 10,
    marginTop: 3,
  },
  msgBox: {
    borderLeftWidth: 3,
    paddingLeft: 9,
    paddingVertical: 5,
    marginBottom: 8,
    backgroundColor: '#141414',
    borderRadius: 4,
  },
  msgText: {
    fontSize: 11,
    fontWeight: '600',
  },
  guideText: {
    color: '#4A4A4A',
    fontSize: 10,
    marginTop: 2,
  },
  warningText: {
    color: '#FF9800',
    fontSize: 10,
    marginTop: 5,
  },
});

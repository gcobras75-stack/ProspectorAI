import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Colors, Typography, Radii } from '../core/theme';

// ─── Constants ────────────────────────────────────────────────────────────────

export const METAL_COLORS: Record<string, string> = {
  oro:    '#FFD700',
  plata:  '#B0BEC5',
  cobre:  '#FF7043',
  tierras_raras: '#69F0AE',
  hierro: '#EF5350',
};

// Anomaly level thresholds (based on score_percent, which is derived from
// real spectral indices when satellite data is available)
function getAnomalyLevel(pct: number): { level: 'ALTA' | 'MEDIA' | 'BAJA'; color: string } {
  if (pct >= 65) return { level: 'ALTA',  color: Colors.anomalyHigh };
  if (pct >= 35) return { level: 'MEDIA', color: Colors.anomalyMed  };
  return             { level: 'BAJA',  color: Colors.anomalyLow  };
}

// Mineralogical association text (honest context, not a measurement)
const METAL_ASSOCIATION: Record<string, string> = {
  oro:    'Patrón de óxido de hierro y gossan compatible con alteración hidrotermal Au-Ag epitermal o pórfido.',
  plata:  'Alteración argílica avanzada compatible con sistemas Ag-Pb-Zn epitermales y vetas polimetálicas.',
  cobre:  'Oxidación de Fe y alteración propilítica compatible con pórfidos Cu-Mo y skarn de cobre.',
  tierras_raras: 'Arcillas y óxidos compatibles con carbonatitas, pegmatitas y placeres de minerales pesados portadores de REE.',
  hierro: 'Óxidos de Fe ferroso y férrico consistentes con BIF, skarn de hierro o depósitos de Fe en placer.',
};

// ─── Props ────────────────────────────────────────────────────────────────────

interface ScoreCardProps {
  metal: string;
  terrain: string;
  metalLabel: string;
  metalIcon: string;
  pointScore: number;     // 0–100, intensidad de anomalía calculada de índices reales
  globalMax?: number;     // kept for backward compat (used only for pct calc internally)
  regionalAvg?: number;   // average across polygon points (0–100)
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
  globalMax = 100,
  regionalAvg,
  guideMineral,
  warning,
}: ScoreCardProps) {
  const [expanded, setExpanded] = useState(false);

  const terrainLabel = terrain === 'playa' ? 'Playa' : 'Sierra';
  const color        = METAL_COLORS[metal] ?? '#FFD700';
  const pct          = Math.round((pointScore / globalMax) * 100);
  const { level, color: levelColor } = getAnomalyLevel(pct);
  const association  = METAL_ASSOCIATION[metal] ?? '';
  const barWidth     = `${Math.min(pct, 100)}%` as const;

  return (
    <View style={styles.card}>

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <Text style={styles.metalTitle}>
          {metalIcon}  {metalLabel.toUpperCase()} — {terrainLabel}
        </Text>
        <View style={[styles.levelBadge, { borderColor: levelColor, backgroundColor: `${levelColor}22` }]}>
          <Text style={[styles.levelBadgeText, { color: levelColor }]}>{level}</Text>
        </View>
      </View>

      {/* ── Anomaly bar ──────────────────────────────────────────────────── */}
      <View style={styles.barSection}>
        <View style={styles.barHeaderRow}>
          <Text style={styles.barLabel}>SEÑAL ESPECTRAL DE ALTERACIÓN</Text>
          <Text style={[styles.barScoreVal, { color: levelColor }]}>{pct}/100</Text>
        </View>
        <View style={styles.track}>
          <View style={[styles.barFill, { width: barWidth, backgroundColor: levelColor }]} />
        </View>
        <Text style={styles.scaleNote}>
          {'Señal espectral 0–100 · alto ≥65 · medio 35–64 · bajo <35 · no es probabilidad de yacimiento ni ley/tonelaje'}
        </Text>
        {regionalAvg !== undefined && (
          <Text style={styles.regionalNote}>
            {pointScore >= regionalAvg
              ? `▲ Por encima del promedio de zona (${Math.round(regionalAvg)}/100)`
              : `▼ Por debajo del promedio de zona (${Math.round(regionalAvg)}/100)`}
          </Text>
        )}
      </View>

      {/* ── Association context ──────────────────────────────────────────── */}
      <TouchableOpacity onPress={() => setExpanded(e => !e)} style={styles.assocRow}>
        <Text style={styles.assocLabel}>Contexto mineralógico {expanded ? '▲' : '▼'}</Text>
      </TouchableOpacity>
      {expanded && (
        <Text style={styles.assocText}>{association}</Text>
      )}

      {/* ── Guide minerals ───────────────────────────────────────────────── */}
      {guideMineral && guideMineral.length > 0 && (
        <Text style={styles.guideText}>
          Buscar en campo:{' '}
          <Text style={{ color: Colors.tripleSpectral }}>{guideMineral.join(' · ')}</Text>
        </Text>
      )}

      {/* ── Warning ──────────────────────────────────────────────────────── */}
      {warning && (
        <Text style={styles.warningText}>⚠️ {warning}</Text>
      )}

      {/* ── Disclaimer ───────────────────────────────────────────────────── */}
      <Text style={styles.disclaimer}>
        Indicador exploratorio — requiere verificación en campo
      </Text>

    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    borderWidth: 1,
    borderColor: Colors.surface4,
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
    color: Colors.text,
    fontWeight: '900',
    ...Typography.body,
    letterSpacing: 0.4,
    flex: 1,
  },
  levelBadge: {
    borderWidth: 1.5,
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 3,
    marginLeft: 8,
  },
  levelBadgeText: {
    fontWeight: '900',
    ...Typography.caption,
    letterSpacing: 0.5,
  },
  barSection: {
    marginBottom: 10,
  },
  barLabel: {
    color: Colors.textDim,
    ...Typography.micro,
    letterSpacing: 0.8,
    flex: 1,
  },
  barHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginBottom: 5,
  },
  barScoreVal: {
    fontWeight: '900',
    ...Typography.body,
    marginLeft: 8,
  },
  scaleNote: {
    color: Colors.textDim,
    ...Typography.micro,
    marginTop: 5,
    lineHeight: 14,
  },
  track: {
    width: '100%',
    height: 8,
    backgroundColor: Colors.surface2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  barFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 4,
    opacity: 0.85,
  },
  regionalNote: {
    color: Colors.textSub,
    ...Typography.caption,
    marginTop: 5,
  },
  assocRow: {
    marginBottom: 4,
  },
  assocLabel: {
    color: Colors.textDim,
    ...Typography.caption,
    letterSpacing: 0.3,
  },
  assocText: {
    color: Colors.textSub,
    ...Typography.body,
    marginBottom: 8,
    fontStyle: 'italic',
  },
  guideText: {
    color: Colors.textSub,
    ...Typography.body,
    marginTop: 6,
  },
  warningText: {
    color: Colors.warning,
    ...Typography.body,
    marginTop: 5,
  },
  disclaimer: {
    color: Colors.textDisabled,
    ...Typography.micro,
    marginTop: 8,
    fontStyle: 'italic',
    letterSpacing: 0.2,
  },
});

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator,
} from 'react-native';
import { Colors, Spacing, Radii, Touch } from '../core/theme';
import { getValidationPairs, ValidationPair } from '../core/Database';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ValidationViewProps {
  projectId: string;
  metalTarget: string;
  isFieldMode?: boolean;
}

type VerdictKey = 'CONFIRMED' | 'PARTIAL' | 'NOT_CONFIRMED';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VERDICT_SHORT: Record<string, string> = {
  CONFIRMED: '✅ CONF.',
  PARTIAL: '⚠️ PARCIAL',
  NOT_CONFIRMED: '❌ N/C',
};

const VERDICT_COLOR: Record<string, string> = {
  CONFIRMED: Colors.success,
  PARTIAL: Colors.warning,
  NOT_CONFIRMED: Colors.danger,
};

const CONSENSUS_COLOR: Record<string, string> = {
  PRIORITY_TARGET: Colors.priorityTarget,
  TRIPLE_SPECTRAL: Colors.tripleSpectral,
  CONFIRMED: Colors.confirmed,
  SINGLE: Colors.single,
  VEGETATION: Colors.anomalyLow,
};

function consensusColor(level?: string): string {
  if (!level) return Colors.textDim;
  return CONSENSUS_COLOR[level] ?? Colors.textSub;
}

function labSummary(pair: ValidationPair, metalTarget: string): string {
  const parts: string[] = [];
  if (pair.lab_au_gt != null) parts.push(`Au: ${pair.lab_au_gt} g/t`);
  if (pair.lab_ag_gt != null) parts.push(`Ag: ${pair.lab_ag_gt} g/t`);
  if (pair.lab_cu_pct != null) parts.push(`Cu: ${pair.lab_cu_pct}%`);
  if (pair.lab_pb_pct != null) parts.push(`Pb: ${pair.lab_pb_pct}%`);
  if (pair.lab_zn_pct != null) parts.push(`Zn: ${pair.lab_zn_pct}%`);
  if (parts.length === 0) return '—';
  // Show the relevant metal first for the project's metal target
  const metalMap: Record<string, string> = {
    oro: 'Au', plata: 'Ag', cobre: 'Cu', plomo: 'Pb', zinc: 'Zn',
  };
  const targetSymbol = metalMap[metalTarget];
  if (targetSymbol) {
    parts.sort((a, b) => (a.startsWith(targetSymbol) ? -1 : b.startsWith(targetSymbol) ? 1 : 0));
  }
  return parts.slice(0, 2).join(' · ');
}

// ─── Row item ─────────────────────────────────────────────────────────────────

function PairRow({ pair, metalTarget }: { pair: ValidationPair; metalTarget: string }) {
  const snap = (() => {
    try { return JSON.parse(pair.spectral_snapshot || '{}'); } catch { return {}; }
  })();
  const consensusLevel: string = snap.consensus_level || '';

  return (
    <View style={rowStyles.row}>
      {/* Left: código + consensus */}
      <View style={rowStyles.left}>
        <Text style={rowStyles.code} numberOfLines={1}>
          {pair.muestra_codigo || pair.muestra_id.slice(-8)}
        </Text>
        {!!consensusLevel && (
          <Text style={[rowStyles.consensus, { color: consensusColor(consensusLevel) }]} numberOfLines={1}>
            {consensusLevel}
          </Text>
        )}
      </View>

      {/* Middle: lab values */}
      <View style={rowStyles.mid}>
        <Text style={rowStyles.lab} numberOfLines={2}>
          {labSummary(pair, metalTarget)}
        </Text>
      </View>

      {/* Right: verdict badge */}
      <View style={rowStyles.right}>
        {pair.validation_verdict ? (
          <Text style={[rowStyles.verdict, { color: VERDICT_COLOR[pair.validation_verdict] ?? Colors.textSub }]}>
            {VERDICT_SHORT[pair.validation_verdict] ?? pair.validation_verdict}
          </Text>
        ) : (
          <Text style={rowStyles.pending}>— pendiente</Text>
        )}
      </View>
    </View>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ValidationView({ projectId, metalTarget, isFieldMode }: ValidationViewProps) {
  const [pairs, setPairs] = useState<ValidationPair[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getValidationPairs(projectId);
      setPairs(data);
    } catch {
      setPairs([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const confirmed = pairs.filter(p => p.validation_verdict === 'CONFIRMED').length;
  const total = pairs.length;
  const pct = total > 0 ? Math.round((confirmed / total) * 100) : 0;

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Colors.primary} size="large" />
      </View>
    );
  }

  return (
    <View style={[styles.root, isFieldMode && styles.rootField]}>
      {/* Counter header */}
      <View style={styles.counter}>
        <Text style={[styles.counterText, isFieldMode && styles.counterTextField]}>
          {total} muestras validadas
          {total > 0 ? ` · ${confirmed} confirmadas (${pct}%)` : ''}
        </Text>
        <TouchableOpacity onPress={load} style={styles.refreshBtn} accessibilityLabel="Recargar">
          <Text style={styles.refreshIcon}>↻</Text>
        </TouchableOpacity>
      </View>

      {total === 0 ? (
        <View style={styles.empty}>
          <Text style={[styles.emptyText, isFieldMode && styles.emptyTextField]}>
            No hay muestras con resultados de laboratorio aún.
          </Text>
        </View>
      ) : (
        <FlatList<ValidationPair>
          data={pairs}
          keyExtractor={item => item.muestra_id}
          renderItem={({ item }) => <PairRow pair={item} metalTarget={metalTarget} />}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.surface,
  },
  rootField: {
    backgroundColor: '#F0F0F0',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  counter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    backgroundColor: Colors.surface2,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surface3,
  },
  counterText: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  counterTextField: {
    color: '#000',
  },
  refreshBtn: {
    width: Touch.min,
    height: Touch.min,
    justifyContent: 'center',
    alignItems: 'center',
  },
  refreshIcon: {
    color: Colors.primary,
    fontSize: 22,
    fontWeight: '700',
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg ?? 24,
  },
  emptyText: {
    color: Colors.textSub,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
  },
  emptyTextField: {
    color: '#444',
  },
  list: {
    padding: Spacing.md,
    paddingBottom: 40,
  },
  separator: {
    height: 1,
    backgroundColor: Colors.surface3,
    marginVertical: 2,
  },
});

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 4,
    minHeight: Touch.min,
  },
  left: {
    flex: 2,
    paddingRight: 8,
  },
  mid: {
    flex: 2,
    paddingHorizontal: 4,
  },
  right: {
    flex: 1.5,
    alignItems: 'flex-end',
  },
  code: {
    color: Colors.primary,
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  consensus: {
    fontSize: 10,
    fontWeight: '600',
    marginTop: 2,
  },
  lab: {
    color: Colors.text,
    fontSize: 12,
    lineHeight: 17,
  },
  verdict: {
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'right',
  },
  pending: {
    color: Colors.textDim,
    fontSize: 11,
    textAlign: 'right',
  },
});

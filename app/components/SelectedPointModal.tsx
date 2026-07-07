import React, { useState } from 'react';
import { View, Text, Modal, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import MapView from 'react-native-maps';
import { findNearestCell, type MiningSpectralResult } from '../core/SatelliteEngine';
import { TAP_METAL_META, cellAnomalyScore, anomalyFromPct } from '../core/spectralHelpers';
import { METAL_COLORS } from './ScoreCard';
import { INDEX_GLOSSARY, S2_REAL_INDEX_KEYS, NON_S2_INDEX_KEYS } from '../core/indexGlossary';
import { buildPointInterpretationContext } from '../core/pointInterpretation';

interface SelectedPointModalProps {
  selectedPoint: any;
  satelliteData: MiningSpectralResult | null;
  selectedMineral: string;
  terrainType: string;
  mapRef: React.RefObject<MapView | null>;
  allPoints?: any[];
  onClose: () => void;
  onSaveSample: () => void;
  onInterpret: (context: string) => void;
}

export default function SelectedPointModal({
  selectedPoint, satelliteData, selectedMineral, terrainType, mapRef, allPoints, onClose, onSaveSample, onInterpret,
}: SelectedPointModalProps) {
  const [openIdx, setOpenIdx] = useState<string | null>(null);

  if (!selectedPoint) return null;

  const realScore = Math.round(selectedPoint.base_score || selectedPoint.score || 0);
  const idx = selectedPoint.indices ?? null;
  const measuredKeys = idx
    ? S2_REAL_INDEX_KEYS.filter(k => typeof idx[k] === 'number')
    : [];
  const { level: primLevel, color: primColor } = anomalyFromPct(realScore);
  const nearestCell = satelliteData?.cells?.length
    ? findNearestCell(selectedPoint.lat, selectedPoint.lng, satelliteData.cells)
    : null;

  // Full point context for the "Interpretación de datos" flow — shared builder that
  // carries ONLY real, measured values so the AI cannot hallucinate (see
  // INTERPRETACION_SYSTEM in ClaudeServices). Missing data is stated as missing.
  const buildInterpretationContext = (): string =>
    buildPointInterpretationContext(selectedPoint, { selectedMineral, terrainType, allPoints, satelliteData });

  return (
    <Modal visible={!!selectedPoint} transparent animationType="slide">
      <View style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.85)' }]}>
        <View style={styles.container}>

          {/* Close X (top-right) — replaces the old full-width CERRAR button */}
          <TouchableOpacity
            style={styles.closeX}
            onPress={onClose}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Text style={styles.closeXText}>✕</Text>
          </TouchableOpacity>

          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.rank}>PUNTO #{selectedPoint.rank}</Text>
            <Text style={styles.coords}>
              📍 Lat: {selectedPoint.lat.toFixed(6)} | Lng: {selectedPoint.lng.toFixed(6)}
            </Text>
            <Text style={styles.meta}>
              Terreno: {terrainType.charAt(0).toUpperCase() + terrainType.slice(1)}{'  |  '}Metal: {selectedMineral.toUpperCase()}
            </Text>
          </View>

          <ScrollView style={{ maxHeight: '100%' }}>
            {/* Data source */}
            <Text style={{ fontSize: 10, color: '#4CAF50', marginBottom: 12 }}>
              {satelliteData?.source_label ?? ''}
            </Text>

            {/* Primary mineral */}
            <View style={styles.primaryBox}>
              <Text style={{ color: '#888', fontSize: 9, letterSpacing: 0.8, marginBottom: 6 }}>
                MINERAL SELECCIONADO — {selectedMineral.toUpperCase()}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <Text style={{ color: METAL_COLORS[selectedMineral] ?? '#FFD700', fontWeight: '900', fontSize: 16 }}>
                  {TAP_METAL_META[selectedMineral]?.icon}  {TAP_METAL_META[selectedMineral]?.label}
                </Text>
                <View style={{ borderWidth: 1.5, borderColor: primColor, borderRadius: 5, paddingHorizontal: 10, paddingVertical: 3, backgroundColor: `${primColor}22` }}>
                  <Text style={{ color: primColor, fontWeight: '900', fontSize: 13 }}>{primLevel}</Text>
                </View>
              </View>
              <View style={{ height: 6, backgroundColor: '#1A1A1A', borderRadius: 3, overflow: 'hidden', marginBottom: 6 }}>
                <View style={{ height: '100%', width: `${realScore}%`, backgroundColor: primColor, borderRadius: 3 }} />
              </View>
              <Text style={{ color: '#555', fontSize: 9, fontStyle: 'italic' }}>
                Intensidad de alteración calculada de índices espectrales reales
              </Text>
            </View>

            {/* Other metals from nearest cell */}
            {nearestCell && (
              <>
                <Text style={{ color: '#444', fontSize: 9, letterSpacing: 0.8, marginBottom: 8 }}>
                  OTROS METALES — celda Sentinel-2 más cercana
                </Text>
                {(['oro', 'plata', 'cobre', 'litio', 'hierro'] as const)
                  .filter(m => m !== selectedMineral)
                  .map(metal => {
                    const score = cellAnomalyScore(nearestCell, metal);
                    const { level, color: aColor } = anomalyFromPct(score);
                    const meta = TAP_METAL_META[metal];
                    return (
                      <View key={metal} style={styles.metalRow}>
                        <Text style={{ color: meta?.color ?? '#888', fontWeight: '700', fontSize: 12, width: 80 }}>
                          {meta?.icon} {meta?.label}
                        </Text>
                        {nearestCell.masked_by_vegetation === true ? (
                          <Text style={{ color: '#FF9800', fontSize: 9, flex: 1 }}>⚠️ Vegetación — sin lectura confiable</Text>
                        ) : (
                          <>
                            <View style={{ flex: 1, height: 5, backgroundColor: '#1A1A1A', borderRadius: 3, overflow: 'hidden', marginHorizontal: 6 }}>
                              <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${score}%`, backgroundColor: aColor, borderRadius: 3, opacity: 0.85 }} />
                            </View>
                            <View style={{ borderWidth: 1, borderColor: aColor, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1, marginLeft: 6, backgroundColor: `${aColor}22` }}>
                              <Text style={{ color: aColor, fontWeight: '700', fontSize: 9 }}>{level}</Text>
                            </View>
                          </>
                        )}
                      </View>
                    );
                  })}
              </>
            )}

            {/* Índices espectrales del punto — valores reales S2 + glosario tocable */}
            {measuredKeys.length > 0 && (
              <View style={styles.idxBox}>
                <Text style={styles.idxTitle}>ÍNDICES ESPECTRALES — Sentinel-2</Text>
                <Text style={styles.idxHint}>Toca un índice para ver qué significa</Text>
                {measuredKeys.map(k => {
                  const info = INDEX_GLOSSARY[k];
                  const v = Math.max(0, Math.min(1, Number(idx[k]) || 0));
                  const open = openIdx === k;
                  const { level: vLevel, color: vColor } = anomalyFromPct(Math.round(v * 100));
                  return (
                    <View key={k} style={styles.idxRow}>
                      <TouchableOpacity activeOpacity={0.7} onPress={() => setOpenIdx(open ? null : k)}>
                        <View style={styles.idxLabelRow}>
                          <Text style={styles.idxLabel}>{info?.label ?? k}  {open ? '▲' : 'ⓘ'}</Text>
                          <Text style={styles.idxVal}>
                            <Text style={{ color: vColor, fontWeight: '900' }}>{vLevel}</Text>
                            <Text style={{ color: '#888' }}>  ({v.toFixed(2)})</Text>
                          </Text>
                        </View>
                        <View style={styles.idxTrack}>
                          <View style={[styles.idxFill, { width: `${Math.round(v * 100)}%`, backgroundColor: vColor }]} />
                        </View>
                      </TouchableOpacity>
                      {open && <Text style={styles.idxDetail}>{info?.detail}</Text>}
                    </View>
                  );
                })}
                <Text style={styles.idxNote}>
                  Estos minerales necesitan análisis profundo (actívalo en Ajustes):{' '}
                  {NON_S2_INDEX_KEYS.map(k => INDEX_GLOSSARY[k]?.label).join(' · ')}
                </Text>
              </View>
            )}

            <Text style={{ color: '#333', fontSize: 9, marginTop: 8, marginBottom: 16, fontStyle: 'italic' }}>
              Indicador exploratorio — requiere verificación en campo
            </Text>

            {/* Actions — primary: interpretación experta con el Ing. Villegas */}
            <TouchableOpacity
              style={styles.btnInterpret}
              activeOpacity={0.85}
              onPress={() => onInterpret(buildInterpretationContext())}
            >
              <Text style={styles.btnInterpretText}>🎓  INTERPRETACIÓN DE DATOS</Text>
            </TouchableOpacity>

            {/* Secondary compact actions, side by side */}
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={styles.btnCompact}
                onPress={() => {
                  mapRef.current?.animateToRegion({ latitude: selectedPoint.lat, longitude: selectedPoint.lng, latitudeDelta: 0.002, longitudeDelta: 0.002 }, 800);
                  onClose();
                }}
              >
                <Text style={styles.btnCompactText}>NAVEGAR</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btnCompactOutline} onPress={onSaveSample}>
                <Text style={styles.btnCompactOutlineText}>GUARDAR MUESTRA</Text>
              </TouchableOpacity>
            </View>

            <View style={{ height: 16 }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  container: {
    backgroundColor: '#000',
    borderColor: '#FFD700',
    borderWidth: 2,
    borderRadius: 20,
    padding: 20,
    width: '92%',
    maxHeight: '85%',
  },
  closeX: {
    position: 'absolute',
    top: 12,
    right: 14,
    zIndex: 10,
    padding: 4,
  },
  closeXText: { color: '#888', fontSize: 20, fontWeight: '700', lineHeight: 20 },
  header: {
    borderBottomWidth: 1,
    borderBottomColor: '#333',
    paddingBottom: 10,
    marginBottom: 14,
    paddingRight: 28,
  },
  rank: { color: '#FFD700', fontSize: 18, fontWeight: '900', letterSpacing: 0.5 },
  coords: { color: '#FFF', fontSize: 11, marginTop: 4, fontFamily: 'monospace' },
  meta: { color: '#888', fontSize: 11, marginTop: 2 },
  primaryBox: {
    backgroundColor: '#0D1A0D',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1E3A1E',
    padding: 12,
    marginBottom: 12,
  },
  metalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 9,
    paddingBottom: 9,
    borderBottomWidth: 1,
    borderBottomColor: '#151515',
  },
  // Primary action — interpretación experta
  btnInterpret: {
    backgroundColor: '#FFD700',
    height: 48,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 10,
  },
  btnInterpretText: { color: '#000', fontWeight: '900', fontSize: 15, letterSpacing: 0.3 },
  // Secondary compact actions
  actionRow: { flexDirection: 'row', gap: 10 },
  btnCompact: {
    flex: 1,
    backgroundColor: '#1A1A00',
    borderWidth: 1,
    borderColor: '#FFD700',
    height: 44,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  btnCompactText: { color: '#FFD700', fontWeight: '700', fontSize: 14 },
  btnCompactOutline: {
    flex: 1,
    backgroundColor: 'transparent',
    borderColor: '#555',
    borderWidth: 1,
    height: 44,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  btnCompactOutlineText: { color: '#CCC', fontWeight: '700', fontSize: 14 },
  idxBox: {
    backgroundColor: '#0A0A0A',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#222',
    padding: 12,
    marginBottom: 12,
  },
  idxTitle: { color: '#888', fontSize: 9, letterSpacing: 0.8, fontWeight: '700' },
  idxHint: { color: '#555', fontSize: 9, fontStyle: 'italic', marginTop: 2, marginBottom: 8 },
  idxRow: { marginBottom: 6 },
  idxLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 },
  idxLabel: { color: '#FFD700', fontSize: 13, fontWeight: '700' },
  idxVal: { color: '#CCC', fontSize: 13, fontFamily: 'monospace' },
  idxTrack: { height: 4, backgroundColor: '#1A1A1A', borderRadius: 3, overflow: 'hidden' },
  idxFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: '#FFD700', borderRadius: 3, opacity: 0.85 },
  idxDetail: { color: '#AAA', fontSize: 10, lineHeight: 14, marginTop: 5, fontStyle: 'italic' },
  idxNote: { color: '#666', fontSize: 9, marginTop: 6, lineHeight: 13 },
});

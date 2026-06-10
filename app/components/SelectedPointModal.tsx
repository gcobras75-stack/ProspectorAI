import React from 'react';
import { View, Text, Modal, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import MapView from 'react-native-maps';
import { findNearestCell, type MiningSpectralResult } from '../core/SatelliteEngine';
import { TAP_METAL_META, cellAnomalyScore, anomalyFromPct } from '../core/spectralHelpers';
import { METAL_COLORS } from './ScoreCard';

interface SelectedPointModalProps {
  selectedPoint: any;
  satelliteData: MiningSpectralResult | null;
  selectedMineral: string;
  terrainType: string;
  mapRef: React.RefObject<MapView | null>;
  onClose: () => void;
  onSaveSample: () => void;
}

export default function SelectedPointModal({
  selectedPoint, satelliteData, selectedMineral, terrainType, mapRef, onClose, onSaveSample,
}: SelectedPointModalProps) {
  if (!selectedPoint) return null;

  const BARS = 18;
  const realScore = Math.round(selectedPoint.base_score || selectedPoint.score || 0);
  const { level: primLevel, color: primColor } = anomalyFromPct(realScore);
  const nearestCell = satelliteData?.cells?.length
    ? findNearestCell(selectedPoint.lat, selectedPoint.lng, satelliteData.cells)
    : null;

  return (
    <Modal visible={!!selectedPoint} transparent animationType="slide">
      <View style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.85)' }]}>
        <View style={styles.container}>

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
              ✅ Datos Sentinel-2 reales · {satelliteData?.source_label ?? ''}
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
                    const ptBars = Math.round((score / 100) * BARS);
                    return (
                      <View key={metal} style={styles.metalRow}>
                        <Text style={{ color: meta?.color ?? '#888', fontWeight: '700', fontSize: 12, width: 80 }}>
                          {meta?.icon} {meta?.label}
                        </Text>
                        {nearestCell.masked_by_vegetation === true ? (
                          <Text style={{ color: '#FF9800', fontSize: 9, flex: 1 }}>⚠️ Vegetación — sin lectura confiable</Text>
                        ) : (
                          <>
                            <Text style={{ fontFamily: 'monospace', fontSize: 10, color: aColor, flex: 1 }}>
                              {'█'.repeat(ptBars) + '░'.repeat(BARS - ptBars)}
                            </Text>
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

            <Text style={{ color: '#333', fontSize: 9, marginTop: 8, marginBottom: 16, fontStyle: 'italic' }}>
              Indicador exploratorio — requiere verificación en campo
            </Text>

            {/* Actions */}
            <TouchableOpacity
              style={styles.btnGold}
              onPress={() => {
                mapRef.current?.animateToRegion({ latitude: selectedPoint.lat, longitude: selectedPoint.lng, latitudeDelta: 0.002, longitudeDelta: 0.002 }, 800);
                onClose();
              }}
            >
              <Text style={styles.btnBlackText}>NAVEGAR A COORDENADAS</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.btnGold, { marginBottom: 12 }]} onPress={onSaveSample}>
              <Text style={styles.btnBlackText}>GUARDAR COMO MUESTRA</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.btnOutline} onPress={onClose}>
              <Text style={{ color: '#FFD700', fontWeight: 'bold', fontSize: 14 }}>CERRAR</Text>
            </TouchableOpacity>

            <View style={{ height: 20 }} />
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
  header: {
    borderBottomWidth: 1,
    borderBottomColor: '#333',
    paddingBottom: 10,
    marginBottom: 14,
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
  btnGold: {
    backgroundColor: '#FFD700',
    minWidth: 140,
    padding: 12,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  btnBlackText: { color: '#000', fontWeight: 'bold', fontSize: 14 },
  btnOutline: {
    backgroundColor: 'transparent',
    borderColor: '#FFD700',
    borderWidth: 2,
    minWidth: 140,
    padding: 12,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
});

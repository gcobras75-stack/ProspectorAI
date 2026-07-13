import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { findNearestCell, type MiningSpectralResult } from '../core/SatelliteEngine';
import { TAP_METAL_META, cellAnomalyScore, anomalyFromPct, tapMessage } from '../core/spectralHelpers';
import { QUICK_METALS } from '../core/materialsCatalog';
import { isSaturated, hasSaturatedIndex, SATURATION_NOTICE } from '../core/saturation';
import { Colors, Radii } from '../core/theme';

interface TapPanelProps {
  tapPoint: { lat: number; lng: number };
  satelliteData: MiningSpectralResult | null;
  onClose: () => void;
}

export default function TapPanel({ tapPoint, satelliteData, onClose }: TapPanelProps) {
  const nearestCell = satelliteData?.cells?.length
    ? findNearestCell(tapPoint.lat, tapPoint.lng, satelliteData.cells)
    : null;
  const hasReal = nearestCell !== null;
  const BARS = 20;
  const [showIndices, setShowIndices] = React.useState(false);

  return (
    <View style={styles.panel}>
      {/* Header */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>📍 PUNTO TOCADO</Text>
          <Text style={{ fontSize: 10, marginTop: 2, color: hasReal ? Colors.success : Colors.warning }}>
            {hasReal
              ? `✅ Sentinel-2 real · celda a ${
                  Math.round(Math.sqrt(
                    ((nearestCell!.lat - tapPoint.lat) ** 2 + (nearestCell!.lng - tapPoint.lng) ** 2)
                  ) * 111000)
                } m`
              : '⚠️ Sin datos reales — dibuja un polígono sobre esta zona'}
          </Text>
          <Text style={{ color: Colors.textDim, fontSize: 10, marginTop: 2, fontFamily: 'monospace' }}>
            {tapPoint.lat.toFixed(6)}, {tapPoint.lng.toFixed(6)}
          </Text>
        </View>
        <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <MaterialCommunityIcons name="close" size={24} color="#FFD700" />
        </TouchableOpacity>
      </View>

      <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
        {hasReal ? (
          <>
            {QUICK_METALS.map(metal => {
              const score = cellAnomalyScore(nearestCell!, metal);
              const { level, color: aColor } = anomalyFromPct(score);
              const msg = tapMessage(score);
              const meta = TAP_METAL_META[metal];
              const ptBars = Math.round((score / 100) * BARS);
              return (
                <View key={metal} style={styles.metalRow}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8, justifyContent: 'space-between' }}>
                    <Text style={{ fontWeight: '900', fontSize: 14, color: meta?.color ?? Colors.primary, letterSpacing: 0.4 }}>
                      {meta?.icon}  {meta?.label}
                    </Text>
                    <View style={{ borderWidth: 1.5, borderColor: aColor, borderRadius: 5, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: `${aColor}22` }}>
                      <Text style={{ color: aColor, fontWeight: '900', fontSize: 11, letterSpacing: 0.5 }}>{level}</Text>
                    </View>
                  </View>
                  {nearestCell!.masked_by_vegetation === true ? (
                    <Text style={{ color: '#FF9800', fontSize: 10, marginLeft: 116 }}>⚠️ Sin lectura confiable (vegetación)</Text>
                  ) : (
                    <>
                      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 5 }}>
                        <Text style={{ fontSize: 10, color: Colors.textDim, width: 116 }}>Alteración:</Text>
                        <Text style={{ fontFamily: 'monospace', fontSize: 11, color: aColor, flex: 1 }}>
                          {'█'.repeat(ptBars) + '░'.repeat(BARS - ptBars)}
                        </Text>
                      </View>
                      <Text style={{ fontSize: 11, color: msg.color, marginLeft: 116 }}>{msg.text}</Text>
                    </>
                  )}
                </View>
              );
            })}

            {/* Raw spectral indices */}
            <TouchableOpacity onPress={() => setShowIndices(v => !v)}>
              <Text style={{ color: Colors.textDisabled, fontSize: 10, letterSpacing: 0.8, marginBottom: 6 }}>
                {showIndices ? '▼' : '▶'} Contexto mineralógico
              </Text>
            </TouchableOpacity>
            {showIndices && <View style={styles.indicesBox}>
              <Text style={{ color: Colors.textDisabled, fontSize: 9, letterSpacing: 0.8, marginBottom: 6 }}>
                DETALLE MINERALÓGICO (celda {nearestCell!.lat.toFixed(4)}, {nearestCell!.lng.toFixed(4)})
              </Text>
              {[
                // El NDVI queda fuera del chequeo de saturación: es vegetación, no
                // un índice de alteración, y su techo no significa lo mismo.
                { label: 'Óxido de hierro',        raw: nearestCell!.iron_oxide, checkSat: true  },
                { label: 'Arcillas de alteración', raw: nearestCell!.clay,       checkSat: true  },
                { label: 'Minerales ferrosos',     raw: nearestCell!.ferroso,    checkSat: true  },
                { label: 'Vegetación (NDVI)',      raw: nearestCell!.ndvi,       checkSat: false },
              ].map(({ label, raw, checkSat }) => {
                const sat = checkSat && isSaturated(raw);
                return (
                  <View key={label} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 }}>
                    <Text style={{ color: Colors.textDim, fontSize: 10 }}>{label}</Text>
                    <Text style={{ color: sat ? Colors.warning : Colors.textSub, fontSize: 10, fontFamily: 'monospace' }}>
                      {raw.toFixed(3)}{sat ? '  SATURADO' : ''}
                    </Text>
                  </View>
                );
              })}
              {hasSaturatedIndex(
                { iron_oxide: nearestCell!.iron_oxide, clay: nearestCell!.clay, ferroso: nearestCell!.ferroso },
              ) && (
                <Text style={{ color: Colors.warning, fontSize: 9, fontWeight: '700', marginTop: 4 }}>
                  ⚠️ {SATURATION_NOTICE}
                </Text>
              )}
              {nearestCell!.masked_by_vegetation && (
                <Text style={{ color: Colors.warning, fontSize: 9, marginTop: 4 }}>
                  ⚠️ Mucha vegetación — la señal mineral puede estar atenuada
                </Text>
              )}
            </View>}
            <Text style={{ color: Colors.textDisabled, fontSize: 9, marginTop: 10, fontStyle: 'italic' }}>
              Indicador exploratorio — requiere verificación en campo
            </Text>
            <View style={{ height: 14 }} />
          </>
        ) : (
          <View style={{ alignItems: 'center', paddingVertical: 28, paddingHorizontal: 16 }}>
            <Text style={{ fontSize: 28, marginBottom: 12 }}>🛰️</Text>
            <Text style={{ color: Colors.textSub, fontSize: 13, fontWeight: '700', textAlign: 'center', marginBottom: 8 }}>
              Sin datos reales en esta zona
            </Text>
            <Text style={{ color: Colors.textDim, fontSize: 11, textAlign: 'center', lineHeight: 17 }}>
              Dibuja un polígono sobre esta área y presiona{' '}
              <Text style={{ color: Colors.primary, fontWeight: '700' }}>ANALIZAR</Text>
              {' '}para ver anomalías reales de Sentinel-2.
            </Text>
            <Text style={{ color: Colors.textDisabled, fontSize: 10, textAlign: 'center', marginTop: 12, fontStyle: 'italic' }}>
              No se muestran scores sin datos satelitales reales.
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    maxHeight: '62%',
    backgroundColor: 'rgba(0,0,0,0.97)',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 2,
    borderTopColor: '#00FFFF',
    padding: 12,
    zIndex: 101,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.primary,
    paddingBottom: 8,
  },
  title: { color: Colors.primary, fontSize: 16, fontWeight: 'bold' },
  metalRow: {
    marginBottom: 14,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surface3,
  },
  indicesBox: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.sm,
    borderWidth: 1,
    borderColor: Colors.surface3,
    padding: 10,
    marginTop: 4,
  },
});

import React, { useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import MapView from 'react-native-maps';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import ScoreCard, { METAL_COLORS } from './ScoreCard';
import { MetalScore } from '../core/GeologicalEngine';
import { computeAdaptiveCellSize, type MiningSpectralResult } from '../core/SatelliteEngine';
import { Colors, Typography, Spacing, Radii, anomalyFromPct } from '../core/theme';

interface ResultsPanelProps {
  satelliteData: MiningSpectralResult | null;
  metalScores: MetalScore[];
  analysisPoints: any[];
  selectedMineral: string;
  terrainType: string;
  areaHa: string;
  mapRef: React.RefObject<MapView | null>;
  onClose: () => void;
  onNavigateTo?: (lat: number, lng: number) => void;
}

export default function ResultsPanel({
  satelliteData, metalScores, analysisPoints, selectedMineral, terrainType, areaHa, mapRef, onClose, onNavigateTo,
}: ResultsPanelProps) {
  const [legendOpen, setLegendOpen] = useState(false);
  const regionalAvg = analysisPoints.length > 0
    ? analysisPoints.reduce((s, p) => s + (p.base_score || 0), 0) / analysisPoints.length
    : undefined;
  const selMs = metalScores.find(ms => ms.metal === selectedMineral);
  const selGlobalMax = selMs?.score_maximo ?? 100;
  const csm = satelliteData
    ? (satelliteData.cell_size_m > 0 ? satelliteData.cell_size_m : computeAdaptiveCellSize(parseFloat(areaHa)))
    : 0;
  const csmLabel = csm >= 1000 ? `${csm / 1000} km` : `${csm} m`;

  return (
    <View style={styles.panel}>
      {/* Header — subtitle only */}
      <View style={styles.header}>
        <Text style={{ color: Colors.textSub, ...Typography.caption }}>
          {selectedMineral.toUpperCase()} · {terrainType.toUpperCase()}
          {analysisPoints.length > 0 ? `  ·  ${analysisPoints.length} puntos` : ''}
        </Text>
        <TouchableOpacity onPress={onClose}>
          <MaterialCommunityIcons name="close" size={24} color="#FFD700" />
        </TouchableOpacity>
      </View>

      <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={false}>

        {/* Satellite source label */}
        {satelliteData && (
          <View style={{
            backgroundColor: satelliteData.cache_age_days !== undefined && satelliteData.cache_age_days > 90
              ? '#2A2A00' : '#0A2A0A',
            borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6,
            marginHorizontal: 8, marginBottom: 8,
          }}>
            <Text style={{ fontSize: 11, color: '#DDDDDD', textAlign: 'center' }}>
              {satelliteData.source_label}
            </Text>
            {satelliteData.cache_age_days !== undefined && satelliteData.cache_age_days > 90 && (
              <Text style={{ fontSize: 10, color: '#FF9800', textAlign: 'center', marginTop: 2 }}>
                ⚠️ Datos de hace {satelliteData.cache_age_days} días — actualiza con conexión
              </Text>
            )}
          </View>
        )}

        {/* ¿Qué significa? — collapsible legend */}
        <TouchableOpacity
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 12,
            paddingVertical: 6,
            marginBottom: legendOpen ? 0 : 4,
          }}
          onPress={() => setLegendOpen(v => !v)}
          activeOpacity={0.7}
        >
          <MaterialCommunityIcons
            name={legendOpen ? 'chevron-down' : 'chevron-right'}
            size={14}
            color={Colors.textDim}
          />
          <Text style={{ color: Colors.textDim, fontSize: 12, marginLeft: 4 }}>
            ¿Qué significan estos resultados?
          </Text>
        </TouchableOpacity>

        {legendOpen && (
          <View style={{
            backgroundColor: Colors.surface3,
            marginHorizontal: 8,
            marginBottom: 8,
            borderRadius: 8,
            padding: 12,
          }}>
            {[
              { label: '🎯 OBJETIVO', desc: 'Anomalía espectral + falla geológica coinciden — máxima prioridad de campo' },
              { label: '🌈 3×', desc: 'Tres satélites (S2 + ASTER + EMIT) de acuerdo — alta confianza espectral' },
              { label: '✅ CONF.', desc: 'Dos satélites (S2 + ASTER) coinciden — buena señal, merece visita' },
              { label: 'INDIVIDUAL', desc: 'Solo una fuente detectó anomalía — explorar con precaución' },
              { label: 'ALTA ≥65%', desc: 'Alteración espectral significativa' },
              { label: 'MEDIA 35–64%', desc: 'Señal moderada' },
              { label: `Malla ${csmLabel || '60 m'}`, desc: 'Tamaño de cada cuadro del análisis espectral' },
            ].map(item => (
              <View key={item.label} style={{ flexDirection: 'row', marginBottom: 6 }}>
                <Text style={{ color: Colors.primary, fontSize: 11, fontWeight: '700', minWidth: 80 }}>
                  {item.label}
                </Text>
                <Text style={{ color: Colors.textSub, fontSize: 11, flex: 1, lineHeight: 15 }}>
                  {item.desc}
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* Primary ScoreCard — selected mineral only */}
        {metalScores.filter(ms => ms.metal === selectedMineral).map((ms) => (
          <ScoreCard
            key={ms.metal}
            metal={ms.metal}
            terrain={terrainType}
            metalLabel={ms.label}
            metalIcon={ms.icon}
            pointScore={ms.score_poligono}
            globalMax={ms.score_maximo}
            regionalAvg={regionalAvg}
            guideMineral={ms.guideMineral}
            warning={ms.warning}
          />
        ))}

        {/* Associations — other metals from the same spectral pattern */}
        {metalScores.filter(ms => ms.metal !== selectedMineral).length > 0 && (
          <View style={styles.assocBox}>
            <Text style={styles.assocTitle}>ASOCIACIONES DEL MISMO PATRÓN ESPECTRAL</Text>
            <View style={styles.assocChips}>
              {metalScores.filter(ms => ms.metal !== selectedMineral).map(ms => {
                const pct   = Math.round((ms.score_poligono / (ms.score_maximo ?? 100)) * 100);
                const anomaly = anomalyFromPct(pct);
                const col   = anomaly.color;
                return (
                  <View key={ms.metal} style={[styles.assocChip, { borderColor: col, backgroundColor: `${col}18` }]}>
                    <Text style={{ fontSize: 12 }}>{ms.icon}</Text>
                    <Text style={{ color: Colors.text, ...Typography.caption, fontWeight: '700', marginLeft: 4 }}>{ms.label}</Text>
                    <Text style={{ color: col, ...Typography.caption, fontWeight: '900', marginLeft: 4 }}>{anomaly.label}</Text>
                  </View>
                );
              })}
            </View>
            <Text style={styles.assocNote}>
              Los indicadores derivan de los mismos índices espectrales — no son mediciones independientes.
            </Text>
          </View>
        )}

        {/* Ranking */}
        {analysisPoints.length > 0 && (
          <View style={styles.rankingSection}>
            <View style={styles.rankingHeader}>
              <Text style={styles.rankingTitle}>
                ZONAS PRIORITARIAS — {selectedMineral.toUpperCase()} {terrainType.toUpperCase()}
              </Text>
            </View>
            {analysisPoints.slice(0, 20).map((p, i) => {
              const score = Math.round(p.score || p.base_score || 0);
              const pct = Math.round((score / selGlobalMax) * 100);
              const anomaly = anomalyFromPct(pct);
              const anomalyColor = anomaly.color;
              const isPriority      = p.consensus === 'PRIORITY_TARGET';
              const isTripleSpectral = p.consensus === 'TRIPLE_SPECTRAL';
              const isConfirmed     = p.consensus === 'CONFIRMED';
              const badgeColor  = isPriority ? Colors.priorityTarget : isTripleSpectral ? Colors.tripleSpectral : isConfirmed ? Colors.confirmed : anomalyColor;
              const badgeLabel  = isPriority ? 'OBJ.' : isTripleSpectral ? '\uD83C\uDF08 3\u00D7' : isConfirmed ? 'CONF.' : anomaly.label;
              const badgeSub    = isPriority ? 'S2+ASTER+Estr.' : isTripleSpectral ? 'S2+ASTER+EMIT' : isConfirmed ? 'S2+ASTER' : 'alteracion';
              return (
                <TouchableOpacity
                  key={i}
                  style={styles.rankingItem}
                  onPress={() => {
                    mapRef.current?.animateToRegion({
                      latitude: p.lat, longitude: p.lng,
                      latitudeDelta: 0.005, longitudeDelta: 0.005,
                    }, 500);
                    onNavigateTo?.(p.lat, p.lng);
                  }}
                >
                  <Text style={styles.rankingRank}>#{p.rank}</Text>
                  <View style={{ flex: 1, marginHorizontal: 10 }}>
                    <Text style={styles.rankingCoord}>{p.lat.toFixed(5)}, {p.lng.toFixed(5)}</Text>
                    <View style={styles.rankingTrack}>
                      <View style={[styles.rankingFill, { width: `${pct}%`, backgroundColor: badgeColor }]} />
                    </View>
                  </View>
                  <View style={{ alignItems: 'flex-end', minWidth: 64 }}>
                    <Text style={[styles.rankingScore, { color: badgeColor }]}>
                      {isPriority ? '\uD83C\uDFAF ' : isTripleSpectral ? '' : isConfirmed ? '\u2705 ' : ''}{badgeLabel}
                    </Text>
                    <Text style={styles.rankingPct}>{badgeSub}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        <View style={{ height: 14 }} />
      </ScrollView>
      {csm > 0 && (
        <Text style={{ color: '#333', fontSize: 9, textAlign: 'center', paddingTop: 3 }}>
          Malla {csmLabel}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    maxHeight: '58%',
    backgroundColor: 'rgba(0,0,0,0.97)',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderTopWidth: 2, borderTopColor: '#FFD700',
    padding: 12, zIndex: 100,
  },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 10, borderBottomWidth: 1, borderBottomColor: '#FFD700', paddingBottom: 8,
  },
  rankingSection: { marginTop: 4, borderTopWidth: 1, borderTopColor: '#222', paddingTop: 12 },
  rankingHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  rankingTitle: { color: Colors.primary, fontWeight: '900', ...Typography.caption, letterSpacing: 0.8, flex: 1 },
  rankingItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: Colors.surface3 },
  rankingRank: { color: Colors.primary, fontWeight: '900', fontSize: 14, width: 24 },
  rankingCoord: { color: Colors.textDim, ...Typography.micro, marginBottom: 4, fontFamily: 'monospace' },
  rankingTrack: { width: '100%', height: 5, backgroundColor: '#111', borderRadius: 3, overflow: 'hidden' },
  rankingFill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 3, opacity: 0.85 },
  rankingScore: { fontWeight: '900', ...Typography.caption },
  rankingPct: { color: Colors.textDim, ...Typography.micro, marginTop: 2 },
  assocBox: {
    backgroundColor: '#0A0A0A',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1E1E1E',
    padding: 10,
    marginBottom: 10,
  },
  assocTitle: {
    color: '#444',
    fontSize: 9,
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  assocChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  assocChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  assocNote: {
    color: '#333',
    fontSize: 9,
    marginTop: 8,
    fontStyle: 'italic',
  },
});

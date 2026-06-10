import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import MapView from 'react-native-maps';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import ScoreCard, { METAL_COLORS } from './ScoreCard';
import { MetalScore } from '../core/GeologicalEngine';
import { computeAdaptiveCellSize, type MiningSpectralResult } from '../core/SatelliteEngine';

interface ResultsPanelProps {
  satelliteData: MiningSpectralResult | null;
  metalScores: MetalScore[];
  analysisPoints: any[];
  selectedMineral: string;
  terrainType: string;
  areaHa: string;
  mapRef: React.RefObject<MapView | null>;
  onClose: () => void;
}

export default function ResultsPanel({
  satelliteData, metalScores, analysisPoints, selectedMineral, terrainType, areaHa, mapRef, onClose,
}: ResultsPanelProps) {
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
        <Text style={{ color: '#666', fontSize: 10 }}>
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

        {/* ScoreCards */}
        {metalScores.map((ms) => (
          <ScoreCard
            key={ms.metal}
            metal={ms.metal}
            terrain={terrainType}
            metalLabel={ms.label}
            metalIcon={ms.icon}
            pointScore={ms.score_poligono}
            globalMax={ms.score_maximo}
            regionalAvg={ms.metal === selectedMineral ? regionalAvg : undefined}
            guideMineral={ms.guideMineral}
            warning={ms.warning}
          />
        ))}

        {/* Ranking */}
        {analysisPoints.length > 0 && (
          <View style={styles.rankingSection}>
            <View style={styles.rankingHeader}>
              <Text style={styles.rankingTitle}>
                ZONAS PRIORITARIAS — {selectedMineral.toUpperCase()} {terrainType.toUpperCase()}
              </Text>
            </View>
            {analysisPoints.slice(0, 5).map((p, i) => {
              const score = Math.round(p.score || p.base_score || 0);
              const pct = Math.round((score / selGlobalMax) * 100);
              const anomalyLevel = pct >= 65 ? 'ALTA' : pct >= 35 ? 'MEDIA' : 'BAJA';
              const anomalyColor = pct >= 65 ? '#E53935' : pct >= 35 ? '#FFA000' : '#546E7A';
              return (
                <TouchableOpacity
                  key={i}
                  style={styles.rankingItem}
                  onPress={() => {
                    mapRef.current?.animateToRegion({
                      latitude: p.lat, longitude: p.lng,
                      latitudeDelta: 0.005, longitudeDelta: 0.005,
                    }, 500);
                  }}
                >
                  <Text style={styles.rankingRank}>#{p.rank}</Text>
                  <View style={{ flex: 1, marginHorizontal: 10 }}>
                    <Text style={styles.rankingCoord}>{p.lat.toFixed(5)}, {p.lng.toFixed(5)}</Text>
                    <View style={styles.rankingTrack}>
                      <View style={[styles.rankingFill, { width: `${pct}%`, backgroundColor: anomalyColor }]} />
                    </View>
                  </View>
                  <View style={{ alignItems: 'flex-end', minWidth: 56 }}>
                    <Text style={[styles.rankingScore, { color: anomalyColor, fontSize: 11 }]}>{anomalyLevel}</Text>
                    <Text style={styles.rankingPct}>alteración</Text>
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
  rankingTitle: { color: '#FFD700', fontWeight: '900', fontSize: 10, letterSpacing: 0.8, flex: 1 },
  rankingItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#1A1A1A' },
  rankingRank: { color: '#FFD700', fontWeight: '900', fontSize: 12, width: 24 },
  rankingCoord: { color: '#555', fontSize: 9, marginBottom: 4, fontFamily: 'monospace' },
  rankingTrack: { width: '100%', height: 5, backgroundColor: '#111', borderRadius: 3, overflow: 'hidden' },
  rankingFill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 3, opacity: 0.85 },
  rankingScore: { fontWeight: '900', fontSize: 12 },
  rankingPct: { color: '#555', fontSize: 9, marginTop: 2 },
});

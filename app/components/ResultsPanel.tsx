import React, { useState, useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Animated } from 'react-native';
import MapView from 'react-native-maps';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import ScoreCard, { METAL_COLORS } from './ScoreCard';
import { MetalScore } from '../core/GeologicalEngine';
import { computeAdaptiveCellSize, type MiningSpectralResult } from '../core/SatelliteEngine';
import { type ZoneProspectivity } from '../core/ConsensusFusion';
import { type KnownOccurrencesResult } from '../core/mrdsService';
import { Colors, Typography, Spacing, Radii, anomalyFromPct } from '../core/theme';

// Puntos de confianza: ●●●○ etc. — independientes del color (color = favorabilidad)
const confidenceDots = (label: 'ALTA' | 'MEDIA' | 'BAJA') => {
  const filled = label === 'ALTA' ? 3 : label === 'MEDIA' ? 2 : 1;
  return '●'.repeat(filled) + '○'.repeat(4 - filled);
};

interface ResultsPanelProps {
  satelliteData: MiningSpectralResult | null;
  metalScores: MetalScore[];
  analysisPoints: any[];
  zoneProspectivity?: ZoneProspectivity | null;
  knownOccurrences?: KnownOccurrencesResult | null;
  selectedMineral: string;
  terrainType: string;
  areaHa: string;
  mapRef: React.RefObject<MapView | null>;
  onClose: () => void;
  onNavigateTo?: (lat: number, lng: number) => void;
}

export default function ResultsPanel({
  satelliteData, metalScores, analysisPoints, zoneProspectivity, knownOccurrences, selectedMineral, terrainType, areaHa, mapRef, onClose, onNavigateTo,
}: ResultsPanelProps) {
  const [legendOpen, setLegendOpen] = useState(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, []);
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
    <Animated.View style={[styles.panel, { opacity: fadeAnim }]}>
      {/* Header — subtitle only */}
      <View style={styles.header}>
        <Text style={{ color: Colors.textSub, ...Typography.caption }}>
          {selectedMineral.toUpperCase()} · {terrainType.toUpperCase()}
          {analysisPoints.length > 0 ? `  ·  ${analysisPoints.length} puntos` : ''}
        </Text>
        <TouchableOpacity onPress={onClose}>
          <MaterialCommunityIcons name="close" size={24} color={Colors.primary} />
        </TouchableOpacity>
      </View>

      <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={false}>

        {/* ── TARJETA HÉROE — Favorabilidad exploratoria (SEÑAL + CONFIANZA) ── */}
        {zoneProspectivity && (
          <View style={[styles.heroCard, { borderColor: zoneProspectivity.band_color }]}>
            <View style={styles.heroTop}>
              <View style={[styles.heroRing, { borderColor: zoneProspectivity.band_color }]}>
                <Text style={[styles.heroNum, { color: zoneProspectivity.band_color }]}>{zoneProspectivity.signal}</Text>
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={[styles.heroBand, { color: zoneProspectivity.band_color }]}>{zoneProspectivity.band_label}</Text>
                <Text style={styles.heroSub}>solo {selectedMineral} · no es probabilidad de yacimiento</Text>
              </View>
            </View>

            {/* SEÑAL */}
            <View style={styles.meterRow}>
              <Text style={styles.meterLabel}>SEÑAL</Text>
              <View style={styles.meterTrack}>
                <View style={[styles.meterFill, { width: `${zoneProspectivity.signal}%`, backgroundColor: zoneProspectivity.band_color }]} />
              </View>
              <Text style={[styles.meterVal, { color: zoneProspectivity.band_color }]}>{zoneProspectivity.signal}</Text>
            </View>
            {/* CONFIANZA — puntos, color neutro (color = favorabilidad, no confianza) */}
            <View style={styles.meterRow}>
              <Text style={styles.meterLabel}>CONFIANZA</Text>
              <View style={styles.meterTrack}>
                <View style={[styles.meterFill, { width: `${zoneProspectivity.confidence}%`, backgroundColor: Colors.textSub }]} />
              </View>
              <Text style={styles.meterDots}>{confidenceDots(zoneProspectivity.confidence_label)}</Text>
            </View>

            {typeof zoneProspectivity.relative_percentile === 'number' && (
              <Text style={styles.heroRel}>
                Entre tus zonas analizadas, esta queda en el percentil {zoneProspectivity.relative_percentile}
              </Text>
            )}

            {/* POR QUÉ */}
            {(zoneProspectivity.reasons_plus.length > 0 || zoneProspectivity.reasons_minus.length > 0) && (
              <View style={styles.whyRow}>
                <View style={styles.whyCol}>
                  <Text style={styles.whyHeadPlus}>SUMA +</Text>
                  {zoneProspectivity.reasons_plus.length > 0
                    ? zoneProspectivity.reasons_plus.map((r, i) => (<Text key={i} style={styles.whyPlus}>+ {r}</Text>))
                    : <Text style={styles.whyDim}>—</Text>}
                </View>
                <View style={styles.whyCol}>
                  <Text style={styles.whyHeadMinus}>RESTA −</Text>
                  {zoneProspectivity.reasons_minus.map((r, i) => (<Text key={i} style={styles.whyMinus}>− {r}</Text>))}
                </View>
              </View>
            )}

            <Text style={styles.heroDisclaimer}>
              Indicador exploratorio — requiere verificación en campo. No indica probabilidad de yacimiento, ley ni tonelaje.
            </Text>
          </View>
        )}

        {/* ── #13 — Yacimientos conocidos (USGS MRDS, validación global) ── */}
        {knownOccurrences && (
          <View style={{ backgroundColor: 'rgba(79,195,247,0.08)', borderWidth: 1, borderColor: 'rgba(79,195,247,0.4)', borderRadius: 8, marginHorizontal: 8, marginBottom: 8, padding: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
              <MaterialCommunityIcons name="diamond-stone" size={16} color="#4FC3F7" />
              <Text style={{ color: '#4FC3F7', fontWeight: '700', fontSize: 12, marginLeft: 6, letterSpacing: 0.5 }}>YACIMIENTOS CONOCIDOS</Text>
            </View>
            {knownOccurrences.error ? (
              <Text style={{ color: Colors.textSub, fontSize: 11 }}>No se pudo consultar la base de yacimientos ({knownOccurrences.error}).</Text>
            ) : knownOccurrences.count === 0 ? (
              <Text style={{ color: Colors.textSub, fontSize: 11 }}>Sin ocurrencias documentadas en esta zona — no implica ausencia de mineral.</Text>
            ) : (
              <>
                <Text style={{ color: '#EDEDED', fontSize: 13, fontWeight: '600', marginBottom: 4 }}>
                  {knownOccurrences.count}{knownOccurrences.capped ? '+' : ''} ocurrencia{knownOccurrences.count === 1 ? '' : 's'} documentada{knownOccurrences.count === 1 ? '' : 's'} cerca
                </Text>
                {knownOccurrences.occurrences.slice(0, 5).map((o, i) => (
                  <Text key={i} style={{ color: Colors.textSub, fontSize: 11, marginBottom: 1 }} numberOfLines={1}>
                    • {o.name}{o.commodity ? ` · ${o.commodity}` : ''}{o.status ? ` · ${o.status}` : ''}
                  </Text>
                ))}
                {knownOccurrences.count > 5 && (
                  <Text style={{ color: Colors.textSub, fontSize: 11, fontStyle: 'italic' }}>…y {knownOccurrences.count - 5} más (marcadores azules en el mapa).</Text>
                )}
              </>
            )}
            <Text style={{ color: Colors.textSub, fontSize: 9.5, marginTop: 6, lineHeight: 13 }}>
              Fuente: USGS MRDS — base global, datos hasta ~2011. Fuera de EE.UU. la cobertura es la mejor disponible pero más dispersa. La ausencia de registros no implica ausencia de mineral.
            </Text>
          </View>
        )}

        {/* Satellite source label */}
        {satelliteData && (
          <View style={{
            backgroundColor: satelliteData.cache_age_days !== undefined && satelliteData.cache_age_days > 90
              ? 'rgba(255,215,0,0.06)' : 'rgba(0,200,100,0.06)',
            borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6,
            marginHorizontal: 8, marginBottom: 8,
          }}>
            <Text style={{ fontSize: 11, color: Colors.textSub, textAlign: 'center' }}>
              {satelliteData.source_label}
            </Text>
            {satelliteData.cache_age_days !== undefined && satelliteData.cache_age_days > 90 && (
              <Text style={{ fontSize: 10, color: Colors.warning, textAlign: 'center', marginTop: 2 }}>
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
              { label: 'Señal 0–100', desc: 'Intensidad de alteración espectral — NO es probabilidad de yacimiento, ley ni tonelaje' },
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
                // Metal sin proxy óptico real en S2 → no mostramos número engañoso
                if (ms.requires_deep) {
                  return (
                    <View key={ms.metal} style={[styles.assocChip, { borderColor: Colors.textSub, backgroundColor: `${Colors.textSub}14` }]}>
                      <Text style={{ fontSize: 12 }}>{ms.icon}</Text>
                      <Text style={{ color: Colors.text, ...Typography.caption, fontWeight: '700', marginLeft: 4 }}>{ms.label}</Text>
                      <Text style={{ color: Colors.textSub, ...Typography.caption, fontWeight: '800', marginLeft: 4 }}>Requiere ASTER/EMIT</Text>
                    </View>
                  );
                }
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
            <Text style={{ color: Colors.textDim, fontSize: 11, paddingHorizontal: 2, marginBottom: 8, lineHeight: 15 }}>
              Señal espectral 0–100 — no es probabilidad de yacimiento. Toca un punto para ver sus índices.
            </Text>
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
        <Text style={{ color: Colors.textDisabled, fontSize: 9, textAlign: 'center', paddingTop: 3 }}>
          Malla {csmLabel}
        </Text>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    maxHeight: '58%',
    backgroundColor: 'rgba(0,0,0,0.97)',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderTopWidth: 2, borderTopColor: Colors.primary,
    padding: 12, zIndex: 100,
  },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 10, borderBottomWidth: 1, borderBottomColor: Colors.primary, paddingBottom: 8,
  },
  // ── Tarjeta héroe — Favorabilidad exploratoria ──
  heroCard: {
    backgroundColor: Colors.surface2,
    borderWidth: 1.5,
    borderRadius: Radii.lg,
    padding: 12,
    marginHorizontal: 8,
    marginBottom: 10,
  },
  heroTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  heroRing: {
    width: 64, height: 64, borderRadius: 32, borderWidth: 3,
    alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bg,
  },
  heroNum: { fontSize: 24, fontWeight: '900' },
  heroBand: { ...Typography.title, fontWeight: '900' },
  heroSub: { color: Colors.textSub, ...Typography.caption, marginTop: 2 },
  meterRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  meterLabel: { color: Colors.textSub, ...Typography.caption, fontWeight: '700', width: 78 },
  meterTrack: { flex: 1, height: 8, backgroundColor: Colors.surface, borderRadius: 4, overflow: 'hidden', marginHorizontal: 8 },
  meterFill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 4 },
  meterVal: { ...Typography.bodyBold, fontWeight: '900', minWidth: 28, textAlign: 'right' },
  meterDots: { color: Colors.text, fontSize: 14, letterSpacing: 2, minWidth: 52, textAlign: 'right' },
  heroRel: { color: Colors.textSub, ...Typography.caption, marginTop: 10, fontStyle: 'italic' },
  whyRow: { flexDirection: 'row', marginTop: 12, borderTopWidth: 1, borderTopColor: Colors.surface3, paddingTop: 10 },
  whyCol: { flex: 1, paddingRight: 6 },
  whyHeadPlus: { color: Colors.confirmed, fontSize: 10, fontWeight: '900', letterSpacing: 0.8, marginBottom: 4 },
  whyHeadMinus: { color: Colors.warning, fontSize: 10, fontWeight: '900', letterSpacing: 0.8, marginBottom: 4 },
  whyPlus: { color: Colors.text, fontSize: 11, lineHeight: 16, marginBottom: 3 },
  whyMinus: { color: Colors.textSub, fontSize: 11, lineHeight: 16, marginBottom: 3 },
  whyDim: { color: Colors.textDim, fontSize: 11 },
  heroDisclaimer: { color: Colors.textDim, fontSize: 10, lineHeight: 14, marginTop: 12, fontStyle: 'italic' },
  rankingSection: { marginTop: 4, borderTopWidth: 1, borderTopColor: Colors.surface3, paddingTop: 12 },
  rankingHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  rankingTitle: { color: Colors.primary, fontWeight: '900', ...Typography.caption, letterSpacing: 0.8, flex: 1 },
  rankingItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: Colors.surface3 },
  rankingRank: { color: Colors.primary, fontWeight: '900', fontSize: 14, width: 24 },
  rankingCoord: { color: Colors.textDim, ...Typography.micro, marginBottom: 4, fontFamily: 'monospace' },
  rankingTrack: { width: '100%', height: 5, backgroundColor: Colors.surface2, borderRadius: 3, overflow: 'hidden' },
  rankingFill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 3, opacity: 0.85 },
  rankingScore: { fontWeight: '900', ...Typography.caption },
  rankingPct: { color: Colors.textDim, ...Typography.micro, marginTop: 2 },
  assocBox: {
    backgroundColor: Colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.surface3,
    padding: 10,
    marginBottom: 10,
  },
  assocTitle: {
    color: Colors.textDisabled,
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
    color: Colors.textDisabled,
    fontSize: 9,
    marginTop: 8,
    fontStyle: 'italic',
  },
});

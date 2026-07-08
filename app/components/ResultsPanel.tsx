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
import { buildPointInterpretationContext } from '../core/pointInterpretation';

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
  onInterpret?: (context: string) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export default function ResultsPanel({
  satelliteData, metalScores, analysisPoints, zoneProspectivity, knownOccurrences, selectedMineral, terrainType, areaHa, mapRef, onClose, onNavigateTo, onInterpret, collapsed, onToggleCollapsed,
}: ResultsPanelProps) {
  const [legendOpen, setLegendOpen] = useState(false);
  const [techOpen, setTechOpen] = useState(false);
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

  // ── NIVEL 1 — resumen en lenguaje llano (minero no técnico, 5 segundos) ──────
  const pointScore = (p: any): number => Math.round(p.score || p.base_score || 0);
  const signalWord = (p: any): string => {
    const s = pointScore(p);
    return s >= 65 ? 'FUERTE' : s >= 35 ? 'MEDIA' : 'DÉBIL';
  };
  const nSats = (p: any): number =>
    Array.isArray(p.supportedBy) && p.supportedBy.length > 0
      ? p.supportedBy.length
      : p.consensus === 'TRIPLE_SPECTRAL' ? 3
      : (p.consensus === 'CONFIRMED' || p.consensus === 'PRIORITY_TARGET') ? 2
      : 1;
  // "¿bueno o malo?" — una línea de evidencia en palabras llanas, sin sensores crudos
  const evidenceLine = (p: any): string => {
    let base: string;
    if (p.consensus === 'PRIORITY_TARGET') {
      base = '🎯 Objetivo prioritario · 2 satélites + falla coinciden';
    } else {
      const n = nSats(p);
      base = n >= 3 ? '✓✓✓ 3 satélites coinciden'
        : n === 2 ? '✓✓ 2 satélites coinciden'
        : '1 satélite detectó señal';
      if (p.near_lineament) base += ' · sobre una posible falla';
    }
    return base;
  };
  const strongCount = analysisPoints.filter(
    p => ['PRIORITY_TARGET', 'TRIPLE_SPECTRAL', 'CONFIRMED'].includes(p.consensus) || pointScore(p) >= 65
  ).length;
  const vegPct = zoneProspectivity?.vegetation_pct ?? 0;
  const nPts = analysisPoints.length;
  const verdict = strongCount >= 1
    ? `🎯 Zona prometedora: ${strongCount} punto${strongCount > 1 ? 's' : ''} de alta prioridad para revisar`
    : vegPct > 50
    ? `🌿 Zona mayormente cubierta de vegetación · ${nPts} punto${nPts !== 1 ? 's' : ''} a revisar con cautela`
    : `📊 Señal moderada · empieza por los ${Math.min(3, nPts)} mejores puntos`;
  const top3 = analysisPoints.slice(0, 3);

  const goToPoint = (p: any) => {
    mapRef.current?.animateToRegion({ latitude: p.lat, longitude: p.lng, latitudeDelta: 0.005, longitudeDelta: 0.005 }, 500);
    onNavigateTo?.(p.lat, p.lng);
  };
  const interpretPoint = (p: any) => {
    onInterpret?.(buildPointInterpretationContext(p, { selectedMineral, terrainType, allPoints: analysisPoints, satelliteData }));
  };
  const verdictIcon = strongCount >= 1 ? '🎯' : vegPct > 50 ? '🌿' : '📊';

  // ── Modo COLAPSADO: barra compacta inferior que no tapa el mapa ──
  if (collapsed) {
    return (
      <TouchableOpacity style={styles.collapsedBar} activeOpacity={0.85} onPress={onToggleCollapsed}>
        <Text style={styles.collapsedText} numberOfLines={1}>
          {verdictIcon}  {selectedMineral} · {terrainType} — {nPts} punto{nPts !== 1 ? 's' : ''}
        </Text>
        <Text style={styles.collapsedChevron}>▲ ver</Text>
      </TouchableOpacity>
    );
  }

  return (
    <Animated.View style={[styles.panel, { opacity: fadeAnim }]}>
      {/* Header — subtitle only */}
      <View style={styles.header}>
        <Text style={{ color: Colors.textSub, ...Typography.caption }}>
          {selectedMineral.toUpperCase()} · {terrainType.toUpperCase()}
          {analysisPoints.length > 0 ? `  ·  ${analysisPoints.length} puntos` : ''}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <TouchableOpacity onPress={onToggleCollapsed} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <MaterialCommunityIcons name="chevron-down" size={26} color={Colors.textSub} />
          </TouchableOpacity>
          <TouchableOpacity onPress={onClose}>
            <MaterialCommunityIcons name="close" size={24} color={Colors.primary} />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={false}>

        {/* ═══════════ NIVEL 1 — Resumen en lenguaje llano ═══════════ */}
        {nPts > 0 && (
          <View style={styles.n1}>
            {/* (1) ¿Qué encontré? — veredicto en una frase */}
            <Text style={styles.verdict}>{verdict}</Text>

            {/* (2) ¿Bueno o malo? — los 3 mejores puntos, un semáforo cada uno */}
            {top3.map((p, i) => {
              const word = signalWord(p);
              const dotColor = word === 'FUERTE' ? Colors.anomalyHigh : word === 'MEDIA' ? Colors.anomalyMed : Colors.anomalyLow;
              return (
                <View key={i} style={styles.simpleCard}>
                  <View style={styles.simpleTop}>
                    <Text style={[styles.simpleDot, { color: dotColor }]}>●</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.simpleTitle}>
                        #{p.rank ?? i + 1} — Señal <Text style={{ color: dotColor, fontWeight: '900' }}>{word}</Text> de minerales alterados
                      </Text>
                      <Text style={styles.simpleSub}>{evidenceLine(p)}</Text>
                    </View>
                  </View>
                  {/* (3) ¿A dónde voy? — acciones directas, máx. 1 tap */}
                  <View style={styles.simpleActions}>
                    <TouchableOpacity style={styles.n1BtnMap} onPress={() => goToPoint(p)} activeOpacity={0.85}>
                      <Text style={styles.n1BtnMapText}>📍 Ver en el mapa</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.n1BtnInterp} onPress={() => interpretPoint(p)} activeOpacity={0.85}>
                      <Text style={styles.n1BtnInterpText}>🎓 Interpretación</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}

            <Text style={styles.n1Disclaimer}>
              Señal espectral exploratoria — requiere verificación en campo. No indica ley ni tonelaje.
            </Text>
          </View>
        )}

        {/* Toggle NIVEL 2 — datos técnicos plegados */}
        <TouchableOpacity style={styles.techToggle} onPress={() => setTechOpen(v => !v)} activeOpacity={0.7}>
          <MaterialCommunityIcons name={techOpen ? 'chevron-down' : 'chevron-right'} size={18} color={Colors.primary} />
          <Text style={styles.techToggleText}>Ver datos técnicos {techOpen ? '▴' : '▾'}</Text>
        </TouchableOpacity>

        {techOpen && (<>

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
                      <Text style={{ color: Colors.textSub, ...Typography.caption, fontWeight: '800', marginLeft: 4 }}>Necesita análisis profundo</Text>
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
              const badgeSub    = isPriority ? '2 satélites + falla' : isTripleSpectral ? '3 satélites ✓✓✓' : isConfirmed ? '2 satélites ✓✓' : 'alteración';
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

        </>)}

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
  // Barra compacta (panel colapsado)
  collapsedBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: 'rgba(0,0,0,0.97)',
    borderTopLeftRadius: 16, borderTopRightRadius: 16,
    borderTopWidth: 2, borderTopColor: Colors.primary,
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 22, zIndex: 100,
  },
  collapsedText: { color: Colors.text, fontSize: 15, fontWeight: '800', flex: 1 },
  collapsedChevron: { color: Colors.primary, fontSize: 13, fontWeight: '700', marginLeft: 10 },
  // ── NIVEL 1 — resumen llano ──
  n1: { marginHorizontal: 4, marginBottom: 6 },
  verdict: { color: Colors.text, fontSize: 16, fontWeight: '900', lineHeight: 22, marginBottom: 12 },
  simpleCard: {
    backgroundColor: Colors.surface2,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.surface4,
    padding: 12,
    marginBottom: 10,
  },
  simpleTop: { flexDirection: 'row', alignItems: 'center' },
  simpleDot: { fontSize: 22, marginRight: 10 },
  simpleTitle: { color: Colors.text, fontSize: 14, fontWeight: '700', lineHeight: 19 },
  simpleSub: { color: Colors.textSub, fontSize: 12.5, marginTop: 3, lineHeight: 17 },
  simpleActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  n1BtnMap: {
    flex: 1, height: 42, borderRadius: 8,
    backgroundColor: Colors.surface3, borderWidth: 1, borderColor: Colors.surface4,
    justifyContent: 'center', alignItems: 'center',
  },
  n1BtnMapText: { color: Colors.text, fontWeight: '700', fontSize: 13.5 },
  n1BtnInterp: {
    flex: 1, height: 42, borderRadius: 8,
    backgroundColor: Colors.primary,
    justifyContent: 'center', alignItems: 'center',
  },
  n1BtnInterpText: { color: '#000', fontWeight: '900', fontSize: 13.5 },
  n1Disclaimer: { color: Colors.textDim, fontSize: 10.5, lineHeight: 14, marginTop: 2, marginBottom: 4, fontStyle: 'italic' },
  techToggle: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 4, paddingVertical: 10,
    borderTopWidth: 1, borderTopColor: Colors.surface3,
    marginTop: 2,
  },
  techToggleText: { color: Colors.primary, fontSize: 13, fontWeight: '700', marginLeft: 4, letterSpacing: 0.3 },
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

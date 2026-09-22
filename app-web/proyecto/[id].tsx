/**
 * proyecto/[id].tsx — detalle de un proyecto (lectura): mapa Leaflet + ResultsPanel.
 *
 * ResultsPanel y ScoreCard son los MISMOS componentes de la app nativa (mismo techo de
 * evidencia, mismas etiquetas de confianza): no se reimplementa ninguna lógica de score.
 * Lo que la PWA no guarda (satelliteData crudo, térmico) se pasa
 * como null y el panel ya lo maneja; nada se inventa para rellenarlo.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, useWindowDimensions } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import ResultsPanel from '../../app/components/ResultsPanel';
import { SAFE_BOTTOM } from '../../web-lib/safeArea';
import VillegasButton from '../../web-lib/VillegasButton';
import ValidationSheet from '../../web-lib/ValidationSheet';
import { listPairs, savePair, removePair } from '../../web-lib/validationStore';
import { pointKey, type PairView, type Verdict } from '../../web-lib/validationPairs';
import { computeAllMetalScores, type MetalScore } from '../../app/core/GeologicalEngine';
import { loadWebProject, loadWebSamples, type WebProject, type WebSample } from '../../app/core/webData';
import LeafletMap, { type MapHandle } from '../../web-lib/LeafletMap';
import { fetchKnownOccurrences, type KnownOccurrencesResult } from '../../app/core/mrdsService';
import { setSelectedProjectId, setPendingInterpretation } from '../../web-lib/selection';

export default function ProyectoWeb() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [project, setProject] = useState<WebProject | null>(null);
  const [samples, setSamples] = useState<WebSample[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState(width < 700); // en móvil el mapa manda; el panel se abre con un toque
  const mapHandle = useRef<MapHandle>(null);
  const [occurrences, setOccurrences] = useState<KnownOccurrencesResult | null>(null);
  // Validación en campo (pares predicción-realidad que el usuario marca). Solo se registra: no ajusta el análisis.
  const [validations, setValidations] = useState<Record<string, PairView>>({});
  const [sheetPoint, setSheetPoint] = useState<any | null>(null);

  useEffect(() => {
    let alive = true;
    if (!id) return;
    setStatus('loading');
    (async () => {
      try {
        const [p, s] = await Promise.all([loadWebProject(String(id)), loadWebSamples(String(id))]);
        if (!alive) return;
        if (!p) { setStatus('missing'); return; }
        setProject(p); setSamples(s); setStatus('ready');
        setSelectedProjectId(p.id); // el chat del Geólogo parte de este proyecto
      } catch (e: any) {
        if (alive) { setError(e?.message || 'No se pudo abrir el proyecto.'); setStatus('error'); }
      }
    })();
    return () => { alive = false; };
  }, [id]);

  const points = project?.analisis_resultado ?? [];

  // Veredictos ya guardados de este proyecto. Si falla la lectura, el detalle sigue funcionando (sin insignias).
  useEffect(() => {
    setValidations({});
    if (!project?.id) return;
    let alive = true;
    listPairs(project.id).then((v) => { if (alive) setValidations(v); }).catch(() => { /* sin insignias; no rompe el detalle */ });
    return () => { alive = false; };
  }, [project?.id]);

  const validationKey = useCallback((p: any) => pointKey(p.lat, p.lng), []);
  const onValidate = useCallback((p: any) => setSheetPoint(p), []);
  const sheetExisting = (() => { try { return sheetPoint ? validations[pointKey(sheetPoint.lat, sheetPoint.lng)] : undefined; } catch { return undefined; } })();
  const saveValidation = useCallback(async (verdict: Verdict, comment: string) => {
    if (!project || !sheetPoint) return;
    const view = await savePair(project as any, sheetPoint, verdict, comment);
    setValidations((v) => ({ ...v, [pointKey(sheetPoint.lat, sheetPoint.lng)]: view }));
  }, [project, sheetPoint]);
  const removeValidation = useCallback(async () => {
    if (!project || !sheetPoint) return;
    await removePair(project as any, sheetPoint);
    setValidations((v) => { const n = { ...v }; delete n[pointKey(sheetPoint.lat, sheetPoint.lng)]; return n; });
  }, [project, sheetPoint]);

  // Yacimientos conocidos (USGS MRDS) alrededor de la zona. En segundo plano: nunca bloquea ni rompe
  // el detalle (si falla, el panel lo dice; no se confunde con "0 yacimientos").
  useEffect(() => {
    setOccurrences(null);
    const vs = (project?.coordenadas ?? []).filter((v: any) => Number.isFinite(v?.latitude) && Number.isFinite(v?.longitude));
    if (vs.length === 0) return;
    let alive = true;
    const lats = vs.map((v: any) => v.latitude), lngs = vs.map((v: any) => v.longitude);
    fetchKnownOccurrences({ latMin: Math.min(...lats), latMax: Math.max(...lats), lngMin: Math.min(...lngs), lngMax: Math.max(...lngs) })
      .then((r) => { if (alive) setOccurrences(r); })
      .catch(() => { /* MRDS no debe romper el detalle */ });
    return () => { alive = false; };
  }, [project?.id]);

  // Mismo cálculo que la app nativa sobre los puntos guardados. Si un análisis viejo no trae
  // índices, no hay tarjetas de metal (no se fabrican).
  const metalScores: MetalScore[] = useMemo(() => {
    if (!project || points.length === 0) return [];
    try { return computeAllMetalScores(points, project.terrain); } catch { return []; }
  }, [project, points]);

  // ResultsPanel espera un ref tipo MapView: este shim responde animateToRegion con Leaflet.
  const mapRefShim = useMemo(() => ({
    current: {
      animateToRegion: (r: { latitude: number; longitude: number }) => mapHandle.current?.flyTo(r.latitude, r.longitude, 16),
    },
  }), []);

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back(); else router.replace('/(tabs)/proyectos' as any);
  }, [router]);

  // dismissTo VUELVE a la pestaña Geólogo ya montada (con su conversación); navigate apilaba una copia nueva de las pestañas.
  // Auditoría de usabilidad (2026-09-21): si la hoja "Validar en campo" está abierta (nota a medio escribir),
  // salir al chat la cierra sin guardar nada; se confirma antes (mismo criterio que "Ir al chat" en Nuevo análisis).
  const openChat = useCallback(() => {
    if (sheetPoint && typeof window !== 'undefined' && !window.confirm('Tienes una validación de campo sin guardar. ¿Salir de todos modos?')) return;
    router.dismissTo('/(tabs)/geologo' as any);
  }, [router, sheetPoint]);

  const onInterpret = useCallback((ctx: string) => {
    setPendingInterpretation(ctx, project?.id ?? null);
    openChat();
  }, [openChat, project?.id]);

  return (
    <View style={s.root}>
      <View style={s.head}>
        <TouchableOpacity onPress={goBack} style={s.back} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={s.backText}>‹ Proyectos</Text>
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 8 }}>
          <Text style={s.title} numberOfLines={1}>{project?.nombre ?? 'Proyecto'}</Text>
          {project && (
            <Text style={s.sub} numberOfLines={1}>
              {[project.mineral, project.terrain, project.area_ha ? `${project.area_ha} ha` : '', project.acquisition_date, project.analysis_meta?.ranking_ia === false ? 'análisis web · sin ranking IA' : ''].filter(Boolean).join(' · ')}
            </Text>
          )}
          {project?.analysis_meta?.origen === 'pwa' && (
            <Text style={s.src} numberOfLines={2}>
              Fuentes: {[
                project.analysis_meta.fuentes?.s2 && 'Sentinel-2', project.analysis_meta.fuentes?.aster && 'ASTER',
                project.analysis_meta.fuentes?.emit && 'EMIT', project.analysis_meta.fuentes?.s1 && 'Sentinel-1/DEM',
                project.analysis_meta.fuentes?.thermal && 'Térmico',
              ].filter(Boolean).join(' · ')}
              {(project.analysis_meta.notas ?? []).length > 0 ? `  ·  ${project.analysis_meta.notas.join(' ')}` : ''}
            </Text>
          )}
        </View>
        <VillegasButton onPress={openChat} />
      </View>

      {status === 'loading' && <ActivityIndicator color="#FFD700" style={{ marginTop: 32 }} />}
      {status === 'missing' && <Text style={s.msg}>Este proyecto no existe o no está sincronizado en tu cuenta.</Text>}
      {status === 'error' && <Text style={[s.msg, { color: '#FF6B6B' }]}>{error}</Text>}

      {status === 'ready' && project && (
        <View style={s.body}>
          {/* zIndex 0 aísla los panes de Leaflet (z-index hasta 1000) para que el panel quede encima */}
          <View style={[StyleSheet.absoluteFill, { zIndex: 0 }]}>
            <LeafletMap ref={mapHandle} vertices={project.coordenadas} points={points} samples={samples} occurrences={occurrences?.occurrences} />
          </View>

          {points.length === 0 ? (
            <View style={s.banner}>
              <Text style={s.bannerText}>
                Este proyecto no tiene celdas analizadas. Para correr un análisis, dibuja una zona en Proyectos → ＋ Nuevo análisis (crea un proyecto nuevo).
              </Text>
            </View>
          ) : (
            <ResultsPanel
              satelliteData={null}
              metalScores={metalScores}
              analysisPoints={points}
              zoneProspectivity={project.prospectivity}
              knownOccurrences={occurrences}
              selectedMineral={project.mineral}
              terrainType={project.terrain}
              areaHa={String(project.area_ha || '')}
              thermalData={null}
              rockType={project.rock_type}
              rockSource={project.rock_source as any}
              rockProposal={null}
              mapRef={mapRefShim as any}
              onClose={() => setCollapsed(true)}
              collapsed={collapsed}
              onToggleCollapsed={() => setCollapsed((c) => !c)}
              onInterpret={onInterpret}
              onValidate={onValidate}
              validations={validations}
              validationKey={validationKey}
            />
          )}
          <ValidationSheet
            point={sheetPoint} existing={sheetExisting}
            onClose={() => setSheetPoint(null)} onSave={saveValidation} onRemove={removeValidation}
          />
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000', paddingBottom: SAFE_BOTTOM as any },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderBottomColor: '#1E1E1E', borderBottomWidth: 1 },
  back: { paddingVertical: 4, paddingRight: 6 },
  backText: { color: '#FFD700', fontSize: 16, fontWeight: '700' },
  title: { color: '#FFF', fontSize: 17, fontWeight: '800' },
  sub: { color: '#888', fontSize: 12, marginTop: 1 },
  src: { color: '#6F6F6F', fontSize: 11, marginTop: 2 },
  msg: { color: '#AAA', padding: 20, fontSize: 14 },
  body: { flex: 1 },
  banner: { position: 'absolute', left: 12, right: 12, bottom: 16, backgroundColor: 'rgba(0,0,0,0.9)', borderColor: '#FFD70066', borderWidth: 1, borderRadius: 12, padding: 12, zIndex: 100 },
  bannerText: { color: '#DDD', fontSize: 13, lineHeight: 19 },
});

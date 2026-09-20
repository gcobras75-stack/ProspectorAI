/**
 * proyecto/[id].tsx — detalle de un proyecto (solo lectura): mapa Leaflet + ResultsPanel.
 *
 * ResultsPanel y ScoreCard son los MISMOS componentes de la app nativa (mismo techo de
 * evidencia, mismas etiquetas de confianza): no se reimplementa ninguna lógica de score.
 * Lo que la PWA no tiene (satelliteData crudo, yacimientos MRDS en vivo, térmico) se pasa
 * como null y el panel ya lo maneja; nada se inventa para rellenarlo.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, useWindowDimensions } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import ResultsPanel from '../../app/components/ResultsPanel';
import { computeAllMetalScores, type MetalScore } from '../../app/core/GeologicalEngine';
import { loadWebProject, loadWebSamples, type WebProject, type WebSample } from '../../app/core/webData';
import LeafletMap, { type MapHandle } from '../../web-lib/LeafletMap';
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

  const onInterpret = useCallback((ctx: string) => {
    setPendingInterpretation(ctx);
    router.navigate('/(tabs)/geologo' as any);
  }, [router]);

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
        </View>
      </View>

      {status === 'loading' && <ActivityIndicator color="#FFD700" style={{ marginTop: 32 }} />}
      {status === 'missing' && <Text style={s.msg}>Este proyecto no existe o no está sincronizado en tu cuenta.</Text>}
      {status === 'error' && <Text style={[s.msg, { color: '#FF6B6B' }]}>{error}</Text>}

      {status === 'ready' && project && (
        <View style={s.body}>
          {/* zIndex 0 aísla los panes de Leaflet (z-index hasta 1000) para que el panel quede encima */}
          <View style={[StyleSheet.absoluteFill, { zIndex: 0 }]}>
            <LeafletMap ref={mapHandle} vertices={project.coordenadas} points={points} samples={samples} />
          </View>

          {points.length === 0 ? (
            <View style={s.banner}>
              <Text style={s.bannerText}>
                Este proyecto no tiene celdas analizadas. Los análisis se corren en la app nativa.
              </Text>
            </View>
          ) : (
            <ResultsPanel
              satelliteData={null}
              metalScores={metalScores}
              analysisPoints={points}
              zoneProspectivity={project.prospectivity}
              knownOccurrences={null}
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
            />
          )}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderBottomColor: '#1E1E1E', borderBottomWidth: 1 },
  back: { paddingVertical: 4, paddingRight: 6 },
  backText: { color: '#FFD700', fontSize: 16, fontWeight: '700' },
  title: { color: '#FFF', fontSize: 17, fontWeight: '800' },
  sub: { color: '#888', fontSize: 12, marginTop: 1 },
  msg: { color: '#AAA', padding: 20, fontSize: 14 },
  body: { flex: 1 },
  banner: { position: 'absolute', left: 12, right: 12, bottom: 16, backgroundColor: 'rgba(0,0,0,0.9)', borderColor: '#FFD70066', borderWidth: 1, borderRadius: 12, padding: 12, zIndex: 100 },
  bannerText: { color: '#DDD', fontSize: 13, lineHeight: 19 },
});

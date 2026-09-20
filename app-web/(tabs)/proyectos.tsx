/**
 * proyectos.web.tsx — lista de proyectos (solo lectura) de la PWA.
 *
 * SPIKE: lista + resumen del proyecto elegido para comprobar que la lectura de
 * Supabase (webData.ts) funciona. La UI final (ResultsPanel, mapa) llega después.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { useAuth } from '../../app/core/AuthContext';
import { setSelectedProjectId } from '../../web-lib/selection';
import {
  listWebProjects, loadWebProject, loadWebSamples,
  type WebProjectSummary, type WebProject, type WebSample,
} from '../../app/core/webData';

export default function ProyectosWeb() {
  const { session, signOut } = useAuth();
  const [projects, setProjects] = useState<WebProjectSummary[] | null>(null);
  const [error, setError] = useState('');
  const [sel, setSel] = useState<{ p: WebProject; samples: WebSample[] } | null>(null);
  const [loadingSel, setLoadingSel] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try { setProjects(await listWebProjects()); }
    catch (e: any) { setError(e?.message || 'No se pudieron cargar los proyectos.'); setProjects([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const open = async (id: string) => {
    setLoadingSel(true); setError('');
    setSelectedProjectId(id); // el chat del Geólogo parte de este proyecto
    try {
      const [p, samples] = await Promise.all([loadWebProject(id), loadWebSamples(id)]);
      setSel(p ? { p, samples } : null);
    } catch (e: any) { setError(e?.message || 'No se pudo abrir el proyecto.'); }
    finally { setLoadingSel(false); }
  };

  return (
    <ScrollView style={s.root} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
      <View style={s.head}>
        <Text style={s.title}>Proyectos</Text>
        <TouchableOpacity onPress={signOut}><Text style={s.link}>Salir</Text></TouchableOpacity>
      </View>
      <Text style={s.muted}>{session?.user?.email}</Text>

      {!!error && <Text style={s.error}>{error}</Text>}
      {projects === null && <ActivityIndicator color="#FFD700" style={{ marginTop: 24 }} />}
      {projects?.length === 0 && !error && <Text style={s.muted}>Sin proyectos sincronizados en esta cuenta.</Text>}

      {projects?.map((p) => (
        <TouchableOpacity key={p.id} style={s.card} onPress={() => open(p.id)}>
          <Text style={s.cardTitle}>{p.nombre}</Text>
          <Text style={s.muted}>
            {[p.mineral, p.terrain, p.area_ha ? `${p.area_ha} ha` : '', p.acquisition_date].filter(Boolean).join(' · ')}
          </Text>
        </TouchableOpacity>
      ))}

      {loadingSel && <ActivityIndicator color="#FFD700" style={{ marginTop: 24 }} />}
      {sel && !loadingSel && (
        <View style={[s.card, { borderColor: '#FFD700' }]}>
          <Text style={s.cardTitle}>{sel.p.nombre}</Text>
          <Text style={s.row}>Celdas analizadas: {sel.p.analisis_resultado.length}</Text>
          <Text style={s.row}>Vértices del polígono: {sel.p.coordenadas.length}</Text>
          <Text style={s.row}>Muestras: {sel.samples.length}</Text>
          <Text style={s.row}>Tipo de roca: {sel.p.rock_type} ({sel.p.rock_source})</Text>
          <Text style={s.row}>Mensajes de chat guardados: {sel.p.chat_history.length}</Text>
          {sel.p.analisis_resultado[0] && (
            <Text style={s.mono}>Primera celda: {JSON.stringify(sel.p.analisis_resultado[0]).slice(0, 300)}…</Text>
          )}
        </View>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: '#FFD700', fontSize: 24, fontWeight: '800' },
  link: { color: '#AAA', fontSize: 14 },
  muted: { color: '#888', fontSize: 13, marginTop: 4 },
  error: { color: '#FF6B6B', marginTop: 12 },
  card: { backgroundColor: '#111', borderColor: '#2A2A2A', borderWidth: 1, borderRadius: 12, padding: 14, marginTop: 12 },
  cardTitle: { color: '#FFF', fontSize: 16, fontWeight: '700' },
  row: { color: '#DDD', fontSize: 14, marginTop: 6 },
  mono: { color: '#777', fontSize: 11, marginTop: 10, fontFamily: 'monospace' },
});

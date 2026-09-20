/**
 * proyectos.tsx (PWA) — lista de proyectos de la cuenta y acceso a "Nuevo análisis". Al tocar uno abre
 * el detalle (mapa + resultados) en /proyecto/[id]. La lista es ligera: no descarga las
 * celdas analizadas; eso lo hace el detalle.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet, RefreshControl } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAuth } from '../../app/core/AuthContext';
import { listWebProjects, type WebProjectSummary } from '../../app/core/webData';
import { setSelectedProjectId } from '../../web-lib/selection';

export default function ProyectosWeb() {
  const { session, signOut } = useAuth();
  const router = useRouter();
  const [projects, setProjects] = useState<WebProjectSummary[] | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try { setProjects(await listWebProjects()); }
    catch (e: any) { setError(e?.message || 'No se pudieron cargar los proyectos.'); setProjects((p) => p ?? []); }
  }, []);

  // Refresca al volver a la pestaña: lo que se sincronizó desde la app aparece sin recargar.
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const open = (id: string) => {
    setSelectedProjectId(id);
    router.push(`/proyecto/${id}` as any);
  };

  return (
    <ScrollView
      style={s.root} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor="#FFD700" onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
    >
      <View style={s.head}>
        <Text style={s.title}>Proyectos</Text>
        <TouchableOpacity onPress={signOut} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}><Text style={s.link}>Salir</Text></TouchableOpacity>
      </View>
      <Text style={s.muted}>{session?.user?.email}</Text>

      <TouchableOpacity style={s.newBtn} onPress={() => router.push('/analisis/nuevo' as any)} activeOpacity={0.85}>
        <Text style={s.newBtnText}>＋ Nuevo análisis</Text>
      </TouchableOpacity>

      {!!error && <Text style={s.error}>{error}</Text>}
      {projects === null && <ActivityIndicator color="#FFD700" style={{ marginTop: 24 }} />}
      {projects?.length === 0 && !error && <Text style={s.muted}>Sin proyectos sincronizados en esta cuenta.</Text>}

      {projects?.map((p) => (
        <TouchableOpacity key={p.id} style={s.card} onPress={() => open(p.id)} activeOpacity={0.8}>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>{p.nombre}</Text>
            <Text style={s.muted}>
              {[p.mineral, p.terrain, p.area_ha ? `${p.area_ha} ha` : '', p.acquisition_date].filter(Boolean).join(' · ')}
            </Text>
          </View>
          <Text style={s.chev}>›</Text>
        </TouchableOpacity>
      ))}
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
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#111', borderColor: '#2A2A2A', borderWidth: 1, borderRadius: 12, padding: 14, marginTop: 12 },
  cardTitle: { color: '#FFF', fontSize: 16, fontWeight: '700' },
  chev: { color: '#FFD700', fontSize: 26, marginLeft: 8 },
  newBtn: { backgroundColor: '#FFD700', borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 14 },
  newBtnText: { color: '#000', fontWeight: '800', fontSize: 16 },
});

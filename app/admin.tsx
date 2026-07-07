/**
 * admin.tsx — Dashboard admin (solo role='admin'). 3 pestañas:
 *   Códigos · Usuarios · Métricas.
 * Todo va contra RPCs SECURITY DEFINER protegidas por is_admin() en la base.
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, ActivityIndicator, Alert, TextInput, ScrollView,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { supabase } from './core/supabase';
import { useAuth } from './core/AuthContext';

type Tab = 'codigos' | 'usuarios' | 'metricas';
type Code = { code: string; created_at: string; uses: number; max_uses: number; active: boolean; expires_at: string | null; estado: string; usado_por: string[] };
type User = { id: string; email: string; nombre: string | null; role: string; active: boolean; deleted: boolean; codigo_usado: string | null; created_at: string; last_seen: string | null };

export default function AdminScreen() {
  const { isAdmin, loading, profile } = useAuth();
  const [tab, setTab] = useState<Tab>('codigos');

  if (loading) return <View style={s.center}><ActivityIndicator color="#FFD700" /></View>;
  if (!isAdmin) {
    return (
      <View style={s.center}>
        <Text style={s.denied}>Acceso solo para administradores.</Text>
        <TouchableOpacity onPress={() => router.back()}><Text style={s.link}>Volver</Text></TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}><Text style={s.back}>‹ Volver</Text></TouchableOpacity>
        <Text style={s.title}>Administración</Text>
        <View style={{ width: 52 }} />
      </View>

      <View style={s.tabs}>
        {(['codigos', 'usuarios', 'metricas'] as Tab[]).map(t => (
          <TouchableOpacity key={t} style={[s.tab, tab === t && s.tabActive]} onPress={() => setTab(t)}>
            <Text style={[s.tabText, tab === t && s.tabTextActive]}>
              {t === 'codigos' ? 'Códigos' : t === 'usuarios' ? 'Usuarios' : 'Métricas'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'codigos'  && <CodesTab />}
      {tab === 'usuarios' && <UsersTab selfId={profile?.id} />}
      {tab === 'metricas' && <MetricsTab />}
    </View>
  );
}

// ═══════════════ CÓDIGOS ═══════════════
function CodesTab() {
  const [codes, setCodes] = useState<Code[]>([]);
  const [fetching, setFetching] = useState(false);
  const [maxUses, setMaxUses] = useState('1');
  const [busy, setBusy] = useState(false);
  const [filtro, setFiltro] = useState<'activos' | 'revocados' | 'todos'>('activos');

  const load = useCallback(async () => {
    setFetching(true);
    const { data, error } = await supabase.rpc('admin_list_codes');
    if (error) Alert.alert('Error', error.message); else setCodes((data as Code[]) ?? []);
    setFetching(false);
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const generate = async () => {
    if (busy) return; setBusy(true);
    const n = Math.max(1, parseInt(maxUses, 10) || 1);
    const { data, error } = await supabase.rpc('generate_invite_code', { p_max_uses: n, p_expires_at: null });
    setBusy(false);
    if (error) { Alert.alert('No se pudo generar', error.message); return; }
    Alert.alert('Código creado', `${data}\n\nCompártelo (${n} uso${n > 1 ? 's' : ''}).`); load();
  };

  const upd = async (code: string, patch: any, okMsg?: string) => {
    const { error } = await supabase.rpc('admin_update_code', { p_code: code, ...patch });
    if (error) Alert.alert('Error', error.message); else { if (okMsg) Alert.alert('Listo', okMsg); load(); }
  };

  const editTope = (c: Code) => {
    Alert.prompt?.('Editar tope de usos', `Actual: ${c.max_uses}. Nuevo máximo:`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Guardar', onPress: (txt?: string) => { const n = parseInt(txt || '', 10); if (n >= 1) upd(c.code, { p_max_uses: n }); } },
    ], 'plain-text', String(c.max_uses));
  };
  const editExpiry = (c: Code) => {
    Alert.alert('Expiración', `Código ${c.code}`, [
      { text: 'Sin expiración', onPress: () => upd(c.code, { p_clear_expiry: true }, 'Sin expiración.') },
      { text: '+7 días', onPress: () => upd(c.code, { p_expires_at: new Date(Date.now() + 7 * 864e5).toISOString() }, 'Expira en 7 días.') },
      { text: '+30 días', onPress: () => upd(c.code, { p_expires_at: new Date(Date.now() + 30 * 864e5).toISOString() }, 'Expira en 30 días.') },
      { text: 'Cancelar', style: 'cancel' },
    ]);
  };

  const shown = codes.filter(c => filtro === 'todos' ? true : filtro === 'revocados' ? !c.active : c.active);

  return (
    <View style={{ flex: 1 }}>
      <View style={s.genRow}>
        <View style={{ flex: 1 }}>
          <Text style={s.lbl}>Usos permitidos</Text>
          <TextInput style={s.inp} value={maxUses} onChangeText={setMaxUses} keyboardType="number-pad" placeholder="1" placeholderTextColor="#555" />
        </View>
        <TouchableOpacity style={[s.gold, busy && { opacity: 0.6 }]} onPress={generate} disabled={busy}>
          {busy ? <ActivityIndicator color="#000" /> : <Text style={s.goldT}>+ Generar</Text>}
        </TouchableOpacity>
      </View>
      <View style={s.filterRow}>
        {(['activos', 'revocados', 'todos'] as const).map(f => (
          <TouchableOpacity key={f} style={[s.chip, filtro === f && s.chipOn]} onPress={() => setFiltro(f)}>
            <Text style={[s.chipT, filtro === f && s.chipTOn]}>{f}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <FlatList
        data={shown} keyExtractor={c => c.code} refreshing={fetching} onRefresh={load}
        contentContainerStyle={{ padding: 12 }}
        ListEmptyComponent={<Text style={s.empty}>Sin códigos en este filtro.</Text>}
        renderItem={({ item }) => (
          <View style={s.card}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={s.code}>{item.code}</Text>
              <Text style={[s.estado, { color: item.estado === 'activo' ? '#4CAF50' : '#FF7043' }]}>{item.estado}</Text>
            </View>
            <Text style={s.meta}>{item.uses}/{item.max_uses} usos{item.expires_at ? ` · expira ${item.expires_at.slice(0, 10)}` : ''}</Text>
            {item.usado_por.length > 0 && <Text style={s.meta2}>Usado por: {item.usado_por.join(', ')}</Text>}
            <View style={s.actions}>
              <TouchableOpacity style={s.act} onPress={() => editTope(item)}><Text style={s.actT}>Editar tope</Text></TouchableOpacity>
              <TouchableOpacity style={s.act} onPress={() => editExpiry(item)}><Text style={s.actT}>Expiración</Text></TouchableOpacity>
              {item.active
                ? <TouchableOpacity style={s.actDanger} onPress={() => upd(item.code, { p_active: false })}><Text style={s.actDangerT}>Revocar</Text></TouchableOpacity>
                : <TouchableOpacity style={s.actOk} onPress={() => upd(item.code, { p_active: true })}><Text style={s.actOkT}>Reactivar</Text></TouchableOpacity>}
            </View>
          </View>
        )}
      />
    </View>
  );
}

// ═══════════════ USUARIOS ═══════════════
function UsersTab({ selfId }: { selfId?: string }) {
  const [users, setUsers] = useState<User[]>([]);
  const [fetching, setFetching] = useState(false);

  const load = useCallback(async () => {
    setFetching(true);
    const { data, error } = await supabase.rpc('admin_list_users');
    if (error) Alert.alert('Error', error.message); else setUsers((data as User[]) ?? []);
    setFetching(false);
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const rpc = async (fn: string, args: any, okMsg?: string) => {
    const { error } = await supabase.rpc(fn, args);
    if (error) Alert.alert('Error', error.message); else { if (okMsg) Alert.alert('Listo', okMsg); load(); }
  };

  const actions = (u: User) => {
    if (u.id === selfId) { Alert.alert('Tu cuenta', 'No puedes aplicarte acciones administrativas a ti mismo.'); return; }
    const opts: any[] = [];
    opts.push(u.active
      ? { text: 'Suspender', style: 'destructive', onPress: () => rpc('admin_suspend_user', { p_user: u.id, p_suspend: true }, 'Usuario suspendido.') }
      : { text: 'Reactivar', onPress: () => rpc('admin_suspend_user', { p_user: u.id, p_suspend: false }, 'Usuario reactivado.') });
    const nuevoRol = u.role === 'admin' ? 'user' : 'admin';
    opts.push({ text: `Cambiar rol a ${nuevoRol}`, onPress: () =>
      Alert.alert('Cambiar rol', `¿Pasar a ${u.email} a rol ${nuevoRol}?`, [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Sí, cambiar', onPress: () => rpc('admin_set_role', { p_user: u.id, p_role: nuevoRol }, `Rol cambiado a ${nuevoRol}.`) },
      ]) });
    if (!u.deleted) opts.push({ text: 'Eliminar cuenta', style: 'destructive', onPress: () =>
      Alert.prompt?.('Eliminar cuenta', 'Escribe ELIMINAR para confirmar (soft delete: NO borra sus datos).', [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Eliminar', style: 'destructive', onPress: (txt?: string) => {
          if ((txt || '').trim().toUpperCase() === 'ELIMINAR') rpc('admin_soft_delete_user', { p_user: u.id }, 'Cuenta eliminada (soft).');
          else Alert.alert('No confirmado', 'Debes escribir exactamente ELIMINAR.');
        } },
      ], 'plain-text') });
    opts.push({ text: 'Cancelar', style: 'cancel' });
    Alert.alert(u.nombre || u.email, u.email, opts);
  };

  const estado = (u: User) => u.deleted ? 'eliminado' : !u.active ? 'suspendido' : 'activo';
  const estadoColor = (u: User) => u.deleted ? '#888' : !u.active ? '#FF7043' : '#4CAF50';

  return (
    <FlatList
      data={users} keyExtractor={u => u.id} refreshing={fetching} onRefresh={load}
      contentContainerStyle={{ padding: 12 }}
      ListEmptyComponent={<Text style={s.empty}>Sin usuarios.</Text>}
      renderItem={({ item }) => (
        <TouchableOpacity style={s.card} onPress={() => actions(item)} activeOpacity={0.7}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={s.uName}>{item.nombre || '(sin nombre)'}{item.id === selfId ? '  (tú)' : ''}</Text>
            <Text style={[s.estado, { color: estadoColor(item) }]}>{estado(item)}</Text>
          </View>
          <Text style={s.meta}>{item.email}</Text>
          <Text style={s.meta2}>
            {item.role === 'admin' ? '👑 admin' : 'usuario'} · código {item.codigo_usado || '—'} · alta {item.created_at.slice(0, 10)}
          </Text>
          <Text style={s.tapHint}>Toca para acciones ▾</Text>
        </TouchableOpacity>
      )}
    />
  );
}

// ═══════════════ MÉTRICAS ═══════════════
function MetricsTab() {
  const [m, setM] = useState<any>(null);
  const [fetching, setFetching] = useState(false);
  const load = useCallback(async () => {
    setFetching(true);
    const { data, error } = await supabase.rpc('admin_metrics');
    if (error) Alert.alert('Error', error.message); else setM(data);
    setFetching(false);
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (!m) return <View style={s.center}><ActivityIndicator color="#FFD700" /></View>;
  const conv = m.codes_generated > 0 ? Math.round((m.codes_used / m.codes_generated) * 100) : 0;

  const Card = ({ label, value }: { label: string; value: any }) => (
    <View style={s.mCard}><Text style={s.mVal}>{value}</Text><Text style={s.mLbl}>{label}</Text></View>
  );

  return (
    <ScrollView contentContainerStyle={{ padding: 12 }} refreshControl={undefined}>
      <Text style={s.sec}>USUARIOS</Text>
      <View style={s.mRow}><Card label="Activos" value={m.users_active} /><Card label="Suspendidos" value={m.users_suspended} /><Card label="Eliminados" value={m.users_deleted} /></View>
      <Text style={s.sec}>CONSULTAS IA</Text>
      <View style={s.mRow}><Card label="Hoy" value={m.ai_today} /><Card label="7 días" value={m.ai_week} /><Card label="30 días" value={m.ai_month} /></View>
      <Text style={s.sec}>MUESTRAS</Text>
      <View style={s.mRow}><Card label="Total" value={m.samples_total} /><Card label="Últimas 24h" value={m.samples_24h} /></View>
      <Text style={s.sec}>CÓDIGOS</Text>
      <View style={s.mRow}><Card label="Generados" value={m.codes_generated} /><Card label="Usados" value={m.codes_used} /><Card label="Conversión" value={`${conv}%`} /></View>

      <Text style={s.sec}>TOP IA (30 días)</Text>
      {m.ai_top.length === 0 ? <Text style={s.empty}>Sin consultas aún.</Text> :
        m.ai_top.map((r: any, i: number) => <Text key={i} style={s.topRow}>{i + 1}. {r.email} — {r.consultas}</Text>)}
      <Text style={s.sec}>TOP PROYECTOS</Text>
      {m.projects_top.length === 0 ? <Text style={s.empty}>Sin proyectos aún.</Text> :
        m.projects_top.map((r: any, i: number) => <Text key={i} style={s.topRow}>{i + 1}. {r.email} — {r.proyectos}</Text>)}
      <TouchableOpacity style={[s.gold, { margin: 16 }]} onPress={load}><Text style={s.goldT}>{fetching ? 'Actualizando…' : 'Actualizar'}</Text></TouchableOpacity>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center', gap: 12 },
  denied: { color: '#AAA', fontSize: 15 }, link: { color: '#FFD700', fontSize: 14, fontWeight: '700' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingTop: 54, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#222', backgroundColor: '#050505' },
  back: { color: '#FFD700', fontSize: 15, fontWeight: '700', width: 52 },
  title: { color: '#FFD700', fontSize: 16, fontWeight: '900' },
  tabs: { flexDirection: 'row', backgroundColor: '#0A0A0A', borderBottomWidth: 1, borderBottomColor: '#1A1A1A' },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: '#FFD700' },
  tabText: { color: '#777', fontWeight: '700', fontSize: 13 }, tabTextActive: { color: '#FFD700' },
  genRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, padding: 14, borderBottomWidth: 1, borderBottomColor: '#151515' },
  lbl: { color: '#AAA', fontSize: 11, fontWeight: '700', marginBottom: 6 },
  inp: { backgroundColor: '#111', color: '#FFF', borderRadius: 8, borderWidth: 1, borderColor: '#333', paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  gold: { backgroundColor: '#FFD700', borderRadius: 8, height: 44, paddingHorizontal: 16, justifyContent: 'center', alignItems: 'center' },
  goldT: { color: '#000', fontWeight: '900', fontSize: 14 },
  filterRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingVertical: 10 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: '#333' },
  chipOn: { borderColor: '#FFD700', backgroundColor: '#FFD70018' },
  chipT: { color: '#888', fontSize: 12, fontWeight: '700', textTransform: 'capitalize' }, chipTOn: { color: '#FFD700' },
  empty: { color: '#666', textAlign: 'center', marginTop: 30, fontSize: 13 },
  card: { backgroundColor: '#0D0D0D', borderRadius: 10, borderWidth: 1, borderColor: '#222', padding: 14, marginBottom: 10 },
  code: { color: '#FFD700', fontSize: 16, fontWeight: '900', letterSpacing: 1.2, fontFamily: 'monospace' },
  estado: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  meta: { color: '#AAA', fontSize: 12, marginTop: 4 }, meta2: { color: '#777', fontSize: 11, marginTop: 3 },
  tapHint: { color: '#555', fontSize: 11, marginTop: 6, fontStyle: 'italic' },
  uName: { color: '#EEE', fontSize: 15, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  act: { borderWidth: 1, borderColor: '#444', borderRadius: 7, paddingHorizontal: 10, paddingVertical: 6 },
  actT: { color: '#CCC', fontSize: 12, fontWeight: '700' },
  actDanger: { borderWidth: 1, borderColor: '#FF5722', borderRadius: 7, paddingHorizontal: 10, paddingVertical: 6 },
  actDangerT: { color: '#FF5722', fontSize: 12, fontWeight: '700' },
  actOk: { borderWidth: 1, borderColor: '#4CAF50', borderRadius: 7, paddingHorizontal: 10, paddingVertical: 6 },
  actOkT: { color: '#4CAF50', fontSize: 12, fontWeight: '700' },
  sec: { color: '#888', fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 16, marginBottom: 8 },
  mRow: { flexDirection: 'row', gap: 10 },
  mCard: { flex: 1, backgroundColor: '#0D0D0D', borderRadius: 10, borderWidth: 1, borderColor: '#222', padding: 12, alignItems: 'center' },
  mVal: { color: '#FFD700', fontSize: 22, fontWeight: '900' }, mLbl: { color: '#999', fontSize: 11, marginTop: 4, textAlign: 'center' },
  topRow: { color: '#CCC', fontSize: 13, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: '#151515' },
});

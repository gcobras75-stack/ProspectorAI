/**
 * admin.tsx — Pantalla admin de códigos de invitación (solo role='admin').
 *
 * Generar (PROSP-XXXX con límite de usos), ver lista con usos, y revocar.
 * Las RPC validan is_admin() en el servidor; esta pantalla es solo la UI.
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, ActivityIndicator, Alert, TextInput,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { supabase } from './core/supabase';
import { useAuth } from './core/AuthContext';

type Code = { code: string; max_uses: number; uses: number; active: boolean; expires_at: string | null; created_at: string };

export default function AdminScreen() {
  const { isAdmin, loading } = useAuth();
  const [codes, setCodes] = useState<Code[]>([]);
  const [fetching, setFetching] = useState(false);
  const [maxUses, setMaxUses] = useState('1');
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    setFetching(true);
    const { data, error } = await supabase
      .from('invite_codes')
      .select('code, max_uses, uses, active, expires_at, created_at')
      .order('created_at', { ascending: false });
    if (error) Alert.alert('Error', error.message);
    else setCodes((data as Code[]) ?? []);
    setFetching(false);
  }, []);

  useFocusEffect(useCallback(() => { if (isAdmin) load(); }, [isAdmin, load]));

  const generate = async () => {
    if (generating) return;
    setGenerating(true);
    const n = Math.max(1, parseInt(maxUses, 10) || 1);
    const { data, error } = await supabase.rpc('generate_invite_code', { p_max_uses: n, p_expires_at: null });
    setGenerating(false);
    if (error) { Alert.alert('No se pudo generar', error.message); return; }
    Alert.alert('Código creado', `${data}\n\nCompártelo con quien invitas (${n} uso${n > 1 ? 's' : ''}).`);
    load();
  };

  const revoke = (code: string) => {
    Alert.alert('Revocar código', `¿Desactivar ${code}? Ya no servirá para registrarse.`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Revocar', style: 'destructive', onPress: async () => {
        const { error } = await supabase.rpc('revoke_invite_code', { p_code: code });
        if (error) Alert.alert('Error', error.message); else load();
      } },
    ]);
  };

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color="#FFD700" /></View>;
  }
  if (!isAdmin) {
    return (
      <View style={styles.center}>
        <Text style={styles.denied}>Acceso solo para administradores.</Text>
        <TouchableOpacity onPress={() => router.back()}><Text style={styles.link}>Volver</Text></TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={styles.back}>‹ Volver</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Códigos de invitación</Text>
        <View style={{ width: 52 }} />
      </View>

      <View style={styles.genRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.genLabel}>Usos permitidos</Text>
          <TextInput
            style={styles.genInput} value={maxUses} onChangeText={setMaxUses}
            keyboardType="number-pad" placeholder="1" placeholderTextColor="#555"
          />
        </View>
        <TouchableOpacity style={[styles.genBtn, generating && { opacity: 0.6 }]} onPress={generate} disabled={generating}>
          {generating ? <ActivityIndicator color="#000" /> : <Text style={styles.genBtnText}>+ Generar código</Text>}
        </TouchableOpacity>
      </View>

      <FlatList
        data={codes}
        keyExtractor={c => c.code}
        refreshing={fetching}
        onRefresh={load}
        contentContainerStyle={{ padding: 12 }}
        ListEmptyComponent={<Text style={styles.empty}>Aún no hay códigos. Genera el primero arriba.</Text>}
        renderItem={({ item }) => {
          const agotado = item.uses >= item.max_uses;
          const muerto = !item.active || agotado;
          return (
            <View style={[styles.codeCard, muerto && { opacity: 0.5 }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.codeText}>{item.code}</Text>
                <Text style={styles.codeMeta}>
                  {item.uses}/{item.max_uses} usos
                  {!item.active ? ' · revocado' : agotado ? ' · agotado' : ' · activo'}
                </Text>
              </View>
              {item.active && !agotado && (
                <TouchableOpacity style={styles.revokeBtn} onPress={() => revoke(item.code)}>
                  <Text style={styles.revokeText}>Revocar</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center', gap: 12 },
  denied: { color: '#AAA', fontSize: 15 },
  link: { color: '#FFD700', fontSize: 14, fontWeight: '700' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingTop: 54, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: '#222', backgroundColor: '#050505',
  },
  back: { color: '#FFD700', fontSize: 15, fontWeight: '700', width: 52 },
  title: { color: '#FFD700', fontSize: 16, fontWeight: '900' },
  genRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, padding: 14, borderBottomWidth: 1, borderBottomColor: '#151515' },
  genLabel: { color: '#AAA', fontSize: 11, fontWeight: '700', marginBottom: 6 },
  genInput: { backgroundColor: '#111', color: '#FFF', borderRadius: 8, borderWidth: 1, borderColor: '#333', paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  genBtn: { backgroundColor: '#FFD700', borderRadius: 8, height: 44, paddingHorizontal: 16, justifyContent: 'center', alignItems: 'center' },
  genBtnText: { color: '#000', fontWeight: '900', fontSize: 14 },
  empty: { color: '#666', textAlign: 'center', marginTop: 40, fontSize: 13 },
  codeCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0D0D0D', borderRadius: 10, borderWidth: 1, borderColor: '#222', padding: 14, marginBottom: 10 },
  codeText: { color: '#FFD700', fontSize: 17, fontWeight: '900', letterSpacing: 1.5, fontFamily: 'monospace' },
  codeMeta: { color: '#888', fontSize: 12, marginTop: 4 },
  revokeBtn: { borderWidth: 1, borderColor: '#FF5722', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  revokeText: { color: '#FF5722', fontWeight: '700', fontSize: 13 },
});

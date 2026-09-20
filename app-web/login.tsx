/**
 * login.tsx — acceso a la PWA. SOLO inicio de sesión de cuentas existentes:
 * sin registro, sin código de invitación (decisión de producto para el demo).
 */
import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { supabase, friendlyAuthError } from '../app/core/supabase';

export default function LoginWeb() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (busy) return;
    if (!email.trim() || !password) { setError('Escribe tu correo y contraseña.'); return; }
    setBusy(true);
    setError('');
    try {
      const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (err) setError(friendlyAuthError(err.message));
      // Éxito: AuthContext detecta la sesión y el guard del layout redirige.
    } catch (e: any) {
      setError(friendlyAuthError(e?.message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={s.root}>
      <View style={s.card}>
        <Text style={s.brand}>ProspectorAI</Text>
        <Text style={s.sub}>Análisis y consulta de proyectos</Text>

        <Text style={s.label}>Correo</Text>
        <TextInput
          style={s.input} value={email} onChangeText={setEmail}
          placeholder="tu@correo.com" placeholderTextColor="#555"
          autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
          textContentType="username" autoComplete="email"
        />
        <Text style={s.label}>Contraseña</Text>
        <TextInput
          style={s.input} value={password} onChangeText={setPassword}
          placeholder="••••••••" placeholderTextColor="#555"
          secureTextEntry autoCapitalize="none" autoCorrect={false}
          textContentType="password" autoComplete="current-password"
          onSubmitEditing={submit}
        />

        {!!error && <Text style={s.error}>{error}</Text>}

        <TouchableOpacity style={[s.btn, busy && { opacity: 0.6 }]} onPress={submit} disabled={busy}>
          {busy ? <ActivityIndicator color="#000" /> : <Text style={s.btnText}>Entrar</Text>}
        </TouchableOpacity>
        <Text style={s.hint}>Versión web: dibuja zonas, corre análisis y consulta tus proyectos. La captura de campo (fotos, muestras, modo sin conexión) es solo de la app nativa.</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center', padding: 16 },
  card: { width: '100%', maxWidth: 400 },
  brand: { color: '#FFD700', fontSize: 30, fontWeight: '800', textAlign: 'center' },
  sub: { color: '#AAA', fontSize: 14, textAlign: 'center', marginBottom: 28 },
  label: { color: '#CCC', fontSize: 13, marginBottom: 6, marginTop: 12 },
  input: {
    backgroundColor: '#161616', borderColor: '#2A2A2A', borderWidth: 1, borderRadius: 10,
    color: '#FFF', paddingHorizontal: 14, paddingVertical: 12, fontSize: 16,
  },
  error: { color: '#FF6B6B', marginTop: 14, fontSize: 14 },
  btn: { backgroundColor: '#FFD700', borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 22 },
  btnText: { color: '#000', fontWeight: '700', fontSize: 16 },
  hint: { color: '#666', fontSize: 12, textAlign: 'center', marginTop: 22 },
});

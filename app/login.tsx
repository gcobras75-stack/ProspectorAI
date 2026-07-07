/**
 * login.tsx — acceso a ProspectorAI.
 *
 * Entrar (email + password) o Crear cuenta (email + password + CÓDIGO DE
 * INVITACIÓN). Sin código válido, el servidor rechaza el alta (trigger RLS).
 * La sesión es persistente: no se vuelve a pedir en cada apertura.
 */
import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator,
  KeyboardAvoidingView, Platform, ScrollView, Alert,
} from 'react-native';
import { supabase, friendlyAuthError, inviteStatusMessage } from './core/supabase';

export default function LoginScreen() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nombre, setNombre] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const isRegister = mode === 'register';

  const submit = async () => {
    if (busy) return;
    if (!email.trim() || !password) {
      Alert.alert('Faltan datos', 'Escribe tu correo y contraseña.');
      return;
    }
    if (isRegister && !code.trim()) {
      Alert.alert('Falta el código', 'Necesitas un código de invitación para crear tu cuenta.');
      return;
    }
    setBusy(true);
    try {
      if (isRegister) {
        // Pre-chequeo del código: mensaje exacto sin depender de parsear un 500.
        const { data: status, error: chkErr } = await supabase.rpc('check_invite_code', { p_code: code.trim() });
        if (chkErr) { Alert.alert('Error de conexión', 'No pudimos validar el código. Revisa tu conexión e intenta de nuevo.'); return; }
        if (status !== 'OK') { Alert.alert('Código de invitación', inviteStatusMessage(status)); return; }

        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { invite_code: code.trim(), nombre: nombre.trim() } },
        });
        if (error) { Alert.alert('No se pudo crear la cuenta', friendlyAuthError(error.message)); return; }
        if (!data.session) {
          Alert.alert(
            'Cuenta creada',
            'Revisa tu correo para confirmar la cuenta y luego inicia sesión.',
            [{ text: 'OK', onPress: () => setMode('login') }],
          );
        }
        // Si la confirmación de correo está desactivada, onAuthStateChange entra solo.
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) { Alert.alert('No se pudo entrar', friendlyAuthError(error.message)); return; }
      }
    } catch (e: any) {
      Alert.alert('Error', friendlyAuthError(e?.message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.logo}>⛏️ ProspectorAI</Text>
        <Text style={styles.subtitle}>
          {isRegister ? 'Crea tu cuenta con tu código de invitación' : 'Entra a tu cuenta'}
        </Text>

        {isRegister && (
          <>
            <Text style={styles.label}>Nombre</Text>
            <TextInput
              style={styles.input} value={nombre} onChangeText={setNombre}
              placeholder="Tu nombre" placeholderTextColor="#555" autoCapitalize="words"
            />
          </>
        )}

        <Text style={styles.label}>Correo</Text>
        <TextInput
          style={styles.input} value={email} onChangeText={setEmail}
          placeholder="correo@ejemplo.com" placeholderTextColor="#555"
          autoCapitalize="none" keyboardType="email-address" autoCorrect={false}
        />

        <Text style={styles.label}>Contraseña</Text>
        <TextInput
          style={styles.input} value={password} onChangeText={setPassword}
          placeholder="••••••••" placeholderTextColor="#555" secureTextEntry
        />

        {isRegister && (
          <>
            <Text style={styles.label}>Código de invitación</Text>
            <TextInput
              style={[styles.input, styles.codeInput]} value={code} onChangeText={setCode}
              placeholder="PROSP-XXXX" placeholderTextColor="#555"
              autoCapitalize="characters" autoCorrect={false}
            />
          </>
        )}

        <TouchableOpacity style={[styles.primaryBtn, busy && { opacity: 0.6 }]} onPress={submit} disabled={busy}>
          {busy
            ? <ActivityIndicator color="#000" />
            : <Text style={styles.primaryBtnText}>{isRegister ? 'Crear cuenta' : 'Entrar'}</Text>}
        </TouchableOpacity>

        <TouchableOpacity style={styles.switchBtn} onPress={() => setMode(isRegister ? 'login' : 'register')}>
          <Text style={styles.switchText}>
            {isRegister ? '¿Ya tienes cuenta? Entra' : '¿Tienes un código? Crea tu cuenta'}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 28 },
  logo: { color: '#FFD700', fontSize: 30, fontWeight: '900', textAlign: 'center', letterSpacing: 0.5 },
  subtitle: { color: '#888', fontSize: 14, textAlign: 'center', marginTop: 8, marginBottom: 28 },
  label: { color: '#AAA', fontSize: 12, fontWeight: '700', letterSpacing: 0.5, marginBottom: 6, marginTop: 14 },
  input: {
    backgroundColor: '#111', color: '#FFF', borderRadius: 10, borderWidth: 1, borderColor: '#333',
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 15,
  },
  codeInput: { letterSpacing: 2, fontWeight: '700', color: '#FFD700' },
  primaryBtn: {
    backgroundColor: '#FFD700', borderRadius: 10, height: 52, marginTop: 26,
    justifyContent: 'center', alignItems: 'center',
  },
  primaryBtnText: { color: '#000', fontWeight: '900', fontSize: 16 },
  switchBtn: { marginTop: 18, alignItems: 'center' },
  switchText: { color: '#FFD700', fontSize: 13, fontWeight: '600' },
});

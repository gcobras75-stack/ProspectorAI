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
import { Ionicons } from '@expo/vector-icons';
import { supabase, friendlyAuthError, inviteStatusMessage } from './core/supabase';

/**
 * Campo de contraseña con ojito 👁️ para mostrar/ocultar. Oculto por defecto.
 * Reutilizable: cualquier contraseña de la app debe usar este componente.
 */
function PasswordField({
  value, onChangeText, placeholder = '••••••••',
}: { value: string; onChangeText: (t: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <View style={styles.passwordRow}>
      <TextInput
        style={styles.passwordInput} value={value} onChangeText={onChangeText}
        placeholder={placeholder} placeholderTextColor="#555"
        secureTextEntry={!show} autoCapitalize="none" autoCorrect={false}
      />
      <TouchableOpacity
        style={styles.eyeBtn} onPress={() => setShow((s) => !s)}
        accessibilityRole="button"
        accessibilityLabel={show ? 'Ocultar contraseña' : 'Mostrar contraseña'}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Ionicons name={show ? 'eye-off-outline' : 'eye-outline'} size={22} color="#AAA" />
      </TouchableOpacity>
    </View>
  );
}

export default function LoginScreen() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nombre, setNombre] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const isRegister = mode === 'register';

  // Código a prueba de humanos: MAYÚSCULAS y sin espacios (los que se cuelan
  // al copiar de WhatsApp), en vivo mientras escribe/pega.
  const onChangeCode = (t: string) => setCode(t.toUpperCase().replace(/\s/g, ''));

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

        {/* Registro: el CÓDIGO va al frente — es lo primero que trae el piloto nuevo. */}
        {isRegister && (
          <>
            <Text style={styles.label}>Código de invitación</Text>
            <TextInput
              style={[styles.input, styles.codeInput]} value={code} onChangeText={onChangeCode}
              placeholder="PROSP-XXXX" placeholderTextColor="#555"
              autoCapitalize="characters" autoCorrect={false} autoComplete="off"
            />

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
        <PasswordField value={password} onChangeText={setPassword} />

        <TouchableOpacity style={[styles.primaryBtn, busy && { opacity: 0.6 }]} onPress={submit} disabled={busy}>
          {busy
            ? <ActivityIndicator color="#000" />
            : <Text style={styles.primaryBtnText}>{isRegister ? 'Crear cuenta' : 'Entrar'}</Text>}
        </TouchableOpacity>

        {/* Acceso directo al registro con código desde la primera pantalla. */}
        {!isRegister && (
          <TouchableOpacity style={styles.inviteBtn} onPress={() => setMode('register')}>
            <Text style={styles.inviteBtnText}>🎟️  Tengo un código de invitación</Text>
          </TouchableOpacity>
        )}

        {/* En login, el acceso al registro ya lo da el botón del código de arriba. */}
        {isRegister && (
          <TouchableOpacity style={styles.switchBtn} onPress={() => setMode('login')}>
            <Text style={styles.switchText}>¿Ya tienes cuenta? Entra</Text>
          </TouchableOpacity>
        )}
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
  passwordRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#111', borderRadius: 10, borderWidth: 1, borderColor: '#333',
  },
  passwordInput: {
    flex: 1, color: '#FFF', paddingHorizontal: 14, paddingVertical: 12, fontSize: 15,
  },
  eyeBtn: { paddingHorizontal: 14, paddingVertical: 10 },
  inviteBtn: {
    marginTop: 16, height: 48, borderRadius: 10, borderWidth: 1.5, borderColor: '#FFD700',
    justifyContent: 'center', alignItems: 'center',
  },
  inviteBtnText: { color: '#FFD700', fontSize: 15, fontWeight: '800' },
  primaryBtn: {
    backgroundColor: '#FFD700', borderRadius: 10, height: 52, marginTop: 26,
    justifyContent: 'center', alignItems: 'center',
  },
  primaryBtnText: { color: '#000', fontWeight: '900', fontSize: 16 },
  switchBtn: { marginTop: 18, alignItems: 'center' },
  switchText: { color: '#FFD700', fontSize: 13, fontWeight: '600' },
});

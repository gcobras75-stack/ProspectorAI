/**
 * supabase.ts — cliente Supabase para la app (Etapa 2).
 *
 * Sesión persistente en AsyncStorage (no pedir login cada vez). La anon key es
 * pública por diseño; el aislamiento real lo garantiza RLS en el servidor.
 */
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// Traduce los errores de auth a mensajes claros. NUNCA devuelve JSON/HTML crudo.
export function friendlyAuthError(message: string | undefined): string {
  const raw = message ?? '';
  const m = raw.toUpperCase();
  if (m.includes('INVITE_CODE_REQUIRED')) return 'Necesitas un código de invitación para registrarte.';
  if (m.includes('INVITE_CODE_INVALID'))  return 'Ese código de invitación no existe. Revisa que esté bien escrito.';
  if (m.includes('INVITE_CODE_REVOKED'))  return 'Ese código fue revocado.';
  if (m.includes('INVITE_CODE_EXPIRED'))  return 'Ese código ya expiró.';
  if (m.includes('INVITE_CODE_EXHAUSTED')) return 'Ese código ya alcanzó su límite de usos.';
  // GoTrue envuelve las excepciones del trigger como un 500 genérico:
  if (m.includes('DATABASE ERROR SAVING NEW USER'))
    return 'No se pudo crear la cuenta. Revisa tu código de invitación e intenta de nuevo.';
  if (m.includes('ALREADY REGISTERED') || m.includes('ALREADY EXISTS'))
    return 'Ese correo ya está registrado. Inicia sesión.';
  if (m.includes('INVALID LOGIN CREDENTIALS')) return 'Correo o contraseña incorrectos.';
  if (m.includes('EMAIL NOT CONFIRMED')) return 'Debes confirmar tu correo antes de entrar.';
  if (m.includes('EMAIL') && m.includes('INVALID')) return 'Ese correo no es válido.';
  if (m.includes('PASSWORD')) return 'La contraseña debe tener al menos 6 caracteres.';
  if (m.includes('NETWORK') || m.includes('FETCH') || m.includes('TIMEOUT') || m.includes('CONNECTION'))
    return 'Error de conexión — intenta de nuevo.';
  // Blindaje: nunca mostrar objetos/JSON/HTML crudos ni mensajes larguísimos.
  const t = raw.trim();
  if (!t || t.length > 120 || t.startsWith('{') || t.startsWith('[') || t.startsWith('<') || m.includes('CLOUDFLARE')) {
    return 'Error de conexión — intenta de nuevo.';
  }
  return t;
}

// Mensaje del pre-chequeo de código (RPC check_invite_code).
// Todos los casos "malos" comparten una salida clara y accionable para el piloto.
export function inviteStatusMessage(status: string | null | undefined): string {
  switch (status) {
    case 'REVOKED':   return 'Ese código fue revocado — pídele uno nuevo a quien te invitó.';
    case 'EXPIRED':   return 'Ese código ya expiró — pídele uno nuevo a quien te invitó.';
    case 'EXHAUSTED': return 'Ese código ya se usó — pídele uno nuevo a quien te invitó.';
    default:          return 'Código no válido o ya usado — pídele uno nuevo a quien te invitó.';
  }
}

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

// Traduce los códigos de error del trigger de registro a mensajes claros.
export function friendlyAuthError(message: string | undefined): string {
  const m = (message ?? '').toUpperCase();
  if (m.includes('INVITE_CODE_REQUIRED')) return 'Necesitas un código de invitación para registrarte.';
  if (m.includes('INVITE_CODE_INVALID'))  return 'Ese código de invitación no existe.';
  if (m.includes('INVITE_CODE_REVOKED'))  return 'Ese código fue revocado.';
  if (m.includes('INVITE_CODE_EXPIRED'))  return 'Ese código ya expiró.';
  if (m.includes('INVITE_CODE_EXHAUSTED')) return 'Ese código ya alcanzó su límite de usos.';
  if (m.includes('INVALID LOGIN CREDENTIALS')) return 'Correo o contraseña incorrectos.';
  if (m.includes('EMAIL NOT CONFIRMED')) return 'Debes confirmar tu correo antes de entrar.';
  if (m.includes('USER ALREADY REGISTERED')) return 'Ya existe una cuenta con ese correo.';
  return message ?? 'Ocurrió un error. Intenta de nuevo.';
}

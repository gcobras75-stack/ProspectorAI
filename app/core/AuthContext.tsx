/**
 * AuthContext.tsx — estado de sesión + perfil (rol) para toda la app.
 *
 * Expone la sesión de Supabase y el perfil del usuario (incluye role='admin'|'user').
 * La sesión se restaura automáticamente al abrir la app (persistSession).
 */
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

export type Profile = {
  id: string;
  nombre: string | null;
  role: 'user' | 'admin';
  codigo_usado: string | null;
};

type AuthState = {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  isAdmin: boolean;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState>({
  session: null, profile: null, loading: true, isAdmin: false,
  refreshProfile: async () => {}, signOut: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = useCallback(async (s: Session | null) => {
    if (!s) { setProfile(null); return; }
    const { data } = await supabase
      .from('profiles')
      .select('id, nombre, role, codigo_usado')
      .eq('id', s.user.id)
      .single();
    setProfile((data as Profile) ?? null);
  }, []);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      await loadProfile(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, s) => {
      setSession(s);
      await loadProfile(s);
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, [loadProfile]);

  const signOut = useCallback(async () => { await supabase.auth.signOut(); }, []);
  const refreshProfile = useCallback(async () => { await loadProfile(session); }, [session, loadProfile]);

  return (
    <AuthContext.Provider
      value={{ session, profile, loading, isAdmin: profile?.role === 'admin', refreshProfile, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

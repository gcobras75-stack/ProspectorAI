/**
 * _layout.web.tsx — layout raíz de la PWA (solo web; la app nativa usa _layout.tsx).
 *
 * Sin SyncEngine, sin reanimated, sin BadgeContext: la PWA no sincroniza: lee y escribe directo en Supabase (proyectos nuevos web_…).
 * Guard de sesión: sin sesión → /login; con sesión estando en /login → app.
 */
import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { AuthProvider, useAuth } from '../app/core/AuthContext';
import { installGeeAuth } from '../web-lib/geeAuth';
import { setScopeUser } from '../web-lib/userScope';
import { SAFE_TOP } from '../web-lib/safeArea';

// Envoltorio de fetch para el servidor GEE (token de app + motivo real de un 401/429). Ver geeAuth.ts.
installGeeAuth();

function RootNavigation() {
  const { session, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  // Identidad del storage local (A5): el id del usuario de la sesión. Se fija en el render, ANTES de montar las pantallas (leen el chat al
  // montar), y solo cuando ya se sabe si hay sesión (con `loading` aún no se sabe: no borrar nada). Al cambiar de usuario o al salir
  // se borra lo del anterior (ver userScope.ts).
  const uid = session?.user?.id ?? null;
  if (!loading) setScopeUser(uid);

  useEffect(() => {
    if (loading) return;
    const inAuth = (segments[0] as string) === 'login';
    if (!session && !inAuth) router.replace('/login' as any);
    else if (session && inAuth) router.replace('/(tabs)' as any);
  }, [session, loading, segments, router]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator color="#FFD700" size="large" />
      </View>
    );
  }

  return (
    // key = usuario: al cambiar de usuario las pantallas se remontan y no conservan el estado (chat en memoria) del anterior.
    <Stack key={uid ?? 'anon'} screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="proyecto/[id]" />
      <Stack.Screen name="analisis/nuevo" />
      <Stack.Screen name="login" />
    </Stack>
  );
}

// Service worker (instalable + estáticos cacheados). Solo con HTTPS o localhost; si falla, la app sigue igual.
function useServiceWorker() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const secure = window.location.protocol === 'https:' || window.location.hostname === 'localhost';
    if (!secure) return;
    navigator.serviceWorker.register('/sw.js').catch(() => { /* sin SW no pasa nada */ });
  }, []);
}

export default function RootLayout() {
  useServiceWorker();
  // Contenedor único para TODAS las pantallas: reserva el hueco de la barra de estado de iOS (env() vale 0 donde no hay).
  // Va fuera de cada ScrollView, así lo que se desplaza se recorta aquí abajo y no se asoma bajo la barra. Fondo negro:
  // sin él se vería el gris del tema claro de react-navigation en esa franja.
  return (
    <View style={{ flex: 1, backgroundColor: '#000', paddingTop: SAFE_TOP as any }}>
      <AuthProvider>
        <RootNavigation />
      </AuthProvider>
    </View>
  );
}

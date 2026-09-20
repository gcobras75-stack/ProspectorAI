/**
 * _layout.web.tsx — layout raíz de la PWA (solo web; la app nativa usa _layout.tsx).
 *
 * Sin SyncEngine, sin reanimated, sin BadgeContext: la PWA es de solo lectura.
 * Guard de sesión: sin sesión → /login; con sesión estando en /login → app.
 */
import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { AuthProvider, useAuth } from '../app/core/AuthContext';

function RootNavigation() {
  const { session, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

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
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="proyecto/[id]" />
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
  return (
    <AuthProvider>
      <RootNavigation />
    </AuthProvider>
  );
}

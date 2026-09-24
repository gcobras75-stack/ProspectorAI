import { Tabs } from 'expo-router';
import React from 'react';
import { Text } from 'react-native';
import { SAFE_BOTTOM } from '../../web-lib/safeArea';

// Icono emoji (sin librería de iconos en la PWA). Antes era null: el hueco vacío del icono recortaba la etiqueta.
const tabIcon = (glyph: string) => ({ focused }: { focused: boolean }) => (
  <Text style={{ fontSize: 20, lineHeight: 24, opacity: focused ? 1 : 0.6 }}>{glyph}</Text>
);

// Tabs de la PWA: Proyectos y Geólogo (el mapa vive dentro del proyecto).
// `index` existe solo para redirigir a Proyectos y no aparece en la barra.
export default function TabLayoutWeb() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: '#FFD700',
        tabBarInactiveTintColor: '#888',
        // La barra mide 48 px + el inset inferior de iOS (indicador de inicio). react-navigation NO lo suma en la web (medido: 48 px aun
        // con inset), así que sin esto el indicador de inicio se dibuja sobre la barra y la etiqueta/último elemento quedan tapados.
        tabBarStyle: { backgroundColor: '#0A0A0A', borderTopColor: '#222', height: `calc(48px + ${SAFE_BOTTOM})` as any, paddingBottom: SAFE_BOTTOM as any },
        // Icono y etiqueta EN LA MISMA FILA: la barra mide 48 px y en columna (28 px de icono + 10 de relleno) a la etiqueta le
        // quedaban 10 px y se recortaba.
        tabBarLabelPosition: 'beside-icon',
        tabBarLabelStyle: { fontSize: 14, fontWeight: '700' },
      }}>
      <Tabs.Screen name="index" options={{ href: null }} />
      <Tabs.Screen name="proyectos" options={{ title: 'Proyectos', tabBarIcon: tabIcon('⛏️') }} />
      <Tabs.Screen name="geologo" options={{ title: 'Geólogo', tabBarIcon: tabIcon('💬') }} />
    </Tabs>
  );
}

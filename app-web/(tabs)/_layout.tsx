import { Tabs } from 'expo-router';
import React from 'react';
import { Text } from 'react-native';

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
        tabBarStyle: { backgroundColor: '#0A0A0A', borderTopColor: '#222' },
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

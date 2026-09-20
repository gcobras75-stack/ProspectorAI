import { Tabs } from 'expo-router';
import React from 'react';

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
        tabBarIcon: () => null,
      }}>
      <Tabs.Screen name="index" options={{ href: null }} />
      <Tabs.Screen name="proyectos" options={{ title: 'Proyectos' }} />
      <Tabs.Screen name="geologo" options={{ title: 'Geólogo' }} />
    </Tabs>
  );
}

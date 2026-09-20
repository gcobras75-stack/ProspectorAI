/**
 * VillegasButton.tsx — acceso al chat del Ing. Villegas desde pantallas que están ENCIMA de las pestañas
 * (detalle de proyecto, Nuevo análisis) y por eso no tienen barra inferior.
 */
import React from 'react';
import { Text, TouchableOpacity, StyleSheet } from 'react-native';

export default function VillegasButton({ onPress, disabled }: { onPress: () => void; disabled?: boolean }) {
  return (
    <TouchableOpacity
      style={[s.btn, disabled && { opacity: 0.35 }]} onPress={onPress} disabled={disabled} activeOpacity={0.8}
      accessibilityLabel="Abrir el chat con el Ing. Villegas" hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
    >
      <Text style={s.text}>💬 Villegas</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  btn: { minHeight: 40, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: '#FFD700', alignItems: 'center', justifyContent: 'center', marginLeft: 8 },
  text: { color: '#FFD700', fontSize: 14, fontWeight: '800' },
});

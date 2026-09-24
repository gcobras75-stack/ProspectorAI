/**
 * DeepAdviceBanner — aviso ANTES de analizar sobre el Análisis profundo, según el material (ver core/deepAdvice).
 * Compartido por la nativa y la PWA. No bloquea nada: informa y ofrece el interruptor ahí mismo.
 *  - Material que sí se beneficia + profundo apagado → sugiere activarlo (botón "Activar").
 *  - Material que no se beneficia + profundo encendido → avisa que puede analizar sin esperar más (botón "Desactivar").
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Colors } from '../core/theme';
import { materialLabel } from '../core/materialsCatalog';
import { deepAdvice, deepAdviceText } from '../core/deepAdvice';

type Props = { materialId: string; deepOn: boolean; onChange: (deep: boolean) => void };

export default function DeepAdviceBanner({ materialId, deepOn, onChange }: Props) {
  const advice = deepAdvice(materialId, deepOn);
  if (!advice) return null;
  const suggest = advice.kind === 'suggest';
  const tone = suggest ? '#FFA000' : '#8AB4F8';
  return (
    <View style={[s.box, { borderColor: tone }]} accessibilityRole="alert">
      <Text style={[s.text, { color: tone }]}>{deepAdviceText(materialLabel(materialId), advice)}</Text>
      <TouchableOpacity
        style={[s.btn, suggest ? { backgroundColor: Colors.primary } : { borderColor: tone, borderWidth: 1 }]}
        onPress={() => onChange(suggest)} activeOpacity={0.85} accessibilityRole="button"
      >
        <Text style={[s.btnText, { color: suggest ? '#000' : tone }]}>{suggest ? 'Activar Análisis profundo' : 'Desactivar Análisis profundo'}</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  box: { borderWidth: 1, borderRadius: 10, padding: 10, marginTop: 8, backgroundColor: 'rgba(0,0,0,0.5)' },
  text: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
  btn: { marginTop: 8, minHeight: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  btnText: { fontSize: 14, fontWeight: '800' },
});

/**
 * ValidationSheet.tsx — hoja para marcar en campo un punto del análisis: Confirmado / Parcial / No encontré nada + nota corta.
 *
 * Anclada ARRIBA (no abajo): en iPhone el teclado tapa la parte baja de la pantalla y ocultaría la nota mientras se escribe.
 * "No encontré nada" se explica siempre como "en MI VISITA no lo encontré", no como "no existe". Solo registra: no ajusta el análisis.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import {
  NOTE_MAX, SCOPE_NOTICE, VERDICTS, VERDICT_BUTTON, VERDICT_COLOR, VERDICT_HELP, pointKey,
  type PairPoint, type PairView, type Verdict,
} from './validationPairs';

type Props = {
  /** Punto a validar; null = hoja cerrada. */
  point: (PairPoint & { evidence?: string }) | null;
  /** Veredicto ya guardado de este punto (si lo hay): se muestra y se puede cambiar. */
  existing?: PairView;
  onClose: () => void;
  onSave: (verdict: Verdict, comment: string) => Promise<void>;
  onRemove?: () => Promise<void>;
};

export default function ValidationSheet({ point, existing, onClose, onSave, onRemove }: Props) {
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setVerdict(existing?.verdict ?? null);
    setComment(existing?.comment ?? '');
    setBusy(false); setError('');
  }, [point, existing]);

  if (!point) return null;
  let where = '';
  try { where = pointKey(point.lat, point.lng); } catch { where = ''; }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await fn(); onClose(); } catch (e: any) { setError(e?.message || 'No se pudo guardar. Revisa tu conexión e intenta de nuevo.'); setBusy(false); }
  };

  return (
    <View style={s.overlay} pointerEvents="box-none">
      <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={busy ? undefined : onClose} accessibilityLabel="Cerrar" />
      <View style={s.card}>
        <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Text style={s.title}>✔ Validar en campo{point.rank ? ` — punto #${point.rank}` : ''}</Text>
          {!!where && <Text style={s.sub}>{where}</Text>}
          {!!point.evidence && <Text style={s.sub} numberOfLines={2}>El análisis marcó: {point.evidence}</Text>}
          {existing && <Text style={s.current}>Ya marcado — puedes cambiarlo.</Text>}

          <Text style={s.q}>¿Qué encontraste al visitar este punto?</Text>
          {VERDICTS.map((v) => {
            const on = verdict === v;
            return (
              <TouchableOpacity
                key={v} onPress={() => setVerdict(v)} disabled={busy} activeOpacity={0.85}
                style={[s.opt, { borderColor: on ? VERDICT_COLOR[v] : '#2A2A2A', backgroundColor: on ? VERDICT_COLOR[v] + '22' : '#161616' }]}
                accessibilityRole="button" accessibilityState={{ selected: on }}
              >
                <Text style={[s.optTitle, on && { color: VERDICT_COLOR[v] }]}>{on ? '● ' : '○ '}{VERDICT_BUTTON[v]}</Text>
                <Text style={s.optHelp}>{VERDICT_HELP[v]}</Text>
              </TouchableOpacity>
            );
          })}

          <TextInput
            style={s.note} value={comment} onChangeText={(t) => setComment(t.slice(0, NOTE_MAX))}
            placeholder="Nota corta (opcional): qué viste, dónde, cuándo…" placeholderTextColor="#666"
            multiline maxLength={NOTE_MAX} editable={!busy}
          />
          <Text style={s.counter}>{comment.length}/{NOTE_MAX}</Text>

          <Text style={s.scope}>{SCOPE_NOTICE}</Text>
          {!!error && <Text style={s.err}>{error}</Text>}

          <View style={s.row}>
            <TouchableOpacity style={[s.btn, s.ghost]} onPress={onClose} disabled={busy}><Text style={s.ghostText}>Cancelar</Text></TouchableOpacity>
            <TouchableOpacity
              style={[s.btn, s.primary, (!verdict || busy) && { opacity: 0.4 }]} disabled={!verdict || busy}
              onPress={() => verdict && run(() => onSave(verdict, comment))}
            >
              {busy ? <ActivityIndicator color="#000" /> : <Text style={s.primaryText}>{existing ? 'Actualizar' : 'Guardar'}</Text>}
            </TouchableOpacity>
          </View>
          {existing && onRemove && (
            <TouchableOpacity onPress={() => run(onRemove)} disabled={busy} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={s.remove}>Quitar veredicto</Text>
            </TouchableOpacity>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 600 },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.65)' },
  card: { marginTop: 12, marginHorizontal: 12, maxHeight: '92%', backgroundColor: '#101010', borderColor: '#2A2A2A', borderWidth: 1, borderRadius: 14, padding: 14 },
  title: { color: '#FFD700', fontSize: 18, fontWeight: '800' },
  sub: { color: '#999', fontSize: 12, marginTop: 3 },
  current: { color: '#FFD700', fontSize: 12, marginTop: 6 },
  q: { color: '#EEE', fontSize: 14, fontWeight: '700', marginTop: 12, marginBottom: 8 },
  opt: { borderWidth: 1.5, borderRadius: 12, padding: 11, marginBottom: 8, minHeight: 52 },
  optTitle: { color: '#EEE', fontSize: 15, fontWeight: '800' },
  optHelp: { color: '#9A9A9A', fontSize: 12, marginTop: 3, lineHeight: 17 },
  note: { backgroundColor: '#161616', borderColor: '#2A2A2A', borderWidth: 1, borderRadius: 10, color: '#FFF', paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, minHeight: 64, textAlignVertical: 'top', marginTop: 4 },
  counter: { color: '#666', fontSize: 11, textAlign: 'right', marginTop: 3 },
  scope: { color: '#888', fontSize: 12, lineHeight: 17, marginTop: 8 },
  err: { color: '#FF6B6B', fontSize: 13, marginTop: 8 },
  row: { flexDirection: 'row', gap: 10, marginTop: 12 },
  btn: { flex: 1, minHeight: 46, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  ghost: { borderColor: '#444', borderWidth: 1 },
  ghostText: { color: '#CCC', fontWeight: '700', fontSize: 15 },
  primary: { backgroundColor: '#FFD700' },
  primaryText: { color: '#000', fontWeight: '800', fontSize: 15 },
  remove: { color: '#888', fontSize: 12, textAlign: 'center', textDecorationLine: 'underline', marginTop: 12, marginBottom: 2 },
});

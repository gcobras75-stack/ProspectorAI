/**
 * geologo.tsx (PWA) — chat con el Ing. Villegas.
 *
 * Consume POST /api/ai/villegas: el cliente manda mensajes + un bloque de DATOS del
 * proyecto elegido; el prompt vive en el servidor. La conversación es solo de esta
 * sesión (en memoria): la PWA no escribe nada en Supabase, así que no pisa el
 * chat_history que guarda la app nativa.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { listWebProjects, loadWebProject, loadWebSamples, type WebProjectSummary } from '../../app/core/webData';
import { askVillegas, type ChatMsg } from '../../web-lib/villegasClient';
import { buildProjectContext } from '../../web-lib/projectContext';
import { getSelectedProjectId, setSelectedProjectId, takePendingInterpretation } from '../../web-lib/selection';
import Markdown from '../../web-lib/Markdown';

type UiMsg = ChatMsg & { error?: boolean; truncated?: boolean };

const INTERPRET_PROMPT = 'Interpreta este proyecto: resumen, significado geológico y plan de campo.';

export default function GeologoWeb() {
  const [projects, setProjects] = useState<WebProjectSummary[] | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [context, setContext] = useState<string | null>(null);
  const [loadingCtx, setLoadingCtx] = useState(false);
  const [messages, setMessages] = useState<UiMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const scrollRef = useRef<ScrollView>(null);
  // Evita que una respuesta tardía de un proyecto anterior se pinte en el actual.
  const epochRef = useRef(0);

  const selectProject = useCallback(async (id: string) => {
    epochRef.current += 1;
    const epoch = epochRef.current;
    setSelId(id); setSelectedProjectId(id);
    setMessages([]); setContext(null); setLoadError(''); setLoadingCtx(true);
    try {
      const [p, samples] = await Promise.all([loadWebProject(id), loadWebSamples(id)]);
      if (epoch !== epochRef.current) return;
      setContext(p ? buildProjectContext(p, samples) : null);
    } catch (e: any) {
      if (epoch === epochRef.current) setLoadError(e?.message || 'No se pudo cargar el proyecto.');
    } finally {
      if (epoch === epochRef.current) setLoadingCtx(false);
    }
  }, []);

  // Interpretación de UN punto (botón del panel de resultados): modo 'punto' del servidor, que
  // usa el prompt de interpretación estricta. Solo manda los datos reales del punto.
  const runPunto = useCallback(async (ctx: string) => {
    const epoch = epochRef.current;
    setMessages((m) => [...m.filter((x) => !x.error), { role: 'user', content: 'Interpretación del punto que elegí en el mapa.' }]);
    setBusy(true);
    try {
      const { reply, truncated } = await askVillegas([{ role: 'user', content: ctx }], null, 'punto');
      if (epoch !== epochRef.current) return;
      setMessages((m) => [...m, { role: 'assistant', content: reply, truncated }]);
    } catch (e: any) {
      if (epoch === epochRef.current) {
        setMessages((m) => [...m, { role: 'assistant', content: e?.message || 'No se pudo interpretar el punto.', error: true }]);
      }
    } finally {
      if (epoch === epochRef.current) setBusy(false);
    }
  }, []);

  // Al enfocar la pestaña: refresca la lista y respeta el proyecto elegido en "Proyectos".
  useFocusEffect(useCallback(() => {
    let alive = true;
    (async () => {
      try {
        const list = await listWebProjects();
        if (!alive) return;
        setProjects(list);
        const want = getSelectedProjectId();
        if (want && want !== selId && list.some((p) => p.id === want)) await selectProject(want);
        const pending = takePendingInterpretation();
        if (pending && alive) runPunto(pending);
      } catch (e: any) {
        if (alive) { setProjects([]); setLoadError(e?.message || 'No se pudieron cargar los proyectos.'); }
      }
    })();
    return () => { alive = false; };
  }, [selId, selectProject, runPunto]));

  useEffect(() => { scrollRef.current?.scrollToEnd({ animated: true }); }, [messages, busy]);

  const send = async (text: string) => {
    const clean = text.trim();
    if (!clean || busy) return;
    const epoch = epochRef.current;
    const next: UiMsg[] = [...messages.filter((m) => !m.error), { role: 'user', content: clean }];
    setMessages(next); setInput(''); setBusy(true);
    try {
      const { reply, truncated } = await askVillegas(next.map(({ role, content }) => ({ role, content })), context);
      if (epoch !== epochRef.current) return;
      setMessages([...next, { role: 'assistant', content: reply, truncated }]);
    } catch (e: any) {
      if (epoch === epochRef.current) {
        setMessages([...next, { role: 'assistant', content: e?.message || 'No se pudo consultar al Ing. Villegas.', error: true }]);
      }
    } finally {
      if (epoch === epochRef.current) setBusy(false);
    }
  };

  const selected = projects?.find((p) => p.id === selId);
  const hasProjects = (projects?.length ?? 0) > 0;

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={s.head}>
        <Text style={s.title}>Ing. Villegas</Text>
        <Text style={s.muted}>Asistente geológico de IA · versión web</Text>
      </View>

      {projects === null && <ActivityIndicator color="#FFD700" style={{ marginTop: 24 }} />}
      {projects !== null && !hasProjects && !loadError && (
        <Text style={[s.muted, { padding: 16 }]}>Sin proyectos sincronizados en esta cuenta.</Text>
      )}

      {hasProjects && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.chips} contentContainerStyle={{ paddingHorizontal: 12 }}>
          {projects!.map((p) => (
            <TouchableOpacity key={p.id} onPress={() => selectProject(p.id)} style={[s.chip, p.id === selId && s.chipOn]}>
              <Text style={[s.chipText, p.id === selId && s.chipTextOn]} numberOfLines={1}>{p.nombre}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {!!loadError && <Text style={[s.error, { paddingHorizontal: 16 }]}>{loadError}</Text>}

      <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 24 }}>
        {loadingCtx && <ActivityIndicator color="#FFD700" />}

        {!loadingCtx && selected && messages.length === 0 && (
          <View style={s.intro}>
            <Text style={s.introTitle}>{selected.nombre}</Text>
            {context ? (
              <>
                <Text style={s.muted}>Tengo los resultados de este proyecto. Pídeme una interpretación o pregunta lo que quieras.</Text>
                <TouchableOpacity style={s.primary} onPress={() => send(INTERPRET_PROMPT)} disabled={busy}>
                  <Text style={s.primaryText}>Interpretar este proyecto</Text>
                </TouchableOpacity>
              </>
            ) : (
              <Text style={s.muted}>
                Este proyecto no tiene celdas analizadas todavía. Puedes correr uno desde Proyectos → ＋ Nuevo análisis; mientras tanto, pregúntame lo que quieras de geología.
              </Text>
            )}
          </View>
        )}
        {!selected && hasProjects && !loadingCtx && (
          <Text style={s.muted}>Elige un proyecto arriba para darme contexto, o escribe una pregunta general.</Text>
        )}

        {messages.map((m, i) => (
          <View key={i} style={[s.bubble, m.role === 'user' ? s.user : s.bot, m.error && s.err]}>
            {m.role === 'assistant' && !m.error
              ? <Markdown>{m.content}</Markdown>
              : <Text selectable style={[s.bubbleText, m.error && { color: '#FF9B9B' }]}>{m.content}</Text>}
            {m.truncated && (
              <Text style={s.trunc}>⚠ Respuesta recortada por longitud. Escribe «continúa» para que siga.</Text>
            )}
          </View>
        ))}
        {busy && (
          <View style={[s.bubble, s.bot, { flexDirection: 'row', alignItems: 'center' }]}>
            <ActivityIndicator color="#FFD700" size="small" />
            <Text style={[s.muted, { marginLeft: 10 }]}>El Ing. Villegas está pensando…</Text>
          </View>
        )}
      </ScrollView>

      <View style={s.composer}>
        <TextInput
          style={s.input} value={input} onChangeText={setInput}
          placeholder="Escribe tu pregunta…" placeholderTextColor="#666"
          multiline maxLength={4000} editable={!busy}
          onKeyPress={(e: any) => {
            // Escritorio: Enter envía, Shift+Enter salto de línea. En móvil solo el botón.
            if (Platform.OS === 'web' && e.nativeEvent.key === 'Enter' && !e.nativeEvent.shiftKey) {
              e.preventDefault?.(); send(input);
            }
          }}
        />
        <TouchableOpacity style={[s.send, (!input.trim() || busy) && { opacity: 0.4 }]} onPress={() => send(input)} disabled={!input.trim() || busy}>
          <Text style={s.sendText}>Enviar</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  head: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  title: { color: '#FFD700', fontSize: 24, fontWeight: '800' },
  muted: { color: '#888', fontSize: 13, marginTop: 4, lineHeight: 19 },
  error: { color: '#FF6B6B', marginTop: 8 },
  chips: { maxHeight: 48, flexGrow: 0, marginVertical: 8 },
  chip: { borderColor: '#2A2A2A', borderWidth: 1, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8, maxWidth: 200, justifyContent: 'center' },
  chipOn: { backgroundColor: '#FFD700', borderColor: '#FFD700' },
  chipText: { color: '#CCC', fontSize: 13 },
  chipTextOn: { color: '#000', fontWeight: '700' },
  intro: { backgroundColor: '#111', borderColor: '#2A2A2A', borderWidth: 1, borderRadius: 12, padding: 14 },
  introTitle: { color: '#FFF', fontSize: 16, fontWeight: '700' },
  primary: { backgroundColor: '#FFD700', borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 14 },
  primaryText: { color: '#000', fontWeight: '700', fontSize: 15 },
  bubble: { borderRadius: 14, padding: 12, marginBottom: 10, maxWidth: '92%' },
  user: { backgroundColor: '#2A2410', alignSelf: 'flex-end', borderColor: '#FFD70055', borderWidth: 1 },
  bot: { backgroundColor: '#141414', alignSelf: 'flex-start', borderColor: '#2A2A2A', borderWidth: 1 },
  err: { borderColor: '#FF6B6B88' },
  trunc: { color: '#FFB84D', fontSize: 12, marginTop: 8 },
  bubbleText: { color: '#EEE', fontSize: 15, lineHeight: 22 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', padding: 12, borderTopColor: '#222', borderTopWidth: 1, backgroundColor: '#0A0A0A' },
  input: {
    flex: 1, backgroundColor: '#161616', borderColor: '#2A2A2A', borderWidth: 1, borderRadius: 12, color: '#FFF',
    paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, maxHeight: 120,
  },
  send: { backgroundColor: '#FFD700', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12, marginLeft: 8 },
  sendText: { color: '#000', fontWeight: '700' },
});

/**
 * geologo.tsx (PWA) — chat con el Ing. Villegas.
 *
 * Consume POST /api/ai/villegas: el cliente manda mensajes + un bloque de DATOS del
 * proyecto elegido; el prompt vive en el servidor. La conversación se guarda en localStorage
 * de este navegador, una por proyecto ("general" si no hay) — ver web-lib/chatStore.ts. La PWA
 * no escribe nada en Supabase, así que no pisa el chat_history que guarda la app nativa.
 *
 * Reglas de conversación:
 *  - Cambiar de proyecto A → B muestra la conversación de B (la de A queda guardada, no se borra).
 *  - Un chat general que YA tenía mensajes en esta sesión se "adopta" al elegir un proyecto: no se pierde.
 *  - Cada petición recuerda su conversación de origen: si llega la respuesta cuando ya se cambió, se guarda ahí.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { listWebProjects, loadWebProject, loadWebSamples, type WebProjectSummary } from '../../app/core/webData';
import { askVillegas } from '../../web-lib/villegasClient';
import { buildProjectContext } from '../../web-lib/projectContext';
import {
  getSelectedProjectId, setSelectedProjectId, peekPendingInterpretation, clearPendingInterpretation,
} from '../../web-lib/selection';
import { GENERAL_KEY, loadChat, saveChat, appendChat, type StoredMsg } from '../../web-lib/chatStore';
import Markdown from '../../web-lib/Markdown';
import { confirmAction } from '../../web-lib/confirmAction';

type UiMsg = StoredMsg;
type Conv = { key: string };

const INTERPRET_PROMPT = 'Interpreta este proyecto: resumen, significado geológico y plan de campo.';

export default function GeologoWeb() {
  const [projects, setProjects] = useState<WebProjectSummary[] | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [context, setContext] = useState<string | null>(null);
  const [loadingCtx, setLoadingCtx] = useState(false);
  const [messages, setMessages] = useState<UiMsg[]>(() => loadChat(GENERAL_KEY));
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const scrollRef = useRef<ScrollView>(null);

  // Estado "de verdad" en refs: los callbacks son estables (no dependen de selId), así el efecto de foco
  // NO se reinicia a media ejecución al cambiar de proyecto (era lo que cancelaba la interpretación pendiente).
  const convRef = useRef<Conv>({ key: GENERAL_KEY }); // conversación activa; cada petición guarda la suya
  const msgsRef = useRef<UiMsg[]>(messages);
  const contextRef = useRef<string | null>(null);
  const selIdRef = useRef<string | null>(null);
  const liveGeneralRef = useRef(false); // hubo chat general en esta sesión de pantalla → se puede adoptar
  const ctxEpochRef = useRef(0);        // descarta cargas de contexto de un proyecto anterior

  const setMsgs = useCallback((next: UiMsg[]) => {
    msgsRef.current = next;
    setMessages(next);
    saveChat(convRef.current.key, next);
  }, []);

  /** Entrega un mensaje a SU conversación: si ya se cambió de chat, va al almacenamiento de la original. */
  const deliver = useCallback((conv: Conv, msg: UiMsg) => {
    if (convRef.current === conv) setMsgs([...msgsRef.current.filter((m) => !m.error), msg]);
    else if (!msg.error) appendChat(conv.key, msg);
  }, [setMsgs]);

  const loadContext = useCallback(async (id: string) => {
    const epoch = ++ctxEpochRef.current;
    setContext(null); contextRef.current = null; setLoadError(''); setLoadingCtx(true);
    try {
      const [p, samples] = await Promise.all([loadWebProject(id), loadWebSamples(id)]);
      if (epoch !== ctxEpochRef.current) return;
      const c = p ? buildProjectContext(p, samples) : null;
      contextRef.current = c; setContext(c);
    } catch (e: any) {
      if (epoch === ctxEpochRef.current) setLoadError(e?.message || 'No se pudo cargar el proyecto.');
    } finally {
      if (epoch === ctxEpochRef.current) setLoadingCtx(false);
    }
  }, []);

  const selectProject = useCallback((id: string) => {
    if (selIdRef.current === id) return;
    const adopt = convRef.current.key === GENERAL_KEY && liveGeneralRef.current
      && msgsRef.current.length > 0 && loadChat(id).length === 0;
    selIdRef.current = id; setSelId(id); setSelectedProjectId(id);
    if (adopt) {
      // El chat general en curso pasa a ser el de este proyecto (misma conversación, sin borrar nada ni cortar
      // una petición en vuelo: sigue apuntando al mismo objeto).
      convRef.current.key = id;
      saveChat(id, msgsRef.current); saveChat(GENERAL_KEY, []);
    } else {
      convRef.current = { key: id };
      msgsRef.current = loadChat(id); setMessages(msgsRef.current);
      setBusy(false);
    }
    liveGeneralRef.current = false;
    void loadContext(id);
  }, [loadContext]);

  const selectGeneral = useCallback(() => {
    if (selIdRef.current === null) return;
    selIdRef.current = null; setSelId(null); setSelectedProjectId(null);
    convRef.current = { key: GENERAL_KEY };
    msgsRef.current = loadChat(GENERAL_KEY); setMessages(msgsRef.current);
    ctxEpochRef.current += 1; setContext(null); contextRef.current = null; setLoadingCtx(false); setLoadError('');
    liveGeneralRef.current = false; setBusy(false);
  }, []);

  // Interpretación de UN punto (botón del panel de resultados): modo 'punto' del servidor, que
  // usa el prompt de interpretación estricta. Solo manda los datos reales del punto.
  const runPunto = useCallback(async (ctx: string) => {
    const conv = convRef.current;
    if (conv.key === GENERAL_KEY) liveGeneralRef.current = true;
    setMsgs([...msgsRef.current.filter((x) => !x.error), { role: 'user', content: 'Interpretación del punto que elegí en el mapa.' }]);
    setBusy(true);
    try {
      const { reply, truncated } = await askVillegas([{ role: 'user', content: ctx }], null, 'punto');
      deliver(conv, { role: 'assistant', content: reply, truncated });
    } catch (e: any) {
      deliver(conv, { role: 'assistant', content: e?.message || 'No se pudo interpretar el punto.', error: true });
    } finally {
      if (convRef.current === conv) setBusy(false);
    }
  }, [setMsgs, deliver]);

  // Al enfocar la pestaña: refresca la lista, respeta el proyecto elegido y ejecuta la interpretación pendiente.
  // La pendiente solo se consume cuando SE VA A EJECUTAR (si la pantalla pierde el foco a medias, queda para la próxima).
  useFocusEffect(useCallback(() => {
    let alive = true;
    (async () => {
      try {
        const list = await listWebProjects();
        if (!alive) return;
        setProjects(list);
        const pend = peekPendingInterpretation();
        const want = pend?.projectId ?? getSelectedProjectId();
        if (want && list.some((p) => p.id === want)) selectProject(want);
        if (!alive) return;
        const p2 = peekPendingInterpretation();
        if (p2) { clearPendingInterpretation(); void runPunto(p2.ctx); }
      } catch (e: any) {
        if (alive) { setProjects([]); setLoadError(e?.message || 'No se pudieron cargar los proyectos.'); }
      }
    })();
    return () => { alive = false; };
  }, [selectProject, runPunto]));

  useEffect(() => { scrollRef.current?.scrollToEnd({ animated: true }); }, [messages, busy]);

  const send = async (text: string) => {
    const clean = text.trim();
    if (!clean || busy) return;
    const conv = convRef.current;
    if (conv.key === GENERAL_KEY) liveGeneralRef.current = true;
    const next: UiMsg[] = [...msgsRef.current.filter((m) => !m.error), { role: 'user', content: clean }];
    setMsgs(next); setInput(''); setBusy(true);
    try {
      const { reply, truncated } = await askVillegas(next.map(({ role, content }) => ({ role, content })), contextRef.current);
      deliver(conv, { role: 'assistant', content: reply, truncated });
    } catch (e: any) {
      deliver(conv, { role: 'assistant', content: e?.message || 'No se pudo consultar al Ing. Villegas.', error: true });
    } finally {
      if (convRef.current === conv) setBusy(false);
    }
  };

  const selected = projects?.find((p) => p.id === selId);
  const hasProjects = (projects?.length ?? 0) > 0;

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={s.head}>
        <Text style={s.title}>Ing. Villegas</Text>
        <Text style={s.muted}>Asistente geológico de IA · versión web</Text>
        {messages.length > 0 && (
          <TouchableOpacity
            onPress={() => {
              // Auditoría de usabilidad (2026-09-21): borraba TODA la conversación (puede ser de días) de un
              // solo toque, sin avisar ni poder deshacerlo. Se confirma antes.
              if (!confirmAction('¿Borrar esta conversación?', 'Se perderá todo el historial de este chat.')) return;
              setMsgs([]);
            }}
            disabled={busy} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={s.clearLink}>Borrar esta conversación</Text>
          </TouchableOpacity>
        )}
      </View>

      {projects === null && <ActivityIndicator color="#FFD700" style={{ marginTop: 24 }} />}
      {projects !== null && !hasProjects && !loadError && (
        <Text style={[s.muted, { padding: 16 }]}>Sin proyectos sincronizados en esta cuenta.</Text>
      )}

      {(hasProjects || messages.length > 0) && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.chips} contentContainerStyle={{ paddingHorizontal: 12 }}>
          <TouchableOpacity onPress={selectGeneral} style={[s.chip, selId === null && s.chipOn]}>
            <Text style={[s.chipText, selId === null && s.chipTextOn]}>General</Text>
          </TouchableOpacity>
          {(projects ?? []).map((p) => (
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
  clearLink: { color: '#777', fontSize: 12, marginTop: 6, textDecorationLine: 'underline' },
  error: { color: '#FF6B6B', marginTop: 8 },
  chips: { maxHeight: 52, flexGrow: 0, marginVertical: 8 },
  // Chip de proyecto agrandado (uso con prisa/manos torpes): ~44px de alto, antes ~36px.
  chip: { borderColor: '#2A2A2A', borderWidth: 1, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 11, marginRight: 8, maxWidth: 200, minHeight: 44, justifyContent: 'center' },
  chipOn: { backgroundColor: '#FFD700', borderColor: '#FFD700' },
  chipText: { color: '#CCC', fontSize: 13 },
  chipTextOn: { color: '#000', fontWeight: '700' },
  intro: { backgroundColor: '#111', borderColor: '#2A2A2A', borderWidth: 1, borderRadius: 12, padding: 14 },
  introTitle: { color: '#FFF', fontSize: 16, fontWeight: '700' },
  // Repaso de consistencia (2026-09-21): mismo mínimo de 52px que login.tsx/proyectos.tsx en las 5 pantallas.
  primary: { backgroundColor: '#FFD700', borderRadius: 10, paddingVertical: 12, minHeight: 52, justifyContent: 'center', alignItems: 'center', marginTop: 14 },
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
    paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, minHeight: 52, maxHeight: 120,
  },
  send: { backgroundColor: '#FFD700', borderRadius: 12, paddingHorizontal: 18, minHeight: 52, justifyContent: 'center', alignItems: 'center', marginLeft: 8 },
  sendText: { color: '#000', fontWeight: '700' },
});

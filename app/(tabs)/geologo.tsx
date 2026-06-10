import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  ActivityIndicator, StyleSheet, KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { askClaudeGeologoExperto } from '../core/ClaudeServices';
import { loadLastAnalysis, getMuestras, saveProjectChatHistory, loadProjectState } from '../core/Database';

const PROJ_KEY = 'currentProjectId';

type Message = { role: 'user' | 'assistant'; content: string };

function formatContext(
  analysis: Awaited<ReturnType<typeof loadLastAnalysis>>,
  samples: any[]
): string {
  if (!analysis) return '';
  const points: any[] = analysis.analisis_resultado || [];
  const topPoints = points.slice(0, 5).map((p, i) => {
    const score = p.score ?? p.base_score ?? 0;
    const level = score >= 65 ? 'ALTA' : score >= 35 ? 'MEDIA' : 'BAJA';
    const conf = p.consensus === 'PRIORITY_TARGET'
      ? ' 🎯 OBJETIVO PRIORITARIO S2+ASTER+Estructura'
      : p.consensus === 'CONFIRMED' ? ' ✅ CONFIRMADA S2+ASTER' : '';
    return `  #${i + 1} Lat:${p.lat?.toFixed(5)}, Lng:${p.lng?.toFixed(5)} — ${level} alteración (score:${Math.round(score)})${conf}`;
  }).join('\n');

  // Structural lineament and priority target summaries
  const lineamentCount  = points.filter((p: any) => p.near_lineament).length;
  const priorityCount   = points.filter((p: any) => p.consensus === 'PRIORITY_TARGET').length;
  const structuralLines: string[] = [];
  if (lineamentCount > 0) {
    structuralLines.push(`LINEAMIENTOS: ${lineamentCount} punto${lineamentCount > 1 ? 's' : ''} cruzan con estructuras (posibles fallas/fracturas)`);
  }
  if (priorityCount > 0) {
    structuralLines.push(`OBJETIVOS PRIORITARIOS: ${priorityCount} zona${priorityCount > 1 ? 's' : ''} con anomalía espectral confirmada + control estructural`);
  }
  const structuralSection = structuralLines.length > 0 ? `\n${structuralLines.join('\n')}` : '';

  const sampleLines = samples.slice(0, 5).map((s, i) => {
    const ia = s.analisis_ia ? JSON.parse(s.analisis_ia) : null;
    const mineral = ia?.mineral_detectado || s.mineral_detectado || '—';
    const prob = ia?.probabilidad ? ` (${ia.probabilidad}%)` : '';
    const nota = s.descripcion_texto ? ` — "${s.descripcion_texto}"` : '';
    return `  ${i + 1}. ${mineral}${prob}${nota}`;
  }).join('\n');

  const source = analysis.satdata_source || 'Sentinel-2';
  const dateStr = analysis.acquisition_date ? ` · imagen ${analysis.acquisition_date}` : '';
  const area = analysis.coordenadas?.length > 0
    ? ` · ${analysis.coordenadas.length} vértices`
    : '';

  return `[CONTEXTO — ÚLTIMO ANÁLISIS]
Mineral objetivo: ${analysis.mineral?.toUpperCase()}
Terreno: ${analysis.terrain}  Roca: ${analysis.rock_type}
Fuente: ${source}${dateStr}${area}

Anomalías detectadas (top ${Math.min(5, points.length)} de ${points.length}):
${topPoints || '  (sin datos)'}${structuralSection}
${samples.length > 0 ? `\nMuestras de campo (${samples.length} total):\n${sampleLines}` : ''}

Responde con:
1. Resumen interpretativo: ¿qué ves?, ¿qué patrón de alteración muestra?
2. Significado geológico: ¿qué sistema mineral es compatible?
3. Plan de campo: ¿dónde caminar primero y qué buscar?`;
}

export default function GeologoScreen() {
  const [messages, setMessages]     = useState<Message[]>([]);
  const [input, setInput]           = useState('');
  const [isTyping, setIsTyping]     = useState(false);
  const [projectId, setProjectId]   = useState('default');
  const [hasAnalysis, setHasAnalysis] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => { initialize(); }, []);

  const initialize = async () => {
    const pid = (await AsyncStorage.getItem(PROJ_KEY)) || 'default';
    setProjectId(pid);

    // Try to restore saved chat history
    const proj = await loadProjectState(pid);
    const history: Message[] = (proj?.chat_history as Message[]) || [];
    if (history.length > 0) {
      setMessages(history);
      setHasAnalysis(true);
      return;
    }

    // No history — load last analysis and send context to geologist
    await sendInitialContext(pid);
  };

  const sendInitialContext = async (pid: string) => {
    const analysis = await loadLastAnalysis();
    const samples  = await getMuestras();
    if (!analysis || (analysis.analisis_resultado || []).length === 0) {
      const noDataMsg: Message = {
        role: 'assistant',
        content: 'No encuentro análisis de zona guardados todavía.\n\nPara comenzar: dibuja un polígono en el mapa, presiona ANALIZAR y luego vuelve aquí. Te daré una interpretación geológica completa del área.',
      };
      setMessages([noDataMsg]);
      await saveProjectChatHistory(pid, [noDataMsg]);
      return;
    }

    setHasAnalysis(true);
    const contextMsg = formatContext(analysis, Array.isArray(samples) ? samples : []);
    const ctxMessage: Message = { role: 'user', content: contextMsg };
    setIsTyping(true);
    try {
      const reply = await askClaudeGeologoExperto([ctxMessage]);
      const initialMessages: Message[] = [{ role: 'assistant', content: reply }];
      setMessages(initialMessages);
      await saveProjectChatHistory(pid, initialMessages);
    } catch (e: any) {
      const errMsg: Message = { role: 'assistant', content: `Error al consultar al geólogo: ${e.message}` };
      setMessages([errMsg]);
    } finally {
      setIsTyping(false);
    }
  };

  const refreshContext = () => {
    Alert.alert(
      'Nuevo análisis',
      '¿Cargar el contexto del último análisis y reiniciar la conversación?',
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Sí, reiniciar', onPress: async () => {
          setMessages([]);
          await saveProjectChatHistory(projectId, []);
          await sendInitialContext(projectId);
        }},
      ]
    );
  };

  const sendMessage = async () => {
    if (!input.trim() || isTyping) return;
    const userMsg: Message = { role: 'user', content: input.trim() };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput('');
    setIsTyping(true);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    try {
      const reply = await askClaudeGeologoExperto(next);
      const final = [...next, { role: 'assistant' as const, content: reply }];
      setMessages(final);
      await saveProjectChatHistory(projectId, final);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setIsTyping(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>🪨 GEÓLOGO EXPERTO</Text>
        <TouchableOpacity onPress={refreshContext} style={styles.refreshBtn}>
          <Text style={styles.refreshText}>↺ Nuevo análisis</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.chatArea}
        contentContainerStyle={{ padding: 12, paddingBottom: 24 }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        {messages.map((m, i) => (
          <View key={i} style={[styles.bubble, m.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant]}>
            {m.role === 'assistant' && (
              <Text style={styles.bubbleSender}>Dr. Ruiz</Text>
            )}
            <Text style={m.role === 'user' ? styles.bubbleUserText : styles.bubbleAssistantText}>
              {m.content}
            </Text>
          </View>
        ))}
        {isTyping && (
          <View style={[styles.bubble, styles.bubbleAssistant, { flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
            <ActivityIndicator size="small" color="#FFD700" />
            <Text style={{ color: '#888', fontSize: 12 }}>Analizando...</Text>
          </View>
        )}
      </ScrollView>

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Pregunta al geólogo..."
          placeholderTextColor="#555"
          multiline
          maxLength={800}
          onSubmitEditing={sendMessage}
        />
        <TouchableOpacity
          style={[styles.sendBtn, (!input.trim() || isTyping) && { opacity: 0.4 }]}
          onPress={sendMessage}
          disabled={!input.trim() || isTyping}
        >
          <Text style={styles.sendBtnText}>▶</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#000' },
  header:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14, paddingTop: 54, borderBottomWidth: 1, borderBottomColor: '#222', backgroundColor: '#050505' },
  headerTitle:  { color: '#FFD700', fontSize: 16, fontWeight: '900', letterSpacing: 0.5 },
  refreshBtn:   { padding: 6 },
  refreshText:  { color: '#666', fontSize: 12 },
  chatArea:     { flex: 1 },
  bubble:       { maxWidth: '88%', borderRadius: 12, padding: 12, marginBottom: 10 },
  bubbleAssistant: { alignSelf: 'flex-start', backgroundColor: '#0C1A0C', borderWidth: 1, borderColor: '#1E3A1E' },
  bubbleUser:      { alignSelf: 'flex-end', backgroundColor: '#1A1A00', borderWidth: 1, borderColor: '#3A3A00' },
  bubbleSender: { color: '#4CAF50', fontSize: 9, fontWeight: '700', letterSpacing: 0.8, marginBottom: 4 },
  bubbleAssistantText: { color: '#DDD', fontSize: 13, lineHeight: 19 },
  bubbleUserText:      { color: '#FFD700', fontSize: 13, lineHeight: 19 },
  inputRow:     { flexDirection: 'row', padding: 10, paddingBottom: 24, borderTopWidth: 1, borderTopColor: '#1A1A1A', gap: 8, backgroundColor: '#050505' },
  input:        { flex: 1, backgroundColor: '#111', color: '#FFF', borderRadius: 10, borderWidth: 1, borderColor: '#333', paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, maxHeight: 100 },
  sendBtn:      { backgroundColor: '#FFD700', borderRadius: 10, paddingHorizontal: 16, justifyContent: 'center', alignItems: 'center', minWidth: 44 },
  sendBtnText:  { color: '#000', fontWeight: '900', fontSize: 16 },
});

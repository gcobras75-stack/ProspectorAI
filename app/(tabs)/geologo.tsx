import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, Image,
  ActivityIndicator, StyleSheet, KeyboardAvoidingView, Platform, Alert, Modal, FlatList,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import * as ImagePicker from 'expo-image-picker';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { askClaudeGeologoExperto, askClaudeInterpretacionPunto, photoUriToBase64 } from '../core/ClaudeServices';
import { loadLastAnalysis, getMuestras, saveProjectChatHistory, loadProjectState, loadFieldPackage, loadProjectWaypoints } from '../core/Database';
import { useBadge } from '../core/BadgeContext';

const PROJ_KEY = 'currentProjectId';
const PENDING_INTERP_KEY = 'pendingGeologoInterpretation';

// Multimodal content mirrors ClaudeServices type
type ContentBlock =
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'text'; text: string };

type MessageContent = string | ContentBlock[];

type Message = { role: 'user' | 'assistant'; content: MessageContent };

type WaypointItem = {
  id: string;
  lat: number;
  lng: number;
  foto_uri: string;
  analisis_texto: string;
  fecha: string;
  nearestCellLabel?: string;
};

// ── Euclidean distance (degrees) between two lat/lng points ──────────────────
function euclideanDist(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = lat1 - lat2;
  const dLng = lng1 - lng2;
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

// ── Find nearest analysis point and return a short label ─────────────────────
function nearestCellLabel(wpLat: number, wpLng: number, points: any[]): string | undefined {
  if (!points || points.length === 0) return undefined;
  let best = points[0];
  let bestDist = euclideanDist(wpLat, wpLng, best.lat ?? 0, best.lng ?? 0);
  for (let i = 1; i < points.length; i++) {
    const d = euclideanDist(wpLat, wpLng, points[i].lat ?? 0, points[i].lng ?? 0);
    if (d < bestDist) { bestDist = d; best = points[i]; }
  }
  // Only attach label if within ~5km (0.045 degrees roughly)
  if (bestDist > 0.045) return undefined;
  const consensus = best.consensus === 'PRIORITY_TARGET'
    ? 'OBJETIVO PRIORITARIO'
    : best.consensus === 'CONFIRMED'
    ? 'CONFIRMADO'
    : best.consensus ?? '';
  const s2 = best.s2Score != null ? ' S2 ✓' : '';
  const aster = best.asterScore != null ? ' ASTER ✓' : '';
  return consensus ? `[celda: ${consensus}${s2}${aster}]` : undefined;
}

function formatContext(
  analysis: Awaited<ReturnType<typeof loadLastAnalysis>>,
  samples: any[],
  waypoints: WaypointItem[],
  analysisPoints: any[]
): string {
  if (!analysis) return '';
  const points: any[] = analysis.analisis_resultado || [];
  const topPoints = points.slice(0, 5).map((p, i) => {
    const score = p.score ?? p.base_score ?? 0;
    const level = score >= 65 ? 'ALTA' : score >= 35 ? 'MEDIA' : 'BAJA';
    const conf = p.consensus === 'PRIORITY_TARGET'
      ? ' OBJETIVO PRIORITARIO S2+ASTER+Estructura'
      : p.consensus === 'CONFIRMED' ? ' CONFIRMADA S2+ASTER' : '';
    return `  #${i + 1} Lat:${p.lat?.toFixed(5)}, Lng:${p.lng?.toFixed(5)} — ${level} alteracion (score:${Math.round(score)})${conf}`;
  }).join('\n');

  const lineamentCount  = points.filter((p: any) => p.near_lineament).length;
  const priorityCount   = points.filter((p: any) => p.consensus === 'PRIORITY_TARGET').length;
  const structuralLines: string[] = [];
  if (lineamentCount > 0) {
    structuralLines.push(`LINEAMIENTOS: ${lineamentCount} punto${lineamentCount > 1 ? 's' : ''} cruzan con estructuras (posibles fallas/fracturas)`);
  }
  if (priorityCount > 0) {
    structuralLines.push(`OBJETIVOS PRIORITARIOS: ${priorityCount} zona${priorityCount > 1 ? 's' : ''} con anomalia espectral confirmada + control estructural`);
  }
  const emitCount = points.filter((p: any) => p.emitScore !== null && p.emitScore !== undefined && p.emitScore >= 65).length;
  if (emitCount > 0) {
    structuralLines.push(`EMIT hiperspectral: ${emitCount} celdas con senal mineral >=65`);
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
    ? ` · ${analysis.coordenadas.length} vertices`
    : '';

  // Waypoints section (text only, no images — cost control)
  let waypointsSection = '';
  if (waypoints.length > 0) {
    const lines = waypoints.slice(0, 10).map((w, i) => {
      const cellLabel = nearestCellLabel(w.lat, w.lng, analysisPoints) ?? '';
      const dateShort = w.fecha.slice(0, 10);
      const analText = w.analisis_texto ? ` · Analisis: ${w.analisis_texto.slice(0, 100)}` : '';
      const cell = cellLabel ? ` · ${cellLabel}` : '';
      return `  #${i + 1}: ${w.lat.toFixed(5)}, ${w.lng.toFixed(5)} · ${dateShort}${analText}${cell}`;
    }).join('\n');
    waypointsSection = `\nMUESTRAS DE CAMPO (${waypoints.length} waypoints con foto):\n${lines}`;
  }

  return `[CONTEXTO — ULTIMO ANALISIS]
Mineral objetivo: ${analysis.mineral?.toUpperCase()}
Terreno: ${analysis.terrain}  Roca: ${analysis.rock_type}
Fuente: ${source}${dateStr}${area}

Anomalias detectadas (top ${Math.min(5, points.length)} de ${points.length}):
${topPoints || '  (sin datos)'}${structuralSection}
${samples.length > 0 ? `\nMuestras de campo (${samples.length} total):\n${sampleLines}` : ''}${waypointsSection}

Responde con:
1. Resumen interpretativo: que ves?, que patron de alteracion muestra?
2. Significado geologico: que sistema mineral es compatible?
3. Plan de campo: donde caminar primero y que buscar?`;
}

// ── Render helper: extract display text from a message content ───────────────
function getDisplayText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  const textBlock = content.find((b): b is { type: 'text'; text: string } => b.type === 'text');
  return textBlock?.text ?? '';
}

function hasImage(content: MessageContent): boolean {
  if (typeof content === 'string') return false;
  return content.some(b => b.type === 'image');
}

export default function GeologoScreen() {
  const [messages, setMessages]       = useState<Message[]>([]);
  const [input, setInput]             = useState('');
  const [isTyping, setIsTyping]       = useState(false);
  const [projectId, setProjectId]     = useState('default');
  const [hasAnalysis, setHasAnalysis] = useState(false);
  const [isConnected, setIsConnected] = useState(true);
  const [fieldPackage, setFieldPackage] = useState<{
    preparado_at: string; resumen_geologo: string; analisis_json: string; mapa_b64: string; size_kb: number;
  } | null>(null);
  const [pendingPhoto, setPendingPhoto] = useState<{ uri: string; waypointContext?: string } | null>(null);
  const [waypointList, setWaypointList] = useState<WaypointItem[]>([]);
  const [showWaypointPicker, setShowWaypointPicker] = useState(false);
  const analysisPointsRef = useRef<any[]>([]);
  const scrollRef = useRef<ScrollView>(null);
  const pendingHandledRef = useRef(false);

  const { setGeologoBadge } = useBadge();

  // Process an interpretation request queued from the point card (SelectedPointModal).
  // Uses ONLY the real point context; the strict anti-hallucination system prompt lives
  // in askClaudeInterpretacionPunto. Guarded so it runs exactly once per request.
  const processPendingInterpretation = useCallback(async () => {
    if (pendingHandledRef.current) return;
    const pending = await AsyncStorage.getItem(PENDING_INTERP_KEY);
    if (!pending) return;
    pendingHandledRef.current = true;
    await AsyncStorage.removeItem(PENDING_INTERP_KEY);

    const pid = (await AsyncStorage.getItem(PROJ_KEY)) || 'default';
    setProjectId(pid);
    setHasAnalysis(true);

    const proj = await loadProjectState(pid);
    const history: Message[] = (proj?.chat_history as Message[]) || [];
    const userMsg: Message = { role: 'user', content: pending };
    const withUser = [...history, userMsg];
    setMessages(withUser);
    setIsTyping(true);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    try {
      const reply = await askClaudeInterpretacionPunto(pending);
      const final = [...withUser, { role: 'assistant' as const, content: reply }];
      setMessages(final);
      await saveProjectChatHistory(pid, final);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (e: any) {
      setMessages([...withUser, { role: 'assistant', content: `Error al generar la interpretación: ${e.message}` }]);
    } finally {
      setIsTyping(false);
      pendingHandledRef.current = false;
    }
  }, []);

  useFocusEffect(useCallback(() => {
    setGeologoBadge(false);
    processPendingInterpretation();
  }, [setGeologoBadge, processPendingInterpretation]));

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      setIsConnected(!!(state.isConnected && state.isInternetReachable));
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => { initialize(); }, []);

  const initialize = async () => {
    const pid = (await AsyncStorage.getItem(PROJ_KEY)) || 'default';
    setProjectId(pid);

    try { setFieldPackage(await loadFieldPackage(pid)); } catch (_) {}

    const proj = await loadProjectState(pid);
    const history: Message[] = (proj?.chat_history as Message[]) || [];
    if (history.length > 0) {
      setMessages(history);
      setHasAnalysis(true);
      return;
    }

    // If an interpretation was queued from the point card, let the focus effect
    // handle it instead of auto-generating a full-analysis summary here.
    const pending = await AsyncStorage.getItem(PENDING_INTERP_KEY);
    if (pending || pendingHandledRef.current) {
      setHasAnalysis(true);
      return;
    }

    await sendInitialContext(pid);
  };

  const sendInitialContext = async (pid: string) => {
    const analysis = await loadLastAnalysis();
    const samples  = await getMuestras();

    if (!analysis || (analysis.analisis_resultado || []).length === 0) {
      const noDataMsg: Message = {
        role: 'assistant',
        content: 'No encuentro analisis de zona guardados todavia.\n\nPara comenzar: dibuja un poligono en el mapa, presiona ANALIZAR y luego vuelve aqui. Te dare una interpretacion geologica completa del area.',
      };
      setMessages([noDataMsg]);
      await saveProjectChatHistory(pid, [noDataMsg]);
      return;
    }

    setHasAnalysis(true);
    const aPoints: any[] = analysis.analisis_resultado || [];
    analysisPointsRef.current = aPoints;

    const waypoints = await loadProjectWaypoints(pid);

    const contextMsg = formatContext(
      analysis,
      Array.isArray(samples) ? samples : [],
      waypoints,
      aPoints
    );
    const ctxMessage: Message = { role: 'user', content: contextMsg };
    setIsTyping(true);
    try {
      const reply = await askClaudeGeologoExperto([ctxMessage]);
      const initialMessages: Message[] = [{ role: 'assistant', content: reply }];
      setMessages(initialMessages);
      await saveProjectChatHistory(pid, initialMessages);
    } catch (e: any) {
      const errMsg: Message = { role: 'assistant', content: `Error al consultar al geologo: ${e.message}` };
      setMessages([errMsg]);
    } finally {
      setIsTyping(false);
    }
  };

  const refreshContext = () => {
    Alert.alert(
      'Nuevo analisis',
      'Cargar el contexto del ultimo analisis y reiniciar la conversacion?',
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Si, reiniciar', onPress: async () => {
          setMessages([]);
          await saveProjectChatHistory(projectId, []);
          await sendInitialContext(projectId);
        }},
      ]
    );
  };

  const handleAttachPhoto = useCallback(async () => {
    // Load waypoints for the picker
    const wps = await loadProjectWaypoints(projectId);
    const wpsWithLabel: WaypointItem[] = wps.map(w => ({
      ...w,
      nearestCellLabel: nearestCellLabel(w.lat, w.lng, analysisPointsRef.current),
    }));
    setWaypointList(wpsWithLabel);

    Alert.alert('Adjuntar foto', 'Selecciona el origen de la imagen:', [
      {
        text: '📷 Tomar foto',
        onPress: async () => {
          const { status } = await ImagePicker.requestCameraPermissionsAsync();
          if (status !== 'granted') {
            Alert.alert('Permiso denegado', 'Se necesita acceso a la camara para tomar fotos.');
            return;
          }
          const result = await ImagePicker.launchCameraAsync({
            mediaTypes: ['images'],
            quality: 0.7,
            base64: false,
          });
          if (!result.canceled && result.assets[0]) {
            setPendingPhoto({ uri: result.assets[0].uri });
          }
        },
      },
      {
        text: '🖼️ Elegir de galería',
        onPress: async () => {
          const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (status !== 'granted') {
            Alert.alert('Permiso denegado', 'Se necesita acceso a la galería para elegir una foto ya tomada.');
            return;
          }
          const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            quality: 0.7,
            base64: false,
          });
          if (!result.canceled && result.assets[0]) {
            setPendingPhoto({ uri: result.assets[0].uri });
          }
        },
      },
      {
        text: '📍 Mis waypoints',
        onPress: () => {
          if (wpsWithLabel.length === 0) {
            Alert.alert('Sin fotos', 'No hay waypoints con fotos en este proyecto.');
            return;
          }
          setShowWaypointPicker(true);
        },
      },
      { text: 'Cancelar', style: 'cancel' },
    ]);
  }, [projectId]);

  const selectWaypoint = useCallback((wp: WaypointItem) => {
    setShowWaypointPicker(false);
    const dateShort = wp.fecha.slice(0, 10);
    const cellPart = wp.nearestCellLabel ? ` · ${wp.nearestCellLabel}` : '';
    const analysisPart = wp.analisis_texto ? ` · "${wp.analisis_texto.slice(0, 80)}"` : '';
    const context = `Waypoint ${wp.lat.toFixed(5)}, ${wp.lng.toFixed(5)} · ${dateShort}${analysisPart}${cellPart}`;
    setPendingPhoto({ uri: wp.foto_uri, waypointContext: context });
  }, []);

  const sendMessage = async () => {
    if ((!input.trim() && !pendingPhoto) || isTyping) return;

    let userMessageContent: MessageContent;

    if (pendingPhoto) {
      const base64 = await photoUriToBase64(pendingPhoto.uri);
      if (base64) {
        const contextPrefix = pendingPhoto.waypointContext
          ? `[FOTO DE CAMPO: ${pendingPhoto.waypointContext}]\n\n`
          : '';
        const textPart = contextPrefix + (input.trim() || 'Analiza esta foto de campo.');
        userMessageContent = [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
          { type: 'text', text: textPart },
        ];
      } else {
        // Fallback: text only with note
        userMessageContent = (input.trim() || 'Foto adjunta.') + '\n[Nota: no se pudo adjuntar la imagen]';
      }
      setPendingPhoto(null);
    } else {
      userMessageContent = input.trim();
    }

    const userMsg: Message = { role: 'user', content: userMessageContent };
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

  const canSend = (input.trim().length > 0 || pendingPhoto !== null) && !isTyping;

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>GEOLOGO EXPERTO</Text>
        <TouchableOpacity onPress={refreshContext} style={styles.refreshBtn}>
          <Text style={styles.refreshText}>Nuevo analisis</Text>
        </TouchableOpacity>
      </View>

      {!isConnected && fieldPackage && fieldPackage.resumen_geologo ? (
        <View style={{ backgroundColor: '#1A2A1A', padding: 10, borderRadius: 8, margin: 8, borderWidth: 1, borderColor: '#2E4A2E' }}>
          <Text style={{ color: '#4CAF50', fontSize: 10, fontWeight: '900' }}>RESUMEN GUARDADO — sin conexion</Text>
          <Text style={{ color: '#CCC', fontSize: 11, marginTop: 4 }}>{fieldPackage.resumen_geologo}</Text>
        </View>
      ) : null}

      <ScrollView
        ref={scrollRef}
        style={styles.chatArea}
        contentContainerStyle={{ padding: 12, paddingBottom: 24 }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        {messages.map((m, i) => (
          <View key={i} style={[styles.bubble, m.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant]}>
            {m.role === 'assistant' && (
              <Text style={styles.bubbleSender}>Ing. Villegas</Text>
            )}
            {hasImage(m.content) && (
              <View style={styles.photoIndicator}>
                <MaterialCommunityIcons name="image" size={14} color="#FFD700" />
                <Text style={styles.photoIndicatorText}> Foto adjunta</Text>
              </View>
            )}
            <Text style={m.role === 'user' ? styles.bubbleUserText : styles.bubbleAssistantText}>
              {getDisplayText(m.content)}
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

      {/* Pending photo preview */}
      {pendingPhoto && (
        <View style={styles.photoPreview}>
          <Image source={{ uri: pendingPhoto.uri }} style={styles.photoPreviewImg} />
          {pendingPhoto.waypointContext && (
            <Text style={styles.photoCtx} numberOfLines={2}>{pendingPhoto.waypointContext}</Text>
          )}
          <TouchableOpacity onPress={() => setPendingPhoto(null)} style={styles.photoRemoveBtn}>
            <MaterialCommunityIcons name="close-circle" size={22} color="#FF5722" />
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.inputRow}>
        <TouchableOpacity onPress={handleAttachPhoto} style={styles.attachBtn}>
          <MaterialCommunityIcons name="paperclip" size={20} color="#FFD700" />
        </TouchableOpacity>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Pregunta al geologo..."
          placeholderTextColor="#555"
          multiline
          maxLength={800}
          onSubmitEditing={sendMessage}
        />
        <TouchableOpacity
          style={[styles.sendBtn, !canSend && { opacity: 0.4 }]}
          onPress={sendMessage}
          disabled={!canSend}
        >
          <Text style={styles.sendBtnText}>&#x25B6;</Text>
        </TouchableOpacity>
      </View>

      {/* Waypoint picker modal */}
      <Modal
        visible={showWaypointPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowWaypointPicker(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Seleccionar waypoint</Text>
              <TouchableOpacity onPress={() => setShowWaypointPicker(false)}>
                <MaterialCommunityIcons name="close" size={22} color="#AAA" />
              </TouchableOpacity>
            </View>
            <FlatList
              data={waypointList}
              keyExtractor={item => item.id}
              style={{ maxHeight: 400 }}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.waypointRow} onPress={() => selectWaypoint(item)}>
                  <Image source={{ uri: item.foto_uri }} style={styles.waypointThumb} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.waypointCoord}>
                      {item.lat.toFixed(5)}, {item.lng.toFixed(5)}
                    </Text>
                    <Text style={styles.waypointDate}>{item.fecha.slice(0, 10)}</Text>
                    {item.nearestCellLabel && (
                      <Text style={styles.waypointCell}>{item.nearestCellLabel}</Text>
                    )}
                    {item.analisis_texto ? (
                      <Text style={styles.waypointAnalysis} numberOfLines={1}>
                        {item.analisis_texto.slice(0, 60)}
                      </Text>
                    ) : null}
                  </View>
                </TouchableOpacity>
              )}
              ListEmptyComponent={<Text style={{ color: '#666', padding: 16 }}>Sin waypoints con foto.</Text>}
            />
          </View>
        </View>
      </Modal>
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
  bubbleAssistant:    { alignSelf: 'flex-start', backgroundColor: '#0C1A0C', borderWidth: 1, borderColor: '#1E3A1E' },
  bubbleUser:         { alignSelf: 'flex-end', backgroundColor: '#1A1A00', borderWidth: 1, borderColor: '#3A3A00' },
  bubbleSender:       { color: '#4CAF50', fontSize: 9, fontWeight: '700', letterSpacing: 0.8, marginBottom: 4 },
  bubbleAssistantText:{ color: '#DDD', fontSize: 13, lineHeight: 19 },
  bubbleUserText:     { color: '#FFD700', fontSize: 13, lineHeight: 19 },
  photoIndicator:     { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  photoIndicatorText: { color: '#FFD700', fontSize: 11 },

  // Photo preview above input
  photoPreview:    { flexDirection: 'row', alignItems: 'center', backgroundColor: '#111', borderTopWidth: 1, borderTopColor: '#222', paddingHorizontal: 12, paddingVertical: 8, gap: 10 },
  photoPreviewImg: { width: 72, height: 72, borderRadius: 8, backgroundColor: '#222' },
  photoCtx:        { flex: 1, color: '#AAA', fontSize: 11, lineHeight: 15 },
  photoRemoveBtn:  { padding: 4 },

  inputRow:     { flexDirection: 'row', padding: 10, paddingBottom: 24, borderTopWidth: 1, borderTopColor: '#1A1A1A', gap: 8, backgroundColor: '#050505', alignItems: 'flex-end' },
  attachBtn:    { backgroundColor: '#111', borderRadius: 10, borderWidth: 1, borderColor: '#333', padding: 10, justifyContent: 'center', alignItems: 'center' },
  input:        { flex: 1, backgroundColor: '#111', color: '#FFF', borderRadius: 10, borderWidth: 1, borderColor: '#333', paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, maxHeight: 100 },
  sendBtn:      { backgroundColor: '#FFD700', borderRadius: 10, paddingHorizontal: 16, justifyContent: 'center', alignItems: 'center', minWidth: 44, height: 44 },
  sendBtnText:  { color: '#000', fontWeight: '900', fontSize: 16 },

  // Waypoint picker modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalCard:    { backgroundColor: '#0D0D0D', borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16, borderWidth: 1, borderColor: '#222' },
  modalHeader:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  modalTitle:   { color: '#FFD700', fontWeight: '700', fontSize: 15 },
  waypointRow:  { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#1A1A1A', gap: 10 },
  waypointThumb:{ width: 60, height: 60, borderRadius: 8, backgroundColor: '#222' },
  waypointCoord:{ color: '#FFF', fontSize: 13, fontWeight: '600' },
  waypointDate: { color: '#666', fontSize: 11, marginTop: 2 },
  waypointCell: { color: '#4CAF50', fontSize: 11, marginTop: 2, fontWeight: '600' },
  waypointAnalysis: { color: '#999', fontSize: 11, marginTop: 2 },
});

import React from 'react';
import { View, Text, Modal, TouchableOpacity, ScrollView, TextInput, ActivityIndicator, Image, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { ClaudeAnalysis } from '../core/ClaudeServices';
import { Colors, Touch, Radii } from '../core/theme';

interface WaypointModalProps {
  visible: boolean;
  isFieldMode: boolean;
  activeProject: string;
  mapCenterLat?: number;
  gpsLat?: number;
  gpsLng?: number;
  sampleBase64: string | null;
  sampleCaptureType: string;
  isAiProcessing: boolean;
  aiResult: ClaudeAnalysis | null;
  waypointNote: string;
  onWaypointNoteChange: (text: string) => void;
  onTakePhoto: (type: string) => void;
  onRunAI: () => void;
  onRetry: () => void;
  onSave: () => void;
  onClose: () => void;
}

export default function WaypointModal({
  visible, isFieldMode, activeProject, mapCenterLat, gpsLat, gpsLng, sampleBase64, sampleCaptureType,
  isAiProcessing, aiResult, waypointNote, onWaypointNoteChange,
  onTakePhoto, onRunAI, onRetry, onSave, onClose,
}: WaypointModalProps) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.85)' }]}>
        <ScrollView style={[styles.content, { maxHeight: '100%', flex: 1, backgroundColor: '#000', borderColor: '#FFD700', borderWidth: 2, padding: 20, borderRadius: 20 }, isFieldMode && styles.contentLight]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }}>
            <Text style={[styles.title, isFieldMode && styles.titleLight, { fontSize: 18, marginBottom: 0 }]}>📸 CAPTURA DE MUESTRA</Text>
            <TouchableOpacity onPress={onClose} style={{ minHeight: Touch.min, justifyContent: 'center' }}>
              <MaterialCommunityIcons name="close" size={28} color={isFieldMode ? Colors.fieldPrimary : Colors.primary} />
            </TouchableOpacity>
          </View>

          <Text style={[styles.sub, { fontSize: 12, color: Colors.text }]}>
            Proyecto: {activeProject} | GPS: {gpsLat != null ? `${gpsLat.toFixed(5)}, ${gpsLng?.toFixed(5)}` : mapCenterLat?.toFixed(5) ?? '---'}
          </Text>

          {!sampleBase64 ? (
            <View style={{ marginTop: 20 }}>
              <Text style={{ color: isFieldMode ? Colors.fieldTextSub : Colors.textSub, fontSize: 14, marginBottom: 15 }}>
                Selecciona el tipo de lente para abrir la cámara:
              </Text>

              <TouchableOpacity style={[styles.photoBtn, isFieldMode && styles.photoBtnLight, { height: 60, marginBottom: 15 }]} onPress={() => onTakePhoto('normal')}>
                <MaterialCommunityIcons name="camera" size={24} color={isFieldMode ? '#000' : '#FFF'} />
                <Text style={[styles.photoBtnText, isFieldMode && styles.photoBtnTextLight]}> FOTO NORMAL</Text>
              </TouchableOpacity>

              <View style={{ backgroundColor: '#111', padding: 10, borderRadius: 8, marginBottom: 15 }}>
                <Text style={{ color: Colors.primary, fontSize: 12, marginBottom: 10 }}>* Monta el lente macro Carson sobre la cámara antes de disparar.</Text>
                <TouchableOpacity style={[styles.photoBtn, isFieldMode && styles.photoBtnLight, { height: 60 }]} onPress={() => onTakePhoto('microscopio')}>
                  <MaterialCommunityIcons name="microscope" size={24} color={isFieldMode ? '#000' : '#FFF'} />
                  <Text style={[styles.photoBtnText, isFieldMode && styles.photoBtnTextLight]}> MICROSCOPIO</Text>
                </TouchableOpacity>
              </View>

              <View style={{ backgroundColor: '#111', padding: 10, borderRadius: 8, marginBottom: 15 }}>
                <Text style={{ color: '#00FFFF', fontSize: 12, marginBottom: 10 }}>* Apaga la luz blanca. Ilumina con linterna UV a 10cm de la roca.</Text>
                <TouchableOpacity style={[styles.photoBtn, isFieldMode && styles.photoBtnLight, { height: 60, marginBottom: 10 }]} onPress={() => onTakePhoto('uv_365')}>
                  <MaterialCommunityIcons name="flashlight" size={24} color={isFieldMode ? '#000' : '#FFF'} />
                  <Text style={[styles.photoBtnText, isFieldMode && styles.photoBtnTextLight]}> UV 365nm (Onda Larga)</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.photoBtn, isFieldMode && styles.photoBtnLight, { height: 60 }]} onPress={() => onTakePhoto('uv_254')}>
                  <MaterialCommunityIcons name="flashlight" size={24} color={isFieldMode ? '#000' : '#FFF'} />
                  <Text style={[styles.photoBtnText, isFieldMode && styles.photoBtnTextLight]}> UV 254nm (Onda Corta)</Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity style={[styles.btnCancel, { marginTop: 20, backgroundColor: '#FF3B30' }]} onPress={onClose}>
                <Text style={styles.btnWhiteText}>CANCELAR</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={{ marginTop: 10 }}>
              <View style={{ height: 260, backgroundColor: '#000', borderRadius: 8, marginBottom: 15, overflow: 'hidden', justifyContent: 'center', alignItems: 'center' }}>
                <Image source={{ uri: `data:image/jpeg;base64,${sampleBase64}` }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
              </View>

              {!aiResult && (
                <TouchableOpacity
                  style={[styles.photoBtn, isFieldMode && styles.photoBtnLight, { height: 60, marginBottom: 15, backgroundColor: '#FFD700', borderRadius: 8, width: '100%' }]}
                  onPress={onRunAI}
                  disabled={isAiProcessing}
                >
                  {isAiProcessing ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <ActivityIndicator color="#000" style={{ marginRight: 8 }} />
                      <Text style={[styles.photoBtnText, isFieldMode && styles.photoBtnTextLight, { marginLeft: 0 }]}>ANALIZANDO CON IA...</Text>
                    </View>
                  ) : (
                    <Text style={[styles.photoBtnText, isFieldMode && styles.photoBtnTextLight, { color: '#FFF' }]}>⚠️ ANALIZAR CON IA</Text>
                  )}
                </TouchableOpacity>
              )}

              {aiResult && (
                <View style={[{ backgroundColor: '#222', padding: 15, borderRadius: 8, marginBottom: 15, borderWidth: 1, borderColor: '#FFD700' }, isFieldMode && { backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 3 }]}>
                  <Text style={[{ color: '#FFD700', fontWeight: 'bold', fontSize: 16 }, isFieldMode && { color: '#000' }]}>
                    {aiResult.mineral_detectado.toUpperCase()} ({aiResult.probabilidad}%)
                  </Text>
                  <Text style={{ color: Colors.textSub, fontSize: 11, marginTop: 10, letterSpacing: 1 }}>ALTERACIÓN / PARAGÉNESIS</Text>
                  <Text style={[{ color: Colors.text, fontSize: 13, marginTop: 2 }, isFieldMode && { color: Colors.fieldText }]}>{aiResult.alteracion}</Text>
                  <Text style={{ color: Colors.textSub, fontSize: 11, marginTop: 10, letterSpacing: 1 }}>INDICADORES CLAVE</Text>
                  <Text style={[{ color: Colors.text, fontSize: 13, marginTop: 2 }, isFieldMode && { color: Colors.fieldText }]}>{aiResult.indicadores?.join(', ')}</Text>
                  {(aiResult.fluorescencia_uv && aiResult.fluorescencia_uv !== 'N/A') && (
                    <View>
                      <Text style={{ color: '#00FFFF', fontSize: 11, marginTop: 10, letterSpacing: 1 }}>FLUORESCENCIA UV</Text>
                      <Text style={[{ color: '#FFF', fontSize: 13, marginTop: 2 }, isFieldMode && { color: '#000' }]}>{aiResult.fluorescencia_uv}</Text>
                    </View>
                  )}
                  <Text style={{ color: Colors.textSub, fontSize: 11, marginTop: 10, letterSpacing: 1 }}>ANÁLISIS TÁCTICO</Text>
                  <Text style={[{ color: Colors.textSub, fontSize: 13, lineHeight: 18, marginTop: 2 }, isFieldMode && { color: Colors.fieldText }]}>{aiResult.analisis_detallado}</Text>
                  <Text style={[{ color: '#FFD700', backgroundColor: '#111', padding: 12, borderRadius: 6, fontSize: 14, fontWeight: 'bold', marginTop: 15 }, isFieldMode && { color: '#000', backgroundColor: '#EEE' }]}>
                    {'>>> '} {aiResult.recomendacion}
                  </Text>
                </View>
              )}

              <TextInput
                style={[styles.noteInput, isFieldMode && styles.noteInputLight, { height: 60, fontSize: 14, marginBottom: 15 }]}
                placeholder="Notas geológicas manuales (opcional)..."
                placeholderTextColor="#888"
                value={waypointNote}
                onChangeText={onWaypointNoteChange}
                multiline
              />

              <Text style={{ color: Colors.textSub, fontSize: 11, textAlign: 'center', marginBottom: 8 }}>
                📍 {gpsLat != null ? `${gpsLat.toFixed(5)}, ${gpsLng?.toFixed(5)} (GPS)` : `${mapCenterLat?.toFixed(5) ?? '---'} (centro mapa)`}
              </Text>
              <View style={{ flexDirection: 'row', justifyContent: 'center', marginTop: 20, gap: 12 }}>
                <TouchableOpacity style={styles.btnOutlineRed} onPress={onClose}>
                  <Text style={{ color: '#FF3B30', fontSize: 14, fontWeight: 'bold' }}>CANCELAR</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.btnOutlineGold} onPress={onRetry}>
                  <Text style={{ color: '#FFD700', fontSize: 14, fontWeight: 'bold' }}>REINTENTAR</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.btnGold, isFieldMode && styles.btnGoldLight]} onPress={onSave}>
                  <Text style={[{ color: '#000', fontSize: 14, fontWeight: 'bold' }, isFieldMode && { color: '#000' }]}>GUARDAR</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  content: { width: '100%', backgroundColor: '#111', borderRadius: 12, padding: 20, borderWidth: 2, borderColor: '#FFD700' },
  contentLight: { backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 3 },
  title: { color: Colors.primary, fontSize: 24, fontWeight: '900', marginBottom: 5 },
  titleLight: { color: Colors.fieldText },
  sub: { color: Colors.textSub, fontSize: 14, marginBottom: 15 },
  photoBtn: { backgroundColor: '#222', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 8, width: '100%', borderColor: '#444', borderWidth: 1 },
  photoBtnLight: { backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 3 },
  photoBtnText: { color: '#FFF', fontWeight: '900', fontSize: 14, marginLeft: 10 },
  photoBtnTextLight: { color: '#000000' },
  btnCancel: { flex: 1, backgroundColor: '#333', padding: 20, borderRadius: 8, alignItems: 'center' },
  btnWhiteText: { color: '#FFF', fontWeight: 'bold', fontSize: 18 },
  noteInput: { backgroundColor: '#222', color: '#FFF', borderRadius: 8, padding: 15, height: 120, textAlignVertical: 'top', fontSize: 18 },
  noteInputLight: { backgroundColor: '#EEE', color: '#000' },
  btnOutlineRed: { flex: 1, minWidth: 100, minHeight: Touch.min, backgroundColor: 'transparent', paddingVertical: 10, paddingHorizontal: 16, borderRadius: Radii.sm, borderWidth: 2, borderColor: '#FF3B30', alignItems: 'center', justifyContent: 'center' },
  btnOutlineGold: { flex: 1, minWidth: 100, minHeight: Touch.min, backgroundColor: 'transparent', paddingVertical: 10, paddingHorizontal: 16, borderRadius: Radii.sm, borderWidth: 2, borderColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  btnGold: { flex: 1, minWidth: 100, minHeight: Touch.min, backgroundColor: Colors.primary, paddingVertical: 10, paddingHorizontal: 16, borderRadius: Radii.sm, borderWidth: 2, borderColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },
  btnGoldLight: { backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 3 },
});

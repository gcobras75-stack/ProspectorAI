import React from 'react';
import { View, Text, Modal, TouchableOpacity, ScrollView, TextInput, Switch, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

interface ConfigModalProps {
  visible: boolean;
  isFieldMode: boolean;
  activeProject: string;
  selectedMineral: string;
  terrainType: string;
  depth: string;
  rockType: string;
  useAI: boolean;
  autoAnalyzeSample: boolean;
  uvLamp: string;
  microscopeConnected: boolean;
  autoSync: boolean;
  vibrationEnabled: boolean;
  deepAnalysis: boolean;
  onClose: () => void;
  setActiveProject: (v: string) => void;
  setSelectedMineral: (v: string) => void;
  setTerrainType: (v: string) => void;
  setDepth: (v: string) => void;
  setRockType: (v: string) => void;
  setUseAI: (v: boolean) => void;
  setAutoAnalyzeSample: (v: boolean) => void;
  setUvLamp: (v: string) => void;
  setMicroscopeConnected: (v: boolean) => void;
  setAutoSync: (v: boolean) => void;
  setIsFieldMode: (v: boolean) => void;
  setVibrationEnabled: (v: boolean) => void;
  setDeepAnalysis: (v: boolean) => void;
}

export default function ConfigModal({
  visible, isFieldMode, activeProject, selectedMineral, terrainType, depth, rockType,
  useAI, autoAnalyzeSample, uvLamp, microscopeConnected, autoSync, vibrationEnabled, deepAnalysis, setDeepAnalysis,
  onClose, setActiveProject, setSelectedMineral, setTerrainType, setDepth, setRockType,
  setUseAI, setAutoAnalyzeSample, setUvLamp, setMicroscopeConnected, setAutoSync,
  setIsFieldMode, setVibrationEnabled,
}: ConfigModalProps) {
  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={styles.overlay}>
        <ScrollView style={[styles.content, { maxHeight: '85%' }, isFieldMode && styles.contentLight]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={[styles.title, isFieldMode && styles.titleLight, { marginBottom: 0 }]}>⚙️ CONFIGURACIÓN</Text>
            <TouchableOpacity onPress={onClose}>
              <MaterialCommunityIcons name="close" size={28} color={isFieldMode ? '#000' : '#FFD700'} />
            </TouchableOpacity>
          </View>

          <Text style={[styles.sectionHeader, { color: '#00FFFF', marginTop: 20 }]}>0. GESTIÓN LOCAL</Text>
          <Text style={[styles.sectionLabel, isFieldMode && styles.sectionLabelLight]}>PROYECTO ACTIVO</Text>
          <TextInput
            style={[styles.input, isFieldMode && styles.inputLight, { height: 44, marginBottom: 10, fontSize: 15, fontWeight: 'bold' }]}
            value={activeProject}
            onChangeText={setActiveProject}
            placeholder="Ej: Concesión Norte"
            placeholderTextColor="#888"
          />

          <Text style={[styles.sectionHeader, { color: '#00FFFF', marginTop: 20 }]}>1. GEOLOGÍA ESTRUCTURAL</Text>

          <Text style={[styles.sectionLabel, isFieldMode && styles.sectionLabelLight]}>MINERAL OBJETIVO</Text>
          <View style={styles.chips}>
            {['oro', 'plata', 'cobre', 'zinc', 'plomo'].map(m => (
              <TouchableOpacity key={m} style={[styles.chip, selectedMineral === m && styles.chipActive]} onPress={() => setSelectedMineral(m)}>
                <Text style={[styles.chipText, selectedMineral === m && styles.chipTextActive]}>{m}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={[styles.sectionLabel, isFieldMode && styles.sectionLabelLight]}>TIPO DE TERRENO</Text>
          <View style={styles.chips}>
            {['sierra', 'playa', 'árido'].map(m => (
              <TouchableOpacity key={m} style={[styles.chip, terrainType === m && styles.chipActive]} onPress={() => setTerrainType(m)}>
                <Text style={[styles.chipText, terrainType === m && styles.chipTextActive]}>{m}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={[styles.sectionLabel, isFieldMode && styles.sectionLabelLight]}>PROFUNDIDAD EST.</Text>
          <View style={styles.chips}>
            {['0-5m', '5-20m', '20m+'].map(m => (
              <TouchableOpacity key={m} style={[styles.chip, depth === m && styles.chipActive]} onPress={() => setDepth(m)}>
                <Text style={[styles.chipText, depth === m && styles.chipTextActive]}>{m}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={[styles.sectionLabel, isFieldMode && styles.sectionLabelLight]}>TIPO DE ROCA MASIVA</Text>
          <View style={styles.chips}>
            {['ignea', 'sedimentaria', 'metamorfica'].map(m => (
              <TouchableOpacity key={m} style={[styles.chip, rockType === m && styles.chipActive]} onPress={() => setRockType(m)}>
                <Text style={[styles.chipText, rockType === m && styles.chipTextActive]}>
                  {m === 'metamorfica' ? 'metamórfica' : m}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={[styles.sectionHeader, { color: '#00FFFF', marginTop: 30 }]}>SATÉLITES</Text>
          <View style={styles.prefRow}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.sectionLabel, isFieldMode && styles.sectionLabelLight, { marginBottom: 0, marginTop: 0 }]}>
                Análisis profundo (S2 + ASTER)
              </Text>
              <Text style={{ color: '#555', fontSize: 10 }}>ASTER tarda ~60 s — geología histórica 2000-2008</Text>
            </View>
            <Switch value={deepAnalysis} onValueChange={setDeepAnalysis} trackColor={{ true: '#FFD700' }} />
          </View>

          <Text style={[styles.sectionHeader, { color: '#00FFFF', marginTop: 30 }]}>2. ANÁLISIS ÓPTICO / IA</Text>
          <View style={styles.prefRow}>
            <Text style={[styles.sectionLabel, isFieldMode && styles.sectionLabelLight, { marginBottom: 0, marginTop: 0 }]}>Claude Vision On/Off</Text>
            <Switch value={useAI} onValueChange={setUseAI} trackColor={{ true: '#FFD700' }} />
          </View>
          {useAI && <Text style={{ color: '#888', fontSize: 11 }}>Modelo Activo: claude-haiku-4-5-20251001</Text>}
          <View style={styles.prefRow}>
            <Text style={[styles.sectionLabel, isFieldMode && styles.sectionLabelLight, { marginBottom: 0, marginTop: 0 }]}>Auto-Análisis AI en Muestreo</Text>
            <Switch value={autoAnalyzeSample} onValueChange={setAutoAnalyzeSample} trackColor={{ true: '#FFD700' }} />
          </View>

          <Text style={[styles.sectionHeader, { color: '#00FFFF', marginTop: 30 }]}>3. HARDWARE EXTERNO</Text>
          <Text style={[styles.sectionLabel, isFieldMode && styles.sectionLabelLight]}>LÁMPARA UV / FLUORESCENCIA</Text>
          <View style={styles.chips}>
            {['Ninguna', '365nm', '254nm'].map(m => (
              <TouchableOpacity key={m} style={[styles.chip, uvLamp === m && styles.chipActive]} onPress={() => setUvLamp(m)}>
                <Text style={[styles.chipText, uvLamp === m && styles.chipTextActive]}>{m}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={styles.prefRow}>
            <Text style={[styles.sectionLabel, isFieldMode && styles.sectionLabelLight, { marginBottom: 0, marginTop: 0 }]}>Microscopio USB-C Carson</Text>
            <TouchableOpacity
              style={{ padding: 6, backgroundColor: microscopeConnected ? '#00FF00' : '#333', borderRadius: 8 }}
              onPress={() => setMicroscopeConnected(!microscopeConnected)}
            >
              <Text style={{ color: microscopeConnected ? '#000' : '#FFF', fontWeight: 'bold' }}>
                {microscopeConnected ? 'CONECTADO' : 'INACTIVO'}
              </Text>
            </TouchableOpacity>
          </View>

          <Text style={[styles.sectionHeader, { color: '#00FFFF', marginTop: 30 }]}>4. BASE DE DATOS Y NUBE</Text>
          <View style={styles.prefRow}>
            <Text style={[styles.sectionLabel, isFieldMode && styles.sectionLabelLight, { marginBottom: 0, marginTop: 0 }]}>Sincronización Cloud Automática</Text>
            <Switch value={autoSync} onValueChange={setAutoSync} trackColor={{ true: '#FFD700' }} />
          </View>

          <Text style={[styles.sectionHeader, { color: '#00FFFF', marginTop: 30 }]}>5. SISTEMA / INTERFAZ</Text>
          <View style={styles.prefRow}>
            <Text style={[styles.sectionLabel, isFieldMode && styles.sectionLabelLight, { marginBottom: 0, marginTop: 0 }]}>Modo Solar Alto Contraste</Text>
            <Switch value={isFieldMode} onValueChange={setIsFieldMode} trackColor={{ true: '#FFD700' }} />
          </View>
          <View style={styles.prefRow}>
            <Text style={[styles.sectionLabel, isFieldMode && styles.sectionLabelLight, { marginBottom: 0, marginTop: 0 }]}>Motor Háptico (Vibración)</Text>
            <Switch value={vibrationEnabled} onValueChange={setVibrationEnabled} trackColor={{ true: '#FFD700' }} />
          </View>

          <View style={[styles.actions, { marginTop: 30 }]}>
            <TouchableOpacity style={styles.btnSave} onPress={onClose}>
              <Text style={styles.btnTextBlack}>Guardar Parámetros Globales</Text>
            </TouchableOpacity>
          </View>
          <View style={{ height: 40 }} />
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  content: { width: '100%', backgroundColor: '#111', borderRadius: 12, padding: 20, borderWidth: 2, borderColor: '#FFD700' },
  contentLight: { backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 3 },
  title: { color: '#FFD700', fontSize: 24, fontWeight: '900', marginBottom: 5 },
  titleLight: { color: '#000000' },
  sectionHeader: { fontSize: 15, marginTop: 15, marginBottom: 5, letterSpacing: 0.5, fontWeight: 'bold' },
  sectionLabel: { color: '#FFD700', fontSize: 12, fontWeight: 'bold', marginTop: 15, marginBottom: 8, letterSpacing: 1 },
  sectionLabelLight: { color: '#444' },
  input: { backgroundColor: '#222', color: '#FFF', borderRadius: 8, padding: 15, textAlignVertical: 'top', fontSize: 18 },
  inputLight: { backgroundColor: '#EEE', color: '#000' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { backgroundColor: '#333', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: '#555' },
  chipActive: { backgroundColor: '#FFD700', borderColor: '#FFD700' },
  chipText: { color: '#FFF', fontSize: 14, fontWeight: 'bold', textTransform: 'capitalize' },
  chipTextActive: { color: '#000' },
  prefRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, marginTop: 10 },
  actions: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 20, gap: 10 },
  btnSave: { flex: 1, backgroundColor: '#FFD700', padding: 20, borderRadius: 8, alignItems: 'center' },
  btnTextBlack: { color: '#000', fontWeight: 'bold', fontSize: 18 },
});

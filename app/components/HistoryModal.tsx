import React from 'react';
import { View, Text, Modal, TouchableOpacity, ScrollView, StyleSheet, Alert } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

interface HistoryModalProps {
  visible: boolean;
  waypoints: any[];
  isFieldMode: boolean;
  onClose: () => void;
  onClear: () => void;
  onExport: () => void;
  onViewDetail?: (wp: any) => void;
}

export default function HistoryModal({
  visible, waypoints, isFieldMode, onClose, onClear, onExport, onViewDetail,
}: HistoryModalProps) {
  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.85)' }]}>
        <View style={[styles.container, isFieldMode && styles.containerLight]}>
          <View style={styles.header}>
            <Text style={[styles.title, isFieldMode && styles.titleLight]}>📋 HISTORIAL</Text>
            <TouchableOpacity onPress={onClose}>
              <MaterialCommunityIcons name="close" size={28} color={isFieldMode ? '#000' : '#FFD700'} />
            </TouchableOpacity>
          </View>

          <Text style={{ fontSize: 12, color: '#FFF', marginBottom: 10 }}>
            {waypoints.length} Muestras almacenadas localmente.
          </Text>

          <ScrollView style={{ flex: 1, marginBottom: 20 }}>
            {waypoints.map((wp, i) => (
              <View key={i} style={styles.item}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ color: '#888', fontSize: 11 }}>
                    {new Date(wp.fecha_hora || wp.timestamp).toLocaleString()}
                  </Text>
                  <Text style={styles.projectBadge}>
                    {wp.proyecto_id || wp.project || 'Sin Proyecto'}
                  </Text>
                </View>
                <Text style={{ color: '#FFF', fontSize: 11, marginTop: 5 }}>
                  Lat: {parseFloat(wp.lat || wp.latitude || 0).toFixed(6)} | Lng: {parseFloat(wp.lng || wp.longitude || 0).toFixed(6)}
                </Text>
                <Text style={styles.mineralText}>
                  {wp.mineral_detectado
                    ? `💎 ${wp.mineral_detectado.toUpperCase()} (${wp.score_ia}%)`
                    : (wp.descripcion_texto || wp.note || 'Muestra sin IA')}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                  {wp.muestra_codigo ? (
                    <Text style={{ color: '#00BCD4', fontSize: 11, fontFamily: 'monospace' }}>{wp.muestra_codigo}</Text>
                  ) : null}
                  {wp.validation_verdict ? (
                    <Text style={{ fontSize: 11, color: wp.validation_verdict === 'CONFIRMED' ? '#4CAF50' : wp.validation_verdict === 'PARTIAL' ? '#FF9800' : '#E53935', fontWeight: 'bold' }}>
                      {wp.validation_verdict === 'CONFIRMED' ? '✅ CONF.' : wp.validation_verdict === 'PARTIAL' ? '⚠️ PARCIAL' : '❌ N/C'}
                    </Text>
                  ) : null}
                  {onViewDetail && (
                    <TouchableOpacity onPress={() => onViewDetail(wp)} style={{ paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: '#FFD700', borderRadius: 4 }}>
                      <Text style={{ color: '#FFD700', fontSize: 11 }}>Ver detalle →</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            ))}
            {waypoints.length === 0 && (
              <Text style={{ color: '#888', textAlign: 'center', marginTop: 50, fontSize: 12 }}>
                Aún no capturas ninguna muestra
              </Text>
            )}
          </ScrollView>

          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
            <TouchableOpacity style={styles.btnClear} onPress={() => {
              Alert.alert(
                'Borrar todas las muestras',
                `¿Eliminar permanentemente las ${waypoints.length} muestras guardadas? Esta acción no se puede deshacer.`,
                [
                  { text: 'Cancelar', style: 'cancel' },
                  { text: 'Borrar todo', style: 'destructive', onPress: onClear },
                ]
              );
            }}>
              <Text style={{ color: '#FF3B30', fontWeight: 'bold', fontSize: 14 }}>Borrar BD</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btnExport} onPress={onExport}>
              <Text style={{ color: '#FFD700', fontWeight: 'bold', fontSize: 14 }}>Exportar CSV</Text>
            </TouchableOpacity>
          </View>
        </View>
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
  container: {
    backgroundColor: '#000',
    borderColor: '#FFD700',
    borderWidth: 2,
    borderRadius: 20,
    padding: 20,
    width: '92%',
    maxHeight: '85%',
    flex: 1,
  },
  containerLight: { backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 3 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#333',
    paddingBottom: 10,
  },
  title: { fontSize: 18, fontWeight: 'bold', color: '#FFD700' },
  titleLight: { color: '#000' },
  item: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#333',
    marginBottom: 8,
  },
  projectBadge: {
    color: '#000',
    fontSize: 10,
    fontWeight: 'bold',
    backgroundColor: '#00FFFF',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  mineralText: {
    color: '#FFD700',
    fontSize: 12,
    fontWeight: 'bold',
    marginTop: 4,
  },
  btnClear: {
    flex: 1,
    backgroundColor: 'transparent',
    borderColor: '#FF3B30',
    borderWidth: 2,
    minWidth: 120,
    padding: 12,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  btnExport: {
    flex: 1,
    backgroundColor: '#000',
    borderColor: '#FFD700',
    borderWidth: 2,
    minWidth: 120,
    padding: 12,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
});

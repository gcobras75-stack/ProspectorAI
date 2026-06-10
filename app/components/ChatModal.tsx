import React from 'react';
import { View, Text, Modal, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

interface ChatModalProps {
  visible: boolean;
  messages: { role: string; content: string }[];
  isTypingChat: boolean;
  input: string;
  onInputChange: (text: string) => void;
  onSend: () => void;
  onClose: () => void;
  isFieldMode: boolean;
}

export default function ChatModal({
  visible, messages, isTypingChat, input, onInputChange, onSend, onClose, isFieldMode,
}: ChatModalProps) {
  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.85)' }]}>
        <View style={[{ backgroundColor: '#000', borderColor: '#00FF00', borderWidth: 2, borderRadius: 20, padding: 20, width: '95%', height: '80%' }, isFieldMode && styles.contentLight]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15, borderBottomWidth: 1, borderBottomColor: '#333', paddingBottom: 10 }}>
            <Text style={{ fontSize: 18, fontWeight: 'bold', color: '#00FF00' }}>👨🏻‍💻 DEV IA (Admin)</Text>
            <TouchableOpacity onPress={onClose}>
              <MaterialCommunityIcons name="close" size={28} color={isFieldMode ? '#000' : '#FFD700'} />
            </TouchableOpacity>
          </View>
          <ScrollView style={{ flex: 1, marginBottom: 15 }}>
            {messages.length === 0 && (
              <Text style={{ color: '#888', textAlign: 'center', marginTop: 20 }}>
                ¡Hola! Soy tu asistente de campo. Hazme preguntas técnicas de mineralogía, estratigrafía o uso de equipo.
              </Text>
            )}
            {messages.map((msg, idx) => (
              <View key={idx} style={{ alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start', backgroundColor: msg.role === 'user' ? '#333' : '#FFD700', padding: 12, borderRadius: 12, maxWidth: '80%', marginBottom: 10 }}>
                <Text style={{ color: msg.role === 'user' ? '#FFF' : '#000', fontSize: 14 }}>{msg.content}</Text>
              </View>
            ))}
            {isTypingChat && <ActivityIndicator color="#FFD700" style={{ alignSelf: 'flex-start', marginTop: 10 }} />}
          </ScrollView>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <TextInput
              style={[
                { flex: 1, padding: 12, borderRadius: 8, borderWidth: 1 },
                isFieldMode
                  ? { backgroundColor: '#F5F5F5', color: '#000', borderColor: '#CCC' }
                  : { backgroundColor: '#222', color: '#FFF', borderColor: '#444' },
              ]}
              placeholder="Escribe tu consulta al motor IA..."
              placeholderTextColor={isFieldMode ? '#888' : '#666'}
              value={input}
              onChangeText={onInputChange}
            />
            <TouchableOpacity onPress={onSend} style={{ backgroundColor: '#FFD700', padding: 12, borderRadius: 8 }}>
              <MaterialCommunityIcons name="send" size={24} color="#000" />
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  contentLight: { backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 3 },
});

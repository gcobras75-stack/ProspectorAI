import React from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, Pressable } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Colors, Typography, Spacing, Radii } from '../core/theme';

interface MoreSheetProps {
  visible: boolean;
  onClose: () => void;
  projectName: string;
  onHistorial: () => void;
  onGuardar: () => void;
  onCampo: () => void;
  onPDF: () => void;
  onAjustes: () => void;
  isFieldMode?: boolean;
}

interface SheetRowProps {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  iconColor: string;
  label: string;
  onPress: () => void;
  isLast?: boolean;
  isFieldMode?: boolean;
}

function SheetRow({ icon, iconColor, label, onPress, isLast, isFieldMode }: SheetRowProps) {
  return (
    <TouchableOpacity
      style={[
        styles.row,
        !isLast && styles.rowBorder,
        isFieldMode && styles.rowField,
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <MaterialCommunityIcons name={icon} size={22} color={isFieldMode ? '#000' : iconColor} />
      <Text style={[styles.rowLabel, isFieldMode && styles.rowLabelField]}>{label}</Text>
      <MaterialCommunityIcons name="chevron-right" size={18} color={isFieldMode ? '#666' : Colors.textDim} />
    </TouchableOpacity>
  );
}

export default function MoreSheet({
  visible,
  onClose,
  projectName,
  onHistorial,
  onGuardar,
  onCampo,
  onPDF,
  onAjustes,
  isFieldMode = false,
}: MoreSheetProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      {/* Overlay — tap to close */}
      <Pressable style={styles.overlay} onPress={onClose} />

      <View style={[styles.sheet, isFieldMode && styles.sheetField]}>
        {/* Handle bar */}
        <View style={styles.handle} />

        {/* Project name */}
        <Text style={[styles.projectName, isFieldMode && styles.projectNameField]} numberOfLines={1}>
          {projectName}
        </Text>

        <SheetRow
          icon="cog"
          iconColor={Colors.primary}
          label="Configuracion"
          onPress={() => { onClose(); onAjustes(); }}
          isFieldMode={isFieldMode}
        />
        <SheetRow
          icon="history"
          iconColor={Colors.primary}
          label="Historial de muestras"
          onPress={() => { onClose(); onHistorial(); }}
          isFieldMode={isFieldMode}
        />
        <SheetRow
          icon="content-save"
          iconColor={Colors.success}
          label="Guardar proyecto"
          onPress={() => { onClose(); onGuardar(); }}
          isFieldMode={isFieldMode}
        />
        <SheetRow
          icon="bag-personal"
          iconColor={Colors.warning}
          label="Preparar para campo"
          onPress={() => { onClose(); onCampo(); }}
          isFieldMode={isFieldMode}
        />
        <SheetRow
          icon="file-pdf-box"
          iconColor={Colors.info}
          label="Generar reporte PDF"
          onPress={() => { onClose(); onPDF(); }}
          isLast
          isFieldMode={isFieldMode}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  sheet: {
    backgroundColor: Colors.surface2,
    borderTopLeftRadius: Radii.xl,
    borderTopRightRadius: Radii.xl,
    paddingBottom: Spacing.xxxl,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    borderTopWidth: 1,
    borderColor: Colors.border,
  },
  sheetField: {
    backgroundColor: '#F5F5F5',
    borderColor: '#CCCCCC',
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: Radii.pill,
    backgroundColor: Colors.surface4,
    alignSelf: 'center',
    marginBottom: Spacing.md,
    marginTop: Spacing.xs,
  },
  projectName: {
    ...Typography.caption,
    color: Colors.textDim,
    textAlign: 'center',
    marginBottom: Spacing.md,
    letterSpacing: 0.5,
  },
  projectNameField: {
    color: '#888',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 52,
    paddingHorizontal: Spacing.sm,
  },
  rowField: {
    backgroundColor: '#F5F5F5',
  },
  rowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: Colors.surface3,
  },
  rowLabel: {
    flex: 1,
    ...Typography.body,
    color: Colors.text,
    marginLeft: Spacing.md,
  },
  rowLabelField: {
    color: '#111',
  },
});

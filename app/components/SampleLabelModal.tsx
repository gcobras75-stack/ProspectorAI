import React from 'react';
import {
  View, Text, Modal, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Colors, Typography, Spacing, Radii, Touch } from '../core/theme';

interface SampleLabelModalProps {
  visible: boolean;
  onClose: () => void;
  sample: {
    muestra_codigo: string;
    proyecto_id: string;
    lat: number;
    lng: number;
    utm_zona: string;
    utm_easting: number;
    utm_northing: number;
    fecha_hora: string;
    tipo_captura: string;
    mineral_detectado?: string;
  };
}

function buildLabelHtml(sample: SampleLabelModalProps['sample']): string {
  const utmLine = sample.utm_zona
    ? `<div class="coords">&#128506;  UTM ${sample.utm_zona} ${sample.utm_easting.toLocaleString()} E &middot; ${sample.utm_northing.toLocaleString()} N</div>`
    : '';
  const mineralLine = sample.mineral_detectado
    ? `<div class="coords">&#128142; ${sample.mineral_detectado.toUpperCase()}</div>`
    : '';
  const fecha = new Date(sample.fecha_hora).toLocaleString('es-MX');
  const qrData = encodeURIComponent(sample.muestra_codigo);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: 'Courier New', monospace; background: white; margin: 0; padding: 20px; }
  .label { border: 3px solid #000; border-radius: 8px; padding: 20px; max-width: 400px; margin: 0 auto; }
  .code { font-size: 32px; font-weight: 900; text-align: center; letter-spacing: 2px; margin: 10px 0; border: 2px solid #000; padding: 8px; }
  .project { font-size: 14px; text-align: center; color: #333; margin-bottom: 8px; }
  .coords { font-size: 13px; margin: 4px 0; }
  .footer { font-size: 11px; color: #666; text-align: center; margin-top: 10px; border-top: 1px solid #ccc; padding-top: 8px; }
  .qr { text-align: center; margin: 12px 0; }
</style>
</head>
<body>
<div class="label">
  <div class="project">${sample.proyecto_id} &middot; ${sample.tipo_captura.toUpperCase()}</div>
  <div class="code">${sample.muestra_codigo}</div>
  <div class="qr"><img src="https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${qrData}" width="120" height="120" /></div>
  <div class="coords">&#128205; ${sample.lat.toFixed(6)}, ${sample.lng.toFixed(6)}</div>
  ${utmLine}
  ${mineralLine}
  <div class="footer">ProspectorAI &middot; ${fecha}</div>
</div>
</body>
</html>`;
}

export default function SampleLabelModal({ visible, onClose, sample }: SampleLabelModalProps) {
  const [printing, setPrinting] = React.useState(false);

  const handlePrint = async () => {
    setPrinting(true);
    try {
      const html = buildLabelHtml(sample);
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        // Generate PDF file first, then share (works on iOS + Android)
        const { uri } = await Print.printToFileAsync({ html });
        await Sharing.shareAsync(uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' });
      } else {
        // Fallback: open system print dialog directly
        await Print.printAsync({ html });
      }
    } catch (err: any) {
      if (err?.message !== 'User cancelled') {
        Alert.alert('Error al imprimir', err?.message || 'No se pudo generar el PDF.');
      }
    } finally {
      setPrinting(false);
    }
  };

  if (!sample) return null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Etiqueta de Muestra</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.closeBtn}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            {/* Preview card (dark-theme approximation of the label) */}
            <View style={styles.previewCard}>
              <Text style={styles.previewProject}>
                {sample.proyecto_id} · {sample.tipo_captura.toUpperCase()}
              </Text>
              <View style={styles.codeBox}>
                <Text style={styles.codeText}>{sample.muestra_codigo}</Text>
              </View>
              <Text style={styles.previewCoord}>
                📍 {sample.lat.toFixed(6)}, {sample.lng.toFixed(6)}
              </Text>
              {!!sample.utm_zona && (
                <Text style={styles.previewCoord}>
                  🗺  UTM {sample.utm_zona} {sample.utm_easting.toLocaleString()} E · {sample.utm_northing.toLocaleString()} N
                </Text>
              )}
              {!!sample.mineral_detectado && (
                <Text style={styles.previewMineral}>
                  💎 {sample.mineral_detectado.toUpperCase()}
                </Text>
              )}
              <Text style={styles.previewFooter}>
                ProspectorAI · {new Date(sample.fecha_hora).toLocaleString('es-MX')}
              </Text>
            </View>

            <Text style={styles.hint}>
              El PDF incluye código QR y se puede enviar por correo, WhatsApp o imprimir directamente.
            </Text>
          </ScrollView>

          {/* Actions */}
          <View style={styles.actions}>
            <TouchableOpacity
              style={styles.btnPrint}
              onPress={handlePrint}
              disabled={printing}
              accessibilityLabel="Compartir o imprimir etiqueta"
            >
              {printing ? (
                <ActivityIndicator color={Colors.surface} size="small" />
              ) : (
                <Text style={styles.btnPrintText}>🖨️ Compartir / Imprimir</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity style={styles.btnClose} onPress={onClose}>
              <Text style={styles.btnCloseText}>Cerrar</Text>
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
    backgroundColor: 'rgba(0,0,0,0.80)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Colors.surface2,
    borderTopLeftRadius: Radii.xl,
    borderTopRightRadius: Radii.xl,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    maxHeight: '80%',
    paddingBottom: 24,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surface3,
  },
  headerTitle: {
    color: Colors.primary,
    fontSize: 16,
    fontWeight: '700',
  },
  closeBtn: {
    color: Colors.textSub,
    fontSize: 18,
    paddingHorizontal: 4,
  },
  scroll: { flex: 1 },
  scrollContent: { padding: Spacing.md },
  previewCard: {
    backgroundColor: Colors.surface3,
    borderRadius: Radii.md,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  previewProject: {
    color: Colors.textSub,
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 6,
  },
  codeBox: {
    borderWidth: 2,
    borderColor: Colors.primary,
    borderRadius: Radii.sm,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  codeText: {
    color: Colors.primary,
    fontSize: 24,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: 2,
    fontFamily: 'monospace',
  },
  previewCoord: {
    color: Colors.text,
    fontSize: 13,
    marginTop: 4,
  },
  previewMineral: {
    color: Colors.primary,
    fontSize: 13,
    fontWeight: 'bold',
    marginTop: 4,
  },
  previewFooter: {
    color: Colors.textDim,
    fontSize: 11,
    textAlign: 'center',
    marginTop: 10,
    borderTopWidth: 1,
    borderTopColor: Colors.surface4,
    paddingTop: 8,
  },
  hint: {
    color: Colors.textSub,
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
  },
  actions: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    gap: 10,
  },
  btnPrint: {
    backgroundColor: Colors.primary,
    borderRadius: Radii.md,
    height: Touch.min,
    justifyContent: 'center',
    alignItems: 'center',
  },
  btnPrintText: {
    color: Colors.surface,
    fontSize: 15,
    fontWeight: '700',
  },
  btnClose: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radii.md,
    height: Touch.min,
    justifyContent: 'center',
    alignItems: 'center',
  },
  btnCloseText: {
    color: Colors.textSub,
    fontSize: 14,
  },
});

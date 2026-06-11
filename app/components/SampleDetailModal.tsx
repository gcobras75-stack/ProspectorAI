import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, Modal, TouchableOpacity, ScrollView, StyleSheet,
  TextInput, ActivityIndicator, Alert, Image, KeyboardAvoidingView,
  Platform,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Colors, Spacing, Radii, Touch } from '../core/theme';
import {
  updateMuestraLab, updateMuestraValidation, upsertValidationPair,
  LabResult,
} from '../core/Database';
import { extractLabCertificateOCR, LabCertificateOCR } from '../core/ClaudeServices';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SampleDetailModalProps {
  visible: boolean;
  onClose: () => void;
  onLabelPress: () => void;
  sample: any | null;
  projectId: string;
  metalTarget: string;
  onLabSaved: () => void;
  onValidationSaved: () => void;
}

type TabId = 'INFO' | 'LAB' | 'VALIDATION';

type VerdictKey = 'CONFIRMED' | 'PARTIAL' | 'NOT_CONFIRMED';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeSuggestedVerdict(metalTarget: string, lab: any): VerdictKey {
  if (metalTarget === 'oro' && lab.lab_au_gt != null) {
    return lab.lab_au_gt >= 0.5 ? 'CONFIRMED' : lab.lab_au_gt >= 0.1 ? 'PARTIAL' : 'NOT_CONFIRMED';
  }
  if (metalTarget === 'plata' && lab.lab_ag_gt != null) {
    return lab.lab_ag_gt >= 10 ? 'CONFIRMED' : lab.lab_ag_gt >= 2 ? 'PARTIAL' : 'NOT_CONFIRMED';
  }
  if (metalTarget === 'cobre' && lab.lab_cu_pct != null) {
    return lab.lab_cu_pct >= 0.3 ? 'CONFIRMED' : lab.lab_cu_pct >= 0.05 ? 'PARTIAL' : 'NOT_CONFIRMED';
  }
  return 'NOT_CONFIRMED';
}

const VERDICT_LABEL: Record<VerdictKey, string> = {
  CONFIRMED: '✅ Confirmada',
  PARTIAL: '⚠️ Parcial',
  NOT_CONFIRMED: '❌ No confirmada',
};

const VERDICT_COLOR: Record<VerdictKey, string> = {
  CONFIRMED: Colors.success,
  PARTIAL: Colors.warning,
  NOT_CONFIRMED: Colors.danger,
};

const THRESHOLDS: Record<string, string> = {
  oro: 'Au ≥ 0.5 g/t = Confirmada',
  plata: 'Ag ≥ 10 g/t = Confirmada',
  cobre: 'Cu ≥ 0.3 % = Confirmada',
};

function verdictBadgeColor(v?: string): string {
  if (v === 'CONFIRMED') return Colors.success;
  if (v === 'PARTIAL') return Colors.warning;
  return Colors.danger;
}

function confidenceDot(c: string): string {
  if (c === 'HIGH') return '🟢 ALTA';
  if (c === 'MEDIUM') return '🟡 MEDIA';
  return '🔴 BAJA';
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function SampleDetailModal({
  visible, onClose, onLabelPress, sample, metalTarget, onLabSaved, onValidationSaved,
}: SampleDetailModalProps) {
  const [tab, setTab] = useState<TabId>('INFO');

  // ── Lab form state
  const [auGt, setAuGt] = useState('');
  const [agGt, setAgGt] = useState('');
  const [cuPct, setCuPct] = useState('');
  const [pbPct, setPbPct] = useState('');
  const [znPct, setZnPct] = useState('');
  const [labName, setLabName] = useState('');
  const [labDate, setLabDate] = useState('');
  const [labSaving, setLabSaving] = useState(false);

  // ── OCR state
  const [ocrPhotoUri, setOcrPhotoUri] = useState<string | null>(null);
  const [ocrPhotoB64, setOcrPhotoB64] = useState<string | null>(null);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrResult, setOcrResult] = useState<LabCertificateOCR | null>(null);

  // ── Validation state
  const [verdict, setVerdict] = useState<VerdictKey>('NOT_CONFIRMED');
  const [valComment, setValComment] = useState('');
  const [valSaving, setValSaving] = useState(false);

  // Populate form when sample changes
  useEffect(() => {
    if (!sample) return;
    setAuGt(sample.lab_au_gt != null ? String(sample.lab_au_gt) : '');
    setAgGt(sample.lab_ag_gt != null ? String(sample.lab_ag_gt) : '');
    setCuPct(sample.lab_cu_pct != null ? String(sample.lab_cu_pct) : '');
    setPbPct(sample.lab_pb_pct != null ? String(sample.lab_pb_pct) : '');
    setZnPct(sample.lab_zn_pct != null ? String(sample.lab_zn_pct) : '');
    setLabName(sample.lab_laboratorio || '');
    setLabDate(sample.lab_fecha_certificado || '');
    setVerdict((sample.validation_verdict as VerdictKey) || 'NOT_CONFIRMED');
    setValComment(sample.validation_comment || '');
    setOcrResult(null);
    setOcrPhotoUri(null);
    setOcrPhotoB64(null);
  }, [sample?.id]);

  // Reset tab when modal opens
  useEffect(() => { if (visible) setTab('INFO'); }, [visible]);

  // ── Lab save
  const handleLabSave = useCallback(async () => {
    if (!sample) return;
    setLabSaving(true);
    try {
      const lab: LabResult = {
        au_gt: auGt !== '' ? parseFloat(auGt) : null,
        ag_gt: agGt !== '' ? parseFloat(agGt) : null,
        cu_pct: cuPct !== '' ? parseFloat(cuPct) : null,
        pb_pct: pbPct !== '' ? parseFloat(pbPct) : null,
        zn_pct: znPct !== '' ? parseFloat(znPct) : null,
        laboratorio: labName,
        fecha_certificado: labDate,
      };
      await updateMuestraLab(sample.id, lab);
      onLabSaved();
      Alert.alert('Guardado', 'Resultados de laboratorio guardados.');
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'No se pudo guardar.');
    } finally {
      setLabSaving(false);
    }
  }, [sample, auGt, agGt, cuPct, pbPct, znPct, labName, labDate, onLabSaved]);

  // ── OCR pick photo
  const handlePickPhoto = useCallback(async (camera: boolean) => {
    const perm = camera
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (perm.status !== 'granted') {
      Alert.alert('Permiso denegado', camera ? 'Necesita acceso a la cámara.' : 'Necesita acceso a la galería.');
      return;
    }
    const result = camera
      ? await ImagePicker.launchCameraAsync({ base64: true, quality: 0.7, mediaTypes: ImagePicker.MediaTypeOptions.Images })
      : await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.7, mediaTypes: ImagePicker.MediaTypeOptions.Images });
    if (!result.canceled && result.assets?.[0]) {
      const asset = result.assets[0];
      setOcrPhotoUri(asset.uri);
      setOcrPhotoB64(asset.base64 ?? null);
      setOcrResult(null);
    }
  }, []);

  const handleOcrExtract = useCallback(async () => {
    if (!ocrPhotoB64) return;
    setOcrLoading(true);
    try {
      const result = await extractLabCertificateOCR(ocrPhotoB64);
      setOcrResult(result);
    } catch (e: any) {
      Alert.alert('Error OCR', e?.message || 'No se pudo extraer valores.');
    } finally {
      setOcrLoading(false);
    }
  }, [ocrPhotoB64]);

  const handleOcrConfirm = useCallback(async () => {
    if (!sample || !ocrResult) return;
    setLabSaving(true);
    try {
      const lab: LabResult = {
        au_gt: ocrResult.au_gt ?? null,
        ag_gt: ocrResult.ag_gt ?? null,
        cu_pct: ocrResult.cu_pct ?? null,
        pb_pct: ocrResult.pb_pct ?? null,
        zn_pct: ocrResult.zn_pct ?? null,
        laboratorio: ocrResult.laboratorio ?? labName,
        fecha_certificado: ocrResult.fecha_certificado ?? labDate,
      };
      await updateMuestraLab(sample.id, lab);
      // Reflect in form fields
      setAuGt(lab.au_gt != null ? String(lab.au_gt) : '');
      setAgGt(lab.ag_gt != null ? String(lab.ag_gt) : '');
      setCuPct(lab.cu_pct != null ? String(lab.cu_pct) : '');
      setPbPct(lab.pb_pct != null ? String(lab.pb_pct) : '');
      setZnPct(lab.zn_pct != null ? String(lab.zn_pct) : '');
      if (lab.laboratorio) setLabName(lab.laboratorio);
      if (lab.fecha_certificado) setLabDate(lab.fecha_certificado);
      onLabSaved();
      Alert.alert('Guardado', 'Resultados del certificado guardados.');
      setOcrResult(null);
      setOcrPhotoUri(null);
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'No se pudo guardar.');
    } finally {
      setLabSaving(false);
    }
  }, [sample, ocrResult, labName, labDate, onLabSaved]);

  const handleOcrEditManually = useCallback(() => {
    if (!ocrResult) return;
    setAuGt(ocrResult.au_gt != null ? String(ocrResult.au_gt) : '');
    setAgGt(ocrResult.ag_gt != null ? String(ocrResult.ag_gt) : '');
    setCuPct(ocrResult.cu_pct != null ? String(ocrResult.cu_pct) : '');
    setPbPct(ocrResult.pb_pct != null ? String(ocrResult.pb_pct) : '');
    setZnPct(ocrResult.zn_pct != null ? String(ocrResult.zn_pct) : '');
    if (ocrResult.laboratorio) setLabName(ocrResult.laboratorio);
    if (ocrResult.fecha_certificado) setLabDate(ocrResult.fecha_certificado);
    setOcrResult(null);
    setOcrPhotoUri(null);
  }, [ocrResult]);

  // ── Validation save
  const handleValSave = useCallback(async () => {
    if (!sample) return;
    setValSaving(true);
    try {
      await updateMuestraValidation(sample.id, verdict as 'CONFIRMED' | 'PARTIAL' | 'NOT_CONFIRMED', valComment);
      const snap = (() => { try { return JSON.parse(sample.spectral_snapshot || '{}'); } catch { return {}; } })();
      await upsertValidationPair(sample.id, sample.proyecto_id || '', {
        spectralConsensus: snap.consensus_level || '',
        spectralEvidence: snap.evidence || '',
        spectralBaseScore: snap.base_score ?? 0,
        spectralIndices: snap.indices || {},
        metalTarget: metalTarget,
        lab: {
          au_gt: sample.lab_au_gt ?? null, ag_gt: sample.lab_ag_gt ?? null,
          cu_pct: sample.lab_cu_pct ?? null, pb_pct: sample.lab_pb_pct ?? null,
          zn_pct: sample.lab_zn_pct ?? null,
        },
        verdict, verdictComment: valComment, verdictThreshold: 0.5,
      });
      onValidationSaved();
      Alert.alert('Guardado', 'Veredicto de validación guardado.');
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'No se pudo guardar.');
    } finally {
      setValSaving(false);
    }
  }, [sample, verdict, valComment, onValidationSaved]);

  if (!sample) return null;

  // Derived
  const spectral = (() => {
    try { return JSON.parse(sample.spectral_snapshot || '{}'); } catch { return {}; }
  })();
  const analisisIA = (() => {
    try { return JSON.parse(sample.analisis_ia || '{}'); } catch { return {}; }
  })();
  const suggestedVerdict = computeSuggestedVerdict(metalTarget, sample);

  // ─── Render helpers ────────────────────────────────────────────────────────

  const renderTabInfo = () => (
    <ScrollView style={styles.tabContent} contentContainerStyle={styles.tabPad}>
      <TouchableOpacity style={styles.labelBtn} onPress={onLabelPress}>
        <Text style={styles.labelBtnText}>🏷️ Etiqueta</Text>
      </TouchableOpacity>

      <Section title="Identificación">
        <Row label="Código" value={sample.muestra_codigo || sample.id} mono />
        <Row label="Proyecto" value={sample.proyecto_id} />
        <Row label="Tipo" value={sample.tipo_captura} />
        <Row label="Fecha" value={new Date(sample.fecha_hora).toLocaleString('es-MX')} />
      </Section>

      <Section title="Coordenadas">
        <Row label="Lat" value={sample.lat?.toFixed(6)} />
        <Row label="Lng" value={sample.lng?.toFixed(6)} />
        {!!sample.utm_zona && (
          <>
            <Row label="Zona UTM" value={sample.utm_zona} />
            <Row label="Easting" value={sample.utm_easting?.toLocaleString()} />
            <Row label="Northing" value={sample.utm_northing?.toLocaleString()} />
          </>
        )}
      </Section>

      {!!sample.imagen_thumbnail && (
        <Section title="Foto">
          <Image
            source={{ uri: sample.imagen_thumbnail }}
            style={styles.photo}
            resizeMode="cover"
          />
        </Section>
      )}

      {!!sample.descripcion_texto && (
        <Section title="Nota de campo">
          <Text style={styles.descText}>{sample.descripcion_texto}</Text>
        </Section>
      )}

      {!!sample.mineral_detectado && (
        <Section title="Análisis IA">
          <Row label="Mineral" value={sample.mineral_detectado} />
          {sample.score_ia != null && <Row label="Score" value={`${sample.score_ia}%`} />}
          {!!analisisIA.alteracion && <Row label="Alteración" value={analisisIA.alteracion} />}
          {Array.isArray(analisisIA.indicadores) && analisisIA.indicadores.length > 0 && (
            <Text style={styles.listItem}>
              {analisisIA.indicadores.map((i: string) => `• ${i}`).join('\n')}
            </Text>
          )}
        </Section>
      )}

      {spectral.consensus_level && (
        <Section title="Espectral satélite">
          <Row label="Consenso" value={spectral.consensus_level} />
          {spectral.base_score != null && (
            <Row label="Score" value={`${(spectral.base_score * 100).toFixed(1)}%`} />
          )}
          {!!spectral.evidence && <Row label="Evidencia" value={spectral.evidence} />}
        </Section>
      )}
    </ScrollView>
  );

  const renderTabLab = () => (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={100}
    >
      <ScrollView style={styles.tabContent} contentContainerStyle={styles.tabPad}>
        {/* Existing lab values */}
        {(sample.lab_au_gt != null || sample.lab_ag_gt != null || sample.lab_cu_pct != null) && (
          <Section title="Valores actuales">
            {sample.lab_au_gt != null && <Row label="Au" value={`${sample.lab_au_gt} g/t`} highlight />}
            {sample.lab_ag_gt != null && <Row label="Ag" value={`${sample.lab_ag_gt} g/t`} highlight />}
            {sample.lab_cu_pct != null && <Row label="Cu" value={`${sample.lab_cu_pct} %`} highlight />}
            {sample.lab_pb_pct != null && <Row label="Pb" value={`${sample.lab_pb_pct} %`} />}
            {sample.lab_zn_pct != null && <Row label="Zn" value={`${sample.lab_zn_pct} %`} />}
            {!!sample.lab_laboratorio && <Row label="Laboratorio" value={sample.lab_laboratorio} />}
            {!!sample.lab_fecha_certificado && <Row label="Fecha cert." value={sample.lab_fecha_certificado} />}
          </Section>
        )}

        {/* Manual entry */}
        <Section title="Ingreso manual">
          <LabInput label="Au (g/t)" value={auGt} onChange={setAuGt} />
          <LabInput label="Ag (g/t)" value={agGt} onChange={setAgGt} />
          <LabInput label="Cu (%)" value={cuPct} onChange={setCuPct} />
          <LabInput label="Pb (%)" value={pbPct} onChange={setPbPct} />
          <LabInput label="Zn (%)" value={znPct} onChange={setZnPct} />
          <View style={styles.inputRow}>
            <Text style={styles.inputLabel}>Laboratorio</Text>
            <TextInput
              style={styles.textInput}
              value={labName}
              onChangeText={setLabName}
              placeholder="Nombre del lab"
              placeholderTextColor={Colors.textDim}
            />
          </View>
          <View style={styles.inputRow}>
            <Text style={styles.inputLabel}>Fecha cert.</Text>
            <TextInput
              style={styles.textInput}
              value={labDate}
              onChangeText={setLabDate}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={Colors.textDim}
            />
          </View>
          <TouchableOpacity
            style={styles.btnSave}
            onPress={handleLabSave}
            disabled={labSaving}
          >
            {labSaving
              ? <ActivityIndicator color={Colors.surface} size="small" />
              : <Text style={styles.btnSaveText}>💾 Guardar resultados</Text>}
          </TouchableOpacity>
        </Section>

        {/* OCR section */}
        <Section title="Escanear certificado (OCR IA)">
          <View style={styles.ocrBtns}>
            <TouchableOpacity
              style={styles.btnOcr}
              onPress={() => handlePickPhoto(true)}
            >
              <Text style={styles.btnOcrText}>📷 Cámara</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.btnOcr}
              onPress={() => handlePickPhoto(false)}
            >
              <Text style={styles.btnOcrText}>🖼️ Galería</Text>
            </TouchableOpacity>
          </View>

          {!!ocrPhotoUri && (
            <Image source={{ uri: ocrPhotoUri }} style={styles.ocrThumb} resizeMode="cover" />
          )}

          {!!ocrPhotoUri && !ocrResult && (
            <TouchableOpacity
              style={styles.btnExtract}
              onPress={handleOcrExtract}
              disabled={ocrLoading}
            >
              {ocrLoading ? (
                <View style={styles.ocrLoadRow}>
                  <ActivityIndicator color={Colors.primary} size="small" />
                  <Text style={styles.btnExtractText}>  Extrayendo valores...</Text>
                </View>
              ) : (
                <Text style={styles.btnExtractText}>🔍 Extraer con IA</Text>
              )}
            </TouchableOpacity>
          )}

          {!!ocrResult && (
            <View style={styles.ocrResults}>
              <View style={styles.ocrConfRow}>
                <Text style={styles.ocrConfBadge}>{confidenceDot(ocrResult.confidence)}</Text>
              </View>
              {!!ocrResult.notes && (
                <Text style={styles.ocrNotes}>⚠️ {ocrResult.notes}</Text>
              )}
              <OcrValueRow label="Au" value={ocrResult.au_gt} unit="g/t" />
              <OcrValueRow label="Ag" value={ocrResult.ag_gt} unit="g/t" />
              <OcrValueRow label="Cu" value={ocrResult.cu_pct} unit="%" />
              <OcrValueRow label="Pb" value={ocrResult.pb_pct} unit="%" />
              <OcrValueRow label="Zn" value={ocrResult.zn_pct} unit="%" />
              {ocrResult.laboratorio && <OcrValueRow label="Lab" value={ocrResult.laboratorio} unit="" />}
              {ocrResult.fecha_certificado && <OcrValueRow label="Fecha" value={ocrResult.fecha_certificado} unit="" />}

              <TouchableOpacity
                style={styles.btnConfirm}
                onPress={handleOcrConfirm}
                disabled={labSaving}
              >
                {labSaving
                  ? <ActivityIndicator color={Colors.surface} size="small" />
                  : <Text style={styles.btnConfirmText}>✅ Confirmar y guardar</Text>}
              </TouchableOpacity>
              <TouchableOpacity style={styles.btnEditManual} onPress={handleOcrEditManually}>
                <Text style={styles.btnEditManualText}>✏️ Editar manualmente</Text>
              </TouchableOpacity>
            </View>
          )}
        </Section>
      </ScrollView>
    </KeyboardAvoidingView>
  );

  const renderTabValidation = () => (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={100}
    >
      <ScrollView style={styles.tabContent} contentContainerStyle={styles.tabPad}>
        {/* Current verdict */}
        {!!sample.validation_verdict && (
          <Section title="Veredicto actual">
            <View style={[styles.verdictBadge, { borderColor: verdictBadgeColor(sample.validation_verdict) }]}>
              <Text style={[styles.verdictBadgeText, { color: verdictBadgeColor(sample.validation_verdict) }]}>
                {VERDICT_LABEL[sample.validation_verdict as VerdictKey] ?? sample.validation_verdict}
              </Text>
            </View>
            {!!sample.validation_comment && (
              <Text style={styles.descText}>{sample.validation_comment}</Text>
            )}
          </Section>
        )}

        {/* Threshold reference */}
        <Section title="Regla de validación">
          <Text style={styles.thresholdText}>
            Para {metalTarget}: {THRESHOLDS[metalTarget] ?? 'Configura el metal objetivo.'}
          </Text>
        </Section>

        {/* Comparison */}
        <Section title="Comparación satélite vs laboratorio">
          <Row
            label="Predicción satélite"
            value={spectral.consensus_level || '—'}
          />
          <Row
            label="Score espectral"
            value={spectral.base_score != null ? `${(spectral.base_score * 100).toFixed(1)}%` : '—'}
          />
          <Row label="Au lab" value={sample.lab_au_gt != null ? `${sample.lab_au_gt} g/t` : '—'} />
          <Row label="Ag lab" value={sample.lab_ag_gt != null ? `${sample.lab_ag_gt} g/t` : '—'} />
          <Row label="Cu lab" value={sample.lab_cu_pct != null ? `${sample.lab_cu_pct} %` : '—'} />
        </Section>

        {/* Suggested verdict */}
        <Section title="Veredicto sugerido">
          <View style={[styles.verdictBadge, { borderColor: VERDICT_COLOR[suggestedVerdict] }]}>
            <Text style={[styles.verdictBadgeText, { color: VERDICT_COLOR[suggestedVerdict] }]}>
              {VERDICT_LABEL[suggestedVerdict]}
            </Text>
          </View>
        </Section>

        {/* Manual override */}
        <Section title="Veredicto manual">
          <View style={styles.verdictBtns}>
            {(['CONFIRMED', 'PARTIAL', 'NOT_CONFIRMED'] as VerdictKey[]).map(v => (
              <TouchableOpacity
                key={v}
                style={[
                  styles.verdictBtn,
                  { borderColor: VERDICT_COLOR[v] },
                  verdict === v && { backgroundColor: VERDICT_COLOR[v] },
                ]}
                onPress={() => setVerdict(v)}
              >
                <Text style={[
                  styles.verdictBtnText,
                  { color: verdict === v ? Colors.surface : VERDICT_COLOR[v] },
                ]}>
                  {VERDICT_LABEL[v]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <TextInput
            style={[styles.textInput, styles.commentInput]}
            value={valComment}
            onChangeText={setValComment}
            placeholder="Comentario (opcional)"
            placeholderTextColor={Colors.textDim}
            multiline
            numberOfLines={3}
          />

          <TouchableOpacity
            style={styles.btnSave}
            onPress={handleValSave}
            disabled={valSaving}
          >
            {valSaving
              ? <ActivityIndicator color={Colors.surface} size="small" />
              : <Text style={styles.btnSaveText}>Guardar veredicto</Text>}
          </TouchableOpacity>
        </Section>
      </ScrollView>
    </KeyboardAvoidingView>
  );

  // ─── Root render ──────────────────────────────────────────────────────────

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        {/* Header */}
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerCode} numberOfLines={1}>
              {sample.muestra_codigo || sample.id}
            </Text>
            <Text style={styles.headerSub}>{sample.proyecto_id}</Text>
          </View>
          <TouchableOpacity
            onPress={onClose}
            style={styles.closeBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.closeBtnText}>✕</Text>
          </TouchableOpacity>
        </View>

        {/* Tab bar */}
        <View style={styles.tabBar}>
          {(['INFO', 'LAB', 'VALIDACIÓN'] as const).map((label, idx) => {
            const id = (['INFO', 'LAB', 'VALIDATION'] as TabId[])[idx];
            const active = tab === id;
            return (
              <TouchableOpacity
                key={id}
                style={[styles.tabPill, active && styles.tabPillActive]}
                onPress={() => setTab(id)}
              >
                <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>
                  {label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Tab content */}
        <View style={{ flex: 1 }}>
          {tab === 'INFO' && renderTabInfo()}
          {tab === 'LAB' && renderTabLab()}
          {tab === 'VALIDATION' && renderTabValidation()}
        </View>
      </View>
    </Modal>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={sectionStyles.container}>
      <Text style={sectionStyles.title}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ label, value, mono, highlight }: { label: string; value?: string | number | null; mono?: boolean; highlight?: boolean }) {
  if (value == null) return null;
  return (
    <View style={rowStyles.row}>
      <Text style={rowStyles.label}>{label}</Text>
      <Text style={[rowStyles.value, mono && rowStyles.mono, highlight && rowStyles.highlight]}>
        {String(value)}
      </Text>
    </View>
  );
}

function LabInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <View style={styles.inputRow}>
      <Text style={styles.inputLabel}>{label}</Text>
      <TextInput
        style={styles.textInput}
        value={value}
        onChangeText={onChange}
        keyboardType="decimal-pad"
        placeholder="—"
        placeholderTextColor={Colors.textDim}
      />
    </View>
  );
}

function OcrValueRow({ label, value, unit }: { label: string; value?: number | string | null; unit: string }) {
  const hasValue = value != null;
  return (
    <View style={rowStyles.row}>
      <Text style={rowStyles.label}>{label}</Text>
      <Text style={[rowStyles.value, hasValue ? { color: Colors.success } : { color: Colors.textDim }]}>
        {hasValue ? `${value}${unit ? ' ' + unit : ''}` : 'no detectado'}
      </Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.surface,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surface3,
    backgroundColor: Colors.surface2,
  },
  headerCode: {
    color: Colors.primary,
    fontSize: 16,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  headerSub: {
    color: Colors.textSub,
    fontSize: 12,
    marginTop: 2,
  },
  closeBtn: {
    width: Touch.min,
    height: Touch.min,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeBtnText: {
    color: Colors.textSub,
    fontSize: 20,
  },
  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    backgroundColor: Colors.surface2,
    gap: 8,
  },
  tabPill: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: Radii.pill,
    borderWidth: 1,
    borderColor: Colors.surface3,
    alignItems: 'center',
  },
  tabPillActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  tabLabel: {
    color: Colors.textSub,
    fontSize: 13,
    fontWeight: '600',
  },
  tabLabelActive: {
    color: Colors.surface,
  },
  tabContent: { flex: 1 },
  tabPad: { padding: Spacing.md, paddingBottom: 40 },
  labelBtn: {
    alignSelf: 'flex-end',
    backgroundColor: Colors.surface3,
    borderWidth: 1,
    borderColor: Colors.primary,
    borderRadius: Radii.sm,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginBottom: Spacing.md,
  },
  labelBtnText: {
    color: Colors.primary,
    fontSize: 13,
    fontWeight: '600',
  },
  photo: {
    width: '100%',
    height: 200,
    borderRadius: Radii.md,
    backgroundColor: Colors.surface3,
  },
  descText: {
    color: Colors.text,
    fontSize: 13,
    lineHeight: 20,
  },
  listItem: {
    color: Colors.textSub,
    fontSize: 13,
    lineHeight: 20,
    marginTop: 4,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    gap: 8,
  },
  inputLabel: {
    color: Colors.textSub,
    fontSize: 13,
    width: 80,
  },
  textInput: {
    flex: 1,
    color: Colors.text,
    fontSize: 14,
    backgroundColor: Colors.surface3,
    borderRadius: Radii.sm,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: Touch.min,
  },
  commentInput: {
    minHeight: 80,
    textAlignVertical: 'top',
    marginBottom: 12,
  },
  btnSave: {
    backgroundColor: Colors.primary,
    borderRadius: Radii.md,
    height: Touch.min,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 6,
  },
  btnSaveText: {
    color: Colors.surface,
    fontSize: 14,
    fontWeight: '700',
  },
  ocrBtns: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  btnOcr: {
    flex: 1,
    height: Touch.min,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radii.md,
    justifyContent: 'center',
    alignItems: 'center',
  },
  btnOcrText: {
    color: Colors.text,
    fontSize: 13,
  },
  ocrThumb: {
    width: '100%',
    height: 160,
    borderRadius: Radii.md,
    backgroundColor: Colors.surface3,
    marginBottom: 10,
  },
  btnExtract: {
    height: Touch.min,
    borderWidth: 1,
    borderColor: Colors.primary,
    borderRadius: Radii.md,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 10,
  },
  btnExtractText: {
    color: Colors.primary,
    fontSize: 14,
    fontWeight: '600',
  },
  ocrLoadRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  ocrResults: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    padding: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.surface3,
  },
  ocrConfRow: {
    marginBottom: 8,
  },
  ocrConfBadge: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.text,
  },
  ocrNotes: {
    color: Colors.warning,
    fontSize: 12,
    marginBottom: 8,
  },
  btnConfirm: {
    backgroundColor: Colors.primary,
    borderRadius: Radii.md,
    height: Touch.min,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 10,
  },
  btnConfirmText: {
    color: Colors.surface,
    fontSize: 14,
    fontWeight: '700',
  },
  btnEditManual: {
    height: Touch.min,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radii.md,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  btnEditManualText: {
    color: Colors.textSub,
    fontSize: 13,
  },
  verdictBadge: {
    borderWidth: 2,
    borderRadius: Radii.md,
    paddingHorizontal: 14,
    paddingVertical: 8,
    alignSelf: 'flex-start',
    marginBottom: 8,
  },
  verdictBadgeText: {
    fontSize: 15,
    fontWeight: '700',
  },
  thresholdText: {
    color: Colors.text,
    fontSize: 13,
    lineHeight: 20,
  },
  verdictBtns: {
    gap: 8,
    marginBottom: 12,
  },
  verdictBtn: {
    height: Touch.min,
    borderWidth: 2,
    borderRadius: Radii.md,
    justifyContent: 'center',
    alignItems: 'center',
  },
  verdictBtnText: {
    fontSize: 14,
    fontWeight: '700',
  },
});

const sectionStyles = StyleSheet.create({
  container: {
    backgroundColor: Colors.surface2,
    borderRadius: Radii.md,
    padding: Spacing.sm,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.surface3,
  },
  title: {
    color: Colors.primary,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
});

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surface3,
  },
  label: {
    color: Colors.textSub,
    fontSize: 12,
    flex: 1,
  },
  value: {
    color: Colors.text,
    fontSize: 13,
    flex: 2,
    textAlign: 'right',
  },
  mono: {
    fontFamily: 'monospace',
  },
  highlight: {
    color: Colors.success,
    fontWeight: '700',
  },
});

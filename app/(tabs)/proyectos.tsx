/**
 * proyectos.tsx — Proyectos tab
 * Lists all saved projects with status, area, samples, last access.
 * Tap → detail view. Long-press → action sheet (rename/delete/etc).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  Alert,
  FlatList,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  deleteProject,
  getMuestras,
  listProjects,
  loadFieldPackage,
  loadProjectState,
  renameProject,
} from '../core/Database';
import { Colors, Radii, Shadows, Spacing, Touch, Typography } from '../core/theme';
import ValidationView from '../components/ValidationView';
import { exportProjectToExcel } from '../core/excelExport';
import { useAuth } from '../core/AuthContext';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProjectRow {
  id: string;
  nombre: string;
  ultimo_acceso: string;
}

interface ProjectMeta extends ProjectRow {
  area_ha: number;
  mineral: string;
  terrain: string;
  acquisition_date: string;
  analisis_count: number;
  sample_count: number;
  photo_count: number;
  chat_count: number;
  campo_ready: boolean;
  top3_anomalies: number[];
  samples_preview: Array<{ id: string; fecha_hora: string; mineral_detectado: string }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function relativeDate(isoString: string): string {
  if (!isoString) return '';
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);
  if (mins < 2) return 'ahora';
  if (mins < 60) return `hace ${mins} min`;
  if (hours < 24) return `hace ${hours}h`;
  if (days === 1) return 'ayer';
  if (days < 30) return `hace ${days} días`;
  const months = Math.floor(days / 30);
  if (months < 12) return `hace ${months} mes${months > 1 ? 'es' : ''}`;
  return `hace ${Math.floor(months / 12)} año${Math.floor(months / 12) > 1 ? 's' : ''}`;
}

function fmtArea(ha: number): string {
  if (!ha || ha === 0) return '— ha';
  return `${ha.toFixed(1)} ha`;
}

// ─── Empty State ─────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <View style={styles.emptyContainer}>
      <Text style={styles.emptyIcon}>📁</Text>
      <Text style={styles.emptyText}>
        {'Traza una zona y guárdala para\ncrear tu primer proyecto.'}
      </Text>
    </View>
  );
}

// ─── Status Badge ─────────────────────────────────────────────────────────────

// `ready` = hay un paquete de campo descargado para usar sin señal. NO tiene nada
// que ver con la conexión actual: antes esto decía "Requiere conexión", lo que
// hacía creer que la app estaba offline aun con WiFi.
function StatusBadge({ ready }: { ready: boolean }) {
  return (
    <View style={[styles.badge, { backgroundColor: ready ? 'rgba(76,175,80,0.15)' : 'rgba(255,152,0,0.15)' }]}>
      <Text style={[styles.badgeText, { color: ready ? Colors.success : Colors.warning }]}>
        {ready ? '✅ Listo para campo' : '📴 Sin paquete de campo'}
      </Text>
    </View>
  );
}

// ─── Project Card ─────────────────────────────────────────────────────────────

interface CardProps {
  item: ProjectMeta;
  onPress: () => void;
  onLongPress: () => void;
}

function ProjectCard({ item, onPress, onLongPress }: CardProps) {
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={onPress}
      onLongPress={onLongPress}
      android_ripple={{ color: 'rgba(255,215,0,0.08)' }}
    >
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle} numberOfLines={1}>{item.nombre}</Text>
        <Text style={styles.cardTime}>{relativeDate(item.ultimo_acceso)}</Text>
      </View>

      <View style={styles.cardMeta}>
        <Text style={styles.cardMetaItem}>📐 {fmtArea(item.area_ha)}</Text>
        {item.mineral ? <Text style={styles.cardMetaItem}>⛏ {item.mineral}</Text> : null}
        {item.terrain ? <Text style={styles.cardMetaItem}>🏔 {item.terrain}</Text> : null}
        <Text style={styles.cardMetaItem}>🔬 {item.sample_count} muestras</Text>
      </View>

      <StatusBadge ready={item.campo_ready} />
    </Pressable>
  );
}

// ─── Detail View ──────────────────────────────────────────────────────────────

interface DetailProps {
  project: ProjectMeta;
  onBack: () => void;
  onDeleted: () => void;
  onRenamed: (newName: string) => void;
}

function ProjectDetail({ project, onBack, onDeleted, onRenamed }: DetailProps) {
  const handleOpenInMap = useCallback(async () => {
    // Misma clave que lee el mapa (index.tsx). Antes usaba otra → nunca cargaba.
    await AsyncStorage.setItem('currentProjectId', project.id);
    router.push('/');
  }, [project.id]);

  const handleDelete = useCallback(() => {
    Alert.alert(
      'Eliminar proyecto',
      'Esta acción no se puede deshacer. ¿Eliminar proyecto y todas sus muestras?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteProject(project.id);
              onDeleted();
            } catch (e) {
              Alert.alert('Error', 'No se pudo eliminar el proyecto.');
            }
          },
        },
      ]
    );
  }, [project.id, onDeleted]);

  const handleExportExcel = useCallback(async () => {
    try {
      await exportProjectToExcel(project.id, project.nombre);
    } catch (e: any) {
      Alert.alert('Excel', 'No se pudo exportar: ' + (e?.message || 'error desconocido'));
    }
  }, [project.id, project.nombre]);

  const anomalyColors = [Colors.anomalyHigh, Colors.anomalyMed, Colors.anomalyLow];

  return (
    <View style={styles.detailContainer}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.surface} />

      {/* Header */}
      <View style={styles.detailHeader}>
        <Pressable
          style={styles.backBtn}
          onPress={onBack}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.backBtnText}>← Volver</Text>
        </Pressable>
        <Text style={styles.detailTitle} numberOfLines={1}>{project.nombre}</Text>
        <View style={{ width: 80 }} />
      </View>

      <ScrollView style={styles.detailScroll} contentContainerStyle={styles.detailScrollContent}>
        {/* Status */}
        <StatusBadge ready={project.campo_ready} />
        <View style={{ height: Spacing.md }} />

        {/* Info block */}
        <View style={styles.infoBlock}>
          <InfoRow label="Área" value={fmtArea(project.area_ha)} />
          <InfoRow label="Mineral objetivo" value={project.mineral || '—'} />
          <InfoRow label="Terreno" value={project.terrain || '—'} />
          <InfoRow label="Fecha adquisición" value={project.acquisition_date || '—'} />
          <InfoRow label="Último acceso" value={relativeDate(project.ultimo_acceso)} />
        </View>

        {/* Analysis summary */}
        <SectionHeader title="Análisis satelital" />
        <View style={styles.infoBlock}>
          <InfoRow label="Zonas analizadas" value={String(project.analisis_count)} />
          {project.top3_anomalies.length > 0 && (
            <View style={styles.anomalyRow}>
              <Text style={styles.infoLabel}>Top anomalías</Text>
              <View style={styles.anomalyChips}>
                {project.top3_anomalies.map((pct, i) => (
                  <View key={i} style={[styles.anomalyChip, { backgroundColor: anomalyColors[i] + '33' }]}>
                    <Text style={[styles.anomalyChipText, { color: anomalyColors[i] }]}>
                      {pct.toFixed(0)}%
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          )}
        </View>

        {/* Samples */}
        <SectionHeader title={`Muestras (${project.sample_count})`} />
        <View style={styles.infoBlock}>
          <InfoRow label="Muestras totales" value={String(project.sample_count)} />
          <InfoRow label="Con foto" value={String(project.photo_count)} />
        </View>

        {/* Sample preview */}
        {project.samples_preview.length > 0 && (
          <View style={styles.samplesList}>
            {project.samples_preview.map((s) => (
              <View key={s.id} style={styles.sampleRow}>
                <Text style={styles.sampleMineral} numberOfLines={1}>
                  {s.mineral_detectado || 'Sin análisis'}
                </Text>
                <Text style={styles.sampleDate}>{relativeDate(s.fecha_hora)}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Chat */}
        <SectionHeader title="Ing. Villegas" />
        <View style={styles.infoBlock}>
          <InfoRow label="Mensajes" value={String(project.chat_count)} />
        </View>

        {/* Validation */}
        <SectionHeader title="Validación" />
        <ValidationView projectId={project.id} metalTarget={project.mineral || 'oro'} />

        {/* Actions */}
        <SectionHeader title="Acciones" />
        <View style={styles.actionsBlock}>
          <ActionButton
            label="🗺  Ver en mapa"
            color={Colors.primary}
            textColor={Colors.bg}
            onPress={handleOpenInMap}
          />
          <ActionButton
            label="📊  Exportar a Excel"
            color={Colors.anomalyMed}
            textColor={Colors.bg}
            onPress={handleExportExcel}
          />
          <ActionButton
            label="🗑  Eliminar proyecto"
            color={Colors.danger}
            textColor={Colors.text}
            onPress={handleDelete}
          />
        </View>

        <View style={{ height: Spacing.xxxl }} />
      </ScrollView>
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <Text style={styles.sectionHeader}>{title.toUpperCase()}</Text>
  );
}

function ActionButton({ label, color, textColor, onPress }: {
  label: string; color: string; textColor: string; onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.actionBtn,
        { backgroundColor: color, opacity: pressed ? 0.8 : 1 },
      ]}
      onPress={onPress}
    >
      <Text style={[styles.actionBtnText, { color: textColor }]}>{label}</Text>
    </Pressable>
  );
}

// ─── Rename Modal ─────────────────────────────────────────────────────────────

interface RenameModalProps {
  visible: boolean;
  initialName: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

function RenameModal({ visible, initialName, onConfirm, onCancel }: RenameModalProps) {
  const [name, setName] = useState(initialName);
  useEffect(() => { if (visible) setName(initialName); }, [visible, initialName]);

  return (
    <Modal transparent animationType="fade" visible={visible} onRequestClose={onCancel}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalBox}>
          <Text style={styles.modalTitle}>Renombrar proyecto</Text>
          <TextInput
            style={styles.modalInput}
            value={name}
            onChangeText={setName}
            placeholder="Nombre del proyecto"
            placeholderTextColor={Colors.textDim}
            autoFocus
            selectTextOnFocus
            returnKeyType="done"
            onSubmitEditing={() => name.trim() && onConfirm(name.trim())}
          />
          <View style={styles.modalButtons}>
            <Pressable style={styles.modalBtnCancel} onPress={onCancel}>
              <Text style={styles.modalBtnCancelText}>Cancelar</Text>
            </Pressable>
            <Pressable
              style={[styles.modalBtnConfirm, !name.trim() && { opacity: 0.4 }]}
              onPress={() => name.trim() && onConfirm(name.trim())}
              disabled={!name.trim()}
            >
              <Text style={styles.modalBtnConfirmText}>Guardar</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function ProyectosScreen() {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedProject, setSelectedProject] = useState<ProjectMeta | null>(null);
  const [renameTarget, setRenameTarget] = useState<ProjectMeta | null>(null);
  const { profile, isAdmin, signOut } = useAuth();

  const openAccount = useCallback(() => {
    const opts: any[] = [];
    if (isAdmin) opts.push({ text: '🎟️  Códigos de invitación', onPress: () => router.push('/admin' as any) });
    opts.push({ text: 'Cerrar sesión', style: 'destructive', onPress: () => { signOut(); } });
    opts.push({ text: 'Cancelar', style: 'cancel' });
    Alert.alert(profile?.nombre || 'Tu cuenta', isAdmin ? 'Administrador' : 'Cuenta', opts);
  }, [isAdmin, profile, signOut]);

  const loadAll = useCallback(async () => {
    try {
      const rows: ProjectRow[] = await listProjects();

      const metas: ProjectMeta[] = await Promise.all(
        rows.map(async (row) => {
          const [state, samples, field] = await Promise.all([
            loadProjectState(row.id),
            getMuestras(row.id),
            loadFieldPackage(row.id),
          ]);

          const analisisArr: any[] = state?.analisis_resultado ?? [];
          const top3 = analisisArr
            .map((a: any) => typeof a?.score === 'number' ? a.score : (typeof a?.pct === 'number' ? a.pct : 0))
            .sort((a: number, b: number) => b - a)
            .slice(0, 3);

          const samplesTyped = samples as Array<{
            id: string; fecha_hora: string; mineral_detectado: string; imagen_thumbnail: string;
          }>;

          return {
            id: row.id,
            nombre: row.nombre,
            ultimo_acceso: row.ultimo_acceso,
            area_ha: state?.area_ha ?? 0,
            mineral: state?.mineral ?? '',
            terrain: state?.terrain ?? '',
            acquisition_date: state?.acquisition_date ?? '',
            analisis_count: analisisArr.length,
            sample_count: samplesTyped.length,
            photo_count: samplesTyped.filter((s) => !!s.imagen_thumbnail).length,
            chat_count: state?.chat_history?.length ?? 0,
            campo_ready: !!field,
            top3_anomalies: top3,
            samples_preview: samplesTyped.slice(0, 5).map((s) => ({
              id: s.id,
              fecha_hora: s.fecha_hora,
              mineral_detectado: s.mineral_detectado,
            })),
          };
        })
      );

      setProjects(metas);
    } catch (err) {
      console.warn('[Proyectos] loadAll error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      loadAll();
    }, [loadAll])
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadAll();
  }, [loadAll]);

  const showActionSheet = useCallback((item: ProjectMeta) => {
    const options = ['Renombrar', 'Eliminar', 'Cancelar'];
    const destructiveIndex = 1;
    const cancelIndex = 2;

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, destructiveButtonIndex: destructiveIndex, cancelButtonIndex: cancelIndex, title: item.nombre },
        (idx) => {
          if (idx === 0) setRenameTarget(item);
          if (idx === 1) confirmDelete(item);
        }
      );
    } else {
      Alert.alert(item.nombre, 'Selecciona una acción', [
        { text: 'Renombrar', onPress: () => setRenameTarget(item) },
        { text: 'Eliminar', style: 'destructive', onPress: () => confirmDelete(item) },
        { text: 'Cancelar', style: 'cancel' },
      ]);
    }
  }, []);

  const confirmDelete = useCallback((item: ProjectMeta) => {
    Alert.alert(
      'Eliminar proyecto',
      'Esta acción no se puede deshacer. ¿Eliminar proyecto y todas sus muestras?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteProject(item.id);
              if (selectedProject?.id === item.id) setSelectedProject(null);
              await loadAll();
            } catch {
              Alert.alert('Error', 'No se pudo eliminar el proyecto.');
            }
          },
        },
      ]
    );
  }, [selectedProject, loadAll]);

  const handleRenameConfirm = useCallback(async (newName: string) => {
    if (!renameTarget) return;
    try {
      await renameProject(renameTarget.id, newName);
      setRenameTarget(null);
      // Update local state without full reload
      setProjects((prev) =>
        prev.map((p) => p.id === renameTarget.id ? { ...p, nombre: newName } : p)
      );
      if (selectedProject?.id === renameTarget.id) {
        setSelectedProject((prev) => prev ? { ...prev, nombre: newName } : prev);
      }
    } catch {
      Alert.alert('Error', 'No se pudo renombrar el proyecto.');
    }
  }, [renameTarget, selectedProject]);

  // ── Detail view ──────────────────────────────────────────────────────────
  if (selectedProject) {
    return (
      <>
        <StatusBar barStyle="light-content" backgroundColor={Colors.surface} />
        <ProjectDetail
          project={selectedProject}
          onBack={() => setSelectedProject(null)}
          onDeleted={() => {
            setSelectedProject(null);
            loadAll();
          }}
          onRenamed={(newName) => {
            setSelectedProject((prev) => prev ? { ...prev, nombre: newName } : prev);
            setProjects((prev) =>
              prev.map((p) => p.id === selectedProject.id ? { ...p, nombre: newName } : p)
            );
          }}
        />
        <RenameModal
          visible={!!renameTarget}
          initialName={renameTarget?.nombre ?? ''}
          onConfirm={handleRenameConfirm}
          onCancel={() => setRenameTarget(null)}
        />
      </>
    );
  }

  // ── List view ──────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.surface} />

      {/* Screen header */}
      <View style={[styles.screenHeader, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.screenTitle}>Proyectos</Text>
          <Text style={styles.screenSubtitle}>
            {projects.length > 0 ? `${projects.length} proyecto${projects.length > 1 ? 's' : ''}` : ''}
          </Text>
        </View>
        <Pressable onPress={openAccount} style={styles.accountBtn} hitSlop={8}>
          <Text style={styles.accountBtnText}>{isAdmin ? '👤 Admin' : '👤 Cuenta'}</Text>
        </Pressable>
      </View>

      <FlatList
        data={projects}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <ProjectCard
            item={item}
            onPress={() => setSelectedProject(item)}
            onLongPress={() => showActionSheet(item)}
          />
        )}
        contentContainerStyle={[
          styles.listContent,
          projects.length === 0 && styles.listContentEmpty,
        ]}
        ListEmptyComponent={loading ? null : <EmptyState />}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors.primary}
            colors={[Colors.primary]}
          />
        }
        showsVerticalScrollIndicator={false}
      />

      <RenameModal
        visible={!!renameTarget}
        initialName={renameTarget?.nombre ?? ''}
        onConfirm={handleRenameConfirm}
        onCancel={() => setRenameTarget(null)}
      />
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.surface,
  },

  // Screen header
  screenHeader: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xl + Spacing.lg,
    paddingBottom: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  screenTitle: {
    ...Typography.hero,
    color: Colors.text,
  },
  screenSubtitle: {
    ...Typography.body,
    color: Colors.textSub,
    marginTop: Spacing.xxs,
  },
  accountBtn: {
    borderWidth: 1,
    borderColor: Colors.primary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: `${Colors.primary}18`,
  },
  accountBtnText: {
    color: Colors.primary,
    fontSize: 13,
    fontWeight: '700',
  },

  // List
  listContent: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.xxxl,
    gap: Spacing.sm,
  },
  listContentEmpty: {
    flex: 1,
  },

  // Card
  card: {
    backgroundColor: Colors.surface2,
    borderRadius: Radii.md,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
    gap: Spacing.sm,
    ...Shadows.card,
  },
  cardPressed: {
    opacity: 0.85,
    borderColor: Colors.primary,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardTitle: {
    ...Typography.title,
    color: Colors.text,
    flex: 1,
    marginRight: Spacing.sm,
  },
  cardTime: {
    ...Typography.micro,
    color: Colors.textDim,
  },
  cardMeta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
  },
  cardMetaItem: {
    ...Typography.caption,
    color: Colors.textSub,
  },

  // Badge
  badge: {
    alignSelf: 'flex-start',
    borderRadius: Radii.pill,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xxs + 2,
  },
  badgeText: {
    ...Typography.caption,
    fontWeight: '600',
  },

  // Empty
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing.xl,
    gap: Spacing.lg,
  },
  emptyIcon: {
    fontSize: 56,
  },
  emptyText: {
    ...Typography.subTitle,
    color: Colors.textSub,
    textAlign: 'center',
    lineHeight: 24,
  },

  // Detail
  detailContainer: {
    flex: 1,
    backgroundColor: Colors.surface,
  },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xl + Spacing.lg,
    paddingBottom: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: Spacing.sm,
  },
  backBtn: {
    minHeight: Touch.min,
    justifyContent: 'center',
    width: 80,
  },
  backBtnText: {
    ...Typography.body,
    color: Colors.primary,
  },
  detailTitle: {
    ...Typography.title,
    color: Colors.text,
    flex: 1,
    textAlign: 'center',
  },
  detailScroll: {
    flex: 1,
  },
  detailScrollContent: {
    padding: Spacing.lg,
    gap: Spacing.xs,
  },

  // Info block
  infoBlock: {
    backgroundColor: Colors.surface2,
    borderRadius: Radii.md,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surface3,
    minHeight: Touch.min,
  },
  infoLabel: {
    ...Typography.body,
    color: Colors.textSub,
  },
  infoValue: {
    ...Typography.bodyBold,
    color: Colors.text,
    textAlign: 'right',
    flex: 1,
    marginLeft: Spacing.sm,
  },

  // Anomaly chips
  anomalyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
    minHeight: Touch.min,
  },
  anomalyChips: {
    flexDirection: 'row',
    gap: Spacing.xs,
  },
  anomalyChip: {
    borderRadius: Radii.xs,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xxs,
  },
  anomalyChipText: {
    ...Typography.caption,
    fontWeight: '700',
  },

  // Section header
  sectionHeader: {
    ...Typography.micro,
    color: Colors.textDim,
    letterSpacing: 1.2,
    marginTop: Spacing.lg,
    marginBottom: Spacing.xs,
    paddingHorizontal: Spacing.xs,
  },

  // Samples preview
  samplesList: {
    backgroundColor: Colors.surface2,
    borderRadius: Radii.md,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  sampleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surface3,
    minHeight: Touch.min,
  },
  sampleMineral: {
    ...Typography.body,
    color: Colors.text,
    flex: 1,
  },
  sampleDate: {
    ...Typography.micro,
    color: Colors.textDim,
  },

  // Actions
  actionsBlock: {
    gap: Spacing.sm,
  },
  actionBtn: {
    borderRadius: Radii.md,
    minHeight: Touch.field,
    justifyContent: 'center',
    alignItems: 'center',
    ...Shadows.card,
  },
  actionBtnText: {
    ...Typography.action,
  },

  // Rename modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.xl,
  },
  modalBox: {
    backgroundColor: Colors.surface2,
    borderRadius: Radii.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.xl,
    width: '100%',
    gap: Spacing.md,
    ...Shadows.float,
  },
  modalTitle: {
    ...Typography.title,
    color: Colors.text,
    textAlign: 'center',
  },
  modalInput: {
    backgroundColor: Colors.surface3,
    borderRadius: Radii.sm,
    borderWidth: 1,
    borderColor: Colors.border,
    color: Colors.text,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    minHeight: Touch.min,
    ...Typography.body,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  modalBtnCancel: {
    flex: 1,
    backgroundColor: Colors.surface4,
    borderRadius: Radii.sm,
    minHeight: Touch.min,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalBtnCancelText: {
    ...Typography.action,
    color: Colors.textSub,
  },
  modalBtnConfirm: {
    flex: 1,
    backgroundColor: Colors.primary,
    borderRadius: Radii.sm,
    minHeight: Touch.min,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalBtnConfirmText: {
    ...Typography.action,
    color: Colors.bg,
  },
});

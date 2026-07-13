import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { View, Text, Modal, TouchableOpacity, ScrollView, TextInput, Switch, StyleSheet, Dimensions, Keyboard, Platform, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
  CATEGORIES, CATEGORIES_EXPANDED_BY_DEFAULT, MATERIALS_CATALOG, selectorConfidence, normalizeMaterialId,
} from '../core/materialsCatalog';
import { createProject } from '../core/Database';
import { getSyncStatus, flushQueue } from '../core/SyncEngine';

type SyncStatus = Awaited<ReturnType<typeof getSyncStatus>>;

// Qué categorías dejó abiertas el usuario. Vive a nivel de MÓDULO a propósito: así
// sobrevive a cerrar y reabrir el modal durante la sesión. Quien busca cantera seguido
// no debería volver a expandir "Piedra ornamental" cada vez.
let expandedMemory: Record<string, boolean> | null = null;

function sessionExpanded(): Record<string, boolean> {
  if (expandedMemory) return expandedMemory;
  const init: Record<string, boolean> = {};
  for (const c of CATEGORIES) {
    init[c.id] = (CATEGORIES_EXPANDED_BY_DEFAULT as string[]).includes(c.id);
  }
  expandedMemory = init;
  return init;
}

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
  /** Un proyecto nuevo pasa a ser el activo: el padre fija currentProjectId con ESTE id. */
  onProjectCreated: (id: string, nombre: string) => void;
  /** El campo "PROYECTO ACTIVO" renombra el proyecto activo; no cambia su identidad. */
  onRenameActiveProject: (nombre: string) => void;
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
  onClose, setActiveProject, onProjectCreated, onRenameActiveProject,
  setSelectedMineral, setTerrainType, setDepth, setRockType,
  setUseAI, setAutoAnalyzeSample, setUvLamp, setMicroscopeConnected, setAutoSync,
  setIsFieldMode, setVibrationEnabled,
}: ConfigModalProps) {
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [materialQuery, setMaterialQuery] = useState('');

  // Crear proyecto = crear su fila y ADOPTAR su id como proyecto activo. Antes se
  // llamaba a createProject y se tiraba el id que devuelve: el proyecto nacía en la
  // BD pero la app seguía apuntando al anterior ('default'), así que los análisis y
  // las muestras se archivaban en el proyecto equivocado.
  const handleCreateProject = useCallback(async () => {
    const nombre = newProjectName.trim();
    if (!nombre) return;
    const id = await createProject(nombre);
    onProjectCreated(id, nombre);
    setNewProjectName('');
    setShowNewProjectModal(false);
  }, [newProjectName, onProjectCreated]);

  // ── Estado de sincronización ────────────────────────────────────────────────
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);

  const refreshSyncStatus = useCallback(async () => {
    try {
      setSyncStatus(await getSyncStatus());
    } catch (_) {
      setSyncStatus(null);
    }
  }, []);

  // Se consulta al abrir el modal (no en cada render).
  useEffect(() => {
    if (visible) void refreshSyncStatus();
  }, [visible, refreshSyncStatus]);

  const handleSyncNow = useCallback(async () => {
    setSyncing(true);
    try {
      await flushQueue();
    } catch (_) { /* flushQueue ya registra sus propios errores */ }
    await refreshSyncStatus();
    setSyncing(false);
  }, [refreshSyncStatus]);

  const insets = useSafeAreaInsets();

  // ── Teclado ────────────────────────────────────────────────────────────────
  // Un KeyboardAvoidingView dentro de un <Modal> no es fiable en iOS (el modal
  // vive en su propia ventana y no siempre recibe el ajuste). Se mide el teclado
  // y se ENCOGE la tarjeta: así el campo de búsqueda queda arriba y la lista
  // filtrada ocupa el espacio que queda, con scroll, en vez de irse bajo el teclado.
  const [keyboardH, setKeyboardH] = useState(0);
  useEffect(() => {
    // iOS avisa con 'will*' (animación suave); Android solo con 'did*'.
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = Keyboard.addListener(showEvt as any, e => {
      setKeyboardH(e?.endCoordinates?.height ?? 0);
    });
    const onHide = Keyboard.addListener(hideEvt as any, () => setKeyboardH(0));
    return () => { onShow.remove(); onHide.remove(); };
  }, []);

  // Altura máxima del modal = alto de pantalla menos safe areas, margen Y TECLADO.
  // El body hace scroll dentro de este límite; el pie queda siempre visible.
  // Suelo de 260 px: en un iPhone chico con el teclado abierto, encoger sin límite
  // dejaría la tarjeta tan baja que no cabría ni el campo de búsqueda.
  const bottomInset = keyboardH > 0 ? keyboardH : insets.bottom;
  const maxCardH = Math.max(
    260,
    Dimensions.get('window').height - insets.top - bottomInset - 24,
  );

  // Scroll automático: al enfocar el buscador, se sube a la parte alta del modal
  // para que la lista filtrada quede entre el campo y el teclado.
  const bodyRef = useRef<ScrollView>(null);
  const searchY = useRef(0);
  const focusSearch = useCallback(() => {
    // Pequeño retraso: el teclado ya está animando y la tarjeta ya encogió.
    setTimeout(() => {
      bodyRef.current?.scrollTo({ y: Math.max(0, searchY.current - 8), animated: true });
    }, Platform.OS === 'ios' ? 60 : 180);
  }, []);

  const selectedId = normalizeMaterialId(selectedMineral);

  // Categorías desplegadas. Arranca con Metálicos y Especiales abiertas (esto es una
  // app de minerales), y RECUERDA lo que el usuario abrió durante la sesión: quien
  // busca cantera seguido no debe pelear con el colapso en cada apertura del modal.
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => sessionExpanded());
  const toggleCat = useCallback((id: string) => {
    setExpanded(prev => {
      const next = { ...prev, [id]: !prev[id] };
      expandedMemory = next;   // persiste mientras viva el proceso
      return next;
    });
  }, []);

  const query = materialQuery.trim().toLowerCase();
  const searching = query.length > 0;

  // Materiales agrupados por categoría. El buscador recorre SIEMPRE el catálogo
  // entero, esté la categoría colapsada o no: escribir "mármol" lo encuentra igual.
  const materialGroups = useMemo(() => {
    const match = MATERIALS_CATALOG.filter(m =>
      !query || m.label.toLowerCase().includes(query) || m.id.includes(query));
    return CATEGORIES
      .map(cat => ({ cat, items: match.filter(m => m.category === cat.id) }))
      .filter(g => g.items.length > 0);
  }, [query]);

  return (
    <Modal visible={visible} transparent animationType="slide">
      {/* Tocar fuera del campo cierra el teclado. Los TouchableOpacity de dentro
          (materiales, botones) capturan su propio toque, así que siguen funcionando. */}
      <Pressable
        style={[styles.overlay, { paddingTop: insets.top + 12, paddingBottom: bottomInset + 12 }]}
        onPress={Keyboard.dismiss}
      >
        <View style={[styles.card, { maxHeight: maxCardH }, isFieldMode && styles.contentLight]}>
          {/* Cabecera fija */}
          <View style={styles.header}>
            <Text style={[styles.title, isFieldMode && styles.titleLight, { marginBottom: 0 }]}>⚙️ CONFIGURACIÓN</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <MaterialCommunityIcons name="close" size={28} color={isFieldMode ? '#000' : '#FFD700'} />
            </TouchableOpacity>
          </View>

          {/* Cuerpo desplazable (categorías + materiales + ajustes) */}
          <ScrollView
            ref={bodyRef}
            style={styles.body}
            contentContainerStyle={{ paddingBottom: 16 }}
            // 'handled': el PRIMER toque sobre un material lo selecciona, en vez de
            // gastarse solo en cerrar el teclado.
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >
          <Text style={[styles.sectionHeader, { color: '#00FFFF', marginTop: 4 }]}>0. GESTIÓN LOCAL</Text>

          <Text style={[styles.sectionLabel, isFieldMode && styles.sectionLabelLight]}>PROYECTO ACTIVO</Text>
          {/* Renombra el proyecto ACTIVO. El texto es solo la etiqueta: la identidad
              del proyecto es su id, que no cambia al editar aquí. */}
          <TextInput
            style={[styles.input, isFieldMode && styles.inputLight, { height: 44, marginBottom: 10, fontSize: 15, fontWeight: 'bold' }]}
            value={activeProject}
            onChangeText={setActiveProject}
            onEndEditing={e => {
              const nombre = e.nativeEvent.text.trim();
              if (nombre) onRenameActiveProject(nombre);
            }}
            placeholder="Ej: Concesión Norte"
            placeholderTextColor="#888"
          />
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
            <TouchableOpacity
              style={{ flex: 1, backgroundColor: '#111', borderWidth: 1, borderColor: '#4CAF50', borderRadius: 8, padding: 10, alignItems: 'center' }}
              onPress={() => setShowNewProjectModal(true)}
            >
              <Text style={{ color: '#4CAF50', fontSize: 12, fontWeight: 'bold' }}>+ Nuevo proyecto</Text>
            </TouchableOpacity>
          </View>

          {/* Estado de sincronización — hasta ahora la cola vivía en SQLite sin que
              nadie pudiera verla: un push que fallaba era invisible. */}
          <Text style={[styles.sectionLabel, isFieldMode && styles.sectionLabelLight]}>ESTADO DE SINCRONIZACIÓN</Text>
          <View style={[styles.syncBox, isFieldMode && styles.syncBoxLight]}>
            <View style={styles.syncRow}>
              <Text style={[styles.syncLabel, isFieldMode && { color: '#333' }]}>
                {syncStatus === null
                  ? 'Consultando…'
                  : syncStatus.pending === 0
                    ? '✅ Todo subido a la nube'
                    : `⏳ ${syncStatus.pending} pendiente${syncStatus.pending > 1 ? 's' : ''} de subir`}
              </Text>
              <TouchableOpacity
                onPress={handleSyncNow}
                disabled={syncing}
                style={[styles.syncBtn, syncing && { opacity: 0.5 }]}
              >
                <Text style={styles.syncBtnText}>{syncing ? 'Subiendo…' : 'Sincronizar ahora'}</Text>
              </TouchableOpacity>
            </View>

            {syncStatus && syncStatus.failures.length > 0 && (
              <View style={{ marginTop: 8 }}>
                <Text style={styles.syncFailHeader}>
                  ⚠️ {syncStatus.failures.length} con errores (se reintentan solos)
                </Text>
                {syncStatus.failures.slice(0, 3).map(f => (
                  <Text key={`${f.entity}:${f.entity_id}`} style={styles.syncFailText} numberOfLines={2}>
                    {f.entity} · {f.attempts} intento{f.attempts > 1 ? 's' : ''} · {f.last_error || 'sin detalle'}
                  </Text>
                ))}
              </View>
            )}
          </View>

          <Text style={[styles.sectionHeader, { color: '#00FFFF', marginTop: 20 }]}>1. GEOLOGÍA ESTRUCTURAL</Text>

          <Text style={[styles.sectionLabel, isFieldMode && styles.sectionLabelLight]}>MATERIAL OBJETIVO</Text>
          <View onLayout={e => { searchY.current = e.nativeEvent.layout.y; }}>
            <TextInput
              style={[styles.input, isFieldMode && styles.inputLight, { height: 40, marginBottom: 10, fontSize: 14 }]}
              value={materialQuery}
              onChangeText={setMaterialQuery}
              onFocus={focusSearch}
              placeholder="🔍 Buscar material… (oro, mármol, yeso…)"
              placeholderTextColor="#888"
              autoCapitalize="none"
              returnKeyType="search"
              clearButtonMode="while-editing"
            />
          </View>
          {materialGroups.length === 0 && (
            <Text style={{ color: '#888', fontSize: 12, marginBottom: 8 }}>Sin resultados para “{materialQuery}”.</Text>
          )}
          {materialGroups.map(({ cat, items }) => {
            // Buscando, todo se muestra abierto: colapsar los resultados de una
            // búsqueda sería esconder justo lo que el usuario pidió ver.
            const open = searching || !!expanded[cat.id];
            return (
            <View key={cat.id} style={{ marginBottom: 6 }}>
              <TouchableOpacity
                onPress={() => { if (!searching) toggleCat(cat.id); }}
                activeOpacity={searching ? 1 : 0.7}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                style={styles.matCatRow}
              >
                <Text style={[styles.matCatHeader, isFieldMode && { color: '#333' }]}>
                  {cat.icon}  {cat.label.toUpperCase()} ({items.length})
                </Text>
                {!searching && (
                  <Text style={[styles.matCatChevron, isFieldMode && { color: '#333' }]}>{open ? '▾' : '▸'}</Text>
                )}
              </TouchableOpacity>

              {open && items.map(m => {
                const active = selectedId === m.id;
                const conf = selectorConfidence(m);
                return (
                  <TouchableOpacity
                    key={m.id}
                    style={[styles.matRow, active && styles.matRowActive, isFieldMode && !active && styles.matRowLight]}
                    // Seleccionar cierra el teclado: el usuario ya encontró lo que buscaba.
                    onPress={() => { Keyboard.dismiss(); setSelectedMineral(m.id); }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                  >
                    <Text style={styles.matIcon}>{m.icon}</Text>

                    {/* El NOMBRE manda y va primero. La pista de confianza va DEBAJO, en
                        gris pequeño: metida en el badge, su ancho empujaba el nombre
                        fuera de la tarjeta y no se sabía qué material era. */}
                    <View style={styles.matTextCol}>
                      <Text
                        style={[styles.matLabel, active && styles.matLabelActive, isFieldMode && !active && { color: '#000' }]}
                        numberOfLines={1}
                      >
                        {m.label}
                      </Text>
                      {conf.hint ? (
                        <Text style={[styles.matHint, isFieldMode && { color: '#666' }]} numberOfLines={1}>
                          {conf.hint}
                        </Text>
                      ) : null}
                    </View>

                    <View style={[styles.confBadge, { backgroundColor: conf.color }]}>
                      <Text style={styles.confBadgeText}>{conf.label}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
            );
          })}
          <Text style={{ color: '#777', fontSize: 10, marginTop: 2, marginBottom: 4, lineHeight: 14 }}>
            La confianza es la detectabilidad satelital honesta del material. En resultados puede bajar si no hay
            cobertura medida en la zona. “De contexto” = se infiere por geología/terreno, no por firma espectral directa.
          </Text>

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
            <View style={{ flex: 1 }}>
              <Text style={[styles.sectionLabel, isFieldMode && styles.sectionLabelLight, { marginBottom: 0, marginTop: 0 }]}>Microscopio USB-C Carson</Text>
              <Text style={{ color: '#555', fontSize: 10 }}>Próximamente</Text>
            </View>
            <View style={{ padding: 8, backgroundColor: '#2A2A2A', borderRadius: 8, opacity: 0.5 }}>
              <Text style={{ color: '#888', fontWeight: 'bold', fontSize: 12 }}>PRÓXIMAMENTE</Text>
            </View>
          </View>

          <Text style={[styles.sectionHeader, { color: '#00FFFF', marginTop: 30 }]}>4. BASE DE DATOS Y NUBE</Text>
          <View style={styles.prefRow}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.sectionLabel, isFieldMode && styles.sectionLabelLight, { marginBottom: 0, marginTop: 0, opacity: 0.5 }]}>
                Sincronización Cloud Automática
              </Text>
              <Text style={{ color: '#555', fontSize: 10 }}>Próximamente</Text>
            </View>
            <Switch value={false} onValueChange={() => {}} trackColor={{ true: '#FFD700' }} disabled />
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

          </ScrollView>

          {/* Pie fijo — siempre visible; respeta la safe area inferior */}
          <View style={[styles.footer, isFieldMode && styles.footerLight, { paddingBottom: 14 }]}>
            <TouchableOpacity style={styles.btnSave} onPress={onClose} accessibilityRole="button">
              <Text style={styles.btnTextBlack} numberOfLines={1}>Aplicar Configuración</Text>
            </TouchableOpacity>
          </View>

          {/* Cross-platform new project modal */}
          <Modal visible={showNewProjectModal} transparent animationType="fade">
            <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
              <View style={{ backgroundColor: '#1A1A1A', borderRadius: 12, padding: 24, width: '100%', borderWidth: 1, borderColor: '#FFD700' }}>
                <Text style={{ color: '#FFD700', fontWeight: '900', fontSize: 16, marginBottom: 16 }}>NUEVO PROYECTO</Text>
                <TextInput
                  style={{ backgroundColor: '#222', color: '#FFF', borderRadius: 8, padding: 12, fontSize: 15, borderWidth: 1, borderColor: '#444', marginBottom: 16 }}
                  placeholder="Nombre del proyecto..."
                  placeholderTextColor="#666"
                  value={newProjectName}
                  onChangeText={setNewProjectName}
                  autoFocus
                  returnKeyType="done"
                  onSubmitEditing={() => { void handleCreateProject(); }}
                />
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <TouchableOpacity
                    style={{ flex: 1, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#555', alignItems: 'center' }}
                    onPress={() => { setShowNewProjectModal(false); setNewProjectName(''); }}
                  >
                    <Text style={{ color: '#AAA', fontWeight: 'bold' }}>Cancelar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={{ flex: 1, padding: 12, borderRadius: 8, backgroundColor: '#4CAF50', alignItems: 'center' }}
                    onPress={() => { void handleCreateProject(); }}
                  >
                    <Text style={{ color: '#FFF', fontWeight: 'bold' }}>Crear</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </Modal>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  // Tarjeta = columna [cabecera fija | cuerpo scroll | pie fijo]. maxHeight se
  // fija en línea según la pantalla y las safe areas.
  card: {
    width: '100%', backgroundColor: '#111', borderRadius: 12,
    borderWidth: 2, borderColor: '#FFD700', overflow: 'hidden',
  },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 16, paddingBottom: 10,
  },
  body: { flexShrink: 1, paddingHorizontal: 20 },
  footer: {
    paddingHorizontal: 20, paddingTop: 12,
    borderTopWidth: 1, borderTopColor: '#333', backgroundColor: '#111',
  },
  footerLight: { backgroundColor: '#FFFFFF', borderTopColor: '#CCC' },
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
  matCatHeader: { color: '#00FFFF', fontSize: 11, fontWeight: 'bold', letterSpacing: 1, marginTop: 10, marginBottom: 4 },
  // Encabezado de categoría plegable: área de toque cómoda y chevron a la derecha.
  matCatRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 2 },
  matCatChevron: { color: '#00FFFF', fontSize: 13, fontWeight: 'bold', marginTop: 10, marginBottom: 4, paddingHorizontal: 4 },
  // El nombre y su pista comparten una columna flexible; el badge queda fuera de ella,
  // así que su ancho ya no puede empujar al nombre.
  matTextCol: { flex: 1, justifyContent: 'center' },
  matHint: { color: '#8A8A8A', fontSize: 10, marginTop: 1 },
  matRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#1A1A1A', borderWidth: 1, borderColor: '#333',
    borderRadius: 8, paddingVertical: 9, paddingHorizontal: 12, marginBottom: 6,
  },
  matRowActive: { backgroundColor: '#3A3100', borderColor: '#FFD700' },
  matRowLight: { backgroundColor: '#F0F0F0', borderColor: '#CCC' },
  matIcon: { fontSize: 18 },
  // SIN flex:1. Antes era hijo directo de la fila (eje horizontal) y flex:1 significaba
  // "llena el ancho". Ahora vive dentro de matTextCol, que es una COLUMNA: ahí flex:1
  // pondría flexBasis:0 y colapsaría la altura del nombre a cero — el mismo fallo que
  // dejaba el botón "Aplicar Configuración" como una barra amarilla vacía.
  matLabel: { color: '#EEE', fontSize: 14, fontWeight: '600' },
  matLabelActive: { color: '#FFD700', fontWeight: '900' },
  confBadge: { borderRadius: 6, paddingVertical: 3, paddingHorizontal: 8 },
  confBadgeText: { color: '#000', fontSize: 10, fontWeight: '800' },
  syncBox: { backgroundColor: '#1A1A1A', borderWidth: 1, borderColor: '#333', borderRadius: 8, padding: 10, marginBottom: 10 },
  syncBoxLight: { backgroundColor: '#F0F0F0', borderColor: '#CCC' },
  syncRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  syncLabel: { color: '#EEE', fontSize: 12, fontWeight: '600', flex: 1 },
  syncBtn: { backgroundColor: '#FFD700', borderRadius: 6, paddingVertical: 7, paddingHorizontal: 10 },
  syncBtnText: { color: '#1a1a1a', fontSize: 11, fontWeight: 'bold' },
  syncFailHeader: { color: '#FF9800', fontSize: 11, fontWeight: 'bold', marginBottom: 3 },
  syncFailText: { color: '#999', fontSize: 10, lineHeight: 14 },
  chip: { backgroundColor: '#333', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: '#555' },
  chipActive: { backgroundColor: '#FFD700', borderColor: '#FFD700' },
  chipText: { color: '#FFF', fontSize: 14, fontWeight: 'bold', textTransform: 'capitalize' },
  chipTextActive: { color: '#000' },
  prefRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, marginTop: 10 },
  actions: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 20, gap: 10 },
  // OJO: aquí NO va `flex: 1`. El pie es una columna, así que flex:1 pondría
  // flexBasis:0 sobre el eje vertical y colapsaría la altura del contenido a 0:
  // el botón se pintaba como una barra amarilla sin texto. Se estira a lo ancho
  // con alignSelf y se le da altura explícita.
  btnSave: {
    alignSelf: 'stretch',
    backgroundColor: '#FFD700',
    paddingHorizontal: 20,
    paddingVertical: 16,
    minHeight: 56,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnTextBlack: { color: '#1a1a1a', fontWeight: 'bold', fontSize: 18, lineHeight: 24 },
});

/**
 * analisis/nuevo.tsx — flujo "Nuevo análisis" de la PWA:
 *   1) dibujar polígono/rectángulo (Geoman) con el semáforo de hectáreas de areaLimits.ts
 *   2) configurar material / terreno / profundidad / roca / análisis profundo
 *   3) correr el análisis contra el servidor GEE (runAnalysis)
 *   4) guardar como proyecto NUEVO (web_…) en Supabase y abrir su detalle
 *
 * Sin captura de fotos ni cola offline: si algo falla se dice tal cual, y si el análisis
 * terminó pero el guardado falló, el resultado se conserva en pantalla para reintentar
 * (un análisis cuesta cuota de satélite; no se tira por un fallo de red al guardar).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, Switch, StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import DrawMap, { type DrawHandle, type LocateStatus } from '../../web-lib/DrawMap';
import { bottomPad } from '../../web-lib/safeArea';
import VillegasButton from '../../web-lib/VillegasButton';
import MaterialPicker from '../../web-lib/MaterialPicker';
import { polygonAreaHa, type Coordinate } from '../../web-lib/geo';
import { runAnalysis, AnalysisError, type AnalysisOutput } from '../../web-lib/runAnalysis';
import { createWebProject } from '../../app/core/webData';
import { AREA_LEVEL_COLOR, AREA_WARN_MESSAGE, areaBlockMessage, getAreaLevel } from '../../app/core/areaLimits';
import { materialLabel } from '../../app/core/materialsCatalog';
import DeepAdviceBanner from '../../app/components/DeepAdviceBanner';
import { effectiveDeep } from '../../app/core/deepAdvice';
import { computeAdaptiveCellSize } from '../../app/core/SatelliteEngine';
import { centroidOf, proposeRockType, rockSourceLabel, type RockProposal, type RockSource } from '../../app/core/lithologyService';
import { parseCoordinate } from '../../app/core/coordParse';
import { scopedKey } from '../../web-lib/userScope';
import { confirmAction } from '../../web-lib/confirmAction';

const TERRAINS = ['sierra', 'playa', 'árido'];
const DEPTHS = ['0-5m', '5-20m', '20m+'];
const ROCKS: { id: string; label: string }[] = [
  { id: 'ignea', label: 'Ígnea' }, { id: 'sedimentaria', label: 'Sedimentaria' }, { id: 'metamorfica', label: 'Metamórfica' },
];
const PREFS_BASE = 'pwa.analysisPrefs';   // por usuario: scopedKey → `pwa.analysisPrefs.<userId>` (userScope.ts)

type Stage = 'draw' | 'config' | 'running';

function loadPrefs(): { mineral: string; terrain: string; depth: string; deep: boolean } {
  const def = { mineral: 'oro', terrain: 'sierra', depth: '0-5m', deep: false };
  try { const k = scopedKey(PREFS_BASE); return k ? { ...def, ...JSON.parse(window.localStorage.getItem(k) || '{}') } : def; } catch { return def; }
}

const todayLabel = () => {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};

export default function NuevoAnalisis() {
  const router = useRouter();
  const drawRef = useRef<DrawHandle>(null);
  const prefs = useMemo(loadPrefs, []);

  const [stage, setStage] = useState<Stage>('draw');
  const [coords, setCoords] = useState<Coordinate[] | null>(null);
  const [jump, setJump] = useState('');
  const [jumpError, setJumpError] = useState('');
  // Trazo en curso (Geoman) y resultado del botón 📍: se muestran como avisos sobre el mapa.
  const [drawingShape, setDrawingShape] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<string | null>(null); // 'edit' | 'drag' | 'remove'
  const [locateStatus, setLocateStatus] = useState<LocateStatus | null>(null);

  const [mineral, setMineral] = useState(prefs.mineral);
  const [terrain, setTerrain] = useState(prefs.terrain);
  const [depth, setDepth] = useState(prefs.depth);
  // Análisis profundo: preferencia guardada (base) + elección manual de esta sesión; en plata arranca encendido (ver deepAdvice).
  const [deepBase, setDeepBase] = useState(prefs.deep);
  const [deepManual, setDeepManual] = useState<boolean | null>(null);
  const deep = effectiveDeep(mineral, deepBase, deepManual);
  const setDeep = (v: boolean) => { setDeepManual(v); setDeepBase(v); };
  const [rockType, setRockType] = useState('ignea');
  const [rockSource, setRockSource] = useState<RockSource>('default');
  const [rockProposal, setRockProposal] = useState<RockProposal | null>(null);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);

  const [step, setStep] = useState('');
  const [error, setError] = useState('');
  const [saveFailed, setSaveFailed] = useState(false);
  const cancelRef = useRef(false);
  const resultRef = useRef<AnalysisOutput | null>(null);
  const rockSourceRef = useRef<RockSource>('default');
  rockSourceRef.current = rockSource;
  const proposedForRef = useRef('');

  const areaHa = coords ? polygonAreaHa(coords) : 0;
  const level = getAreaLevel(areaHa);
  const blocked = level === 'block';
  const areaColor = AREA_LEVEL_COLOR[level];
  const cellM = coords ? Math.round(computeAdaptiveCellSize(areaHa)) : 0;

  useEffect(() => { if (!nameTouched) setName(`${materialLabel(mineral)} · ${todayLabel()}`); }, [mineral, nameTouched]);

  // Propuesta de tipo de roca por ubicación (misma lógica que la app nativa): se consulta al
  // tener polígono, una vez por celda de ~0.01°, y NUNCA pisa lo que el usuario ya eligió.
  useEffect(() => {
    if (!coords || coords.length < 3) return;
    const c = centroidOf(coords);
    if (!c) return;
    const key = `${c.lat.toFixed(2)}_${c.lng.toFixed(2)}`;
    if (proposedForRef.current === key) return;
    proposedForRef.current = key;
    (async () => {
      const proposal = await proposeRockType(c.lat, c.lng);
      if (!proposal) return; // sin cobertura/red: se queda manual
      setRockProposal(proposal);
      if (rockSourceRef.current === 'usuario') return; // comprobado DESPUÉS del await
      setRockType(proposal.rock_type);
      setRockSource(proposal.source);
    })();
  }, [coords]);

  // El aviso de "ubicación encontrada" se va solo; los errores se quedan más tiempo (o hasta cerrarlos).
  useEffect(() => {
    if (!locateStatus || locateStatus.state === 'searching') return;
    const t = setTimeout(() => setLocateStatus(null), locateStatus.state === 'found' ? 4000 : 12000);
    return () => clearTimeout(t);
  }, [locateStatus]);

  const goJump = () => {
    const r = parseCoordinate(jump);
    if ('error' in r) { setJumpError(r.error); return; }
    setJumpError('');
    drawRef.current?.flyTo(r.lat, r.lng, 16);
  };

  const pickRock = (id: string) => { setRockType(id); setRockSource('usuario'); };

  const savePrefs = () => {
    try { const k = scopedKey(PREFS_BASE); if (k) window.localStorage.setItem(k, JSON.stringify({ mineral, terrain, depth, deep: deepBase })); } catch { /* storage bloqueado */ }
  };

  const persist = useCallback(async (out: AnalysisOutput) => {
    if (!coords) return;
    setStep('Guardando proyecto…');
    const id = await createWebProject({
      name: name.trim() || `${materialLabel(mineral)} · ${todayLabel()}`,
      mineral, terrain, depth, rock_type: rockType, rock_source: rockSource,
      coordenadas: coords, analisis_resultado: out.finalPoints, prospectivity: out.zp,
      area_ha: Math.round(out.areaHa * 100) / 100,
      satdata_source: out.satdataSource, acquisition_date: out.acquisitionDate, analysis_meta: out.meta,
    });
    router.replace(`/proyecto/${id}` as any);
  }, [coords, name, mineral, terrain, depth, rockType, rockSource, router]);

  const start = async () => {
    if (!coords || blocked) return;
    savePrefs();
    cancelRef.current = false; resultRef.current = null;
    setError(''); setSaveFailed(false); setStage('running'); setStep('Preparando…');

    let wake: any = null;
    try { wake = await (navigator as any).wakeLock?.request('screen'); } catch { /* no soportado */ }
    const warnLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warnLeave);

    try {
      const out = await runAnalysis(
        { coords, mineral, terrain, depth, rockType, rockSource, rockProposed: rockProposal?.rock_type ?? null, deepAnalysis: deep },
        setStep, () => cancelRef.current,
      );
      resultRef.current = out;
      try { await persist(out); }
      catch (e: any) { setSaveFailed(true); setError(e?.message || 'No se pudo guardar el proyecto.'); }
    } catch (e: any) {
      if (e instanceof AnalysisError && e.code === 'CANCELLED') { setStage('config'); }
      else setError(e?.message || 'El análisis falló.');
    } finally {
      window.removeEventListener('beforeunload', warnLeave);
      try { await wake?.release(); } catch { /* ya liberado */ }
    }
  };

  const retrySave = async () => {
    if (!resultRef.current) return;
    setError(''); setSaveFailed(false);
    try { await persist(resultRef.current); }
    catch (e: any) { setSaveFailed(true); setError(e?.message || 'No se pudo guardar el proyecto.'); }
  };

  // Ir al chat sale de esta pantalla: la zona dibujada se pierde (el mapa se desmonta), así que se avisa.
  const openChat = () => {
    if (coords && !confirmAction('¿Ir al chat con Villegas?', 'Se perderá la zona que dibujaste.')) return;
    router.dismissTo('/(tabs)/geologo' as any);
  };
  const goBack = () => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)/proyectos' as any); };

  return (
    <View style={s.root}>
      <View style={s.head}>
        <TouchableOpacity onPress={stage === 'config' ? () => setStage('draw') : goBack} disabled={stage === 'running'} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={[s.back, stage === 'running' && { opacity: 0.3 }]}>‹ {stage === 'config' ? 'Mapa' : 'Proyectos'}</Text>
        </TouchableOpacity>
        <Text style={[s.title, { flex: 1 }]}>Nuevo análisis</Text>
        <VillegasButton onPress={openChat} disabled={stage === 'running'} />
      </View>

      {/* ── 1) Mapa de dibujo (se mantiene montado: desmontarlo perdería el polígono) ── */}
      <View style={s.body}>
        <View style={s.jumpRow}>
          <TextInput
            style={s.jumpInput} value={jump} onChangeText={setJump} onSubmitEditing={goJump}
            placeholder="Ir a coordenada (19.43, -99.13 · GMS · UTM)" placeholderTextColor="#777"
            autoCapitalize="none" autoCorrect={false}
          />
          <TouchableOpacity style={s.jumpBtn} onPress={goJump}><Text style={s.jumpBtnText}>Ir</Text></TouchableOpacity>
          <TouchableOpacity style={[s.jumpBtn, { marginLeft: 6 }]} onPress={() => drawRef.current?.locate()} accessibilityLabel="Mi ubicación"><Text style={s.jumpBtnText}>📍</Text></TouchableOpacity>
        </View>
        {!!jumpError && <Text style={s.jumpError}>{jumpError}</Text>}

        <View style={s.mapWrap}>
          <View style={[StyleSheet.absoluteFill, { zIndex: 0 }]}>
            <DrawMap ref={drawRef} areaColor={areaColor} onChange={setCoords} onDrawing={setDrawingShape} onEditMode={setEditMode} onLocate={setLocateStatus} />
          </View>

          {/* Avisos sobre el mapa (no capturan toques, salvo el de error, que se puede cerrar) */}
          <View style={s.notices} pointerEvents="box-none">
            {locateStatus?.state === 'searching' && (
              <View style={s.notice} pointerEvents="none"><Text style={s.noticeText}>📍 Buscando tu ubicación…</Text></View>
            )}
            {locateStatus?.state === 'found' && (
              <View style={s.notice} pointerEvents="none">
                <Text style={s.noticeText}>📍 Tu ubicación{locateStatus.accuracy > 0 ? ` (±${locateStatus.accuracy} m)` : ''}</Text>
              </View>
            )}
            {locateStatus?.state === 'error' && (
              <TouchableOpacity style={[s.notice, s.noticeError]} onPress={() => setLocateStatus(null)} activeOpacity={0.85}>
                <Text style={s.noticeErrorText}>{locateStatus.message}</Text>
                <Text style={s.noticeClose}>Toca para cerrar</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {stage === 'draw' && (
          <View style={s.bar}>
            {(drawingShape || editMode) ? (
              // Trazando o editando: UNA fila compacta bajo el mapa (no encima). El aviso es una línea; los botones, de dedo (44 px).
              <>
                <Text style={s.drawHint} numberOfLines={1}>
                  {drawingShape === 'Polygon' ? 'Toca el punto que late para cerrar la figura'
                    : drawingShape ? 'Toca dos esquinas opuestas'
                    : editMode === 'edit' ? 'Arrastra los vértices para ajustar la zona'
                    : editMode === 'drag' ? 'Arrastra la zona para moverla'
                    : 'Toca la zona para borrarla'}
                </Text>
                <View style={s.actRow}>
                  {drawingShape === 'Polygon' && (
                    <>
                      <TouchableOpacity style={[s.act, s.actMain]} onPress={() => drawRef.current?.finish()} activeOpacity={0.8}>
                        <Text style={s.actMainText}>Finalizar</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={s.act} onPress={() => drawRef.current?.undoVertex()} activeOpacity={0.8}>
                        <Text style={s.actText}>↶ Deshacer punto</Text>
                      </TouchableOpacity>
                    </>
                  )}
                  {!drawingShape && (
                    <TouchableOpacity style={[s.act, s.actMain]} onPress={() => drawRef.current?.cancel()} activeOpacity={0.8}>
                      <Text style={s.actMainText}>Listo</Text>
                    </TouchableOpacity>
                  )}
                  {!!drawingShape && (
                    <TouchableOpacity style={s.act} onPress={() => drawRef.current?.cancel()} activeOpacity={0.8}>
                      <Text style={s.actText}>Cancelar</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </>
            ) : !coords ? (
              <Text style={s.hint}>Dibuja la zona con las herramientas de la izquierda del mapa: polígono o rectángulo. Se analiza una zona a la vez.</Text>
            ) : (
              <>
                <Text style={[s.area, { color: areaColor }]}>
                  {areaHa.toFixed(2)} ha{level !== 'ok' ? ' ⚠️' : ''} · ~{cellM} m/celda
                </Text>
                {level !== 'ok' && <Text style={[s.areaMsg, { color: areaColor }]}>{blocked ? areaBlockMessage(areaHa) : AREA_WARN_MESSAGE}</Text>}
                <TouchableOpacity style={[s.primary, blocked && { opacity: 0.35 }]} disabled={blocked} onPress={() => setStage('config')}>
                  <Text style={s.primaryText}>Configurar análisis ›</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}
      </View>

      {/* ── 2) Configuración ── */}
      {stage === 'config' && (
        <View style={s.overlay}>
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: bottomPad(40) }}>
            <Text style={s.sec}>NOMBRE DEL PROYECTO</Text>
            <TextInput style={s.input} value={name} onChangeText={(t) => { setName(t); setNameTouched(true); }} maxLength={80} placeholderTextColor="#777" />

            <Text style={s.sec}>MATERIAL OBJETIVO</Text>
            <MaterialPicker value={mineral} onChange={setMineral} />

            <Text style={s.sec}>TERRENO</Text>
            <View style={s.chips}>{TERRAINS.map((t) => <Chip key={t} on={terrain === t} label={t} onPress={() => setTerrain(t)} />)}</View>

            <Text style={s.sec}>PROFUNDIDAD ESPERADA</Text>
            <View style={s.chips}>{DEPTHS.map((d) => <Chip key={d} on={depth === d} label={d} onPress={() => setDepth(d)} />)}</View>

            <Text style={s.sec}>TIPO DE ROCA</Text>
            <View style={s.chips}>{ROCKS.map((r) => <Chip key={r.id} on={rockType === r.id} label={r.label} onPress={() => pickRock(r.id)} />)}</View>
            <Text style={s.note}>
              Origen: {rockSourceLabel(rockSource)}
              {rockProposal?.unit_name && rockSource !== 'usuario' ? ` · unidad: ${rockProposal.unit_name}` : ''}
            </Text>

            <View style={s.switchRow}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={s.switchTitle}>Análisis profundo</Text>
                <Text style={s.note}>Suma ASTER, EMIT y Sentinel-1/DEM (consenso entre fuentes). Tarda más y usa más cuota de satélite.</Text>
              </View>
              <Switch value={deep} onValueChange={setDeep} trackColor={{ true: '#FFD700', false: '#333' }} />
            </View>
            <DeepAdviceBanner materialId={mineral} deepOn={deep} onChange={setDeep} />

            <View style={s.summary}>
              <Text style={s.summaryText}>
                {materialLabel(mineral)} · {terrain} · {depth} · {areaHa.toFixed(2)} ha · ~{cellM} m/celda
              </Text>
              <Text style={s.note}>Se creará un proyecto NUEVO con el resultado; no se modifica ningún proyecto existente. Sin ranking por IA en la versión web.</Text>
            </View>

            <TouchableOpacity style={[s.primary, blocked && { opacity: 0.35 }]} disabled={blocked} onPress={start}>
              <Text style={s.primaryText}>Analizar</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      )}

      {/* ── 3) Ejecución ── */}
      {stage === 'running' && (
        <View style={[s.overlay, { justifyContent: 'center', padding: 24 }]}>
          {!error ? (
            <>
              <ActivityIndicator color="#FFD700" size="large" />
              <Text style={s.runStep}>{step}</Text>
              <Text style={s.runNote}>Mantén esta pantalla abierta. Puede tardar varios minutos según la zona y las fuentes.</Text>
              <TouchableOpacity
                style={s.ghost}
                onPress={() => {
                  // Auditoría de usabilidad (2026-09-21): cancelar a medio análisis tira minutos de espera y
                  // cuota de satélite ya gastada (mismo espíritu que "no se tira por un fallo de red al
                  // guardar"). Un toque accidental con prisa no debe perderlo sin avisar.
                  if (!confirmAction('¿Cancelar el análisis en curso?', 'Se perderá el progreso.')) return;
                  cancelRef.current = true; setStep('Cancelando…');
                }}
              >
                <Text style={s.ghostText}>Cancelar</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={s.errTitle}>{saveFailed ? 'El análisis terminó, pero no se pudo guardar' : 'No se pudo completar el análisis'}</Text>
              <Text style={s.errMsg}>{error}</Text>
              {saveFailed && (
                <TouchableOpacity style={s.primary} onPress={retrySave}><Text style={s.primaryText}>Reintentar guardado</Text></TouchableOpacity>
              )}
              <TouchableOpacity style={s.ghost} onPress={() => { setError(''); setSaveFailed(false); setStage('config'); }}>
                <Text style={s.ghostText}>{saveFailed ? 'Descartar y volver' : 'Volver a la configuración'}</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      )}
    </View>
  );
}

function Chip({ on, label, onPress }: { on: boolean; label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={[s.chip, on && s.chipOn]} onPress={onPress}>
      <Text style={[s.chipText, on && s.chipTextOn]}>{label}</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderBottomColor: '#1E1E1E', borderBottomWidth: 1 },
  back: { color: '#FFD700', fontSize: 16, fontWeight: '700', marginRight: 12 },
  title: { color: '#FFF', fontSize: 17, fontWeight: '800' },
  body: { flex: 1 },
  jumpRow: { flexDirection: 'row', padding: 8, backgroundColor: '#0A0A0A' },
  // Fila del salto por coordenada + 📍: altura mínima de 44px (uso con prisa/manos torpes), antes ~36px.
  jumpInput: { flex: 1, backgroundColor: '#161616', borderColor: '#2A2A2A', borderWidth: 1, borderRadius: 8, color: '#FFF', paddingHorizontal: 10, paddingVertical: 8, fontSize: 16, minHeight: 44 },
  jumpBtn: { backgroundColor: '#222', borderRadius: 8, paddingHorizontal: 14, minHeight: 44, justifyContent: 'center', alignItems: 'center', marginLeft: 6 },
  jumpBtnText: { color: '#FFD700', fontWeight: '700' },
  jumpError: { color: '#FF6B6B', fontSize: 12, paddingHorizontal: 10, paddingBottom: 6, backgroundColor: '#0A0A0A' },
  mapWrap: { flex: 1 },
  notices: { position: 'absolute', top: 10, left: 84, right: 66, zIndex: 300, alignItems: 'center' },
  notice: { backgroundColor: 'rgba(14,14,14,0.95)', borderColor: '#2A2A2A', borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 8, maxWidth: 420 },
  noticeText: { color: '#EEE', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  drawHint: { color: '#FFD700', fontSize: 13, fontWeight: '700', marginBottom: 8 },
  actRow: { flexDirection: 'row', gap: 8 },
  act: { flex: 1, minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: '#444', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  actMain: { backgroundColor: '#FFD700', borderColor: '#FFD700' },
  actText: { color: '#DDD', fontWeight: '700', fontSize: 14 },
  actMainText: { color: '#000', fontWeight: '800', fontSize: 15 },
  noticeError: { borderColor: '#FF6B6B' },
  noticeErrorText: { color: '#FF9B9B', fontSize: 13, lineHeight: 19, textAlign: 'center' },
  noticeClose: { color: '#888', fontSize: 11, textAlign: 'center', marginTop: 6 },
  // En flujo (NO superpuesta al mapa): así el borde inferior del mapa, donde va la atribución de Esri, siempre se ve.
  bar: { backgroundColor: '#0A0A0A', borderTopColor: '#FFD700', borderTopWidth: 2, padding: 14, paddingBottom: bottomPad(14) },
  hint: { color: '#BBB', fontSize: 13, lineHeight: 19 },
  area: { fontSize: 18, fontWeight: '800' },
  areaMsg: { fontSize: 12, marginTop: 4, lineHeight: 17 },
  // Repaso de consistencia (2026-09-21): mismo mínimo de 52px que login.tsx/proyectos.tsx en las 5 pantallas.
  primary: { backgroundColor: '#FFD700', borderRadius: 12, paddingVertical: 14, minHeight: 52, justifyContent: 'center', alignItems: 'center', marginTop: 12 },
  primaryText: { color: '#000', fontWeight: '800', fontSize: 16 },
  ghost: { borderColor: '#444', borderWidth: 1, borderRadius: 12, paddingVertical: 12, minHeight: 52, justifyContent: 'center', alignItems: 'center', marginTop: 12 },
  ghostText: { color: '#CCC', fontWeight: '700' },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000', zIndex: 200, marginTop: 45 },
  sec: { color: '#FFD700', fontSize: 12, fontWeight: '800', letterSpacing: 0.6, marginTop: 18, marginBottom: 8 },
  input: { backgroundColor: '#161616', borderColor: '#2A2A2A', borderWidth: 1, borderRadius: 10, color: '#FFF', paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, minHeight: 52 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  // 44px: mismo mínimo que el chip de proyecto de geologo.tsx y el botón 📍/"Ir" de esta pantalla.
  chip: { borderColor: '#333', borderWidth: 1, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 11, minHeight: 44 },
  chipOn: { backgroundColor: '#FFD700', borderColor: '#FFD700' },
  chipText: { color: '#CCC', fontSize: 14 },
  chipTextOn: { color: '#000', fontWeight: '700' },
  note: { color: '#8A8A8A', fontSize: 12, marginTop: 6, lineHeight: 17 },
  switchRow: { flexDirection: 'row', alignItems: 'center', marginTop: 20, backgroundColor: '#111', borderRadius: 12, padding: 12 },
  switchTitle: { color: '#EEE', fontSize: 15, fontWeight: '700' },
  summary: { marginTop: 20, backgroundColor: '#111', borderRadius: 12, padding: 12 },
  summaryText: { color: '#DDD', fontSize: 13, lineHeight: 19 },
  runStep: { color: '#FFF', fontSize: 17, fontWeight: '700', textAlign: 'center', marginTop: 20 },
  runNote: { color: '#888', fontSize: 13, textAlign: 'center', marginTop: 10, lineHeight: 19 },
  errTitle: { color: '#FF6B6B', fontSize: 17, fontWeight: '800', textAlign: 'center' },
  errMsg: { color: '#CCC', fontSize: 14, textAlign: 'center', marginTop: 10, lineHeight: 20 },
});

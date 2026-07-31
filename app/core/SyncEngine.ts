/**
 * SyncEngine.ts — sincronización SQLite (caché offline) → Supabase (fuente de verdad).
 *
 * Cada escritura local encola (entity, id) en sync_queue. Aquí leemos el estado
 * ACTUAL de la fila local y lo empujamos a Supabase bajo el user_id de la sesión.
 * Sin señal → se queda en la cola y se vacía al reconectar (NetInfo). Nada se pierde.
 *
 * NO toca el motor de análisis ni el modo campo: SQLite sigue siendo la caché
 * local intacta; esto solo la replica hacia la nube.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { AppState } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { supabase } from './supabase';
import {
  getSyncQueue, dequeueSync, enqueueSync,
  getProjectRowRaw, getMuestraById, getValidationPairRaw,
  getAllProjectIds, getAllMuestraIds, getAllValidationIds,
  getSampleIdsWithLocalPhoto,
  upsertProjectFromRemote, upsertSampleFromRemote, upsertValidationFromRemote,
  setSamplePhotoUrl, recordSyncFailure, markSampleSynced, getSyncFailures,
} from './Database';

const SUPABASE_URL      = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
const PHOTO_BUCKET      = 'sample-photos';

// Sube una foto local (file://) al Storage del usuario y devuelve su URL pública.
// Usa uploadAsync (binario) — no requiere convertir base64 ni dependencias extra.
async function uploadSamplePhoto(localUri: string, userId: string, sampleId: string): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return null;
    const path = `${userId}/${sampleId}.jpg`;
    const res = await FileSystem.uploadAsync(
      `${SUPABASE_URL}/storage/v1/object/${PHOTO_BUCKET}/${path}`,
      localUri,
      {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: SUPABASE_ANON_KEY,
          'Content-Type': 'image/jpeg',
          'x-upsert': 'true',
        },
      }
    );
    if (res.status !== 200 && res.status !== 201) return null;
    return `${SUPABASE_URL}/storage/v1/object/public/${PHOTO_BUCKET}/${path}`;
  } catch {
    return null;
  }
}

function parse<T>(raw: any, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

let flushing = false;
let listenerBound = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;

/** Latido de respaldo: vacía la cola aunque no haya cambios de red ni de AppState. */
const HEARTBEAT_MS = 60_000;

async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
}

// ── Mapeo fila local → payload remoto ────────────────────────────────────────
function projectPayload(row: any, userId: string) {
  return {
    user_id: userId,
    client_id: row.id,
    name: row.nombre,
    mineral: row.mineral,
    terrain: row.terrain,
    rock_type: row.rock_type,
    depth: row.depth,
    area_ha: typeof row.area_ha === 'number' ? row.area_ha : Number(row.area_ha) || 0,
    coordenadas: parse(row.coordenadas, []),
    analisis_resultado: parse(row.analisis_resultado, []),
    prospectivity: parse(row.prospectivity, null),
    data: {
      notas: row.notas ?? '',
      // Origen del tipo de roca. Va en el blob para no exigir una migración remota;
      // sin él, una reinstalación restauraba la roca pero olvidaba quién la eligió,
      // y la carta geológica volvía a pisar la corrección del usuario.
      rock_source: row.rock_source ?? 'default',
      satdata_source: row.satdata_source ?? '',
      acquisition_date: row.acquisition_date ?? '',
      chat_history: parse(row.chat_history, []),
      reporte_geologo_texto: row.reporte_geologo_texto ?? '',
    },
  };
}

function samplePayload(row: any, userId: string) {
  return {
    user_id: userId,
    client_id: row.id,
    project_client_id: row.proyecto_id ?? 'default',
    lat: row.lat,
    lng: row.lng,
    mineral_detectado: row.mineral_detectado ?? '',
    descripcion_texto: row.descripcion_texto ?? '',
    analisis_ia: parse(row.analisis_ia, null),
    lab_result: {
      au_gt: row.lab_au_gt, ag_gt: row.lab_ag_gt, cu_pct: row.lab_cu_pct,
      pb_pct: row.lab_pb_pct, zn_pct: row.lab_zn_pct, laboratorio: row.lab_laboratorio ?? '',
    },
    // Nota: imagen_thumbnail y certificados (base64) NO se suben aún — irán a
    // Supabase Storage en una etapa posterior; aquí va solo la metadata.
    data: {
      muestra_codigo: row.muestra_codigo ?? '',
      tipo_captura: row.tipo_captura ?? '',
      fecha_hora: row.fecha_hora ?? '',
      altitud: row.altitud ?? 0, rumbo: row.rumbo ?? 0,
      utm_zona: row.utm_zona ?? '', utm_easting: row.utm_easting ?? 0, utm_northing: row.utm_northing ?? 0,
      spectral_snapshot: parse(row.spectral_snapshot, {}),
      validation_verdict: row.validation_verdict ?? '', validation_comment: row.validation_comment ?? '',
      score_ia: row.score_ia ?? 0,
    },
  };
}

function validationPayload(row: any, userId: string) {
  return {
    user_id: userId,
    client_id: row.id,
    project_client_id: row.proyecto_id ?? 'default',
    predicted: {
      consensus: row.spectral_consensus ?? '', evidence: row.spectral_evidence ?? '',
      base_score: row.spectral_base_score ?? 0, indices: parse(row.spectral_indices_json, {}),
      metal: row.metal_target ?? '',
    },
    actual: {
      au_gt: row.lab_au_gt, ag_gt: row.lab_ag_gt, cu_pct: row.lab_cu_pct,
      pb_pct: row.lab_pb_pct, zn_pct: row.lab_zn_pct,
      verdict: row.verdict ?? '', comment: row.verdict_comment ?? '', threshold: row.verdict_threshold ?? 0.5,
    },
    data: { muestra_id: row.muestra_id ?? '', created_at: row.created_at ?? '' },
  };
}

// ── Procesa un item de la cola. Devuelve true si se sincronizó (o ya no aplica). ──
async function processItem(item: { entity: string; entity_id: string; op: string }, userId: string): Promise<boolean> {
  if (item.op === 'delete') {
    // Solo proyectos encolan delete; borra también sus hijas por project_client_id.
    await supabase.from('samples').delete().eq('user_id', userId).eq('project_client_id', item.entity_id);
    await supabase.from('validation_pairs').delete().eq('user_id', userId).eq('project_client_id', item.entity_id);
    const { error } = await supabase.from('projects').delete().eq('user_id', userId).eq('client_id', item.entity_id);
    if (error) throw error;
    return true;
  }

  let table = '', payload: any = null;
  let dequeue = true; // false → dejar en cola para reintentar (p. ej. foto no subida)
  if (item.entity === 'project') {
    const row = await getProjectRowRaw(item.entity_id);
    if (!row) return true; // fila borrada localmente → nada que subir
    table = 'projects'; payload = projectPayload(row, userId);
  } else if (item.entity === 'sample') {
    const row = await getMuestraById(item.entity_id);
    if (!row) return true;
    // Sube la foto local a Storage (una vez) y usa la URL pública.
    let fotoUrl: string = row.imagen_thumbnail || '';
    if (fotoUrl.startsWith('file://')) {
      const uploaded = await uploadSamplePhoto(fotoUrl, userId, row.id);
      if (uploaded) {
        fotoUrl = uploaded;
        await setSamplePhotoUrl(row.id, uploaded); // la próxima vez ya es URL
      } else {
        // No se pudo subir (offline en la sierra, etc.): sincroniza la metadata
        // pero DEJA la muestra en cola para reintentar la foto al recuperar señal.
        fotoUrl = '';
        dequeue = false;
      }
    }
    table = 'samples';
    payload = samplePayload(row, userId);
    if (fotoUrl.startsWith('http')) payload.data.foto_url = fotoUrl;
  } else if (item.entity === 'validation') {
    const row = await getValidationPairRaw(item.entity_id);
    if (!row) return true;
    table = 'validation_pairs'; payload = validationPayload(row, userId);
  } else {
    return true; // entidad desconocida → descartar
  }

  const { error } = await supabase.from(table).upsert(payload, { onConflict: 'user_id,client_id' });
  if (error) throw error;

  // SYNCED honesto: solo aquí, con el upsert ya confirmado por Supabase.
  if (item.entity === 'sample' && dequeue) await markSampleSynced(item.entity_id);

  return dequeue;
}

/** Por qué un flush no llegó a correr. `pending: -1` significa "no se midió". */
export type FlushSkip = 'busy' | 'no-session' | 'offline';

export interface FlushResult {
  synced: number;
  pending: number;
  /** Ausente si el ciclo corrió de verdad. */
  skipped?: FlushSkip;
}

/** Vacía la cola. Silencioso: si no hay sesión/red, no hace nada y reintenta luego.
 *
 *  El candado `flushing` se toma ANTES de cualquier `await`. Estaba después de dos
 *  (currentUserId y NetInfo.fetch), así que era un TOCTOU de manual: dos disparadores
 *  casi simultáneos —el latido y el botón "Sincronizar ahora", por ejemplo— pasaban
 *  los dos el `if (flushing)` antes de que ninguno pusiera el flag, y acababan
 *  subiendo LA MISMA FOTO dos veces. Las filas no se duplicaban (el upsert va contra
 *  el índice único user_id+client_id), pero el binario sí viajaba dos veces, y esto
 *  es una app de campo que gasta datos móviles.
 *
 *  Con el flag arriba, el `try/finally` cubre TODAS las salidas, incluidas las
 *  tempranas por falta de sesión o de red. */
export async function flushQueue(): Promise<FlushResult> {
  if (flushing) return { synced: 0, pending: -1, skipped: 'busy' };
  flushing = true;

  let synced = 0;
  let failed = 0;
  try {
    const userId = await currentUserId();
    if (!userId) return { synced: 0, pending: -1, skipped: 'no-session' };
    const net = await NetInfo.fetch();
    if (!(net.isConnected && net.isInternetReachable !== false)) {
      return { synced: 0, pending: -1, skipped: 'offline' };
    }

    const queue = await getSyncQueue();
    for (const item of queue) {
      try {
        const done = await processItem(item as any, userId);
        if (done) {
          await dequeueSync(item.entity, item.entity_id);
          synced++;
        }
        // done=false → se queda en cola (foto pendiente); continúa con las demás.
      } catch (e: any) {
        // Un item que falla NO puede bloquear a los que vienen detrás: antes esto
        // hacía `break` y un solo item envenenado congelaba la cola entera para
        // siempre, en silencio. Ahora se registra el error, se deja en cola para
        // reintentar, y se SIGUE con los demás.
        failed++;
        const msg = e?.message || e?.error_description || JSON.stringify(e) || 'error desconocido';
        console.warn(`[Sync] falló ${item.entity}:${item.entity_id} →`, msg);
        await recordSyncFailure(item.entity, item.entity_id, msg);
        continue;
      }
    }
    const remaining = await getSyncQueue();
    if (failed > 0) {
      console.warn(`[Sync] ciclo terminado: ${synced} subidos, ${failed} fallidos, ${remaining.length} en cola`);
    }
    return { synced, pending: remaining.length };
  } finally {
    flushing = false;
  }
}

/** Baja de Supabase a SQLite lo que falte localmente (restaura tras reinstalar).
 *  Solo inserta lo ausente: no pisa cambios locales sin sincronizar. */
export async function pullFromRemote(userId: string): Promise<{ projects: number; samples: number; validations: number } | null> {
  const net = await NetInfo.fetch();
  if (!(net.isConnected && net.isInternetReachable !== false)) return null;
  try {
    const { data: projects } = await supabase.from('projects').select('*').eq('user_id', userId);
    for (const p of projects ?? []) await upsertProjectFromRemote(p);
    const { data: samples } = await supabase.from('samples').select('*').eq('user_id', userId);
    for (const s of samples ?? []) await upsertSampleFromRemote(s);
    const { data: vps } = await supabase.from('validation_pairs').select('*').eq('user_id', userId);
    for (const v of vps ?? []) await upsertValidationFromRemote(v);
    return { projects: projects?.length ?? 0, samples: samples?.length ?? 0, validations: vps?.length ?? 0 };
  } catch (_) {
    return null; // silencioso; se reintenta en el próximo login/reconexión
  }
}

/** Al iniciar sesión: 1) restaura desde Supabase (reinstalación), 2) migra los
 *  datos locales existentes a la cuenta (una vez) y sincroniza. */
export async function onLogin(userId: string): Promise<void> {
  await pullFromRemote(userId);
  const key = `sync_migrated_${userId}`;
  const already = await AsyncStorage.getItem(key);
  if (!already) {
    for (const id of await getAllProjectIds())    await enqueueSync('project', id);
    for (const id of await getAllMuestraIds())     await enqueueSync('sample', id);
    for (const id of await getAllValidationIds())  await enqueueSync('validation', id);
    await AsyncStorage.setItem(key, '1');
  }
  // Migración de fotos: encola SIEMPRE las muestras con foto local (file://) sin
  // subir, para proteger datos actuales antes de cualquier reinstalación.
  for (const id of await getSampleIdsWithLocalPhoto()) await enqueueSync('sample', id);
  await flushQueue();
}

/** Pide un envío tras una escritura local, agrupando ráfagas (debounce).
 *
 *  ESTE ERA EL ESLABÓN QUE FALTABA: `enqueueSync` solo mete una fila en la tabla
 *  local `sync_queue`; no empuja nada. Y `flushQueue` únicamente corría al arrancar
 *  la app (onLogin) o ante un CAMBIO de red. Con la app abierta y el WiFi estable,
 *  los análisis y las muestras se quedaban encolados indefinidamente: solo subían
 *  al reiniciar la app. Ahora cada escritura pide su propio envío. */
export function scheduleFlush(delayMs: number = 2000): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushQueue();
  }, delayMs);
}

/** Vacía la cola automáticamente. Idempotente.
 *
 *  En total hay CINCO disparadores de `flushQueue`, para que subir nunca dependa de
 *  un único evento frágil. Tres los engancha esta función:
 *   1) reconexión de red (NetInfo),
 *   2) la app vuelve a primer plano (AppState),
 *   3) latido periódico cada 60 s (por si los otros dos no llegan a ocurrir).
 *  Y otros dos viven fuera:
 *   4) `scheduleFlush()` tras cada escritura local (debounce de 2 s) — lo llaman
 *      el guardado y el análisis en app/(tabs)/index.tsx,
 *   5) el botón "Sincronizar ahora" de ConfigModal, que llama a `flushQueue()` directo.
 *
 *  Los cinco pueden coincidir: el candado de `flushQueue` es lo único que impide
 *  que dos ciclos se pisen. Si añades un sexto, actualiza esta lista. */
export function startAutoSync(): void {
  if (listenerBound) return;
  listenerBound = true;

  NetInfo.addEventListener(state => {
    if (state.isConnected && state.isInternetReachable !== false) {
      void flushQueue();
    }
  });

  AppState.addEventListener('change', status => {
    if (status === 'active') void flushQueue();
  });

  if (heartbeat) clearInterval(heartbeat);
  heartbeat = setInterval(() => {
    // Con la cola vacía no se toca la red: es una app de campo y la batería cuenta.
    void (async () => {
      const queue = await getSyncQueue();
      if (queue.length > 0) await flushQueue();
    })();
  }, HEARTBEAT_MS);
}

/** Resumen de la cola para la UI: cuántos faltan por subir y qué ha fallado. */
export async function getSyncStatus(): Promise<{
  pending: number;
  failures: Array<{ entity: string; entity_id: string; attempts: number; last_error: string }>;
}> {
  const [queue, failures] = await Promise.all([getSyncQueue(), getSyncFailures()]);
  return { pending: queue.length, failures };
}

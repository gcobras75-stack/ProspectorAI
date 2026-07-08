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
import { supabase } from './supabase';
import {
  getSyncQueue, dequeueSync, enqueueSync,
  getProjectRowRaw, getMuestraById, getValidationPairRaw,
  getAllProjectIds, getAllMuestraIds, getAllValidationIds,
  upsertProjectFromRemote, upsertSampleFromRemote, upsertValidationFromRemote,
} from './Database';

function parse<T>(raw: any, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

let flushing = false;
let listenerBound = false;

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
  if (item.entity === 'project') {
    const row = await getProjectRowRaw(item.entity_id);
    if (!row) return true; // fila borrada localmente → nada que subir
    table = 'projects'; payload = projectPayload(row, userId);
  } else if (item.entity === 'sample') {
    const row = await getMuestraById(item.entity_id);
    if (!row) return true;
    table = 'samples'; payload = samplePayload(row, userId);
  } else if (item.entity === 'validation') {
    const row = await getValidationPairRaw(item.entity_id);
    if (!row) return true;
    table = 'validation_pairs'; payload = validationPayload(row, userId);
  } else {
    return true; // entidad desconocida → descartar
  }

  const { error } = await supabase.from(table).upsert(payload, { onConflict: 'user_id,client_id' });
  if (error) throw error;
  return true;
}

/** Vacía la cola. Silencioso: si no hay sesión/red, no hace nada y reintenta luego. */
export async function flushQueue(): Promise<{ synced: number; pending: number }> {
  if (flushing) return { synced: 0, pending: -1 };
  const userId = await currentUserId();
  if (!userId) return { synced: 0, pending: -1 };
  const net = await NetInfo.fetch();
  if (!(net.isConnected && net.isInternetReachable !== false)) return { synced: 0, pending: -1 };

  flushing = true;
  let synced = 0;
  try {
    const queue = await getSyncQueue();
    for (const item of queue) {
      try {
        await processItem(item as any, userId);
        await dequeueSync(item.entity, item.entity_id);
        synced++;
      } catch (_) {
        // Error de red/servidor → deja el resto en cola y corta este ciclo.
        break;
      }
    }
    const remaining = await getSyncQueue();
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
  await flushQueue();
}

/** Escucha reconexiones para vaciar la cola automáticamente. Idempotente. */
export function startAutoSync(): void {
  if (listenerBound) return;
  listenerBound = true;
  NetInfo.addEventListener(state => {
    if (state.isConnected && state.isInternetReachable !== false) {
      flushQueue();
    }
  });
}

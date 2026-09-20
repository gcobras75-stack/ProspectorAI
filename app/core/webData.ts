/**
 * webData.ts — capa de datos de la PWA: lectura de proyectos/muestras y CREACIÓN de
 * proyectos nuevos desde un análisis.
 *
 * La app nativa lee de SQLite local y sincroniza con Supabase; la PWA NO tiene
 * SQLite ni cola de sync: habla directo con Supabase con la sesión del usuario (RLS
 * `projects_own` / `samples_own` aísla por user_id).
 *
 * ESCRITURA: solo `createWebProject`, y es un INSERT de una fila nueva con client_id
 * `web_…`. Nunca update/upsert/delete. Motivo: la app nativa solo INSERTA en su pull lo
 * que le falta (no actualiza proyectos que ya tiene) y sube la fila completa cuando edita
 * un proyecto, así que escribir sobre un proyecto existente se perdería o pisaría datos
 * (chat_history, notas). Un proyecto nuevo lo recibe la app en su siguiente inicio de
 * sesión y ya no lo pisa nadie.
 *
 * El mapeo remoto → modelo replica el de `upsertProjectFromRemote` /
 * `upsertSampleFromRemote` (Database.ts) para que la PWA vea exactamente lo mismo
 * que la app tras un restore: `client_id` es el id local, el blob `data` lleva
 * notas/rock_source/satdata_source/acquisition_date/chat_history.
 *
 * Solo importa `supabase` (sin expo-sqlite, sin módulos nativos).
 */
import { supabase } from './supabase';

export type WebProjectSummary = {
  /** client_id (el id que usa la app nativa; con él se enlazan las muestras). */
  id: string;
  nombre: string;
  mineral: string;
  terrain: string;
  rock_type: string;
  area_ha: number;
  acquisition_date: string;
  satdata_source: string;
  updated_at: string;
};

export type WebProject = WebProjectSummary & {
  depth: string;
  rock_source: string;
  coordenadas: any[];
  analisis_resultado: any[];
  prospectivity: any;
  notas: string;
  chat_history: { role: string; content: any }[];
  reporte_geologo_texto: string;
  /** Metadatos honestos del análisis hecho en la PWA (ranking_ia, fuentes que respondieron…). null si vino de la app. */
  analysis_meta: any | null;
};

export type WebSample = {
  id: string;
  proyecto_id: string;
  lat: number;
  lng: number;
  mineral_detectado: string;
  descripcion_texto: string;
  muestra_codigo: string;
  fecha_hora: string;
  tipo_captura: string;
  score_ia: number;
  analisis_ia: any;
  spectral_snapshot: any;
  foto_url: string;
  lab: { au_gt: number | null; ag_gt: number | null; cu_pct: number | null; pb_pct: number | null; zn_pct: number | null; laboratorio: string };
  validation_verdict: string;
  validation_comment: string;
};

// jsonb puede llegar ya parseado (objeto) o, en filas viejas, como string.
function asArray(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}
function asObject(v: any): any {
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return null;
}

const SUMMARY_COLS =
  'client_id, name, mineral, terrain, rock_type, area_ha, updated_at, data->>acquisition_date, data->>satdata_source';

function toSummary(r: any): WebProjectSummary {
  return {
    id: r.client_id,
    nombre: r.name || 'Proyecto',
    mineral: r.mineral || '',
    terrain: r.terrain || '',
    rock_type: r.rock_type || '',
    area_ha: Number(r.area_ha) || 0,
    acquisition_date: r.acquisition_date || '',
    satdata_source: r.satdata_source || '',
    updated_at: r.updated_at || '',
  };
}

/**
 * Lista ligera (sin analisis_resultado ni coordenadas): un proyecto con miles de
 * celdas pesa MBs, y la lista no las necesita. El detalle se pide aparte.
 */
export async function listWebProjects(): Promise<WebProjectSummary[]> {
  const { data, error } = await supabase
    .from('projects')
    .select(SUMMARY_COLS)
    .not('client_id', 'is', null)
    .order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(toSummary);
}

/** Proyecto completo (con celdas analizadas) por su client_id. null si no existe. */
export async function loadWebProject(clientId: string): Promise<WebProject | null> {
  const { data, error } = await supabase
    .from('projects')
    .select('client_id, name, mineral, terrain, rock_type, depth, area_ha, coordenadas, analisis_resultado, prospectivity, data, updated_at')
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const d = asObject(data.data) ?? {};
  return {
    ...toSummary({ ...data, acquisition_date: d.acquisition_date, satdata_source: d.satdata_source }),
    depth: data.depth || '',
    rock_source: d.rock_source || 'default',
    coordenadas: asArray(data.coordenadas),
    analisis_resultado: asArray(data.analisis_resultado),
    prospectivity: asObject(data.prospectivity),
    notas: d.notas || '',
    chat_history: asArray(d.chat_history),
    reporte_geologo_texto: d.reporte_geologo_texto || '',
    analysis_meta: asObject(d.analysis_meta),
  };
}

/** Muestras de un proyecto (por project_client_id). */
export async function loadWebSamples(projectClientId: string): Promise<WebSample[]> {
  const { data, error } = await supabase
    .from('samples')
    .select('client_id, project_client_id, lat, lng, mineral_detectado, descripcion_texto, analisis_ia, lab_result, data')
    .eq('project_client_id', projectClientId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: any): WebSample => {
    const d = asObject(r.data) ?? {};
    const lab = asObject(r.lab_result) ?? {};
    return {
      id: r.client_id,
      proyecto_id: r.project_client_id,
      lat: r.lat,
      lng: r.lng,
      mineral_detectado: r.mineral_detectado || '',
      descripcion_texto: r.descripcion_texto || '',
      muestra_codigo: d.muestra_codigo || '',
      fecha_hora: d.fecha_hora || '',
      tipo_captura: d.tipo_captura || '',
      score_ia: Number(d.score_ia) || 0,
      analisis_ia: asObject(r.analisis_ia),
      spectral_snapshot: asObject(d.spectral_snapshot) ?? {},
      foto_url: d.foto_url || '',
      lab: {
        au_gt: lab.au_gt ?? null, ag_gt: lab.ag_gt ?? null, cu_pct: lab.cu_pct ?? null,
        pb_pct: lab.pb_pct ?? null, zn_pct: lab.zn_pct ?? null, laboratorio: lab.laboratorio || '',
      },
      validation_verdict: d.validation_verdict || '',
      validation_comment: d.validation_comment || '',
    };
  });
}

// ─── Escritura: proyecto nuevo desde un análisis de la PWA ───────────────────

export type NewWebProject = {
  name: string;
  mineral: string;
  terrain: string;
  depth: string;
  rock_type: string;
  rock_source: string;
  coordenadas: { latitude: number; longitude: number }[];
  analisis_resultado: any[];
  prospectivity: any;
  area_ha: number;
  satdata_source: string;
  acquisition_date: string;
  analysis_meta: any;
};

/** Id local estable con prefijo web_ (mismo estilo que los proj_… de la app nativa). */
export function newWebClientId(): string {
  return 'web_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * Crea un proyecto NUEVO. Devuelve su client_id. Es INSERT: si el id existiera (no debería),
 * el índice único (user_id, client_id) rechaza la operación en vez de sobrescribir.
 * La forma de la fila es la misma que SyncEngine.projectPayload, así que la app nativa la
 * restaura con upsertProjectFromRemote sin cambios (analysis_meta va en el blob `data`,
 * que la app ignora).
 */
export async function createWebProject(p: NewWebProject): Promise<string> {
  const { data: sess } = await supabase.auth.getSession();
  const userId = sess.session?.user?.id;
  if (!userId) throw new Error('Tu sesión expiró. Inicia sesión de nuevo.');

  const clientId = newWebClientId();
  const { error } = await supabase.from('projects').insert({
    user_id: userId,
    client_id: clientId,
    name: p.name,
    mineral: p.mineral,
    terrain: p.terrain,
    rock_type: p.rock_type,
    depth: p.depth,
    area_ha: p.area_ha,
    coordenadas: p.coordenadas,
    analisis_resultado: p.analisis_resultado,
    prospectivity: p.prospectivity,
    data: {
      notas: '',
      rock_source: p.rock_source,
      satdata_source: p.satdata_source,
      acquisition_date: p.acquisition_date,
      chat_history: [],
      reporte_geologo_texto: '',
      analysis_meta: p.analysis_meta,
    },
  });
  if (error) throw new Error(error.message);
  return clientId;
}

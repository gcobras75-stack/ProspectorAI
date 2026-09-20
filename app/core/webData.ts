/**
 * webData.ts — capa de datos de SOLO LECTURA para la PWA (demo/consulta).
 *
 * La app nativa lee de SQLite local y sincroniza con Supabase; la PWA NO tiene
 * SQLite ni cola de sync: lee directo de Supabase con la sesión del usuario (RLS
 * `projects_own` / `samples_own` aísla por user_id). Aquí NO hay escrituras: ni
 * insert, ni update, ni delete, ni enqueueSync.
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

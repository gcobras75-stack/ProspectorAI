import * as SQLite from 'expo-sqlite';

let dbCache: SQLite.SQLiteDatabase | null = null;

/** Parse JSON de forma segura: nunca lanza; devuelve fallback si está vacío o corrupto.
 *  Evita que una fila con JSON malformado rompa toda la carga del proyecto. */
function safeJsonParse<T>(raw: any, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export const initDB = async () => {
  if (dbCache) return dbCache;
  dbCache = await SQLite.openDatabaseAsync('prospectorai_v2.db');
  
  await dbCache.execAsync(`
    CREATE TABLE IF NOT EXISTS proyectos (
      id TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      fecha_creacion TEXT NOT NULL,
      ultimo_acceso TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS muestras (
      id TEXT PRIMARY KEY,
      proyecto_id TEXT,
      lat REAL,
      lng REAL,
      altitud REAL,
      rumbo REAL,
      fecha_hora TEXT,
      tipo_captura TEXT,
      imagen_thumbnail TEXT,
      descripcion_texto TEXT,
      analisis_ia TEXT,
      mineral_detectado TEXT,
      score_ia INTEGER,
      sincronizado INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS poligonos_cache (
      id TEXT PRIMARY KEY,
      mineral TEXT,
      terrain TEXT,
      rock_type TEXT,
      coordenadas TEXT,
      fecha TEXT,
      analisis_resultado TEXT,
      estado TEXT DEFAULT 'OFFLINE'
    );
    CREATE TABLE IF NOT EXISTS spectral_cache (
      cache_key      TEXT PRIMARY KEY,
      cells_json     TEXT NOT NULL,
      acquisition_date TEXT NOT NULL,
      cloud_cover    REAL DEFAULT 0,
      coverage_pct   REAL DEFAULT 0,
      images_used    INTEGER DEFAULT 0,
      cell_size_m    INTEGER DEFAULT 500,
      satellite      TEXT DEFAULT 'SENTINEL2_REAL',
      fecha_guardado TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_queue (
      entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      op TEXT NOT NULL DEFAULT 'upsert',
      queued_at TEXT NOT NULL,
      PRIMARY KEY (entity, entity_id)
    );
    CREATE TABLE IF NOT EXISTS validation_pairs (
      id TEXT PRIMARY KEY,
      muestra_id TEXT NOT NULL,
      proyecto_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      spectral_consensus TEXT DEFAULT '',
      spectral_evidence TEXT DEFAULT '',
      spectral_base_score REAL DEFAULT 0,
      spectral_indices_json TEXT DEFAULT '{}',
      metal_target TEXT DEFAULT '',
      lab_au_gt REAL,
      lab_ag_gt REAL,
      lab_cu_pct REAL,
      lab_pb_pct REAL,
      lab_zn_pct REAL,
      verdict TEXT DEFAULT '',
      verdict_comment TEXT DEFAULT '',
      verdict_threshold REAL DEFAULT 0.5
    );
  `);

  // ── Schema migration: add new columns (safe to re-run) ──────────────────
  const migrations = [
    `ALTER TABLE proyectos ADD COLUMN mineral      TEXT    DEFAULT 'oro'`,
    `ALTER TABLE proyectos ADD COLUMN terrain      TEXT    DEFAULT 'sierra'`,
    `ALTER TABLE proyectos ADD COLUMN depth        TEXT    DEFAULT '0-5m'`,
    `ALTER TABLE proyectos ADD COLUMN rock_type    TEXT    DEFAULT 'ignea'`,
    `ALTER TABLE proyectos ADD COLUMN coordenadas  TEXT    DEFAULT '[]'`,
    `ALTER TABLE proyectos ADD COLUMN analisis_resultado TEXT DEFAULT '[]'`,
    `ALTER TABLE proyectos ADD COLUMN satdata_source    TEXT DEFAULT ''`,
    `ALTER TABLE proyectos ADD COLUMN acquisition_date  TEXT DEFAULT ''`,
    `ALTER TABLE proyectos ADD COLUMN area_ha      REAL    DEFAULT 0`,
    `ALTER TABLE proyectos ADD COLUMN chat_history TEXT    DEFAULT '[]'`,
    `ALTER TABLE proyectos ADD COLUMN notas        TEXT    DEFAULT ''`,
    `ALTER TABLE proyectos ADD COLUMN prospectivity TEXT   DEFAULT '{}'`,
    `ALTER TABLE poligonos_cache ADD COLUMN satdata_source   TEXT DEFAULT ''`,
    `ALTER TABLE poligonos_cache ADD COLUMN acquisition_date TEXT DEFAULT ''`,
    `ALTER TABLE poligonos_cache ADD COLUMN prospectivity    TEXT DEFAULT '{}'`,
    `ALTER TABLE proyectos ADD COLUMN campo_preparado_at   TEXT    DEFAULT ''`,
    `ALTER TABLE proyectos ADD COLUMN campo_resumen_geologo TEXT   DEFAULT ''`,
    `ALTER TABLE proyectos ADD COLUMN campo_analisis_json   TEXT   DEFAULT ''`,
    `ALTER TABLE proyectos ADD COLUMN campo_mapa_b64        TEXT   DEFAULT ''`,
    `ALTER TABLE proyectos ADD COLUMN campo_size_kb         INTEGER DEFAULT 0`,
    `ALTER TABLE proyectos ADD COLUMN reporte_geologo_texto  TEXT DEFAULT ''`,
    `ALTER TABLE proyectos ADD COLUMN reporte_generado_at    TEXT DEFAULT ''`,
    `ALTER TABLE muestras  ADD COLUMN reporte_resena         TEXT DEFAULT ''`,
    `ALTER TABLE proyectos ADD COLUMN reporte_analisis_hash TEXT DEFAULT ''`,
    // Muestras — sample identity + UTM + spectral snapshot
    `ALTER TABLE muestras ADD COLUMN muestra_codigo TEXT DEFAULT ''`,
    `ALTER TABLE muestras ADD COLUMN utm_zona TEXT DEFAULT ''`,
    `ALTER TABLE muestras ADD COLUMN utm_easting INTEGER DEFAULT 0`,
    `ALTER TABLE muestras ADD COLUMN utm_northing INTEGER DEFAULT 0`,
    `ALTER TABLE muestras ADD COLUMN spectral_snapshot TEXT DEFAULT '{}'`,
    // Muestras — lab results
    `ALTER TABLE muestras ADD COLUMN lab_au_gt REAL`,
    `ALTER TABLE muestras ADD COLUMN lab_ag_gt REAL`,
    `ALTER TABLE muestras ADD COLUMN lab_cu_pct REAL`,
    `ALTER TABLE muestras ADD COLUMN lab_pb_pct REAL`,
    `ALTER TABLE muestras ADD COLUMN lab_zn_pct REAL`,
    `ALTER TABLE muestras ADD COLUMN lab_laboratorio TEXT DEFAULT ''`,
    `ALTER TABLE muestras ADD COLUMN lab_fecha_certificado TEXT DEFAULT ''`,
    `ALTER TABLE muestras ADD COLUMN lab_certificado_b64 TEXT DEFAULT ''`,
    `ALTER TABLE muestras ADD COLUMN lab_guardado_at TEXT DEFAULT ''`,
    // Muestras — validation
    `ALTER TABLE muestras ADD COLUMN validation_verdict TEXT DEFAULT ''`,
    `ALTER TABLE muestras ADD COLUMN validation_comment TEXT DEFAULT ''`,
  ];
  for (const sql of migrations) {
    try { await dbCache.execAsync(sql); } catch (_) { /* column already exists */ }
  }

  const hasDefault = await dbCache.getFirstAsync('SELECT id FROM proyectos WHERE id = ?', ['default']);
  if (!hasDefault) {
    await dbCache.runAsync(
      'INSERT INTO proyectos (id, nombre, fecha_creacion, ultimo_acceso) VALUES (?, ?, ?, ?)',
      ['default', 'Predefinido', new Date().toISOString(), new Date().toISOString()]
    );
  }
  return dbCache;
};

// ─── SYNC OUTBOX ──────────────────────────────────────────────────────────────
// Cada escritura local encola (entity, id) aquí. SyncEngine lee el estado ACTUAL
// de la fila local y lo empuja a Supabase; al confirmarse, borra la entrada.
// Así el modo campo offline nunca se degrada: si no hay señal, queda en cola.

export type SyncEntity = 'project' | 'sample' | 'validation';

export const enqueueSync = async (
  entity: SyncEntity,
  entityId: string,
  op: 'upsert' | 'delete' = 'upsert'
): Promise<void> => {
  if (!entityId) return;
  try {
    const db = await initDB();
    await db.runAsync(
      `INSERT OR REPLACE INTO sync_queue (entity, entity_id, op, queued_at) VALUES (?, ?, ?, ?)`,
      [entity, entityId, op, new Date().toISOString()]
    );
  } catch (_) { /* la sincronización nunca debe romper una escritura local */ }
};

export const getSyncQueue = async (): Promise<Array<{ entity: SyncEntity; entity_id: string; op: string }>> => {
  const db = await initDB();
  return await db.getAllAsync(
    'SELECT entity, entity_id, op FROM sync_queue ORDER BY queued_at ASC'
  ) as any[];
};

export const dequeueSync = async (entity: string, entityId: string): Promise<void> => {
  const db = await initDB();
  await db.runAsync('DELETE FROM sync_queue WHERE entity = ? AND entity_id = ?', [entity, entityId]);
};

export const getProjectRowRaw = async (id: string): Promise<any | null> => {
  const db = await initDB();
  return await db.getFirstAsync('SELECT * FROM proyectos WHERE id = ?', [id]);
};

export const getAllProjectIds = async (): Promise<string[]> => {
  const db = await initDB();
  const rows = await db.getAllAsync('SELECT id FROM proyectos') as any[];
  return rows.map(r => r.id);
};

export const getAllMuestraIds = async (): Promise<string[]> => {
  const db = await initDB();
  const rows = await db.getAllAsync('SELECT id FROM muestras') as any[];
  return rows.map(r => r.id);
};

// Muestras cuya foto sigue siendo un archivo local (file://) sin subir a Storage.
export const getSampleIdsWithLocalPhoto = async (): Promise<string[]> => {
  const db = await initDB();
  const rows = await db.getAllAsync(
    "SELECT id FROM muestras WHERE imagen_thumbnail LIKE 'file://%'"
  ) as any[];
  return rows.map(r => r.id);
};

export const getAllValidationIds = async (): Promise<string[]> => {
  const db = await initDB();
  const rows = await db.getAllAsync('SELECT id FROM validation_pairs') as any[];
  return rows.map(r => r.id);
};

export const getValidationPairRaw = async (id: string): Promise<any | null> => {
  const db = await initDB();
  return await db.getFirstAsync('SELECT * FROM validation_pairs WHERE id = ?', [id]);
};

// ─── PULL: restaurar filas de Supabase a SQLite tras reinstalar ───────────────
// Solo INSERTA lo que falta localmente (no pisa cambios locales sin sincronizar).

export const upsertProjectFromRemote = async (r: any): Promise<void> => {
  const db = await initDB();
  const id = r.client_id;
  if (!id) return;
  const exists = await db.getFirstAsync('SELECT id FROM proyectos WHERE id = ?', [id]);
  if (exists) return;
  const d = r.data || {};
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO proyectos (id, nombre, fecha_creacion, ultimo_acceso, mineral, terrain, depth, rock_type,
       coordenadas, analisis_resultado, satdata_source, acquisition_date, area_ha, chat_history, notas,
       prospectivity, reporte_geologo_texto)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, r.name || 'Proyecto', now, now, r.mineral || 'oro', r.terrain || 'sierra',
      r.depth || '0-5m', r.rock_type || 'ignea',
      JSON.stringify(r.coordenadas ?? []), JSON.stringify(r.analisis_resultado ?? []),
      d.satdata_source || '', d.acquisition_date || '', Number(r.area_ha) || 0,
      JSON.stringify(d.chat_history ?? []), d.notas || '',
      JSON.stringify(r.prospectivity ?? null), d.reporte_geologo_texto || '',
    ]
  );
};

export const upsertSampleFromRemote = async (r: any): Promise<void> => {
  const db = await initDB();
  const id = r.client_id;
  if (!id) return;
  const exists = await db.getFirstAsync('SELECT id FROM muestras WHERE id = ?', [id]);
  if (exists) return;
  const d = r.data || {};
  const lab = r.lab_result || {};
  await db.runAsync(
    `INSERT INTO muestras (id, proyecto_id, lat, lng, altitud, rumbo, fecha_hora, tipo_captura, imagen_thumbnail,
       descripcion_texto, analisis_ia, mineral_detectado, score_ia, sincronizado, muestra_codigo,
       utm_zona, utm_easting, utm_northing, spectral_snapshot,
       lab_au_gt, lab_ag_gt, lab_cu_pct, lab_pb_pct, lab_zn_pct, lab_laboratorio,
       validation_verdict, validation_comment)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, r.project_client_id || 'default', r.lat, r.lng, d.altitud || 0, d.rumbo || 0,
      d.fecha_hora || '', d.tipo_captura || 'normal', d.foto_url || '',   // foto: URL de Storage (si existe)
      r.descripcion_texto || '', r.analisis_ia ? JSON.stringify(r.analisis_ia) : '{}',
      r.mineral_detectado || '', d.score_ia || 0, d.muestra_codigo || '',
      d.utm_zona || '', d.utm_easting || 0, d.utm_northing || 0, JSON.stringify(d.spectral_snapshot ?? {}),
      lab.au_gt ?? null, lab.ag_gt ?? null, lab.cu_pct ?? null, lab.pb_pct ?? null, lab.zn_pct ?? null, lab.laboratorio || '',
      d.validation_verdict || '', d.validation_comment || '',
    ]
  );
};

export const upsertValidationFromRemote = async (r: any): Promise<void> => {
  const db = await initDB();
  const id = r.client_id;
  if (!id) return;
  const exists = await db.getFirstAsync('SELECT id FROM validation_pairs WHERE id = ?', [id]);
  if (exists) return;
  const p = r.predicted || {};
  const a = r.actual || {};
  const d = r.data || {};
  await db.runAsync(
    `INSERT INTO validation_pairs (id, muestra_id, proyecto_id, created_at, spectral_consensus, spectral_evidence,
       spectral_base_score, spectral_indices_json, metal_target, lab_au_gt, lab_ag_gt, lab_cu_pct, lab_pb_pct, lab_zn_pct,
       verdict, verdict_comment, verdict_threshold)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, d.muestra_id || '', r.project_client_id || 'default', d.created_at || new Date().toISOString(),
      p.consensus || '', p.evidence || '', p.base_score || 0, JSON.stringify(p.indices ?? {}), p.metal || '',
      a.au_gt ?? null, a.ag_gt ?? null, a.cu_pct ?? null, a.pb_pct ?? null, a.zn_pct ?? null,
      a.verdict || '', a.comment || '', a.threshold ?? 0.5,
    ]
  );
};

export const saveMuestra = async (data: any) => {
  const db = await initDB();
  await db.runAsync(
    `INSERT INTO muestras (id, proyecto_id, lat, lng, altitud, rumbo, fecha_hora, tipo_captura, imagen_thumbnail, descripcion_texto, analisis_ia, mineral_detectado, score_ia, sincronizado) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id, 
      data.proyecto_id || 'default', 
      data.lat, 
      data.lng, 
      data.altitud || 0, 
      data.rumbo || 0,
      data.fecha_hora, 
      data.tipo_captura || 'normal', 
      data.imagen_thumbnail || '', 
      data.descripcion_texto || '',
      data.analisis_ia ? JSON.stringify(data.analisis_ia) : '{}', 
      data.mineral_detectado || '',
      data.score_ia || 0,
      0
    ]
  );
  await enqueueSync('sample', data.id);
};

export const getMuestras = async (proyectoId?: string) => {
  const db = await initDB();
  if (proyectoId && proyectoId !== 'ALL') {
    return await db.getAllAsync('SELECT * FROM muestras WHERE proyecto_id = ? ORDER BY fecha_hora DESC', [proyectoId]);
  }
  return await db.getAllAsync('SELECT * FROM muestras ORDER BY fecha_hora DESC');
};

export const clearMuestras = async () => {
   const db = await initDB();
   // También limpia validation_pairs para no dejar pares colgados sin su muestra.
   await db.runAsync('DELETE FROM validation_pairs');
   await db.runAsync('DELETE FROM muestras');
};

export const savePoligonoCache = async (data: any) => {
  const db = await initDB();
  await db.runAsync(
    `INSERT OR REPLACE INTO poligonos_cache
       (id, mineral, terrain, rock_type, coordenadas, fecha, analisis_resultado, estado, satdata_source, acquisition_date, prospectivity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id, data.mineral, data.terrain, data.rock_type,
      typeof data.coordenadas === 'string' ? data.coordenadas : JSON.stringify(data.coordenadas),
      new Date().toISOString(),
      typeof data.analisis_resultado === 'string' ? data.analisis_resultado : JSON.stringify(data.analisis_resultado),
      data.estado || 'OFFLINE',
      data.satdata_source || '',
      data.acquisition_date || '',
      data.prospectivity ? (typeof data.prospectivity === 'string' ? data.prospectivity : JSON.stringify(data.prospectivity)) : '{}',
    ]
  );
};

export const getPendingPolygons = async () => {
  const db = await initDB();
  return await db.getAllAsync('SELECT * FROM poligonos_cache WHERE estado = ?', ['OFFLINE']);
};

export const saveSpectralCache = async (
  cacheKey: string,
  data: {
    cells_json: string;
    acquisition_date: string;
    cloud_cover: number;
    coverage_pct: number;
    images_used: number;
    cell_size_m: number;
  }
): Promise<void> => {
  const db = await initDB();
  await db.runAsync(
    `INSERT OR REPLACE INTO spectral_cache
     (cache_key, cells_json, acquisition_date, cloud_cover, coverage_pct, images_used, cell_size_m, satellite, fecha_guardado)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cacheKey,
      data.cells_json,
      data.acquisition_date,
      data.cloud_cover,
      data.coverage_pct,
      data.images_used,
      data.cell_size_m,
      'SENTINEL2_REAL',
      new Date().toISOString(),
    ]
  );
};

export const loadSpectralCache = async (cacheKey: string): Promise<{
  cells_json: string;
  acquisition_date: string;
  cloud_cover: number;
  coverage_pct: number;
  images_used: number;
  cell_size_m: number;
  fecha_guardado: string;
  age_days: number;
} | null> => {
  const db = await initDB();
  const row = await db.getFirstAsync(
    'SELECT * FROM spectral_cache WHERE cache_key = ?',
    [cacheKey]
  ) as any;
  if (!row) return null;
  const ageDays = Math.floor(
    (Date.now() - new Date(row.fecha_guardado).getTime()) / 86400000
  );
  return {
    cells_json:       row.cells_json,
    acquisition_date: row.acquisition_date,
    cloud_cover:      row.cloud_cover,
    coverage_pct:     row.coverage_pct,
    images_used:      row.images_used,
    cell_size_m:      row.cell_size_m,
    fecha_guardado:   row.fecha_guardado,
    age_days:         ageDays,
  };
};

// ─── PROJECT MANAGEMENT ────────────────────────────────────────────────────

export const listProjects = async (): Promise<Array<{ id: string; nombre: string; ultimo_acceso: string }>> => {
  const db = await initDB();
  return await db.getAllAsync('SELECT id, nombre, ultimo_acceso FROM proyectos ORDER BY ultimo_acceso DESC') as any[];
};

export const createProject = async (nombre: string): Promise<string> => {
  const db = await initDB();
  const id = 'proj_' + Date.now().toString(36);
  await db.runAsync(
    'INSERT INTO proyectos (id, nombre, fecha_creacion, ultimo_acceso) VALUES (?, ?, ?, ?)',
    [id, nombre, new Date().toISOString(), new Date().toISOString()]
  );
  await enqueueSync('project', id);
  return id;
};

export const saveProjectState = async (
  projectId: string,
  data: {
    mineral?: string;
    terrain?: string;
    depth?: string;
    rock_type?: string;
    coordenadas?: any[];
    analisis_resultado?: any[];
    satdata_source?: string;
    acquisition_date?: string;
    area_ha?: number;
    notas?: string;
    prospectivity?: any;
  }
): Promise<void> => {
  const db = await initDB();
  const fields = Object.keys(data).filter(k => data[k as keyof typeof data] !== undefined);
  if (fields.length === 0) return;
  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => {
    const v = data[f as keyof typeof data];
    // Serializa arrays Y objetos (antes solo arrays → un objeto rompía el bind de SQLite)
    return (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
  });
  values.push(new Date().toISOString()); // ultimo_acceso
  values.push(projectId);
  await db.runAsync(
    `UPDATE proyectos SET ${setClause}, ultimo_acceso = ? WHERE id = ?`,
    values as any[]
  );
  await enqueueSync('project', projectId);
};

export const loadProjectState = async (projectId: string): Promise<{
  id: string; nombre: string;
  mineral: string; terrain: string; depth: string; rock_type: string;
  coordenadas: any[]; analisis_resultado: any[];
  satdata_source: string; acquisition_date: string; area_ha: number;
  chat_history: { role: string; content: any }[];
  notas: string;
  prospectivity: any;
} | null> => {
  const db = await initDB();
  const row = await db.getFirstAsync('SELECT * FROM proyectos WHERE id = ?', [projectId]) as any;
  if (!row) return null;
  return {
    id: row.id,
    nombre: row.nombre,
    mineral: row.mineral || 'oro',
    terrain: row.terrain || 'sierra',
    depth: row.depth || '0-5m',
    rock_type: row.rock_type || 'ignea',
    coordenadas: safeJsonParse(row.coordenadas, [] as any[]),
    analisis_resultado: safeJsonParse(row.analisis_resultado, [] as any[]),
    satdata_source: row.satdata_source || '',
    acquisition_date: row.acquisition_date || '',
    area_ha: row.area_ha || 0,
    chat_history: safeJsonParse(row.chat_history, [] as { role: string; content: any }[]),
    notas: row.notas || '',
    prospectivity: safeJsonParse(row.prospectivity, null),
  };
};

export const saveProjectChatHistory = async (
  projectId: string,
  messages: { role: string; content: any }[]
): Promise<void> => {
  const db = await initDB();
  await db.runAsync(
    'UPDATE proyectos SET chat_history = ?, ultimo_acceso = ? WHERE id = ?',
    [JSON.stringify(messages), new Date().toISOString(), projectId]
  );
  await enqueueSync('project', projectId);
};

export const loadLastAnalysis = async (): Promise<{
  mineral: string; terrain: string; rock_type: string;
  coordenadas: any[]; analisis_resultado: any[];
  satdata_source: string; acquisition_date: string; fecha: string;
  prospectivity: any;
} | null> => {
  const db = await initDB();
  const row = await db.getFirstAsync(
    'SELECT * FROM poligonos_cache ORDER BY fecha DESC LIMIT 1'
  ) as any;
  if (!row) return null;
  return {
    mineral: row.mineral || 'oro',
    terrain: row.terrain || 'sierra',
    rock_type: row.rock_type || 'ignea',
    coordenadas: safeJsonParse(row.coordenadas, [] as any[]),
    analisis_resultado: safeJsonParse(row.analisis_resultado, [] as any[]),
    satdata_source: row.satdata_source || '',
    acquisition_date: row.acquisition_date || '',
    fecha: row.fecha || '',
    prospectivity: safeJsonParse(row.prospectivity, null),
  };
};

// ─── FIELD MODE PACKAGE ───────────────────────────────────────────────────────

export async function saveFieldPackage(
  projectId: string,
  data: { resumen_geologo: string; analisis_json: string; mapa_b64: string; size_kb: number; }
): Promise<void> {
  const db = await initDB();
  await db.runAsync(
    `UPDATE proyectos SET campo_preparado_at = datetime('now'), campo_resumen_geologo = ?,
     campo_analisis_json = ?, campo_mapa_b64 = ?, campo_size_kb = ? WHERE id = ?`,
    [data.resumen_geologo, data.analisis_json, data.mapa_b64, data.size_kb, projectId]
  );
  await enqueueSync('project', projectId);
}

export async function loadFieldPackage(projectId: string): Promise<{
  preparado_at: string; resumen_geologo: string; analisis_json: string; mapa_b64: string; size_kb: number;
} | null> {
  const db = await initDB();
  const row = await db.getFirstAsync(
    'SELECT campo_preparado_at, campo_resumen_geologo, campo_analisis_json, campo_mapa_b64, campo_size_kb FROM proyectos WHERE id = ?',
    [projectId]
  ) as any;
  if (!row || !row.campo_preparado_at) return null;
  return {
    preparado_at: row.campo_preparado_at,
    resumen_geologo: row.campo_resumen_geologo || '',
    analisis_json: row.campo_analisis_json || '',
    mapa_b64: row.campo_mapa_b64 || '',
    size_kb: row.campo_size_kb || 0,
  };
}

// ─── REPORT PERSISTENCE ────────────────────────────────────────────────────

export const saveReportContent = async (projectId: string, geologoTexto: string, analisisHash: string): Promise<void> => {
  const db = await initDB();
  await db.runAsync(
    `UPDATE proyectos SET reporte_geologo_texto = ?, reporte_generado_at = datetime('now'), reporte_analisis_hash = ? WHERE id = ?`,
    [geologoTexto, analisisHash, projectId]
  );
  await enqueueSync('project', projectId);
};

export const loadReportContent = async (projectId: string): Promise<{ geologoTexto: string; generadoAt: string; analisisHash: string } | null> => {
  const db = await initDB();
  const row = await db.getFirstAsync(
    'SELECT reporte_geologo_texto, reporte_generado_at, reporte_analisis_hash FROM proyectos WHERE id = ?',
    [projectId]
  ) as any;
  if (!row || !row.reporte_geologo_texto) return null;
  return {
    geologoTexto: row.reporte_geologo_texto,
    generadoAt: row.reporte_generado_at || '',
    analisisHash: row.reporte_analisis_hash || '',
  };
};

export const deleteProject = async (projectId: string): Promise<void> => {
  const db = await initDB();
  // Borra primero las dependencias para no dejar filas huérfanas (validation_pairs
  // referencia muestra_id/proyecto_id; antes quedaban colgadas al eliminar el proyecto).
  await db.runAsync('DELETE FROM validation_pairs WHERE proyecto_id = ?', [projectId]);
  await db.runAsync('DELETE FROM muestras WHERE proyecto_id = ?', [projectId]);
  await db.runAsync('DELETE FROM proyectos WHERE id = ?', [projectId]);
  // spectral_cache and poligonos_cache don't have proyecto_id columns — skip
  // Encola el borrado remoto (Supabase cascada las hijas por project_client_id).
  await enqueueSync('project', projectId, 'delete');
};

export const renameProject = async (projectId: string, nombre: string): Promise<void> => {
  const db = await initDB();
  await db.runAsync(
    'UPDATE proyectos SET nombre = ?, ultimo_acceso = ? WHERE id = ?',
    [nombre, new Date().toISOString(), projectId]
  );
  await enqueueSync('project', projectId);
};

export const saveSampleResena = async (sampleId: string, resena: string): Promise<void> => {
  const db = await initDB();
  await db.runAsync('UPDATE muestras SET reporte_resena = ? WHERE id = ?', [resena, sampleId]);
  await enqueueSync('sample', sampleId);
};

export const loadMuestrasForReport = async (projectId: string): Promise<Array<{
  id: string; lat: number; lng: number; foto_uri?: string; analisis_texto?: string;
  fecha: string; reporte_resena: string;
}>> => {
  const db = await initDB();
  const rows = await db.getAllAsync(
    'SELECT id, lat, lng, imagen_thumbnail AS foto_uri, analisis_ia AS analisis_texto, fecha_hora AS fecha, reporte_resena FROM muestras WHERE proyecto_id = ? ORDER BY fecha_hora DESC',
    [projectId]
  ) as any[];
  return rows.map(r => ({
    id: r.id, lat: r.lat, lng: r.lng,
    foto_uri: r.foto_uri || undefined,
    analisis_texto: r.analisis_texto || undefined,
    fecha: r.fecha || '',
    reporte_resena: r.reporte_resena || '',
  }));
};

// ─── WAYPOINTS FOR ING. VILLEGAS / REPORT ─────────────────────────────────────

export async function loadProjectWaypoints(projectId: string): Promise<Array<{
  id: string; lat: number; lng: number; foto_uri: string; analisis_texto: string; fecha: string;
}>> {
  const db = await initDB();
  const rows = await db.getAllAsync(
    `SELECT id, lat, lng, imagen_thumbnail AS foto_uri,
            COALESCE(descripcion_texto, '') AS analisis_texto,
            COALESCE(fecha_hora, '') AS fecha
     FROM muestras
     WHERE proyecto_id = ? AND imagen_thumbnail != ''
     ORDER BY fecha_hora DESC`,
    [projectId]
  ) as any[];
  return rows.map(r => ({
    id: String(r.id), lat: Number(r.lat), lng: Number(r.lng),
    foto_uri: String(r.foto_uri), analisis_texto: String(r.analisis_texto), fecha: String(r.fecha),
  }));
}

// ─── MUESTRA EXTENDED UPDATES ─────────────────────────────────────────────

export const updateMuestraCodigo = async (
  id: string,
  codigo: string,
  utmZona: string,
  utmEasting: number,
  utmNorthing: number,
  spectralSnapshot: object
): Promise<void> => {
  const db = await initDB();
  await db.runAsync(
    `UPDATE muestras SET muestra_codigo = ?, utm_zona = ?, utm_easting = ?, utm_northing = ?, spectral_snapshot = ? WHERE id = ?`,
    [codigo, utmZona, utmEasting, utmNorthing, JSON.stringify(spectralSnapshot), id]
  );
  await enqueueSync('sample', id);
};

export interface LabResult {
  au_gt?: number | null;
  ag_gt?: number | null;
  cu_pct?: number | null;
  pb_pct?: number | null;
  zn_pct?: number | null;
  laboratorio?: string;
  fecha_certificado?: string;
  certificado_b64?: string;
}

export const updateMuestraLab = async (id: string, lab: LabResult): Promise<void> => {
  const db = await initDB();
  await db.runAsync(
    `UPDATE muestras SET
      lab_au_gt = ?, lab_ag_gt = ?, lab_cu_pct = ?, lab_pb_pct = ?, lab_zn_pct = ?,
      lab_laboratorio = ?, lab_fecha_certificado = ?, lab_certificado_b64 = ?,
      lab_guardado_at = datetime('now')
     WHERE id = ?`,
    [
      lab.au_gt ?? null, lab.ag_gt ?? null, lab.cu_pct ?? null, lab.pb_pct ?? null, lab.zn_pct ?? null,
      lab.laboratorio ?? '', lab.fecha_certificado ?? '', lab.certificado_b64 ?? '',
      id,
    ]
  );
  await enqueueSync('sample', id);
};

export const updateMuestraValidation = async (
  id: string,
  verdict: 'CONFIRMED' | 'PARTIAL' | 'NOT_CONFIRMED',
  comment: string
): Promise<void> => {
  const db = await initDB();
  await db.runAsync(
    `UPDATE muestras SET validation_verdict = ?, validation_comment = ? WHERE id = ?`,
    [verdict, comment, id]
  );
  await enqueueSync('sample', id);
};

// ─── VALIDATION PAIRS ─────────────────────────────────────────────────────

export interface ValidationPair {
  id: string;
  muestra_id: string;
  muestra_codigo?: string;  // from JOIN with muestras
  proyecto_id: string;
  created_at: string;
  spectral_consensus: string;
  spectral_evidence: string;
  spectral_base_score: number;
  spectral_indices_json: string;
  metal_target: string;
  lab_au_gt: number | null;
  lab_ag_gt: number | null;
  lab_cu_pct: number | null;
  lab_pb_pct: number | null;
  lab_zn_pct: number | null;
  verdict: string;
  verdict_comment: string;
  verdict_threshold: number;
}

export const upsertValidationPair = async (
  muestraId: string,
  proyectoId: string,
  data: {
    spectralConsensus: string;
    spectralEvidence: string;
    spectralBaseScore: number;
    spectralIndices: object;
    metalTarget: string;
    lab: LabResult;
    verdict: string;
    verdictComment: string;
    verdictThreshold: number;
  }
): Promise<void> => {
  const db = await initDB();
  const existing = await db.getFirstAsync('SELECT id FROM validation_pairs WHERE muestra_id = ?', [muestraId]) as any;
  const id = existing?.id ?? 'vp_' + Date.now().toString(36);
  await db.runAsync(
    `INSERT OR REPLACE INTO validation_pairs
     (id, muestra_id, proyecto_id, created_at, spectral_consensus, spectral_evidence,
      spectral_base_score, spectral_indices_json, metal_target,
      lab_au_gt, lab_ag_gt, lab_cu_pct, lab_pb_pct, lab_zn_pct,
      verdict, verdict_comment, verdict_threshold)
     VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, muestraId, proyectoId, data.spectralConsensus, data.spectralEvidence,
      data.spectralBaseScore, JSON.stringify(data.spectralIndices), data.metalTarget,
      data.lab.au_gt ?? null, data.lab.ag_gt ?? null, data.lab.cu_pct ?? null,
      data.lab.pb_pct ?? null, data.lab.zn_pct ?? null,
      data.verdict, data.verdictComment, data.verdictThreshold,
    ]
  );
  await enqueueSync('validation', id);
};

export const getValidationPairs = async (proyectoId: string): Promise<ValidationPair[]> => {
  const db = await initDB();
  return await db.getAllAsync(
    `SELECT vp.*, m.muestra_codigo, m.lat, m.lng
     FROM validation_pairs vp
     JOIN muestras m ON vp.muestra_id = m.id
     WHERE vp.proyecto_id = ?
     ORDER BY vp.created_at DESC`,
    [proyectoId]
  ) as ValidationPair[];
};

export const getMuestraById = async (id: string): Promise<any | null> => {
  const db = await initDB();
  return await db.getFirstAsync('SELECT * FROM muestras WHERE id = ?', [id]) as any;
};

// Actualiza la foto de una muestra a su URL de Storage tras subirla (sin re-encolar).
export const setSamplePhotoUrl = async (id: string, url: string): Promise<void> => {
  const db = await initDB();
  await db.runAsync('UPDATE muestras SET imagen_thumbnail = ? WHERE id = ?', [url, id]);
};

export default function DummyDatabaseRoute() { return null; }

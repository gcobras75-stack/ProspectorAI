import * as SQLite from 'expo-sqlite';

let dbCache: SQLite.SQLiteDatabase | null = null;

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
    `ALTER TABLE poligonos_cache ADD COLUMN satdata_source   TEXT DEFAULT ''`,
    `ALTER TABLE poligonos_cache ADD COLUMN acquisition_date TEXT DEFAULT ''`,
    `ALTER TABLE proyectos ADD COLUMN campo_preparado_at   TEXT    DEFAULT ''`,
    `ALTER TABLE proyectos ADD COLUMN campo_resumen_geologo TEXT   DEFAULT ''`,
    `ALTER TABLE proyectos ADD COLUMN campo_analisis_json   TEXT   DEFAULT ''`,
    `ALTER TABLE proyectos ADD COLUMN campo_mapa_b64        TEXT   DEFAULT ''`,
    `ALTER TABLE proyectos ADD COLUMN campo_size_kb         INTEGER DEFAULT 0`,
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
   await db.runAsync('DELETE FROM muestras');
};

export const savePoligonoCache = async (data: any) => {
  const db = await initDB();
  await db.runAsync(
    `INSERT OR REPLACE INTO poligonos_cache (id, mineral, terrain, rock_type, coordenadas, fecha, analisis_resultado, estado) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id, data.mineral, data.terrain, data.rock_type, 
      typeof data.coordenadas === 'string' ? data.coordenadas : JSON.stringify(data.coordenadas),
      new Date().toISOString(),
      typeof data.analisis_resultado === 'string' ? data.analisis_resultado : JSON.stringify(data.analisis_resultado),
      data.estado || 'OFFLINE'
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
  }
): Promise<void> => {
  const db = await initDB();
  const fields = Object.keys(data).filter(k => data[k as keyof typeof data] !== undefined);
  if (fields.length === 0) return;
  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => {
    const v = data[f as keyof typeof data];
    return Array.isArray(v) ? JSON.stringify(v) : v;
  });
  values.push(new Date().toISOString()); // ultimo_acceso
  values.push(projectId);
  await db.runAsync(
    `UPDATE proyectos SET ${setClause}, ultimo_acceso = ? WHERE id = ?`,
    values as any[]
  );
};

export const loadProjectState = async (projectId: string): Promise<{
  id: string; nombre: string;
  mineral: string; terrain: string; depth: string; rock_type: string;
  coordenadas: any[]; analisis_resultado: any[];
  satdata_source: string; acquisition_date: string; area_ha: number;
  chat_history: { role: string; content: string }[];
  notas: string;
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
    coordenadas: row.coordenadas ? JSON.parse(row.coordenadas) : [],
    analisis_resultado: row.analisis_resultado ? JSON.parse(row.analisis_resultado) : [],
    satdata_source: row.satdata_source || '',
    acquisition_date: row.acquisition_date || '',
    area_ha: row.area_ha || 0,
    chat_history: row.chat_history ? JSON.parse(row.chat_history) : [],
    notas: row.notas || '',
  };
};

export const saveProjectChatHistory = async (
  projectId: string,
  messages: { role: string; content: string }[]
): Promise<void> => {
  const db = await initDB();
  await db.runAsync(
    'UPDATE proyectos SET chat_history = ?, ultimo_acceso = ? WHERE id = ?',
    [JSON.stringify(messages), new Date().toISOString(), projectId]
  );
};

export const loadLastAnalysis = async (): Promise<{
  mineral: string; terrain: string; rock_type: string;
  coordenadas: any[]; analisis_resultado: any[];
  satdata_source: string; acquisition_date: string; fecha: string;
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
    coordenadas: row.coordenadas ? JSON.parse(row.coordenadas) : [],
    analisis_resultado: row.analisis_resultado ? JSON.parse(row.analisis_resultado) : [],
    satdata_source: row.satdata_source || '',
    acquisition_date: row.acquisition_date || '',
    fecha: row.fecha || '',
  };
};

// ─── FIELD MODE PACKAGE ───────────────────────────────────────────────────────

export async function saveFieldPackage(
  projectId: string,
  data: {
    resumen_geologo: string;
    analisis_json: string;
    mapa_b64: string;
    size_kb: number;
  }
): Promise<void> {
  const db = await initDB();
  await db.runAsync(
    `UPDATE proyectos
     SET campo_preparado_at = datetime('now'),
         campo_resumen_geologo = ?,
         campo_analisis_json = ?,
         campo_mapa_b64 = ?,
         campo_size_kb = ?
     WHERE id = ?`,
    [data.resumen_geologo, data.analisis_json, data.mapa_b64, data.size_kb, projectId]
  );
}

export async function loadFieldPackage(projectId: string): Promise<{
  preparado_at: string;
  resumen_geologo: string;
  analisis_json: string;
  mapa_b64: string;
  size_kb: number;
} | null> {
  const db = await initDB();
  const row = await db.getFirstAsync(
    'SELECT campo_preparado_at, campo_resumen_geologo, campo_analisis_json, campo_mapa_b64, campo_size_kb FROM proyectos WHERE id = ?',
    [projectId]
  ) as any;
  if (!row || !row.campo_preparado_at) return null;
  return {
    preparado_at:     row.campo_preparado_at,
    resumen_geologo:  row.campo_resumen_geologo  || '',
    analisis_json:    row.campo_analisis_json    || '',
    mapa_b64:         row.campo_mapa_b64         || '',
    size_kb:          row.campo_size_kb          || 0,
  };
}

export default function DummyDatabaseRoute() { return null; }

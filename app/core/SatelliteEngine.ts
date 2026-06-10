/**
 * SatelliteEngine.ts
 *
 * Fetches REAL Sentinel-2 spectral indices for mineral prospecting.
 *
 * Decision flow (regla de oro):
 *   1. Try server → on success, save to cache → return SENTINEL2_REAL
 *   2. On network error → try SQLite cache → return SENTINEL2_CACHED
 *   3. Cache miss + no network → return NO_DATA_OFFLINE
 *   NEVER returns SIMULATED for polygon analysis.
 */

import { saveSpectralCache, loadSpectralCache } from './Database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MiningSpectralCell {
  lat: number;
  lng: number;
  /** Iron oxide ratio B4/B2. Gossan proxy. Range: 0.5–4.0 */
  iron_oxide: number;
  /** Ferrous iron ratio B11/B8. Range: 0.3–3.0 */
  ferroso: number;
  /** Clay/hydroxyl ratio B11/B12. Hydrothermal clays. Range: 0.5–2.5 */
  clay: number;
  /** NDVI (B8-B4)/(B8+B4). Used as vegetation mask. Range: -1 to 1 */
  ndvi: number;
  /** True when NDVI > 0.55 — mineral signal unreliable under dense vegetation */
  masked_by_vegetation: boolean;
  utm_zone: string;   // e.g. "13N"
  epsg: string;       // e.g. "EPSG:32613"
}

export interface AsterSpectralCell {
  lat: number;
  lng: number;
  iron_oxide_aster: number | null;  // B02/B01
  alunite_bd: number | null;        // Al-OH band depth
  chlorite_bd: number | null;       // Mg-OH band depth
  ferroso_aster: number | null;     // B05/B04
  utm_zone: string;
  epsg: string;
}

export type SpectralDataSource =
  | 'SENTINEL2_REAL'     // live from server, just fetched
  | 'SENTINEL2_CACHED'   // loaded from SQLite cache (real data, saved previously)
  | 'NO_DATA_OFFLINE';   // no server + no cache → polygon analysis must NOT run

export interface MiningSpectralResult {
  cells: MiningSpectralCell[];
  /** Fast lookup: key = "lat,lng" (5dp), value = cell */
  cellIndex: Map<string, MiningSpectralCell>;
  acquisition_date: string;
  cloud_cover: number;
  images_used: number;
  cell_size_m: number;
  coverage_pct: number;
  data_source: SpectralDataSource;
  /** Only set for SENTINEL2_CACHED: days since the data was saved */
  cache_age_days?: number;
  /** Human-readable label for display in the UI */
  source_label: string;
}

export interface AsterSpectralResult {
  cells: AsterSpectralCell[];
  cellIndex: Map<string, AsterSpectralCell>;
  images_used: number;
  archive_range: string;
}

export interface AsterCoverageReport {
  count: number;
  coverage_ok: boolean;
  avg_cloud_cover: number | null;
  message: string;
  scenes: Array<{ date: string; cloud_cover: number | null }>;
}

// ---------------------------------------------------------------------------
// Cache key: centroid at 2dp (~1km precision) + area quantized to 10 ha
// This identifies "same zone" reliably without exact polygon matching
// ---------------------------------------------------------------------------

export function computeCacheKey(
  polygonCoords: Array<{ latitude: number; longitude: number }>
): string {
  if (!polygonCoords || polygonCoords.length === 0) return 'invalid';
  let sumLat = 0, sumLng = 0;
  for (const c of polygonCoords) { sumLat += c.latitude; sumLng += c.longitude; }
  const centLat = (sumLat / polygonCoords.length).toFixed(2);
  const centLng = (sumLng / polygonCoords.length).toFixed(2);
  // Rough area in ha (shoelace, no need for precision here)
  const R = 6378137;
  const avgLat = (sumLat / polygonCoords.length) * Math.PI / 180;
  const pts = polygonCoords.map(c => ({
    x: c.longitude * Math.PI / 180 * R * Math.cos(avgLat),
    y: c.latitude  * Math.PI / 180 * R,
  }));
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i], p2 = pts[(i + 1) % pts.length];
    area += (p1.x * p2.y - p2.x * p1.y);
  }
  const areaHa = Math.round(Math.abs(area / 2) / 10000 / 10) * 10; // round to nearest 10 ha
  return `s2mining_${centLat}_${centLng}_${areaHa}ha`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getServerUrl(): string {
  const envUrl = process.env.EXPO_PUBLIC_SERVER_URL;
  if (envUrl && envUrl !== 'undefined' && envUrl !== '') return envUrl.replace(/\/$/, '');
  return 'https://prospector-gee-server-production.up.railway.app';
}

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function toGeoJSONCoords(coords: Array<{ latitude: number; longitude: number }>): number[][] {
  const ring = coords.map(c => [c.longitude, c.latitude]);
  const first = ring[0], last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return ring;
}

function buildCellIndex<T extends { lat: number; lng: number }>(cells: T[]): Map<string, T> {
  const index = new Map<string, T>();
  for (const cell of cells) {
    index.set(`${cell.lat.toFixed(5)},${cell.lng.toFixed(5)}`, cell);
  }
  return index;
}

function makeSourceLabel(source: SpectralDataSource, acquisitionDate: string, ageDays?: number): string {
  switch (source) {
    case 'SENTINEL2_REAL':
      return `📡 Sentinel-2 real · imagen ${acquisitionDate}`;
    case 'SENTINEL2_CACHED':
      return `📡 Sentinel-2 real · guardado hace ${ageDays ?? '?'} días · sin conexión`;
    case 'NO_DATA_OFFLINE':
      return '🔌 Sin datos. Conecta a internet para analizar esta zona.';
  }
}

// ---------------------------------------------------------------------------
// Public: fetchMiningSpectralGrid  (regla de oro enforced here)
// ---------------------------------------------------------------------------

export async function fetchMiningSpectralGrid(
  polygonCoords: Array<{ latitude: number; longitude: number }>,
  options?: { fecha_inicio?: string; fecha_fin?: string; cell_size_m?: number }
): Promise<MiningSpectralResult> {
  const cacheKey   = computeCacheKey(polygonCoords);
  const serverUrl  = getServerUrl();
  const coordinates = toGeoJSONCoords(polygonCoords);

  // ── 1. Try server ─────────────────────────────────────────────────────────
  const body: Record<string, unknown> = { coordinates };
  if (options?.fecha_inicio) body.fecha_inicio = options.fecha_inicio;
  if (options?.fecha_fin)    body.fecha_fin    = options.fecha_fin;
  if (options?.cell_size_m)  body.cell_size_m  = options.cell_size_m;

  try {
    const response = await fetchWithTimeout(
      `${serverUrl}/api/mining/spectral-grid`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      45000
    );
    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      throw new Error(`Server ${response.status}: ${errText}`);
    }
    const raw = await response.json();
    const cells: MiningSpectralCell[] = raw.cells || [];

    // ── Save to cache immediately (fire-and-forget, don't block) ────────────
    saveSpectralCache(cacheKey, {
      cells_json:       JSON.stringify(cells),
      acquisition_date: raw.acquisition_date || '',
      cloud_cover:      raw.cloud_cover      || 0,
      coverage_pct:     raw.coverage_pct     || 0,
      images_used:      raw.images_used      || 0,
      cell_size_m:      raw.cell_size_m      || 500,
    }).catch(e => console.warn('[SatelliteEngine] cache write failed:', e.message));

    return {
      cells,
      cellIndex:        buildCellIndex(cells),
      acquisition_date: raw.acquisition_date || '',
      cloud_cover:      raw.cloud_cover      || 0,
      images_used:      raw.images_used      || 0,
      cell_size_m:      raw.cell_size_m      || 500,
      coverage_pct:     raw.coverage_pct     || 0,
      data_source:      'SENTINEL2_REAL',
      source_label:     makeSourceLabel('SENTINEL2_REAL', raw.acquisition_date || ''),
    };

  } catch (networkErr: any) {
    console.warn('[SatelliteEngine] Server unreachable:', networkErr.message);
  }

  // ── 2. Try SQLite cache ───────────────────────────────────────────────────
  try {
    const cached = await loadSpectralCache(cacheKey);
    if (cached) {
      const cells: MiningSpectralCell[] = JSON.parse(cached.cells_json);
      const source: SpectralDataSource = 'SENTINEL2_CACHED';
      return {
        cells,
        cellIndex:        buildCellIndex(cells),
        acquisition_date: cached.acquisition_date,
        cloud_cover:      cached.cloud_cover,
        images_used:      cached.images_used,
        cell_size_m:      cached.cell_size_m,
        coverage_pct:     cached.coverage_pct,
        data_source:      source,
        cache_age_days:   cached.age_days,
        source_label:     makeSourceLabel(source, cached.acquisition_date, cached.age_days),
      };
    }
  } catch (cacheErr: any) {
    console.warn('[SatelliteEngine] Cache read failed:', cacheErr.message);
  }

  // ── 3. No data available — caller must block polygon analysis ─────────────
  return {
    cells:            [],
    cellIndex:        new Map(),
    acquisition_date: '',
    cloud_cover:      0,
    images_used:      0,
    cell_size_m:      500,
    coverage_pct:     0,
    data_source:      'NO_DATA_OFFLINE',
    source_label:     makeSourceLabel('NO_DATA_OFFLINE', ''),
  };
}

// ---------------------------------------------------------------------------
// Public: fetchAsterCoverage
// ---------------------------------------------------------------------------

export async function fetchAsterCoverage(
  lat: number, lng: number, radius_km = 50
): Promise<AsterCoverageReport> {
  const serverUrl = getServerUrl();
  try {
    const response = await fetchWithTimeout(
      `${serverUrl}/api/mining/aster-coverage?lat=${lat}&lng=${lng}&radius_km=${radius_km}`,
      { method: 'GET' },
      30000
    );
    if (!response.ok) throw new Error(`Server error ${response.status}`);
    return await response.json();
  } catch (err: any) {
    console.warn('[SatelliteEngine] fetchAsterCoverage failed:', err.message);
    return { count: 0, coverage_ok: false, avg_cloud_cover: null,
             message: `No se pudo verificar cobertura ASTER: ${err.message}`, scenes: [] };
  }
}

// ---------------------------------------------------------------------------
// Public: fetchAsterGrid (only call when coverage_ok = true)
// ---------------------------------------------------------------------------

export async function fetchAsterGrid(
  polygonCoords: Array<{ latitude: number; longitude: number }>,
  options?: { cell_size_m?: number }
): Promise<AsterSpectralResult> {
  const coordinates = toGeoJSONCoords(polygonCoords);
  const serverUrl   = getServerUrl();
  const body: Record<string, unknown> = { coordinates };
  if (options?.cell_size_m) body.cell_size_m = options.cell_size_m;

  try {
    const response = await fetchWithTimeout(
      `${serverUrl}/api/mining/aster-grid`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      60000
    );
    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      throw new Error(`Server error ${response.status}: ${errText}`);
    }
    const raw = await response.json();
    const cells: AsterSpectralCell[] = raw.cells || [];
    return { cells, cellIndex: buildCellIndex(cells),
             images_used: raw.images_used || 0, archive_range: raw.archive_range || '2000-2008' };
  } catch (err: any) {
    console.warn('[SatelliteEngine] fetchAsterGrid failed:', err.message);
    return { cells: [], cellIndex: new Map(), images_used: 0, archive_range: '' };
  }
}

// ---------------------------------------------------------------------------
// Utility: nearest-neighbor lookup for GeologicalEngine
// ---------------------------------------------------------------------------

export function findNearestCell<T extends { lat: number; lng: number }>(
  lat: number, lng: number, cells: T[],
  maxDistanceDeg = 0.02  // ~2km — returns null if farther
): T | null {
  if (!cells || cells.length === 0) return null;
  let best: T | null = null;
  let bestDist = Infinity;
  for (const cell of cells) {
    const d = (cell.lat - lat) ** 2 + (cell.lng - lng) ** 2;
    if (d < bestDist) { bestDist = d; best = cell; }
  }
  return bestDist > maxDistanceDeg ** 2 ? null : best;
}

// app/core/mrdsService.ts
// Validación con yacimientos minerales conocidos — USGS MRDS (base GLOBAL, datos ~hasta 2011).
// API verificada: GET https://mrdata.usgs.gov/mrds/search-bbox.php?xmin&ymin&xmax&ymax&f=json
// Respuesta: GeoJSON FeatureCollection. Lectura DEFENSIVA (campos pueden faltar o venir
// como objeto o como arreglo). No se inventa nada: si la red falla, se devuelve { error }.

export interface KnownOccurrence {
  name: string;
  commodity: string;
  status: string;
  lat: number;
  lng: number;
}

export interface KnownOccurrencesResult {
  occurrences: KnownOccurrence[];
  count: number;      // total real encontrado (antes del cap)
  capped: boolean;    // true si count > MAX_OCCURRENCES
  error?: string;     // presente solo si la consulta falló (NO confundir con 0 resultados)
}

export interface OccurrenceBbox {
  latMin: number;
  latMax: number;
  lngMin: number;
  lngMax: number;
}

const MRDS_BBOX_URL = 'https://mrdata.usgs.gov/mrds/search-bbox.php';
const BUFFER_DEG = 0.03;       // ~3 km de margen, para captar yacimientos "cerca" del polígono
const MAX_OCCURRENCES = 300;   // cap defensivo para no saturar el mapa
const TIMEOUT_MS = 12000;

// Lee `key` de un contenedor que puede ser objeto, arreglo de objetos, o nulo. Defensivo.
function readField(container: any, key: string): string {
  if (container == null) return '';
  if (Array.isArray(container)) {
    for (const item of container) { const s = readField(item, key); if (s) return s; }
    return '';
  }
  if (typeof container === 'object') {
    const v = container[key];
    return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v));
  }
  if (typeof container === 'string') return container.trim();
  return '';
}

export async function fetchKnownOccurrences(
  bbox: OccurrenceBbox,
  opts?: { commodity?: string; signal?: AbortSignal }
): Promise<KnownOccurrencesResult> {
  const empty: KnownOccurrence[] = [];
  if (!bbox || !Number.isFinite(bbox.latMin) || !Number.isFinite(bbox.latMax) ||
      !Number.isFinite(bbox.lngMin) || !Number.isFinite(bbox.lngMax)) {
    return { occurrences: empty, count: 0, capped: false, error: 'bbox inválido' };
  }

  const xmin = Math.min(bbox.lngMin, bbox.lngMax) - BUFFER_DEG;
  const xmax = Math.max(bbox.lngMin, bbox.lngMax) + BUFFER_DEG;
  const ymin = Math.min(bbox.latMin, bbox.latMax) - BUFFER_DEG;
  const ymax = Math.max(bbox.latMin, bbox.latMax) + BUFFER_DEG;

  const params = new URLSearchParams({
    xmin: String(xmin), ymin: String(ymin), xmax: String(xmax), ymax: String(ymax), f: 'json',
  });
  if (opts?.commodity) params.set('com', opts.commodity);
  const url = `${MRDS_BBOX_URL}?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: opts?.signal ?? controller.signal });
    if (!res.ok) return { occurrences: empty, count: 0, capped: false, error: `HTTP ${res.status}` };
    const data: any = await res.json();
    const features: any[] = Array.isArray(data?.features) ? data.features : [];
    const all: KnownOccurrence[] = [];
    for (const f of features) {
      const coords = f?.geometry?.coordinates;
      const lng = Array.isArray(coords) ? Number(coords[0]) : NaN;
      const lat = Array.isArray(coords) ? Number(coords[1]) : NaN;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const p = f?.properties ?? {};
      const name = readField(p?.name, 'name') || 'Sin nombre';
      const commodity = readField(p?.commodity, 'commod');
      const status = readField(p?.deposits, 'dev_st');
      all.push({ name, commodity, status, lat, lng });
    }
    const capped = all.length > MAX_OCCURRENCES;
    return {
      occurrences: capped ? all.slice(0, MAX_OCCURRENCES) : all,
      count: all.length,
      capped,
    };
  } catch (e: any) {
    const msg = e?.name === 'AbortError' ? 'tiempo de espera agotado' : (e?.message || 'error de red');
    return { occurrences: empty, count: 0, capped: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

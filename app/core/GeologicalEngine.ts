import type { MiningSpectralResult, AsterSpectralCell, EmitSpectralCell } from './SatelliteEngine';
import { findNearestCell, computeAdaptiveCellSize } from './SatelliteEngine';
import { CATALOG_WEIGHTS, getMaterial, normalizeMaterialId } from './materialsCatalog';

/**
 * Pesos espectrales por material (fuente única, exportada para que otros módulos
 * — p.ej. el cálculo de confianza en ConsensusFusion — los reutilicen).
 *
 * Los 22 materiales del catálogo (CATALOG_WEIGHTS) son la fuente de verdad; se
 * conservan además los ids heredados (zinc/plomo/litio) para retrocompatibilidad
 * con proyectos guardados antes del catálogo agrupado.
 */
export const METAL_WEIGHTS: Record<string, Record<string, number>> = {
  // Ids heredados (se normalizan a ids del catálogo en la UI, pero por si acaso).
  zinc:   { sphalerite: 0.45, carbonate: 0.35, clay: 0.20 },
  plomo:  { galena: 0.40, gossan: 0.35, iron_oxide: 0.25 },
  tierras_raras:  { clay: 0.45, carbonate: 0.35, argillic: 0.20 },
  // Catálogo Fase 1 (22 materiales) — pisa cualquier legado con mismo id.
  ...CATALOG_WEIGHTS,
};

/**
 * Índices SIN proxy directo de Sentinel-2. Hoy se generan sintéticamente
 * (generateIndices, semilla por coordenada) — NO son medición real y no deben
 * presentarse como tal. Se usan para penalizar la CONFIANZA del metal afectado.
 */
export const SYNTHETIC_INDEX_KEYS = ['silica', 'malachite', 'sphalerite', 'carbonate', 'galena'] as const;

export interface SpectralIndices {
  iron_oxide: number;
  clay: number;
  gossan: number;
  silica: number;
  ferric_iron: number;
  malachite: number;
  propylitic: number;
  argillic: number;
  sphalerite: number;
  carbonate: number;
  galena: number;
}

export interface AnalysisPoint {
  id: string;
  rank: number;
  lat: number;
  lng: number;
  base_score: number;
  indices: SpectralIndices;
  score?: number;
  indices_analizados?: any[];
  interpretacion?: string; /* legacy */
  analisis_integral?: string;
  geologia_interpretada?: string;
  recomendacion?: string;
  /** 'SENTINEL2_REAL' or 'SENTINEL2_CACHED' when indices come from satellite */
  data_source?: 'SENTINEL2_REAL' | 'SENTINEL2_CACHED' | 'SIMULATED';
  utm_zone?: string;
  epsg?: string;
  /** Claves de índice que recibieron dato REAL medido de ASTER/EMIT (Etapa B). */
  enriched_indices?: string[];
}

// Generador pseudo-aleatorio basado en una semilla determinista
function pseudoRandom(seed: number): number {
  let x = Math.sin(seed * 99999.9999) * 10000;
  return x - Math.floor(x);
}

// Ray casting algorithm for polygon bounds
function pointInPolygon(point: {lat: number, lng: number}, vs: any[]) {
    let x = point.lat, y = point.lng;
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        let xi = vs[i].latitude, yi = vs[i].longitude;
        let xj = vs[j].latitude, yj = vs[j].longitude;
        let intersect = ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// Calculate Area in Hectares
function calcAreaHectares(coords: any[]): number {
  if (!coords || coords.length < 3) return 0;
  const R = 6378137;
  let sumY = 0;
  for (const c of coords) sumY += c.latitude;
  const avgLat = (sumY / coords.length) * Math.PI / 180;
  const points = coords.map((c:any) => ({
    x: c.longitude * Math.PI / 180 * R * Math.cos(avgLat),
    y: c.latitude * Math.PI / 180 * R
  }));
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    area += (p1.x * p2.y - p2.x * p1.y);
  }
  return Math.abs(area / 2) / 10000;
}

// Generate deterministic indices (0.0 to 1.0)
function generateIndices(lat: number, lng: number, terrain: string, rockType: string): SpectralIndices {
   const seed = lat * 10000 + lng * 10000;
   const generate = (offset: number) => 0.1 + pseudoRandom(seed + offset) * 0.9;
   
   let indices: SpectralIndices = {
     iron_oxide: generate(1),
     clay: generate(2),
     gossan: generate(3),
     silica: generate(4),
     ferric_iron: generate(5),
     malachite: generate(6),
     propylitic: generate(7),
     argillic: generate(8),
     sphalerite: generate(9),
     carbonate: generate(10),
     galena: generate(11)
   };

   // Geological context simulated influence
   if (terrain === 'sierra') { indices.iron_oxide *= 1.2; indices.gossan *= 1.2; }
   if (rockType === 'ignea') { indices.silica *= 1.3; indices.propylitic *= 1.2; }
   if (rockType === 'sedimentaria') { indices.clay *= 1.3; indices.carbonate *= 1.4; }

   // Normalize caps
   for (let key in indices) {
     (indices as any)[key] = Math.min(1.0, (indices as any)[key]);
   }
   return indices;
}

export function analyzeZoneLocal(
  polygonCoords: any[],
  mineral: string,
  terrain: string,
  depth: string,
  rockType: string,
  waypoints: any[],
  satelliteData: MiningSpectralResult
): { success: boolean; top_points: AnalysisPoint[]; area_ha: number; all_points?: AnalysisPoint[]; grid_size?: { latStep: number; lngStep: number }; weights_used?: Record<string, number>; error?: string } {

  if (!polygonCoords || polygonCoords.length < 3) return { success: false, top_points: [], area_ha: 0 };

  // Block analysis if no real satellite data is available
  if (!satelliteData || satelliteData.data_source === 'NO_DATA_OFFLINE') {
    return {
      success: false,
      top_points: [],
      area_ha: 0,
      error: 'NO_DATA_OFFLINE',
    };
  }

  const areaHa = calcAreaHectares(polygonCoords);
  let targetCount = 5;
  if (areaHa >= 200) targetCount = 20;
  else if (areaHa >= 50) targetCount = 15;
  else if (areaHa >= 10) targetCount = 10;

  // 1. Base Weights (fuente única: METAL_WEIGHTS exportado arriba)
  let weights = { ...(METAL_WEIGHTS[mineral.toLowerCase()] || METAL_WEIGHTS['oro']) };

  // 2. Field Sample Auto-calibration
  // Find successful samples for this mineral nearby
  const successfulSamples = waypoints.filter(wp => 
    wp.mineral_detectado?.toLowerCase() === mineral.toLowerCase() && wp.score_ia > 80
  );

  if (successfulSamples.length > 0) {
    // Determine the dominant index from successful samples
    let dominantIndex = '';
    let maxVal = 0;
    for (const wp of successfulSamples) {
       // Usar el snapshot espectral REAL congelado al tomar la muestra (indices del
       // punto S2 más cercano). NO fabricar con generateIndices: si la muestra no
       // tiene snapshot real, se omite (no se calibra con datos inventados).
       const snap = wp.spectral_snapshot ?? wp.spectralSnapshot;
       let realIndices: any = null;
       if (snap) {
          try { const parsed = typeof snap === 'string' ? JSON.parse(snap) : snap; realIndices = parsed?.indices ?? null; }
          catch { realIndices = null; }
       }
       if (!realIndices) continue;
       for (const key of Object.keys(weights)) {
          const val = Number((realIndices as any)[key]) || 0;
          if (val > maxVal) {
             maxVal = val;
             dominantIndex = key;
          }
       }
    }
    
    // Boost the dominant index weight slightly (local recalibration)
    if (dominantIndex && weights[dominantIndex] !== undefined) {
       const boost = 0.10; // 10% boost
       weights[dominantIndex] += boost;
       // Normalize weights to sum to 1.0
       let sum = 0;
       for (const k in weights) sum += weights[k];
       for (const k in weights) weights[k] = weights[k] / sum;
    }
  }

  // Bounding box
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const pt of polygonCoords) {
      if (pt.latitude < minLat) minLat = pt.latitude;
      if (pt.latitude > maxLat) maxLat = pt.latitude;
      if (pt.longitude < minLng) minLng = pt.longitude;
      if (pt.longitude > maxLng) maxLng = pt.longitude;
  }

  // Adaptive grid: step size matches satellite resolution — no false precision
  const cellSizeM    = satelliteData.cell_size_m > 0
    ? satelliteData.cell_size_m
    : computeAdaptiveCellSize(areaHa);
  // Convert metres → degrees (1° lat ≈ 111 km)
  const degPerCell   = cellSizeM / 111_000;
  const bboxHeightDeg = maxLat - minLat;
  const bboxWidthDeg  = maxLng - minLng;
  // Steps: bbox / cell size, capped 5–45 per axis
  const stepsLat = Math.max(5, Math.min(45, Math.round(bboxHeightDeg / degPerCell)));
  const stepsLng = Math.max(5, Math.min(45, Math.round(bboxWidthDeg  / degPerCell)));

  // Grid search to find candidates inside polygon
  const candidates: AnalysisPoint[] = [];
  const latStep = (maxLat - minLat) / stepsLat;
  const lngStep = (maxLng - minLng) / stepsLng;

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

  for (let i = 0; i < stepsLat; i++) {
    for (let j = 0; j < stepsLng; j++) {
      const lat = minLat + latStep * i;
      const lng = minLng + lngStep * j;
      if (pointInPolygon({lat, lng}, polygonCoords)) {

        // Use real satellite data (SENTINEL2_REAL or SENTINEL2_CACHED)
        const nearestCell = satelliteData.cells.length > 0
          ? findNearestCell(lat, lng, satelliteData.cells)
          : null;

        let indices: SpectralIndices;
        const pointDataSource = satelliteData.data_source as 'SENTINEL2_REAL' | 'SENTINEL2_CACHED';
        let utm_zone: string | undefined;
        let epsg: string | undefined;

        if (nearestCell && !nearestCell.masked_by_vegetation) {
          // Map real S2 ratios → normalized 0-1 for weight compatibility.
          // Los índices SIN proxy directo de Sentinel-2 (silica/malachite/sphalerite/
          // carbonate/galena = SYNTHETIC_INDEX_KEYS) NO se fabrican: se dejan en 0
          // (evidencia ausente) hasta que el análisis profundo (ASTER/EMIT) aporte el
          // dato real. Antes se rellenaban con generateIndices (pseudo-aleatorio por
          // coordenada), lo que inventaba señal y elevaba scores sin medición real.
          indices = {
            iron_oxide:  clamp((nearestCell.iron_oxide - 0.5) / 2.5, 0, 1),
            clay:        clamp((nearestCell.clay       - 0.5) / 2.0, 0, 1),
            gossan:      clamp((nearestCell.iron_oxide - 0.5) / 2.5, 0, 1),
            ferric_iron: clamp((nearestCell.iron_oxide - 0.5) / 2.5, 0, 1),
            propylitic:  clamp((nearestCell.clay       - 0.5) / 2.0, 0, 1),
            argillic:    clamp((nearestCell.clay       - 0.5) / 2.0, 0, 1),
            silica:      0,
            malachite:   0,
            sphalerite:  0,
            carbonate:   0,
            galena:      0,
          };
          utm_zone = nearestCell.utm_zone;
          epsg     = nearestCell.epsg;
        } else {
          // Celda enmascarada por vegetación (NDVI alto) o sin cobertura S2: no hay
          // evidencia óptica real. Antes se fabricaba con generateIndices; ahora se
          // marca SIN SEÑAL (0) para no inventar. La baja confianza del punto se refleja
          // en el indicador (vegetation_pct / simulated_pct).
          indices = {
            iron_oxide: 0, clay: 0, gossan: 0, ferric_iron: 0, propylitic: 0,
            argillic: 0, silica: 0, malachite: 0, sphalerite: 0, carbonate: 0, galena: 0,
          };
        }

        let rawScore = 0;
        for (const key in weights) rawScore += (indices as any)[key] * (weights as any)[key];

        candidates.push({
          id: `${lat}-${lng}`,
          rank: 0,
          lat,
          lng,
          indices,
          base_score: rawScore * 100,
          data_source: pointDataSource,
          utm_zone,
          epsg,
        });
      }
    }
  }

  // Sort by base_score DESC
  candidates.sort((a, b) => b.base_score - a.base_score);
  
  // Select Top N
  const topPoints = candidates.slice(0, targetCount);
  topPoints.forEach((p, idx) => p.rank = idx + 1);

  return { success: true, top_points: topPoints, area_ha: areaHa, all_points: candidates, grid_size: {latStep, lngStep}, weights_used: weights };
}

// =============================================================================
// ETAPA B — Enriquecimiento con datos REALES medidos de ASTER/EMIT
// =============================================================================
// Cuando el análisis profundo aporta celdas ASTER/EMIT con cobertura, llenamos
// los índices de alteración OBSERVABLES con la medición real (donde antes había 0
// por falta de proxy Sentinel-2). Los sulfuros puros (malachite/sphalerite/galena)
// y la sílice NO tienen medición mineral-específica en estos productos → quedan en 0.
// Normalización idéntica a la de ConsensusFusion (mismas constantes) para consistencia.

/** Índice destino → proxy real medible por ASTER/EMIT. */
const DEEP_ENRICHABLE_KEYS = ['carbonate', 'propylitic', 'argillic', 'ferric_iron'] as const;

/**
 * Enriquece los SpectralIndices de un punto con ASTER/EMIT reales. Devuelve los
 * índices resultantes y las claves que recibieron dato real (solo si SUBEN la señal,
 * nunca reducen un valor S2 real existente). Si no hay celda, devuelve sin cambios.
 */
export function enrichIndicesWithDeepData(
  indices: SpectralIndices,
  asterCell: AsterSpectralCell | null | undefined,
  emitCell: EmitSpectralCell | null | undefined
): { indices: SpectralIndices; enriched: string[] } {
  if (!asterCell && !emitCell) return { indices, enriched: [] };
  const c01 = (v: number) => Math.max(0, Math.min(1, v));
  const out: SpectralIndices = { ...indices };
  const enriched: string[] = [];
  // Reúne valores reales normalizados (0-1) por índice destino.
  const real: Record<string, number[]> = {};
  const add = (key: string, v: number | null | undefined) => {
    if (v == null || !Number.isFinite(v)) return;
    (real[key] ||= []).push(c01(v));
  };
  if (emitCell) {
    add('ferric_iron', (emitCell.ferric_emit    - 1.0) / 2.0); // ratio ~1-3
    add('argillic',     emitCell.al_clay_emit    / 0.3);        // band depth
    add('propylitic',   emitCell.mg_clay_emit    / 0.3);        // band depth
    add('carbonate',   (emitCell.carbonate_emit  - 1.0) / 1.5); // ratio
  }
  if (asterCell) {
    if (asterCell.iron_oxide_aster != null) add('ferric_iron', (asterCell.iron_oxide_aster - 1.0) / 2.0);
    if (asterCell.ferroso_aster    != null) add('ferric_iron', (asterCell.ferroso_aster    - 1.0) / 1.5);
    if (asterCell.alunite_bd       != null) add('argillic',     asterCell.alunite_bd / 0.3);
    if (asterCell.chlorite_bd      != null) add('propylitic',   asterCell.chlorite_bd / 0.3);
  }
  for (const key of DEEP_ENRICHABLE_KEYS) {
    const vals = real[key];
    if (!vals || !vals.length) continue;
    // Promedio de proxies reales disponibles (conservador, no exagera).
    const measured = vals.reduce((a, b) => a + b, 0) / vals.length;
    const current = (out as any)[key] ?? 0;
    // Mejor evidencia real: solo sube, nunca reduce una señal S2 real.
    if (measured > current) {
      (out as any)[key] = measured;
      enriched.push(key);
    }
  }
  return { indices: out, enriched };
}

/** Score 0-100 a partir de índices y pesos por metal (suma ponderada). */
export function scoreFromIndices(indices: SpectralIndices, weights: Record<string, number>): number {
  let s = 0;
  for (const k in weights) s += ((indices as any)[k] || 0) * (weights as any)[k];
  return Math.max(0, Math.min(100, s * 100));
}

/**
 * Enriquece en sitio una lista de puntos con ASTER/EMIT reales y recomputa su
 * base_score con los pesos del metal. Solo afecta a los puntos cuya celda más
 * cercana aporta dato real. Idempotente (usa el máximo). Devuelve la misma lista.
 */
export function enrichPointsWithDeepData<T extends { lat: number; lng: number; indices: SpectralIndices; base_score: number; enriched_indices?: string[] }>(
  points: T[],
  asterCells: AsterSpectralCell[] | null | undefined,
  emitCells: EmitSpectralCell[] | null | undefined,
  weights: Record<string, number>
): T[] {
  const aCells = asterCells && asterCells.length ? asterCells : null;
  const eCells = emitCells && emitCells.length ? emitCells : null;
  if (!aCells && !eCells) return points;
  for (const p of points) {
    if (!p || !p.indices) continue;
    const aCell = aCells ? (findNearestCell(p.lat, p.lng, aCells as any) as any) : null;
    const eCell = eCells ? (findNearestCell(p.lat, p.lng, eCells as any) as any) : null;
    const { indices, enriched } = enrichIndicesWithDeepData(p.indices, aCell, eCell);
    if (enriched.length) {
      p.indices = indices;
      p.enriched_indices = Array.from(new Set([...(p.enriched_indices || []), ...enriched]));
      p.base_score = scoreFromIndices(indices, weights);
    }
  }
  return points;
}

// =============================================================================
// TWO-DIMENSION SCORING SYSTEM
// =============================================================================

// Normalización HEURÍSTICA (no es un techo físico calibrado): convierte el score
// crudo 0–1 a porcentaje relativo. Metales sin entrada (zinc, plomo) usan un neutral 50.
export const SCORE_MAXIMO_GLOBAL: Record<string, Record<string, number>> = {
  oro:    { sierra: 92, playa: 78 },
  plata:  { sierra: 71, playa: 45 },
  cobre:  { sierra: 88, playa: 40 },
  tierras_raras:  { sierra: 85, playa: 30 },
  hierro: { sierra: 95, playa: 70 },
};

export interface MetalScore {
  metal: string;
  label: string;
  icon: string;
  score_maximo: number;
  score_poligono: number;
  score_percent: number;
  detected: 'high' | 'medium' | 'low';
  guideMineral: string[];
  satellite: string;
  bands: string[];
  warning?: string;
  /** % del modelo del metal que depende de índices SIN proxy real en Sentinel-2 */
  synthetic_weight_pct?: number;
  /** true si el metal no es medible con Sentinel-2 (requiere ASTER/EMIT). El score
   *  mostrado sería engañoso, así que la UI debe mostrar "Requiere ASTER/EMIT". */
  requires_deep?: boolean;
}

/** Umbral de dependencia sintética por encima del cual un metal se marca como
 *  requires_deep (no medible honestamente con Sentinel-2). Constante tuneable. */
export const SYNTHETIC_REQUIRES_DEEP_THRESHOLD = 0.5;

/**
 * Config de ADQUISICIÓN por metal y terreno: qué satélite, qué bandas y qué
 * minerales guía buscar en campo.
 *
 * NO lleva `label` ni `icon` A PROPÓSITO. Los llevaba, y ganaban sobre el
 * catálogo (`cfg?.label ?? cat?.label`): por eso `tierras_raras` seguía
 * pintándose como "⚡ Litio" mucho después de que el litio saliera del catálogo.
 * El nombre y el ícono de un material tienen UNA sola fuente —
 * MATERIALS_CATALOG— y se leen con `getMaterial()`. Nunca al revés.
 */
interface MetalConfigEntry {
  satellite: string;
  bands: string[];
  guideMineral: string[];
  warning?: string;
}

const METAL_CONFIG: Record<string, Record<string, MetalConfigEntry>> = {
  oro: {
    sierra: { satellite: 'LANDSAT8',  bands: ['IRON_OXIDE', 'CLAY_MINERALS', 'NDVI'],          guideMineral: ['Pirita', 'Cuarzo', 'Gossan'] },
    playa:  { satellite: 'SENTINEL2', bands: ['SWIR_MINERAL', 'FALSE_COLOR'],                  guideMineral: ['Arena negra', 'Magnetita', 'Placer'] },
  },
  plata: {
    sierra: { satellite: 'ASTER',     bands: ['ASTER_ALUNITE', 'CLAY_MINERALS'],               guideMineral: ['Galena', 'Cerusita', 'Clorita'] },
    playa:  { satellite: 'SENTINEL2', bands: ['FALSE_COLOR', 'SWIR_MINERAL'],                  guideMineral: ['Calcita', 'Galena detrítica'],          warning: 'Baja probabilidad en costas planas' },
  },
  cobre: {
    sierra: { satellite: 'ASTER',     bands: ['FERROUS_IRON', 'ASTER_CHLORITE', 'IRON_OXIDE'], guideMineral: ['Malaquita', 'Azurita', 'Calcopirita'] },
    playa:  { satellite: 'SENTINEL2', bands: ['IRON_OXIDE', 'NDVI'],                           guideMineral: ['Calcopirita residual'],                 warning: 'Muy baja probabilidad en playas' },
  },
  // Minerales guía de TIERRAS RARAS (bastnäsita/monacita/xenotima). Antes decían
  // espodumena/petalita/lepidolita — menas de LITIO: el mismo fantasma, en los datos.
  tierras_raras: {
    sierra: { satellite: 'EMIT',      bands: ['EMIT_AL_CLAY', 'EMIT_MG_CLAY'],                 guideMineral: ['Bastnäsita', 'Monacita', 'Xenotima'] },
    playa:  { satellite: 'EMIT',      bands: ['EMIT_AL_CLAY'],                                 guideMineral: ['Monacita detrítica', 'Xenotima'],       warning: 'Solo en placeres de arenas pesadas' },
  },
  hierro: {
    sierra: { satellite: 'SENTINEL2', bands: ['IRON_OXIDE', 'FERROUS_IRON', 'FALSE_COLOR'],    guideMineral: ['Magnetita', 'Hematita', 'Limonita'] },
    playa:  { satellite: 'LANDSAT8',  bands: ['IRON_OXIDE', 'FALSE_COLOR'],                    guideMineral: ['Arena ferrosa', 'Magnetita placer'] },
  },
  // Id del catálogo. Antes esta config vivía bajo las claves heredadas `zinc` y
  // `plomo`, que ya nadie consulta: el panel pedía `plomo_zinc` y se quedaba sin
  // satélite, sin bandas y —lo grave— sin el aviso de "sulfuro sin firma óptica".
  plomo_zinc: {
    sierra: { satellite: 'ASTER',     bands: ['ASTER_CALCITE', 'EMIT_CARBONATE', 'IRON_OXIDE'], guideMineral: ['Galena', 'Esfalerita', 'Smithsonita'], warning: 'Sulfuro sin firma óptica directa — requiere ASTER/EMIT' },
    playa:  { satellite: 'ASTER',     bands: ['ASTER_CALCITE'],                                 guideMineral: ['Galena detrítica', 'Esfalerita'],      warning: 'Sulfuro sin firma óptica directa — requiere ASTER/EMIT' },
  },
  manganeso: {
    sierra: { satellite: 'SENTINEL2', bands: ['IRON_OXIDE', 'FERROUS_IRON'],                   guideMineral: ['Pirolusita', 'Psilomelana', 'Rodocrosita'], warning: 'Firma parecida a la de los óxidos de hierro — no son separables por óptico' },
    playa:  { satellite: 'SENTINEL2', bands: ['IRON_OXIDE'],                                   guideMineral: ['Pirolusita detrítica'],                warning: 'Firma parecida a la de los óxidos de hierro — no son separables por óptico' },
  },
};

/** Config de adquisición del metal, aceptando ids heredados (zinc/plomo/litio). */
function metalConfig(metal: string, terrainKey: string): MetalConfigEntry | undefined {
  return METAL_CONFIG[metal]?.[terrainKey] ?? METAL_CONFIG[normalizeMaterialId(metal)]?.[terrainKey];
}

// ── Point Score (map tap) ─────────────────────────────────────────────────────

// Reproducible seeded random: same lat+lng+offset → same value always
function seededRandom(lat: number, lng: number, offset: number): number {
  const x = Math.abs(Math.sin(lat * 9301 + lng * 49297 + offset * 233) * 233280);
  return x - Math.floor(x);
}

// Per-metal base offset so each metal gets independent index values
const METAL_SEED_BASE: Record<string, number> = {
  oro: 10, plata: 20, cobre: 30, tierras_raras: 40, hierro: 50,
};

export interface GeologicalIndicator {
  label: string;
  status: 'confirmed' | 'partial' | 'absent';
}

/**
 * @deprecated LEGACY — SIN USO. Genera scores con seededRandom (pseudo-aleatorio),
 * NO son medición real. No conectar a la UI: usa computeAllMetalScores (datos S2
 * reales). Se conserva solo como referencia histórica.
 */
export function computePointScore(
  lat: number,
  lng: number,
  terrain: string,
): { scores: MetalScore[]; indicators: GeologicalIndicator[] } {
  const terrainKey = terrain === 'playa' ? 'playa' : 'sierra';
  // Lista de metales del scoring. 'litio' se retiró del catálogo (lo sustituyó
  // Tierras raras); mantenerlo aquí generaba una tarjeta LITIO fantasma.
  const metals = ['oro', 'plata', 'cobre', 'tierras_raras', 'hierro'];

  const scores: MetalScore[] = metals.map(metal => {
    const scoreMax = SCORE_MAXIMO_GLOBAL[metal]?.[terrainKey] ?? 100;
    const cfg      = metalConfig(metal, terrainKey);
    const cat      = getMaterial(metal);
    const base     = METAL_SEED_BASE[metal] ?? 0;

    const ironOxide  = seededRandom(lat, lng, base + 1);
    const argillic   = seededRandom(lat, lng, base + 2);
    const thermal    = seededRandom(lat, lng, base + 3);
    const regional   = seededRandom(lat, lng, base + 4);
    const historical = seededRandom(lat, lng, base + 5);

    const raw        = ironOxide * 0.30 + argillic * 0.25 + thermal * 0.20
                     + regional * 0.15 + historical * 0.10;
    const pointScore = Math.round(Math.min(scoreMax, raw * scoreMax));
    const pct        = Math.round((pointScore / scoreMax) * 100);
    const detected: 'high' | 'medium' | 'low' =
      pct >= 65 ? 'high' : pct >= 45 ? 'medium' : 'low';

    return {
      metal,
      // Nombre e ícono SIEMPRE desde el catálogo (fuente única).
      label:          cat?.label       ?? metal,
      icon:           cat?.icon        ?? '⛏️',
      score_maximo:   scoreMax,
      score_poligono: pointScore,
      score_percent:  pct,
      detected,
      guideMineral:   cfg?.guideMineral ?? [],
      satellite:      cfg?.satellite    ?? 'SENTINEL2',
      bands:          cfg?.bands        ?? [],
      warning:        cfg?.warning,
    };
  }).sort((a, b) => b.score_percent - a.score_percent);

  // Geological indicators (common baseline, not per-metal)
  const classify = (v: number): 'confirmed' | 'partial' | 'absent' =>
    v > 0.60 ? 'confirmed' : v > 0.35 ? 'partial' : 'absent';

  const indicators: GeologicalIndicator[] = [
    { label: 'Óxidos de hierro (GOSSAN)',  status: classify(seededRandom(lat, lng, 1)) },
    { label: 'Alteración argílica',         status: classify(seededRandom(lat, lng, 2)) },
    { label: 'Silicificación / Cuarzo',     status: classify(seededRandom(lat, lng, 6)) },
    { label: 'Anomalía térmica',            status: classify(seededRandom(lat, lng, 3)) },
  ];

  return { scores, indicators };
}

/**
 * Score por metal a partir de los ÍNDICES ESPECTRALES REALES de los puntos
 * analizados (las mismas celdas Sentinel-2 que alimentan el ranking), aplicando
 * METAL_WEIGHTS. "Otros metales" = mismo patrón espectral REAL, distinta ponderación.
 * Ya NO usa generateIndices (pseudo-aleatorio): los índices sin proxy directo de S2
 * (SYNTHETIC_INDEX_KEYS) valen 0, así que los metales que dependen de ellos salen
 * bajos y se marcan `requires_deep` para que la UI muestre "Requiere ASTER/EMIT".
 */
export function computeAllMetalScores(points: AnalysisPoint[], terrain: string): MetalScore[] {
  if (!points || points.length === 0) return [];

  // Promedio de los índices REALES sobre los puntos analizados (0–1).
  const keys = Object.keys(points[0].indices) as (keyof SpectralIndices)[];
  const avg: Record<string, number> = {};
  for (const k of keys) avg[k as string] = 0;
  for (const p of points) for (const k of keys) avg[k as string] += (p.indices as any)[k] || 0;
  for (const k of keys) avg[k as string] /= points.length;

  // Índices sintéticos que recibieron dato REAL de ASTER/EMIT (Etapa B) en algún
  // punto: dejan de contar como "sintético/faltante" para la etiqueta requires_deep.
  const enrichedKeys = new Set<string>();
  for (const p of points) for (const k of (p.enriched_indices || [])) enrichedKeys.add(k);

  const terrainKey = terrain === 'playa' ? 'playa' : 'sierra';
  // Panel "otros metales": los 7 metálicos del catálogo (misma señal espectral
  // real, distinta ponderación). El resto de familias (ornamental, construcción…)
  // no compiten aquí — su comparación no aporta al usuario.
  const metals = ['oro', 'plata', 'cobre', 'hierro', 'plomo_zinc', 'manganeso', 'tierras_raras'];

  return metals.map(metal => {
    const weights = METAL_WEIGHTS[metal] || {};
    const cfg     = metalConfig(metal, terrainKey);
    const cat     = getMaterial(metal);
    const scoreMax = SCORE_MAXIMO_GLOBAL[metal]?.[terrainKey] ?? 50;

    // Score crudo 0–1 = Σ(índice_real · peso). Los índices sintéticos valen 0.
    let raw = 0;
    for (const k in weights) raw += (avg[k] ?? 0) * weights[k];

    // Fracción del modelo del metal en índices SIN proxy real de S2, EXCLUYENDO los
    // que ASTER/EMIT ya enriqueció (Etapa B): p.ej. el carbonato del zinc medido por
    // EMIT deja de contar como sintético, y el metal puede dejar de exigir profundo.
    let synthW = 0;
    for (const k of SYNTHETIC_INDEX_KEYS) {
      if (enrichedKeys.has(k)) continue; // ya tiene dato real medido → no es sintético
      synthW += (weights as any)[k] || 0;
    }
    const synthetic_weight_pct = Math.round(synthW * 100);
    const requires_deep = synthW > SYNTHETIC_REQUIRES_DEEP_THRESHOLD;
    const warning = requires_deep
      ? 'No medible con Sentinel-2 — requiere ASTER/EMIT'
      : synthetic_weight_pct > 0
        ? `${synthetic_weight_pct}% del modelo sin proxy óptico directo`
        : cfg?.warning;

    const score_poligono = Math.round(Math.min(scoreMax, raw * scoreMax));
    const score_percent  = Math.round((score_poligono / scoreMax) * 100);
    const detected: 'high' | 'medium' | 'low' =
      score_percent >= 70 ? 'high' : score_percent >= 40 ? 'medium' : 'low';

    return {
      metal,
      // Nombre e ícono SIEMPRE desde el catálogo (fuente única).
      label: cat?.label ?? metal,
      icon: cat?.icon ?? '⛏️',
      score_maximo: scoreMax,
      score_poligono,
      score_percent,
      detected,
      guideMineral: cfg?.guideMineral ?? [],
      satellite: cfg?.satellite ?? 'SENTINEL2',
      bands: cfg?.bands ?? [],
      warning,
      synthetic_weight_pct,
      requires_deep,
    };
  }).sort((a, b) => b.score_percent - a.score_percent);
}

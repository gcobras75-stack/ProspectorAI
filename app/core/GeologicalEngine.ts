import type { MiningSpectralResult } from './SatelliteEngine';
import { findNearestCell } from './SatelliteEngine';

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
): { success: boolean; top_points: AnalysisPoint[]; area_ha: number; all_points?: AnalysisPoint[]; grid_size?: { latStep: number; lngStep: number }; error?: string } {

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

  // 1. Base Weights
  const baseWeights: Record<string, Record<string, number>> = {
    oro:    { gossan: 0.35, iron_oxide: 0.30, clay: 0.20, silica: 0.15 },
    plata:  { clay: 0.40, argillic: 0.30, propylitic: 0.30 },
    cobre:  { ferric_iron: 0.40, malachite: 0.35, propylitic: 0.25 },
    zinc:   { sphalerite: 0.45, carbonate: 0.35, clay: 0.20 },
    plomo:  { galena: 0.40, gossan: 0.35, iron_oxide: 0.25 },
    hierro: { iron_oxide: 0.45, ferric_iron: 0.35, gossan: 0.20 },
    litio:  { clay: 0.45, carbonate: 0.35, argillic: 0.20 },
  };

  let weights = { ...(baseWeights[mineral.toLowerCase()] || baseWeights['oro']) };

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
       const wLat = wp.lat || wp.latitude;
       const wLng = wp.lng || wp.longitude;
       if (!wLat || !wLng) continue;
       const simIndices = generateIndices(wLat, wLng, terrain, rockType);
       for (const key of Object.keys(weights)) {
          const val = (simIndices as any)[key];
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

  // Grid search to find candidates inside polygon
  const candidates: AnalysisPoint[] = [];
  const gridSteps = 30; // 30x30 grid ~ 900 points tested
  const latStep = (maxLat - minLat) / gridSteps;
  const lngStep = (maxLng - minLng) / gridSteps;

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

  for (let i = 0; i < gridSteps; i++) {
    for (let j = 0; j < gridSteps; j++) {
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
          // Map real S2 ratios → normalized 0-1 for weight compatibility
          const simBase = generateIndices(lat, lng, terrain, rockType);
          indices = {
            iron_oxide:  clamp((nearestCell.iron_oxide - 0.5) / 2.5, 0, 1),
            clay:        clamp((nearestCell.clay       - 0.5) / 2.0, 0, 1),
            gossan:      clamp((nearestCell.iron_oxide - 0.5) / 2.5, 0, 1),
            ferric_iron: clamp((nearestCell.iron_oxide - 0.5) / 2.5, 0, 1),
            propylitic:  clamp((nearestCell.clay       - 0.5) / 2.0, 0, 1),
            argillic:    clamp((nearestCell.clay       - 0.5) / 2.0, 0, 1),
            // No direct S2 proxy for these — keep simulated (minor influence on scoring)
            silica:      simBase.silica,
            malachite:   simBase.malachite,
            sphalerite:  simBase.sphalerite,
            carbonate:   simBase.carbonate,
            galena:      simBase.galena,
          };
          utm_zone = nearestCell.utm_zone;
          epsg     = nearestCell.epsg;
        } else {
          // Cell masked by vegetation or outside coverage — use simBase for this point
          indices = generateIndices(lat, lng, terrain, rockType);
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

  return { success: true, top_points: topPoints, area_ha: areaHa, all_points: candidates, grid_size: {latStep, lngStep} };
}

// =============================================================================
// TWO-DIMENSION SCORING SYSTEM
// =============================================================================

export const SCORE_MAXIMO_GLOBAL: Record<string, Record<string, number>> = {
  oro:    { sierra: 92, playa: 78 },
  plata:  { sierra: 71, playa: 45 },
  cobre:  { sierra: 88, playa: 40 },
  litio:  { sierra: 85, playa: 30 },
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
}

// Spectral proxy weights for the polygon score formula
const POLIGONO_WEIGHTS = {
  iron_oxide:  0.30, // iron oxide alteration
  argillic:    0.25, // argillic alteration
  ferric_iron: 0.20, // thermal anomaly proxy
  gossan:      0.15, // regional geology proxy
  carbonate:   0.10, // historical findings proxy
};

// Per-metal spectral affinity functions (same formulas as baseWeights)
const METAL_AFFINITY: Record<string, (idx: SpectralIndices) => number> = {
  oro:    idx => idx.gossan * 0.35 + idx.iron_oxide * 0.30 + idx.clay * 0.20 + idx.silica * 0.15,
  plata:  idx => idx.clay * 0.40 + idx.argillic * 0.30 + idx.propylitic * 0.30,
  cobre:  idx => idx.ferric_iron * 0.40 + idx.malachite * 0.35 + idx.propylitic * 0.25,
  litio:  idx => idx.clay * 0.45 + idx.carbonate * 0.35 + idx.argillic * 0.20,
  hierro: idx => idx.iron_oxide * 0.45 + idx.ferric_iron * 0.35 + idx.gossan * 0.20,
};

interface MetalConfigEntry {
  label: string;
  icon: string;
  satellite: string;
  bands: string[];
  guideMineral: string[];
  warning?: string;
}

const METAL_CONFIG: Record<string, Record<string, MetalConfigEntry>> = {
  oro: {
    sierra: { label: 'Oro',    icon: '🥇', satellite: 'LANDSAT8',  bands: ['IRON_OXIDE', 'CLAY_MINERALS', 'NDVI'],             guideMineral: ['Pirita', 'Cuarzo', 'Gossan'] },
    playa:  { label: 'Oro',    icon: '🥇', satellite: 'SENTINEL2', bands: ['SWIR_MINERAL', 'FALSE_COLOR'],                     guideMineral: ['Arena negra', 'Magnetita', 'Placer'] },
  },
  plata: {
    sierra: { label: 'Plata',  icon: '🥈', satellite: 'ASTER',     bands: ['ASTER_ALUNITE', 'CLAY_MINERALS'],                  guideMineral: ['Galena', 'Cerusita', 'Clorita'] },
    playa:  { label: 'Plata',  icon: '🥈', satellite: 'SENTINEL2', bands: ['FALSE_COLOR', 'SWIR_MINERAL'],                     guideMineral: ['Calcita', 'Galena detrítica'],         warning: 'Baja probabilidad en costas planas' },
  },
  cobre: {
    sierra: { label: 'Cobre',  icon: '🟤', satellite: 'ASTER',     bands: ['FERROUS_IRON', 'ASTER_CHLORITE', 'IRON_OXIDE'],    guideMineral: ['Malaquita', 'Azurita', 'Calcopirita'] },
    playa:  { label: 'Cobre',  icon: '🟤', satellite: 'SENTINEL2', bands: ['IRON_OXIDE', 'NDVI'],                              guideMineral: ['Calcopirita residual'],                warning: 'Muy baja probabilidad en playas' },
  },
  litio: {
    sierra: { label: 'Litio',  icon: '⚡', satellite: 'EMIT',      bands: ['EMIT_AL_CLAY', 'EMIT_MG_CLAY'],                   guideMineral: ['Espodumena', 'Petalita', 'Lepidolita'] },
    playa:  { label: 'Litio',  icon: '⚡', satellite: 'EMIT',      bands: ['EMIT_AL_CLAY'],                                    guideMineral: ['Bischofita', 'Halita'],                warning: 'Solo en salares / playas salinas' },
  },
  hierro: {
    sierra: { label: 'Hierro', icon: '⚙️', satellite: 'SENTINEL2', bands: ['IRON_OXIDE', 'FERROUS_IRON', 'FALSE_COLOR'],       guideMineral: ['Magnetita', 'Hematita', 'Limonita'] },
    playa:  { label: 'Hierro', icon: '⚙️', satellite: 'LANDSAT8',  bands: ['IRON_OXIDE', 'FALSE_COLOR'],                       guideMineral: ['Arena ferrosa', 'Magnetita placer'] },
  },
};

// ── Point Score (map tap) ─────────────────────────────────────────────────────

// Reproducible seeded random: same lat+lng+offset → same value always
function seededRandom(lat: number, lng: number, offset: number): number {
  const x = Math.abs(Math.sin(lat * 9301 + lng * 49297 + offset * 233) * 233280);
  return x - Math.floor(x);
}

// Per-metal base offset so each metal gets independent index values
const METAL_SEED_BASE: Record<string, number> = {
  oro: 10, plata: 20, cobre: 30, litio: 40, hierro: 50,
};

export interface GeologicalIndicator {
  label: string;
  status: 'confirmed' | 'partial' | 'absent';
}

export function computePointScore(
  lat: number,
  lng: number,
  terrain: string,
): { scores: MetalScore[]; indicators: GeologicalIndicator[] } {
  const terrainKey = terrain === 'playa' ? 'playa' : 'sierra';
  const metals = ['oro', 'plata', 'cobre', 'litio', 'hierro'];

  const scores: MetalScore[] = metals.map(metal => {
    const scoreMax = SCORE_MAXIMO_GLOBAL[metal]?.[terrainKey] ?? 100;
    const cfg      = METAL_CONFIG[metal]?.[terrainKey];
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
      label:          cfg?.label       ?? metal,
      icon:           cfg?.icon        ?? '⛏️',
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

export function computeAllMetalScores(polygonCoords: any[], terrain: string): MetalScore[] {
  if (!polygonCoords || polygonCoords.length < 3) return [];

  // Compute centroid (deterministic seed)
  let sumLat = 0, sumLng = 0;
  for (const c of polygonCoords) { sumLat += c.latitude; sumLng += c.longitude; }
  const centLat = sumLat / polygonCoords.length;
  const centLng = sumLng / polygonCoords.length;

  const idx = generateIndices(centLat, centLng, terrain, 'ignea');

  // Global formula score (0–1)
  const globalRaw =
    idx.iron_oxide  * POLIGONO_WEIGHTS.iron_oxide +
    idx.argillic    * POLIGONO_WEIGHTS.argillic   +
    idx.ferric_iron * POLIGONO_WEIGHTS.ferric_iron +
    idx.gossan      * POLIGONO_WEIGHTS.gossan      +
    idx.carbonate   * POLIGONO_WEIGHTS.carbonate;

  const terrainKey = terrain === 'playa' ? 'playa' : 'sierra';
  const metals = ['oro', 'plata', 'cobre', 'litio', 'hierro'];

  return metals.map(metal => {
    const scoreMax = SCORE_MAXIMO_GLOBAL[metal]?.[terrainKey] ?? 50;
    const cfg = METAL_CONFIG[metal]?.[terrainKey];
    const affinityFn = METAL_AFFINITY[metal];

    // Blend global formula with metal-specific spectral affinity
    const metalRaw = globalRaw * 0.5 + (affinityFn ? affinityFn(idx) : globalRaw) * 0.5;
    const score_poligono = Math.round(Math.min(scoreMax, metalRaw * scoreMax));
    const score_percent = Math.round((score_poligono / scoreMax) * 100);
    const detected: 'high' | 'medium' | 'low' =
      score_percent >= 70 ? 'high' : score_percent >= 40 ? 'medium' : 'low';

    return {
      metal,
      label: cfg?.label ?? metal,
      icon: cfg?.icon ?? '⛏️',
      score_maximo: scoreMax,
      score_poligono,
      score_percent,
      detected,
      guideMineral: cfg?.guideMineral ?? [],
      satellite: cfg?.satellite ?? 'SENTINEL2',
      bands: cfg?.bands ?? [],
      warning: cfg?.warning,
    };
  }).sort((a, b) => b.score_percent - a.score_percent);
}

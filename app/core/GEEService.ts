/**
 * GEEService.ts
 * Service layer for Google Earth Engine REST API via local backend proxy.
 * All requests route through EXPO_PUBLIC_SERVER_URL to avoid CORS and key exposure.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BandIndex =
  | 'TRUE_COLOR'
  | 'FALSE_COLOR'
  | 'NDVI'
  | 'SWIR_MINERAL'
  | 'IRON_OXIDE'
  | 'CLAY_MINERALS'
  | 'FERROUS_IRON'
  // EMIT hyperspectral
  | 'EMIT_AL_CLAY'
  | 'EMIT_MG_CLAY'
  | 'EMIT_CARBONATE'
  | 'EMIT_FERRIC';

export type GEEDataset = 'SENTINEL2' | 'LANDSAT8' | 'LANDSAT9' | 'EMIT';

/** EMIT indices require dataset=EMIT; multispectral indices require Sentinel/Landsat */
export const EMIT_BAND_IDS: BandIndex[] = ['EMIT_AL_CLAY', 'EMIT_MG_CLAY', 'EMIT_CARBONATE', 'EMIT_FERRIC'];
export const MULTISPECTRAL_BAND_IDS: BandIndex[] = ['TRUE_COLOR', 'FALSE_COLOR', 'NDVI', 'SWIR_MINERAL', 'IRON_OXIDE', 'CLAY_MINERALS', 'FERROUS_IRON'];

export interface BandConfig {
  id: BandIndex;
  label: string;
  shortLabel: string;
  description: string;
  mineralUse: string;
  icon: string; // MaterialCommunityIcons name
  gradientColors: string[];
  gradientLabels: string[];
}

export interface GEETileConfig {
  tileUrl: string; // URL template with {z}/{x}/{y}
  mapId: string;
  legend: { color: string; label: string }[];
  bandDescription: string;
  mineralApplication: string;
  acquisitionDate: string;
  cloudCover: number;
  expiresAt: number;
}

export interface GEEPixelValues {
  bandValues: Record<string, number>;
  computedIndex: number;
}

// ---------------------------------------------------------------------------
// Band configurations — descriptions in Spanish, focused on mineral prospecting
// ---------------------------------------------------------------------------

export const BAND_CONFIGS: Record<BandIndex, BandConfig> = {
  TRUE_COLOR: {
    id: 'TRUE_COLOR',
    label: 'Color Verdadero',
    shortLabel: 'RGB',
    description:
      'Composición RGB estándar (Rojo-Verde-Azul). Representa la superficie tal como la vería el ojo humano desde el espacio.',
    mineralUse:
      'Referencia visual de base. Útil para identificar afloramientos rocosos, vegetación escasa y zonas de alteración superficial visibles.',
    icon: 'eye-outline',
    gradientColors: ['#1A6B1A', '#7EC850', '#D4C27A', '#A0785A', '#6B3A2A'],
    gradientLabels: ['Vegetación densa', 'Vegetación dispersa', 'Suelo desnudo', 'Roca expuesta', 'Alteración visible'],
  },
  FALSE_COLOR: {
    id: 'FALSE_COLOR',
    label: 'Falso Color (IRC)',
    shortLabel: 'IRC',
    description:
      'Infrarrojo cercano (NIR) combinado con Rojo y Verde. Las áreas con vegetación sana aparecen en rojo intenso; los minerales y rocas en tonos azul-cian.',
    mineralUse:
      'Discriminación rápida entre cobertura vegetal y afloramientos rocosos. Zonas sin cobertura con tonos fríos sugieren litología desnuda prospectable.',
    icon: 'layers',
    gradientColors: ['#FF0000', '#FF8800', '#FFFF00', '#00CCFF', '#0000FF'],
    gradientLabels: ['Vegetación vigorosa', 'Vegetación escasa', 'Suelo húmedo', 'Roca sedimentaria', 'Roca ígnea/metamórfica'],
  },
  NDVI: {
    id: 'NDVI',
    label: 'NDVI — Índice Vegetal',
    shortLabel: 'NDVI',
    description:
      'Índice de Diferencia Normalizada de Vegetación (NIR-Rojo)/(NIR+Rojo). Valores altos = vegetación sana. Valores bajos o negativos = roca, suelo, agua.',
    mineralUse:
      'Zonas de NDVI anómalosamente bajo en áreas donde debería haber vegetación pueden indicar suelos tóxicos por mineralización (halo geoquímico). Delimita afloramientos.',
    icon: 'leaf',
    gradientColors: ['#8B0000', '#FF4400', '#FFDD00', '#88DD00', '#006600'],
    gradientLabels: ['Sin vegetación (-1 a 0)', 'Muy escasa (0–0.1)', 'Moderada (0.1–0.3)', 'Densa (0.3–0.6)', 'Muy densa (0.6–1)'],
  },
  SWIR_MINERAL: {
    id: 'SWIR_MINERAL',
    label: 'SWIR Mineralización',
    shortLabel: 'SWIR',
    description:
      'Bandas del Infrarrojo de Onda Corta (SWIR1 + SWIR2). Penetra cobertura vegetal ligera y es sensible a minerales arcillosos, hidrotermales y sulfuros.',
    mineralUse:
      'Detección de zonas de alteración hidrotermal, arcillas propilíticas y serícitas. Fundamental en exploración de pórfidos de cobre, epitermal de oro y plata.',
    icon: 'terrain',
    gradientColors: ['#000033', '#003366', '#006699', '#00AACC', '#FFEEAA'],
    gradientLabels: ['Sin respuesta SWIR', 'Respuesta baja', 'Alteración moderada', 'Alteración intensa', 'Mineralización activa'],
  },
  IRON_OXIDE: {
    id: 'IRON_OXIDE',
    label: 'Óxidos de Hierro',
    shortLabel: 'Fe-Ox',
    description:
      'Cociente de bandas Rojo/Azul (o Rojo/SWIR según sensor). Sensible a minerales de Fe: goethita, limonita, hematita y jarosita que tiñen la roca de pardo-rojizo.',
    mineralUse:
      'Mapeo de gossan (sombrero de hierro), halos de oxidación de sulfuros masivos, zonas de lixiviación. Guía directa a depósitos de oro, plata, cobre y polimetálicos.',
    icon: 'magnet',
    gradientColors: ['#1A1A1A', '#4A2000', '#993300', '#FF6600', '#FFD700'],
    gradientLabels: ['Sin óxidos', 'Trazas Fe', 'Limonita', 'Goethita/Hematita', 'Gossan intenso'],
  },
  CLAY_MINERALS: {
    id: 'CLAY_MINERALS',
    label: 'Minerales Arcillosos',
    shortLabel: 'Arcillas',
    description:
      'Cociente SWIR2/SWIR1 optimizado para respuesta de alunita, caolinita, illita y muscovita. Resalta zonas de alteración argílica y serícita.',
    mineralUse:
      'Identificación de halos de alteración argílica avanzada (ALS) y propilítica alrededor de centros hidrotermales. Clave en sistemas epitermales y pórfidos.',
    icon: 'layers',
    gradientColors: ['#1A0D00', '#4D3319', '#997755', '#CCBB88', '#FFEEDD'],
    gradientLabels: ['Sin arcillas', 'Arcillas traza', 'Arcillas moderadas', 'Arcillas abundantes', 'Alteración argílica intensa'],
  },
  FERROUS_IRON: {
    id: 'FERROUS_IRON',
    label: 'Hierro Ferroso (Fe²⁺)',
    shortLabel: 'Fe²⁺',
    description:
      'Cociente NIR/SWIR1. Sensible al hierro ferroso en silicatos máficos como olivino, piroxeno y anfíbol. Distingue ferrous de férrico.',
    mineralUse:
      'Mapeo de rocas máficas y ultramáficas (fuentes de Ni, Co, Cr, PGE). Delimita intrusivos básicos y zonas de serpentinización con potencial para minerales estratégicos.',
    icon: 'water',
    gradientColors: ['#000022', '#001144', '#003388', '#2266CC', '#88AAFF'],
    gradientLabels: ['Sin Fe²⁺', 'Fe²⁺ traza', 'Fe²⁺ moderado', 'Rocas máficas', 'Ultramáficas/Serpentinita'],
  },

  // ── EMIT hyperspectral (NASA/ISS · 285 bandas · 60 m) ─────────────────────
  EMIT_AL_CLAY: {
    id: 'EMIT_AL_CLAY',
    label: 'EMIT — Arcillas Al-OH',
    shortLabel: 'Al-OH',
    description:
      'Profundidad de banda a 2200 nm. Detecta absorción de Al-OH en caolinita, alunita, moscovita y pirofilita con resolución espectral de 7 nm.',
    mineralUse:
      'Guía a epitermales de alta sulfidación (Au-Ag) y halos de alteración argílica avanzada (ALS) en pórfidos de Cu. 60 m · ISS · 2022–presente.',
    icon: 'grain',
    gradientColors: ['#1A0A00', '#4D2500', '#996633', '#DDAA44', '#FFFFCC'],
    gradientLabels: ['Sin Al-OH', 'Trazas caolinita', 'Caolinita moderada', 'Caolinita/Alunita', 'Alt. argílica (ALS)'],
  },
  EMIT_MG_CLAY: {
    id: 'EMIT_MG_CLAY',
    label: 'EMIT — Arcillas Mg-OH',
    shortLabel: 'Mg-OH',
    description:
      'Profundidad de banda a 2300 nm. Detecta absorción de Mg-OH en clorita, serpentina, talco y tremolita.',
    mineralUse:
      'Indica alteración propilítica en pórfidos Cu-Mo y rocas ultramáficas con potencial de Ni, Cr, Co y PGE. 60 m · ISS · 2022–presente.',
    icon: 'water',
    gradientColors: ['#001A00', '#00331A', '#006633', '#00AA55', '#AAFFCC'],
    gradientLabels: ['Sin Mg-OH', 'Trazas clorita', 'Clorita moderada', 'Clorita/Serpentina', 'Alt. propilítica'],
  },
  EMIT_CARBONATE: {
    id: 'EMIT_CARBONATE',
    label: 'EMIT — Carbonatos',
    shortLabel: 'CO₃',
    description:
      'Profundidad de banda a 2350 nm. Detecta la absorción CO₃²⁻ de calcita, dolomita y magnesita.',
    mineralUse:
      'Clave para skarns (Fe, Cu, Au, W), carbonatitas (REE, Nb) y carbonatización hidrotermal en epitermales. 60 m · ISS · 2022–presente.',
    icon: 'layers-outline',
    gradientColors: ['#00001A', '#001144', '#003388', '#3366CC', '#AACCFF'],
    gradientLabels: ['Sin carbonatos', 'Trazas calcita', 'Carbonatos mod.', 'Carbonatización', 'Skarn/Carbonatita'],
  },
  EMIT_FERRIC: {
    id: 'EMIT_FERRIC',
    label: 'EMIT — Fe³⁺ Hiperespectral',
    shortLabel: 'Fe³⁺',
    description:
      'Profundidad de banda a 870 nm (campo cristalino Fe³⁺). Mayor sensibilidad que Sentinel-2 para hematita, goethita y jarosita.',
    mineralUse:
      'Localiza gossanes y halos de oxidación sobre depósitos de sulfuros (Cu, Au, Ag, Zn) con precisión subpixel. 60 m · ISS · 2022–presente.',
    icon: 'fire',
    gradientColors: ['#1A0000', '#550000', '#AA2200', '#FF5500', '#FFCC00'],
    gradientLabels: ['Sin Fe³⁺', 'Fe³⁺ traza', 'Goethita/Limonita', 'Hematita abundante', 'Gossan intenso'],
  },
};

// ---------------------------------------------------------------------------
// Dataset metadata
// ---------------------------------------------------------------------------

export const DATASET_LABELS: Record<
  GEEDataset,
  { label: string; resolution: string; revisit: string }
> = {
  SENTINEL2: {
    label: 'Sentinel-2',
    resolution: '10 m',
    revisit: '5 días',
  },
  LANDSAT8: {
    label: 'Landsat 8',
    resolution: '30 m',
    revisit: '16 días',
  },
  LANDSAT9: {
    label: 'Landsat 9',
    resolution: '30 m',
    revisit: '16 días',
  },
  EMIT: {
    label: 'EMIT Hiperespectral',
    resolution: '60 m',
    revisit: 'ISS',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getServerUrl(): string {
  const url = process.env.EXPO_PUBLIC_SERVER_URL;
  if (!url) {
    throw new Error(
      'EXPO_PUBLIC_SERVER_URL no está configurada. Verifica tu archivo .env'
    );
  }
  return url.replace(/\/$/, ''); // strip trailing slash
}

function buildQueryString(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

async function geeGet<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const base = getServerUrl();
  const qs = buildQueryString(params);
  const url = `${base}${path}?${qs}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch (networkErr: any) {
    throw new Error(
      `No se pudo conectar al servidor proxy GEE (${base}). ` +
        `Verifica que el servidor esté corriendo. Detalle: ${networkErr.message}`
    );
  }

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.error || body?.message || JSON.stringify(body);
    } catch {
      detail = await response.text().catch(() => '');
    }
    throw new Error(
      `Error del servidor GEE [${response.status}]: ${detail || response.statusText}`
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new Error('Respuesta inválida del servidor GEE: no es JSON válido.');
  }
}

// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

/**
 * Fetches a tile configuration (mapId + tileUrl template) from the backend proxy.
 * The backend is responsible for authenticating with GEE and returning a signed
 * tile URL template in the format:  https://.../{z}/{x}/{y}
 */
export async function getGEETileConfig(
  lat: number,
  lng: number,
  index: BandIndex,
  dataset: GEEDataset,
  dateStart: string,
  dateEnd: string,
  maxCloud: number
): Promise<GEETileConfig> {
  const data = await geeGet<GEETileConfig>('/api/gee/tiles', {
    lat,
    lng,
    index,
    dataset,
    dateStart,
    dateEnd,
    maxCloud,
  });

  if (!data.tileUrl) {
    throw new Error(
      'El servidor no retornó una URL de tiles válida. ' +
        'Verifica la configuración del backend GEE.'
    );
  }

  return data;
}

/**
 * Fetches pixel-level spectral values at the given coordinate.
 * Useful for point sampling and spectral signature analysis.
 */
export async function getGEEPixelValues(
  lat: number,
  lng: number,
  index: BandIndex,
  dataset: GEEDataset,
  dateStart: string,
  dateEnd: string
): Promise<GEEPixelValues> {
  const data = await geeGet<GEEPixelValues>('/api/gee/pixels', {
    lat,
    lng,
    index,
    dataset,
    dateStart,
    dateEnd,
  });

  if (data.computedIndex === undefined || data.computedIndex === null) {
    throw new Error('El servidor no retornó valores de píxel válidos para esta zona y fecha.');
  }

  return data;
}

/**
 * Returns a dynamic date range ending today.
 * daysBack=30  → Sentinel-2, Landsat 8/9 (5-16 day revisit, 30 days guarantees recent data)
 * daysBack=180 → EMIT (sparse ISS targeting, 6 months ensures scene availability)
 */
export function getDefaultDateRange(daysBack = 30): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - daysBack);
  const fmt = (d: Date): string => d.toISOString().split('T')[0];
  return { start: fmt(start), end: fmt(end) };
}

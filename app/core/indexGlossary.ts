// Glosario honesto de índices espectrales usados en ProspectorAI.
// s2_real = true  → derivado de Sentinel-2 (medición satelital real).
// s2_real = false → SIN proxy directo en Sentinel-2; requiere ASTER/EMIT.
//
// Las definiciones son geología de exploración estándar (alteración hidrotermal),
// redactadas en lenguaje claro. No afirman presencia de yacimiento, solo
// "compatibilidad" con procesos de alteración.

export interface IndexInfo {
  key: string;
  label: string;     // nombre legible
  formula?: string;  // proxy / relación de bandas (informativo)
  short: string;     // una línea
  detail: string;    // explicación honesta
  s2_real: boolean;  // hay proxy directo en Sentinel-2
}

export const INDEX_GLOSSARY: Record<string, IndexInfo> = {
  iron_oxide: {
    key: 'iron_oxide', label: 'Óxido de hierro', formula: 'Sentinel-2 B4/B2', s2_real: true,
    short: 'Hierro oxidado en superficie.',
    detail: 'Relación de bandas roja/azul de Sentinel-2. Resalta minerales de hierro oxidado (hematita, goethita). Valores altos pueden indicar gossan o suelos férricos, frecuentes sobre sulfuros oxidados.',
  },
  gossan: {
    key: 'gossan', label: 'Gossan (sombrero de hierro)', formula: 'Sentinel-2 B4/B2', s2_real: true,
    short: 'Oxidación de sulfuros en superficie.',
    detail: 'Capa de óxidos de hierro que se forma cuando los sulfuros (pirita, etc.) se oxidan en superficie. Es una guía clásica de posible mineralización oculta debajo.',
  },
  clay: {
    key: 'clay', label: 'Arcillas (SWIR)', formula: 'Sentinel-2 B11/B12', s2_real: true,
    short: 'Arcillas de alteración hidrotermal.',
    detail: 'Relación de bandas SWIR que resalta minerales de arcilla (caolinita, illita) generados por alteración hidrotermal. Marca zonas donde fluidos calientes alteraron la roca.',
  },
  ferric_iron: {
    key: 'ferric_iron', label: 'Hierro férrico (Fe³⁺)', formula: 'derivado Sentinel-2', s2_real: true,
    short: 'Hierro en estado oxidado.',
    detail: 'Señal de hierro férrico (Fe³⁺). Acompaña a gossans y zonas de oxidación; refuerza la presencia de óxidos de hierro.',
  },
  propylitic: {
    key: 'propylitic', label: 'Alteración propilítica', formula: 'derivado Sentinel-2', s2_real: true,
    short: 'Halo externo de sistemas hidrotermales.',
    detail: 'Asociación clorita-epidota-calcita. Forma el halo externo de los sistemas de pórfido; indica la periferia de un sistema hidrotermal.',
  },
  argillic: {
    key: 'argillic', label: 'Alteración argílica', formula: 'derivado Sentinel-2', s2_real: true,
    short: 'Arcillas por alteración ácida.',
    detail: 'Arcillas (caolinita, esmectita) producidas por alteración ácida. Zona intermedia de sistemas epitermales y pórfidos.',
  },
  silica: {
    key: 'silica', label: 'Sílice / Cuarzo', formula: 'ASTER (térmico)', s2_real: false,
    short: 'Silicificación — requiere ASTER.',
    detail: 'Silicificación (cuarzo). No tiene proxy directo en Sentinel-2; se mide con bandas térmicas de ASTER o con EMIT.',
  },
  malachite: {
    key: 'malachite', label: 'Malaquita (Cu)', formula: 'ASTER / EMIT', s2_real: false,
    short: 'Carbonato de cobre — requiere ASTER/EMIT.',
    detail: 'Carbonato de cobre verde, mena oxidada de cobre. No es medible directo por Sentinel-2; se infiere por la alteración asociada vía ASTER/EMIT.',
  },
  sphalerite: {
    key: 'sphalerite', label: 'Esfalerita (Zn)', formula: 'ASTER / EMIT (carbonato)', s2_real: false,
    short: 'Sulfuro de Zn — sin firma óptica.',
    detail: 'Sulfuro de zinc. Los sulfuros no tienen firma óptica propia; se infieren por el carbonato encajonante (calcita) vía ASTER/EMIT.',
  },
  carbonate: {
    key: 'carbonate', label: 'Carbonato', formula: 'ASTER CALCITE / EMIT', s2_real: false,
    short: 'Calcita/dolomita — requiere ASTER/EMIT.',
    detail: 'Calcita/dolomita. Roca encajonante típica de depósitos Zn-Pb (skarn, CRD). Proxy real disponible vía ASTER (calcita) o EMIT, no por Sentinel-2.',
  },
  galena: {
    key: 'galena', label: 'Galena (Pb)', formula: 'ASTER / EMIT (gossan)', s2_real: false,
    short: 'Sulfuro de Pb — sin firma óptica.',
    detail: 'Sulfuro de plomo. Sin firma óptica propia; se infiere por el gossan asociado a su oxidación.',
  },
};

// Índices con proxy REAL en Sentinel-2 (los que se muestran como "medidos").
export const S2_REAL_INDEX_KEYS = [
  'iron_oxide', 'gossan', 'clay', 'ferric_iron', 'propylitic', 'argillic',
] as const;

// Índices SIN dato directo en Sentinel-2 (requieren ASTER/EMIT).
export const NON_S2_INDEX_KEYS = [
  'silica', 'malachite', 'sphalerite', 'carbonate', 'galena',
] as const;

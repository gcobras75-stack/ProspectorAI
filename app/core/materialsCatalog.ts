/**
 * materialsCatalog.ts — CATÁLOGO ÚNICO de materiales analizables (Fase 1).
 *
 * Fuente de verdad única que reemplaza las listas dispersas e inconsistentes
 * (ConfigModal chips, TAP_METAL_META, METAL_WEIGHTS, SCORE_MAXIMO_GLOBAL).
 *
 * Cada material pertenece a:
 *   • una FAMILIA de detección  → define su receta espectral (pesos sobre los
 *     índices reales que YA calcula el proxy GEE) y el marco geológico para la IA.
 *   • una CATEGORÍA de UI       → solo agrupa visualmente en el selector.
 *
 * HONESTIDAD (regla de la casa): `confidenceBase` es la detectabilidad INTRÍNSECA
 * del material vía satélite. La confianza REAL que se muestra en resultados es
 * min(confidenceBase, cobertura_real) — un material "Media" baja a "De contexto"
 * donde no hay dato medido (índices sintéticos sin ASTER/EMIT). Ver
 * resolveDisplayConfidence().
 *
 * Módulo hoja: no importa nada del motor para evitar ciclos. Los pesos usan las
 * mismas claves string que SpectralIndices (GeologicalEngine).
 */

export type MaterialConfidence = 'alta' | 'media' | 'contexto';

export type MaterialFamily =
  | 'metalicos_alteracion'
  | 'oxidos_fe'
  | 'carbonatos'
  | 'sulfatos'
  | 'silice_arcillas'
  | 'volcanicos'
  | 'aluvial';

export type MaterialCategory =
  | 'metalicos'
  | 'industriales'
  | 'ornamental'
  | 'construccion'
  | 'especiales';

export interface MaterialEntry {
  id: string;                 // id estable persistido en DB/AsyncStorage
  label: string;              // nombre legible (mayúscula inicial)
  icon: string;               // emoji
  category: MaterialCategory; // agrupación de UI
  family: MaterialFamily;     // receta de detección
  confidenceBase: MaterialConfidence;
  /** Pesos sobre los índices espectrales reales (claves de SpectralIndices). */
  weights: Record<string, number>;
}

/**
 * Materiales cuya detección mejora con el índice de sílice térmico
 * (POST /api/mining/thermal-grid, emisividad ASTER GED).
 *
 * Solo estos disparan la ruta y solo estos pueden SUBIR de "De contexto" a "Media".
 * La condición es `quality_ok` del servidor: exige cobertura Y roca expuesta. Sobre
 * vegetación la emisividad es plana y tapa la firma del cuarzo, así que ahí no se
 * sube nada — se mide vegetación, no roca.
 */
export const THERMAL_MATERIALS = ['silice', 'granito', 'cantera', 'pomez'] as const;

export function isThermalMaterial(id: string | null | undefined): boolean {
  const norm = normalizeMaterialId(id);
  return (THERMAL_MATERIALS as readonly string[]).includes(norm);
}

/** Mensaje honesto cuando el térmico corrió pero no es concluyente. */
export const THERMAL_VEG_NOTE =
  'La vegetación tapa la firma térmica del cuarzo — el índice de sílice no es concluyente aquí.';

// ─── Metadata de familias (marco geológico para la IA) ───────────────────────

export interface FamilyMeta {
  label: string;
  /** Marco metalogenético/geológico que se inyecta en los prompts para que la
   *  interpretación se adapte al material (no hablar de "alteración de oro" si
   *  buscas mármol). */
  aiFrame: string;
  /** Palabra para el objetivo del punto ("alteración" vs "señal"). */
  signalWord: string;
}

export const FAMILIES: Record<MaterialFamily, FamilyMeta> = {
  metalicos_alteracion: {
    label: 'Metálicos por alteración',
    signalWord: 'alteración hidrotermal',
    aiFrame:
      'sistemas hidrotermales metálicos (epitermal Au-Ag, pórfido Cu-Mo, skarn, ' +
      'vetas polimetálicas). Interpreta óxidos de hierro, arcillas y alteración ' +
      'como halos de posible mineralización metálica.',
  },
  oxidos_fe: {
    label: 'Óxidos de fierro',
    signalWord: 'concentración de óxidos de hierro',
    aiFrame:
      'concentraciones de óxidos de hierro (hematita, magnetita, goethita). Para ' +
      'bancos de jales, depósitos antropogénicos de residuos mineros con geometría ' +
      'artificial. NO lo interpretes como alteración hidrotermal de metales preciosos.',
  },
  carbonatos: {
    label: 'Carbonatos',
    signalWord: 'firma de carbonato',
    aiFrame:
      'rocas carbonatadas (caliza, mármol, dolomía, ónix). Interpreta las firmas de ' +
      'carbonato como roca de plataforma sedimentaria o metamórfica y evalúa su ' +
      'aptitud como roca ornamental/industrial. NO hables de alteración hidrotermal ni de oro.',
  },
  sulfatos: {
    label: 'Sulfatos',
    signalWord: 'firma de sulfato',
    aiFrame:
      'evaporitas y sulfatos (yeso, anhidrita, barita). Interprétalos como depósitos ' +
      'sedimentarios/evaporíticos. NO uses el marco de metales preciosos ni de alteración hidrotermal.',
  },
  silice_arcillas: {
    label: 'Sílice / Arcillas',
    signalWord: 'firma de sílice/arcilla',
    aiFrame:
      'materias primas industriales: sílice (cuarzo, arena silícea), caolín y arcillas. ' +
      'Interprétalas como recurso industrial no metálico. La sílice pura se detecta por su ' +
      'firma térmica (reststrahlen del cuarzo, 8-9.5 µm): si el análisis trae índice de ' +
      'sílice medido, úsalo; si viene marcado como no concluyente por vegetación, dilo.',
  },
  volcanicos: {
    label: 'Volcánicos / contexto',
    signalWord: 'contexto litológico',
    aiFrame:
      'rocas volcánicas y piroclásticas (piedra pómez, laja, cantera/toba). Interpreta ' +
      'por contexto litológico y morfología del terreno, NO por una firma espectral única.',
  },
  aluvial: {
    label: 'Aluvial / geomorfología',
    signalWord: 'contexto geomorfológico',
    aiFrame:
      'depósitos aluviales y de placer (agregados de río, placeres de oro). Interpreta ' +
      'por geomorfología fluvial (paleocauces, drenaje), NO por firma mineral directa. ' +
      'El oro de placer NO es visible desde satélite: solo se infiere el ambiente favorable.',
  },
};

// ─── Metadata de categorías (agrupación de UI) ───────────────────────────────

// El ORDEN importa: ProspectorAI es una app de minerales. Metálicos primero y
// siempre arriba; Especiales (jales, placeres) es minería también, así que va
// segundo. El resto detrás, y colapsadas por defecto en el selector.
export const CATEGORIES: { id: MaterialCategory; label: string; icon: string }[] = [
  { id: 'metalicos',    label: 'Metálicos',          icon: '⛏️' },
  { id: 'especiales',   label: 'Especiales',         icon: '⚗️' },
  { id: 'industriales', label: 'Industriales',       icon: '🏭' },
  { id: 'ornamental',   label: 'Piedra ornamental',  icon: '💎' },
  { id: 'construccion', label: 'Construcción',       icon: '🧱' },
];

/** Categorías abiertas al abrir el selector. Las demás arrancan colapsadas. */
export const CATEGORIES_EXPANDED_BY_DEFAULT: MaterialCategory[] = ['metalicos', 'especiales'];

// ─── Catálogo (22 materiales) ────────────────────────────────────────────────

export const MATERIALS_CATALOG: MaterialEntry[] = [
  // ── Metálicos ──────────────────────────────────────────────────────────────
  { id: 'oro',           label: 'Oro',            icon: '🥇', category: 'metalicos',    family: 'metalicos_alteracion', confidenceBase: 'media',
    weights: { gossan: 0.35, iron_oxide: 0.30, clay: 0.20, silica: 0.15 } },
  { id: 'plata',         label: 'Plata',          icon: '🥈', category: 'metalicos',    family: 'metalicos_alteracion', confidenceBase: 'media',
    weights: { clay: 0.40, argillic: 0.30, propylitic: 0.30 } },
  { id: 'cobre',         label: 'Cobre',          icon: '🟤', category: 'metalicos',    family: 'metalicos_alteracion', confidenceBase: 'media',
    weights: { ferric_iron: 0.40, malachite: 0.35, propylitic: 0.25 } },
  { id: 'hierro',        label: 'Fierro',         icon: '⚙️', category: 'metalicos',    family: 'oxidos_fe',            confidenceBase: 'alta',
    weights: { iron_oxide: 0.45, ferric_iron: 0.35, gossan: 0.20 } },
  { id: 'plomo_zinc',    label: 'Plomo-Zinc',     icon: '🔩', category: 'metalicos',    family: 'metalicos_alteracion', confidenceBase: 'media',
    weights: { carbonate: 0.30, sphalerite: 0.25, galena: 0.20, gossan: 0.15, iron_oxide: 0.10 } },
  { id: 'manganeso',     label: 'Manganeso',      icon: '🧲', category: 'metalicos',    family: 'metalicos_alteracion', confidenceBase: 'contexto',
    weights: { iron_oxide: 0.45, ferric_iron: 0.35, clay: 0.20 } },
  { id: 'tierras_raras', label: 'Tierras raras',  icon: '🧪', category: 'metalicos',    family: 'metalicos_alteracion', confidenceBase: 'media',
    weights: { clay: 0.30, argillic: 0.30, iron_oxide: 0.20, silica: 0.20 } },

  // ── Industriales ─────────────────────────────────────────────────────────────
  { id: 'fluorita',      label: 'Fluorita',       icon: '💠', category: 'industriales', family: 'metalicos_alteracion', confidenceBase: 'contexto',
    weights: { clay: 0.40, argillic: 0.30, iron_oxide: 0.30 } },
  { id: 'barita',        label: 'Barita',         icon: '⚪', category: 'industriales', family: 'sulfatos',             confidenceBase: 'contexto',
    weights: { carbonate: 0.40, clay: 0.30, iron_oxide: 0.30 } },
  { id: 'yeso',          label: 'Yeso',           icon: '🤍', category: 'industriales', family: 'sulfatos',             confidenceBase: 'media',
    weights: { clay: 0.40, argillic: 0.35, carbonate: 0.25 } },
  { id: 'silice',        label: 'Sílice',         icon: '🪟', category: 'industriales', family: 'silice_arcillas',      confidenceBase: 'contexto',
    weights: { silica: 1.0 } },
  { id: 'arcillas_caolin', label: 'Arcillas / Caolín', icon: '🏺', category: 'industriales', family: 'silice_arcillas', confidenceBase: 'alta',
    weights: { clay: 0.45, argillic: 0.40, iron_oxide: 0.15 } },

  // ── Piedra ornamental ────────────────────────────────────────────────────────
  { id: 'marmol',        label: 'Mármol',         icon: '🏛️', category: 'ornamental',   family: 'carbonatos',          confidenceBase: 'media',
    weights: { carbonate: 1.0 } },
  { id: 'onix',          label: 'Ónix',           icon: '🖤', category: 'ornamental',   family: 'carbonatos',          confidenceBase: 'contexto',
    weights: { carbonate: 1.0 } },
  { id: 'cantera',       label: 'Cantera',        icon: '🧱', category: 'ornamental',   family: 'volcanicos',          confidenceBase: 'contexto',
    weights: { silica: 0.50, iron_oxide: 0.25, clay: 0.25 } },
  { id: 'granito',       label: 'Granito',        icon: '🪨', category: 'ornamental',   family: 'silice_arcillas',     confidenceBase: 'contexto',
    weights: { silica: 0.60, iron_oxide: 0.20, clay: 0.20 } },
  { id: 'laja',          label: 'Laja',           icon: '🪧', category: 'ornamental',   family: 'volcanicos',          confidenceBase: 'contexto',
    weights: { iron_oxide: 0.34, clay: 0.33, ferric_iron: 0.33 } },

  // ── Construcción ─────────────────────────────────────────────────────────────
  { id: 'caliza',        label: 'Caliza',         icon: '🧱', category: 'construccion', family: 'carbonatos',          confidenceBase: 'media',
    weights: { carbonate: 1.0 } },
  { id: 'agregados',     label: 'Agregados pétreos', icon: '🚧', category: 'construccion', family: 'aluvial',          confidenceBase: 'contexto',
    weights: { iron_oxide: 0.34, clay: 0.33, ferric_iron: 0.33 } },
  { id: 'pomez',         label: 'Piedra pómez',   icon: '🫧', category: 'construccion', family: 'volcanicos',          confidenceBase: 'contexto',
    weights: { iron_oxide: 0.34, clay: 0.33, ferric_iron: 0.33 } },

  // ── Especiales ───────────────────────────────────────────────────────────────
  { id: 'bancos_jales',  label: 'Bancos de jales', icon: '♻️', category: 'especiales',  family: 'oxidos_fe',           confidenceBase: 'alta',
    weights: { iron_oxide: 0.50, ferric_iron: 0.30, gossan: 0.20 } },
  { id: 'placeres',      label: 'Placeres de río', icon: '🌊', category: 'especiales',  family: 'aluvial',             confidenceBase: 'contexto',
    weights: { iron_oxide: 0.40, gossan: 0.35, ferric_iron: 0.25 } },
];

// ─── Índice por id + helpers ──────────────────────────────────────────────────

const BY_ID: Record<string, MaterialEntry> = Object.fromEntries(
  MATERIALS_CATALOG.map(m => [m.id, m])
);

/** Mapea ids heredados (selector viejo) a ids del catálogo nuevo. */
export function normalizeMaterialId(id: string | null | undefined): string {
  const v = (id ?? '').toLowerCase().trim();
  switch (v) {
    case 'zinc':
    case 'plomo':
      return 'plomo_zinc';
    case 'litio':          // el slot de litio-en-arcillas pasó a Tierras raras
      return 'tierras_raras';
    default:
      return BY_ID[v] ? v : 'oro'; // desconocido → oro (default histórico)
  }
}

export function getMaterial(id: string | null | undefined): MaterialEntry | undefined {
  return BY_ID[normalizeMaterialId(id)];
}

export function materialLabel(id: string | null | undefined): string {
  return getMaterial(id)?.label ?? (id ?? '').toString();
}

export function materialIcon(id: string | null | undefined): string {
  return getMaterial(id)?.icon ?? '⛏️';
}

/** Marco geológico de la familia del material, para inyectar en prompts de IA. */
export function materialAiFrame(id: string | null | undefined): FamilyMeta {
  const fam = getMaterial(id)?.family ?? 'metalicos_alteracion';
  return FAMILIES[fam];
}

/** Pesos espectrales de todos los materiales, para fusionar en METAL_WEIGHTS. */
export const CATALOG_WEIGHTS: Record<string, Record<string, number>> = Object.fromEntries(
  MATERIALS_CATALOG.map(m => [m.id, m.weights])
);

// ─── Etiquetas de confianza ───────────────────────────────────────────────────

export const CONFIDENCE_META: Record<MaterialConfidence, { label: string; color: string }> = {
  alta:     { label: 'Alta',        color: '#4CAF50' },
  media:    { label: 'Media',       color: '#FFA000' },
  contexto: { label: 'De contexto', color: '#78909C' },
};

/**
 * Etiqueta para el SELECTOR (confianza intrínseca, antes de medir nada).
 *
 * Ya no dice "(mejora en camino)": la mejora llegó (índice de sílice térmico). Para
 * los materiales térmicos se anuncia la condición REAL bajo la que suben, en vez de
 * prometer una mejora futura indefinida.
 */
export function selectorConfidence(
  entry: MaterialEntry,
): { label: string; color: string; hint?: string } {
  const base = CONFIDENCE_META[entry.confidenceBase];
  // El badge lleva SOLO el nivel. La explicación viaja aparte (`hint`) y se pinta en
  // una línea secundaria: metida en el badge, su ancho empujaba el NOMBRE del material
  // fuera de la tarjeta y no se sabía qué material era.
  if (entry.confidenceBase === 'contexto' && isThermalMaterial(entry.id)) {
    return { color: base.color, label: base.label, hint: 'sube a Media con roca expuesta' };
  }
  return { color: base.color, label: base.label };
}

/**
 * Confianza REAL para RESULTADOS = min(intrínseca, cobertura medida).
 * Si el modelo del material depende de índices sin dato real (requires_deep /
 * alta fracción sintética no enriquecida por ASTER/EMIT), baja a "De contexto".
 */
export function resolveDisplayConfidence(
  id: string | null | undefined,
  opts?: {
    requiresDeep?: boolean;
    syntheticWeightPct?: number;
    /** Gate del índice de sílice térmico, cuando la ruta se disparó para este material. */
    thermal?: { quality_ok: boolean; rock_pct?: number } | null;
  },
): { level: MaterialConfidence; label: string; color: string; note?: string } {
  const entry = getMaterial(id);
  let level: MaterialConfidence = entry?.confidenceBase ?? 'contexto';
  let note: string | undefined;

  const synthPct = opts?.syntheticWeightPct ?? 0;
  // min() con la cobertura real: sin dato medido, no se puede prometer Alta/Media.
  if (opts?.requiresDeep || synthPct >= 50) {
    if (level !== 'contexto') {
      level = 'contexto';
      note = 'sin dato medido en esta zona (requiere ASTER/EMIT)';
    }
  } else if (synthPct > 0 && level === 'alta') {
    level = 'media';
    note = `${synthPct}% del modelo sin proxy óptico directo`;
  }

  // ── Índice de sílice térmico: la ÚNICA vía por la que un material sube de nivel.
  // Sigue siendo min(): la confianza no supera a la evidencia que la sostiene. Con
  // quality_ok el térmico ES evidencia medida sobre roca, así que sílice/granito/
  // cantera/pómez pasan de "De contexto" a "Media". Sin quality_ok (típicamente por
  // vegetación) no hay evidencia, y se quedan donde estaban con el motivo honesto.
  if (opts?.thermal && isThermalMaterial(id)) {
    if (opts.thermal.quality_ok) {
      if (level === 'contexto') {
        level = 'media';
        const pct = opts.thermal.rock_pct;
        note = pct != null
          ? `índice de sílice medido sobre roca expuesta (${pct}% de la zona)`
          : 'índice de sílice medido sobre roca expuesta';
      }
    } else {
      level = 'contexto';
      note = THERMAL_VEG_NOTE;
    }
  }

  const meta = CONFIDENCE_META[level];
  return { level, label: meta.label, color: meta.color, note };
}

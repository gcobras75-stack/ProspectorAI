/**
 * lithologyService.ts — propone el TIPO DE ROCA a partir de la ubicación.
 *
 * POR QUÉ EXISTE
 * Configuración pedía "tipo de roca" al usuario: justo el dato que un prospector
 * típicamente NO sabe. Se le pedía a ciegas y se usaba en el motor y en los prompts.
 * Ahora se propone a partir de la carta geológica y el usuario solo corrige si quiere.
 *
 * ARQUITECTURA — pensada para cambiar de fuente sin tocar nada más
 * Todo consumidor llama a `proposeRockType(lat, lng)` y recibe un `RockProposal`.
 * La fuente concreta vive detrás de `SOURCES`, una cadena de proveedores que se
 * prueban en orden. Hoy: Macrostrat (global, gratuita) → GLiM (global, fallback).
 * Cuando entre el SGM (Etapa 3, cartas mexicanas 1:50 000), basta con anteponer un
 * proveedor nuevo a esa lista: la UI, el motor y los prompts no se enteran.
 *
 * HONESTIDAD (regla de la casa)
 * Una carta REGIONAL no es verdad de campo. La propuesta viaja siempre con su
 * `source` y su `confidence`, y el Ing. Villegas recibe explícitamente si la roca
 * viene de la carta o la puso el usuario, para que module su certeza. Si no hay
 * cobertura o la red falla, NO se inventa nada: se devuelve null y el campo se queda
 * manual, como hasta hoy.
 */

/** Las tres categorías internas que ya entienden el motor y los prompts. */
export type RockType = 'ignea' | 'sedimentaria' | 'metamorfica';

export type RockSource = 'macrostrat' | 'glim' | 'sgm' | 'usuario' | 'default';

export interface RockProposal {
  rock_type: RockType;
  source: RockSource;
  /** Nombre de la unidad tal como la nombra la carta (para mostrar y para la IA). */
  unit_name?: string;
  /** Litología cruda de la fuente, sin traducir. Se guarda para poder auditar el mapeo. */
  raw_lithology?: string;
  /** 'alta' solo si la fuente da una litología explícita; 'media' si se infirió. */
  confidence: 'alta' | 'media';
}

// ─── Mapeo litología → categoría interna ─────────────────────────────────────
//
// Las cartas hablan de litologías concretas (granito, caliza, esquisto…); el motor
// solo distingue tres familias. Este es el diccionario, y está aquí a propósito: es
// la pieza que habrá que revisar cuando entre el SGM, no el resto del código.
//
//   ÍGNEA        → cristalizada de magma: intrusivas (granito, diorita, gabro) y
//                  volcánicas (basalto, riolita, andesita, toba, ignimbrita).
//   SEDIMENTARIA → depositada en capas: caliza, arenisca, lutita, conglomerado,
//                  evaporitas, y los depósitos no consolidados (aluvión, dunas).
//   METAMÓRFICA  → transformada por presión/temperatura: esquisto, gneis, mármol,
//                  cuarcita, pizarra, skarn.
//
// El orden importa: se busca la primera coincidencia, así que los términos más
// específicos van antes que los genéricos.
const LITHOLOGY_MAP: Array<{ re: RegExp; rock: RockType }> = [
  // Metamórficas — antes que ígneas/sedimentarias porque "mármol" contiene "carbon-"
  // en algunas descripciones y "cuarcita" podría confundirse con arenisca.
  { re: /schist|gneiss|marble|quartzite|slate|phyllite|amphibolite|migmatite|granulite|eclogite|skarn|metamorph|esquisto|gneis|m[áa]rmol|cuarcita|pizarra|metam[óo]rfic/i, rock: 'metamorfica' },

  // Ígneas — intrusivas y volcánicas
  { re: /granit|granodiorit|diorit|gabbro|tonalit|syenit|peridotit|pegmatit|basalt|andesit|rhyolit|dacit|tuff|ignimbrit|volcanic|lava|pyroclastic|obsidian|igneous|plutonic|intrusive|extrusive|granito|diorita|basalto|riolita|andesita|toba|ignimbrita|volc[áa]nic|[íi]gne/i, rock: 'ignea' },

  // Sedimentarias — incluye no consolidados (aluvión, dunas, gravas)
  { re: /limestone|dolomit|sandstone|shale|mudstone|siltstone|conglomerat|breccia|chert|marl|gypsum|anhydrite|evaporit|coal|chalk|sediment|alluvi|colluvi|fluvial|eolian|dune|sand|gravel|clay|silt|caliza|dolom[íi]a|arenisca|lutita|limolita|conglomerado|yeso|evaporita|aluvi[óo]n|sedimentar/i, rock: 'sedimentaria' },
];

/** Traduce una litología cruda a nuestras 3 categorías. null si no la reconoce. */
export function mapLithology(raw: string | null | undefined): RockType | null {
  if (!raw) return null;
  for (const { re, rock } of LITHOLOGY_MAP) {
    if (re.test(raw)) return rock;
  }
  return null;
}

// ─── Caché en memoria, por celda de ~0.05° (~5 km) ───────────────────────────
// La litología no cambia entre dos puntos vecinos, y no queremos una llamada de red
// por cada render ni por cada vértice movido.
const cache = new Map<string, RockProposal | null>();
const cacheKey = (lat: number, lng: number) => `${lat.toFixed(2)}_${lng.toFixed(2)}`;

function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// ─── Proveedores ─────────────────────────────────────────────────────────────

/** Macrostrat: mapa geológico global, gratuito, sin API key. */
async function fromMacrostrat(lat: number, lng: number): Promise<RockProposal | null> {
  const url = `https://macrostrat.org/api/v2/geologic_units/map?lat=${lat}&lng=${lng}`;
  const res = await fetchWithTimeout(url, 12000);
  if (!res.ok) throw new Error(`Macrostrat ${res.status}`);
  const json = await res.json();
  const unit = json?.success?.data?.[0];
  if (!unit) return null;   // sin cobertura: NO se inventa nada

  // Macrostrat trae la litología en `lith` (texto libre) y a veces en `name`/`descrip`.
  const raw = [unit.lith, unit.name, unit.descrip].filter(Boolean).join(' — ');
  const rock = mapLithology(raw);
  if (!rock) return null;   // litología no reconocida: mejor manual que adivinar

  return {
    rock_type: rock,
    source: 'macrostrat',
    unit_name: unit.name || unit.strat_name || undefined,
    raw_lithology: unit.lith || undefined,
    // 'alta' solo si la fuente dio litología explícita; si se dedujo del nombre, 'media'.
    confidence: unit.lith ? 'alta' : 'media',
  };
}

/**
 * GLiM (Global Lithological Map) vía Macrostrat, como red de seguridad.
 * Cubre zonas donde el mapa geológico detallado no llega — a cambio de menos detalle,
 * de ahí que su confianza sea siempre 'media'.
 */
async function fromGlim(lat: number, lng: number): Promise<RockProposal | null> {
  const url = `https://macrostrat.org/api/v2/mobile/map_query_v2?lat=${lat}&lng=${lng}&z=10`;
  const res = await fetchWithTimeout(url, 12000);
  if (!res.ok) throw new Error(`GLiM ${res.status}`);
  const json = await res.json();
  const d = json?.success?.data;
  const raw = [d?.lith, d?.name, d?.map_unit_name].filter(Boolean).join(' — ');
  const rock = mapLithology(raw);
  if (!rock) return null;

  return {
    rock_type: rock,
    source: 'glim',
    unit_name: d?.name || d?.map_unit_name || undefined,
    raw_lithology: d?.lith || undefined,
    confidence: 'media',
  };
}

// Orden de preferencia. Cuando entre el SGM (cartas 1:50 000), va DELANTE de estos.
const SOURCES: Array<(lat: number, lng: number) => Promise<RockProposal | null>> = [
  fromMacrostrat,
  fromGlim,
];

/**
 * Propone el tipo de roca del punto. Devuelve null si ninguna fuente sabe o si no hay
 * red: en ese caso el campo se queda manual y no se bloquea nada.
 */
export async function proposeRockType(lat: number, lng: number): Promise<RockProposal | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const key = cacheKey(lat, lng);
  if (cache.has(key)) return cache.get(key) ?? null;

  for (const source of SOURCES) {
    try {
      const proposal = await source(lat, lng);
      if (proposal) {
        cache.set(key, proposal);
        return proposal;
      }
    } catch (e: any) {
      // Una fuente caída no debe tumbar la cadena: se prueba la siguiente.
      console.warn('[lithology] fuente falló:', e?.message);
    }
  }

  // Ninguna fuente supo. Se cachea el "no sé" para no reintentar en bucle sobre la
  // misma zona; el usuario elige a mano, como siempre.
  cache.set(key, null);
  return null;
}

/** Centroide de un polígono. Suficiente para consultar una carta a escala regional. */
export function centroidOf(coords: Array<{ latitude: number; longitude: number }>): { lat: number; lng: number } | null {
  if (!coords || coords.length === 0) return null;
  let sLat = 0, sLng = 0;
  for (const c of coords) { sLat += c.latitude; sLng += c.longitude; }
  return { lat: sLat / coords.length, lng: sLng / coords.length };
}

/** Etiqueta legible del origen, para la UI y para el prompt del geólogo. */
export function rockSourceLabel(source: RockSource): string {
  switch (source) {
    case 'macrostrat':
    case 'glim':
      return 'carta geológica regional';
    case 'sgm':
      return 'carta SGM 1:50,000';
    case 'usuario':
      return 'indicado por el usuario';
    default:
      return 'valor por defecto';
  }
}

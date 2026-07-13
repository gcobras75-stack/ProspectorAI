/**
 * costTelemetry.ts — telemetría de costos de IA/análisis (best-effort).
 *
 * Registra en Supabase (tabla analytics_costos) el consumo real por análisis y
 * por llamada a Claude: hectáreas, fuentes disparadas, tokens de entrada/salida
 * (de `usage` que devuelve la API) y costo estimado en USD.
 *
 * REGLA: es 100% best-effort. NUNCA lanza ni bloquea la IA ni el análisis. Si la
 * tabla no existe todavía, no hay red, o RLS rechaza, se traga el error en
 * silencio (log a consola) y la app sigue igual.
 *
 * Precios por modelo (USD por 1M de tokens) — ver [[prospector-materials-catalog]]:
 *   claude-haiku-4-5   → $1.00 entrada · $5.00 salida
 *   claude-sonnet-4-6  → $3.00 entrada · $15.00 salida
 */
import { supabase } from './supabase';

type Precio = { in: number; out: number }; // USD por token
const PRECIOS: Record<string, Precio> = {
  haiku:  { in: 1.0 / 1e6, out: 5.0 / 1e6 },
  sonnet: { in: 3.0 / 1e6, out: 15.0 / 1e6 },
};

function precioDe(model: string | undefined): Precio {
  const m = (model ?? '').toLowerCase();
  if (m.includes('haiku')) return PRECIOS.haiku;
  return PRECIOS.sonnet; // Sonnet es el default (análisis complejo)
}

export type UsageLike =
  | {
      input_tokens?: number;
      output_tokens?: number;
      // Prompt caching: la API los devuelve APARTE de input_tokens (no están
      // incluidos en él). Ver app/core/ClaudeServices.ts.
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    }
  | undefined
  | null;

/** TTL de la caché de prompts. Cambia el premium de ESCRITURA, no el de lectura. */
export type CacheTtl = '5m' | '1h';

// Multiplicadores sobre el precio de entrada (Anthropic):
//   escritura de caché → 1.25× (TTL 5 min) · 2× (TTL 1 h)
//   lectura de caché   → 0.1×  (≈90% de ahorro)
const CACHE_WRITE_MULT: Record<CacheTtl, number> = { '5m': 1.25, '1h': 2.0 };
const CACHE_READ_MULT = 0.1;

export function computeCostUsd(
  model: string | undefined,
  usage: UsageLike,
  cacheTtl: CacheTtl = '5m',
): number {
  const p = precioDe(model);
  const ins = usage?.input_tokens ?? 0;
  const outs = usage?.output_tokens ?? 0;
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  return (
    ins * p.in +
    cacheWrite * p.in * CACHE_WRITE_MULT[cacheTtl] +
    cacheRead * p.in * CACHE_READ_MULT +
    outs * p.out
  );
}

export type CostoTipo =
  | 'analisis_zona' | 'interpretacion' | 'reporte' | 'foto' | 'lote' | 'chat' | 'muestra';

// Análisis "actual": las llamadas de IA (lote, interpretación) se etiquetan con
// el id del último análisis de zona para poder agrupar costo por análisis.
let currentAnalisisId: string | null = null;
export function setCurrentAnalisis(id: string | null): void { currentAnalisisId = id; }
export function newAnalisisId(): string {
  return `an_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// Columnas añadidas por la migración 0011. Si esa migración todavía no está
// aplicada en el proyecto, PostgREST rechaza la fila ENTERA por columna
// desconocida — y perderíamos toda la telemetría, no solo el dato de caché.
// Por eso reintentamos una vez sin ellas.
const CACHE_COLS = ['cache_creation_input_tokens', 'cache_read_input_tokens'];

async function insertRow(row: Record<string, any>): Promise<void> {
  try {
    // user_id se rellena solo con el default auth.uid() en la tabla (RLS-safe).
    const { error } = await supabase.from('analytics_costos').insert(row);
    if (!error) return;

    const faltaColumnaCache = CACHE_COLS.some(c => error.message?.includes(c));
    if (faltaColumnaCache) {
      const { ['cache_creation_input_tokens']: _w, ['cache_read_input_tokens']: _r, ...sinCache } = row;
      const retry = await supabase.from('analytics_costos').insert(sinCache);
      if (retry.error) console.log('[costTelemetry] insert omitido:', retry.error.message);
      else console.log('[costTelemetry] migración 0011 pendiente: fila guardada sin tokens de caché.');
      return;
    }
    console.log('[costTelemetry] insert omitido:', error.message);
  } catch (e: any) {
    console.log('[costTelemetry] insert falló (best-effort):', e?.message);
  }
}

/** Registra una llamada a Claude con sus tokens reales. Nunca lanza. */
export function logAICall(
  tipo: CostoTipo,
  model: string | undefined,
  usage: UsageLike,
  extra?: { material?: string; analisisId?: string | null; cacheTtl?: CacheTtl },
): void {
  const cacheWrite = usage?.cache_creation_input_tokens ?? null;
  const cacheRead = usage?.cache_read_input_tokens ?? null;

  // Sonda de caché: si en turnos repetidos del chat esto sale siempre en read=0,
  // la caché NO está pegando (prefijo invalidado) y hay que revisar el system.
  if (cacheWrite || cacheRead) {
    console.log(`[cache] ${tipo}: write=${cacheWrite ?? 0} read=${cacheRead ?? 0}`);
  }

  void insertRow({
    tipo,
    modelo: model ?? null,
    analisis_id: extra?.analisisId ?? currentAnalisisId,
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
    costo_usd: Number(computeCostUsd(model, usage, extra?.cacheTtl ?? '5m').toFixed(6)),
    material: extra?.material ?? null,
  });
}

/** Registra el contexto de un análisis de zona (sin costo de tokens: GEE es gratis). */
export function logAnalisisZona(params: {
  analisisId: string;
  hectareas?: number;
  // `thermal` = índice de sílice térmico (ASTER GED). Se dispara solo para la familia
  // sílice/roca, así que su frecuencia dice cuánto se usa esa familia de materiales.
  fuentes: { s2?: boolean; emit?: boolean; aster?: boolean; s1?: boolean; dem?: boolean; thermal?: boolean };
  material?: string;
  nInterpretaciones?: number;
  nFotos?: number;
}): void {
  void insertRow({
    tipo: 'analisis_zona',
    analisis_id: params.analisisId,
    hectareas: params.hectareas ?? null,
    fuentes: params.fuentes,
    material: params.material ?? null,
    n_interpretaciones: params.nInterpretaciones ?? 0,
    n_fotos: params.nFotos ?? 0,
  });
}

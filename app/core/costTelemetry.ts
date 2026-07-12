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

export type UsageLike = { input_tokens?: number; output_tokens?: number } | undefined | null;

export function computeCostUsd(model: string | undefined, usage: UsageLike): number {
  const p = precioDe(model);
  const ins = usage?.input_tokens ?? 0;
  const outs = usage?.output_tokens ?? 0;
  return ins * p.in + outs * p.out;
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

async function insertRow(row: Record<string, any>): Promise<void> {
  try {
    // user_id se rellena solo con el default auth.uid() en la tabla (RLS-safe).
    const { error } = await supabase.from('analytics_costos').insert(row);
    if (error) console.log('[costTelemetry] insert omitido:', error.message);
  } catch (e: any) {
    console.log('[costTelemetry] insert falló (best-effort):', e?.message);
  }
}

/** Registra una llamada a Claude con sus tokens reales. Nunca lanza. */
export function logAICall(
  tipo: CostoTipo,
  model: string | undefined,
  usage: UsageLike,
  extra?: { material?: string; analisisId?: string | null },
): void {
  void insertRow({
    tipo,
    modelo: model ?? null,
    analisis_id: extra?.analisisId ?? currentAnalisisId,
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
    costo_usd: Number(computeCostUsd(model, usage).toFixed(6)),
    material: extra?.material ?? null,
  });
}

/** Registra el contexto de un análisis de zona (sin costo de tokens: GEE es gratis). */
export function logAnalisisZona(params: {
  analisisId: string;
  hectareas?: number;
  fuentes: { s2?: boolean; emit?: boolean; aster?: boolean; s1?: boolean; dem?: boolean };
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

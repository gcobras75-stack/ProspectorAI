/**
 * deepAdvice.ts — ¿le sirve a ESTE material el Análisis profundo (ASTER/EMIT)? Fuente única para la
 * sugerencia de las dos apps (nativa y PWA). Sin dependencias nativas: se prueba con node --test.
 *
 * El profundo solo recupera los índices de DEEP_ENRICHABLE_KEYS. Un material "se beneficia" cuando
 * su techo de puntaje (100 − peso de los índices sin proxy real) sube de forma apreciable al activarlo.
 * malachite (cobre), silica (oro), sphalerite y galena NO están en la lista: ASTER/EMIT no los miden.
 */
import { CATALOG_WEIGHTS, normalizeMaterialId } from './materialsCatalog';

/** Índices SIN proxy directo de Sentinel-2 (hoy sintéticos; no son medición). */
export const SYNTHETIC_INDEX_KEYS = ['silica', 'malachite', 'sphalerite', 'carbonate', 'galena'] as const;
/** Índice destino → lo que ASTER/EMIT sí miden de verdad. */
export const DEEP_ENRICHABLE_KEYS = ['carbonate', 'propylitic', 'argillic', 'ferric_iron'] as const;

/** Sube el techo al menos esto (puntos porcentuales) → se sugiere activar el profundo. */
export const DEEP_SUGGEST_MIN_GAIN_PCT = 20;

export type DeepAdvice = {
  /** suggest: el profundo mejora mucho a este material (y está apagado). unneeded: no lo mejora (y está encendido). */
  kind: 'suggest' | 'unneeded';
  ceilingPct: number;
  ceilingWithDeepPct: number;
};

/** Techo del puntaje sin y con Análisis profundo, en %. null si el material no está en el catálogo. */
export function deepCeilings(materialId: string): { off: number; on: number } | null {
  const w = (CATALOG_WEIGHTS as Record<string, Record<string, number>>)[normalizeMaterialId(materialId)];
  if (!w) return null;
  const total = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  const synth = (deep: boolean) => SYNTHETIC_INDEX_KEYS
    .filter((k) => !(deep && (DEEP_ENRICHABLE_KEYS as readonly string[]).includes(k)))
    .reduce((a, k) => a + (w[k] || 0), 0);
  const pct = (s: number) => Math.round(Math.max(0, 1 - s / total) * 100);
  return { off: pct(synth(false)), on: pct(synth(true)) };
}

/** Aviso que corresponde mostrar según material y estado del interruptor; null si no hay nada que decir. */
export function deepAdvice(materialId: string, deepOn: boolean): DeepAdvice | null {
  const c = deepCeilings(materialId);
  if (!c) return null;
  const benefits = c.on - c.off >= DEEP_SUGGEST_MIN_GAIN_PCT;
  if (benefits && !deepOn) return { kind: 'suggest', ceilingPct: c.off, ceilingWithDeepPct: c.on };
  if (!benefits && deepOn) return { kind: 'unneeded', ceilingPct: c.off, ceilingWithDeepPct: c.on };
  return null;
}

export function deepAdviceText(label: string, a: DeepAdvice): string {
  return a.kind === 'suggest'
    ? `Este material mejora mucho con Análisis profundo (tarda más): el puntaje máximo posible pasa de ${a.ceilingPct}% a ${a.ceilingWithDeepPct}%. ¿Activarlo?`
    : `Análisis profundo apenas cambia el resultado de ${label}: su techo de puntaje no sube. Puedes analizarlo igual de bien sin esperar más.`;
}

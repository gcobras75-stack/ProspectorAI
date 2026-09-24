/**
 * displayScore.ts — ÚNICA función que decide qué número (0–100) se muestra por punto.
 *
 * REGLA: si el punto tiene `score` (el de la IA o el del consenso multi-satélite), ese
 * es el número; si no, `base_score` (señal espectral cruda de Sentinel-2); si tampoco, 0.
 *
 * Por qué así: `score` es lo que ordena el ranking (`rank`), así que el número tiene que
 * ser el que explica ese orden. Antes cada pantalla elegía por su cuenta (lista: score
 * primero; modal, PDF, Excel y mapa de calor: base_score primero) y el mismo punto
 * salía 74 en un sitio y 91 en otro.
 *
 * OJO al leerlo: el `score` de consenso es max(S2, ASTER, EMIT) × 1.15–1.25 (ver
 * ConsensusFusion), no una medición cruda. Por eso la frase que acompaña al número dice
 * "compárala solo con otros puntos de tu misma zona".
 *
 * Módulo hoja, sin imports: lo usan la app nativa, la PWA, el PDF y el Excel.
 */
export function displayScore(p: { score?: unknown; base_score?: unknown } | null | undefined): number {
  const s = p?.score;
  if (typeof s === 'number' && Number.isFinite(s)) return s;
  const b = p?.base_score;
  if (typeof b === 'number' && Number.isFinite(b)) return b;
  return 0;
}

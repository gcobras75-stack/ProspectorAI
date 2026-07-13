/**
 * Índices espectrales SATURADOS (topados en 1.00).
 *
 * Un índice que llega al techo de su escala no dice "aquí hay muchísimo mineral":
 * dice que el sensor no puede distinguir más allá de ese punto. En temporada seca
 * el suelo desnudo eleva los índices de alteración de forma generalizada, así que
 * un 1.00 aislado NO es evidencia de anomalía: hay que compararlo contra el fondo
 * regional para saber si de verdad destaca.
 *
 * Por eso la app lo marca como `saturado: true` y lo dice en pantalla, en vez de
 * pintarlo como el valor más alto posible.
 *
 * PRÓXIMO PASO (servidor): el análisis de CONTRASTE REGIONAL, que compara la celda
 * contra la estadística de la zona. Cuando exista, el aviso de abajo se convierte
 * en el botón que lo dispara.
 */

/** Umbral de saturación: a partir de aquí el índice se considera topado. */
export const SATURATION_THRESHOLD = 0.99;

/** Aviso corto que se muestra junto a un valor saturado. */
export const SATURATION_NOTICE = 'Valor saturado — requiere análisis de contraste regional';

export function isSaturated(value: unknown): boolean {
  const v = Number(value);
  return Number.isFinite(v) && v >= SATURATION_THRESHOLD;
}

/**
 * Devuelve las claves de `indices` cuyo valor está saturado.
 * Acepta `unknown` porque lo llaman tanto tipos concretos (SpectralIndices) como
 * objetos sueltos que llegan del servidor sin índice de firma.
 */
export function saturatedKeys(indices: unknown, keys?: string[]): string[] {
  if (!indices || typeof indices !== 'object') return [];
  const bag = indices as Record<string, unknown>;
  const candidates = keys ?? Object.keys(bag);
  return candidates.filter(k => isSaturated(bag[k]));
}

/** ¿El punto/celda tiene al menos un índice topado? */
export function hasSaturatedIndex(indices: unknown, keys?: string[]): boolean {
  return saturatedKeys(indices, keys).length > 0;
}

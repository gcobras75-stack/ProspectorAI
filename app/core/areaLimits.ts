// ─────────────────────────────────────────────────────────────────────────────
// Límites de superficie por polígono.
//
// IMPORTANTE — estos umbrales son la BASE DEL COBRO POR HECTÁREAS de los planes
// futuros: el tope duro define cuánta superficie entra en un análisis, y por lo
// tanto cuánto cuesta. Cambiar estos números cambia el producto y el precio, así
// que viven aquí, en un solo lugar, y no repartidos por la UI.
//
// Motivo técnico del tope: el tamaño de celda es adaptativo (ver
// computeAdaptiveCellSize en SatelliteEngine). A más superficie, celdas más
// grandes y menor resolución efectiva; pasando ~10.000 ha el resultado deja de
// ser accionable en campo.
// ─────────────────────────────────────────────────────────────────────────────

/** Tope duro: por encima de esto NO se permite analizar. */
export const MAX_AREA_HA = 10_000;

/** Aviso suave: a partir de aquí se analiza, pero se advierte que baja la resolución. */
export const WARN_AREA_HA = 5_000;

export type AreaLevel = 'ok' | 'warn' | 'block';

export function getAreaLevel(areaHa: number): AreaLevel {
  if (!Number.isFinite(areaHa) || areaHa <= 0) return 'ok';
  if (areaHa > MAX_AREA_HA) return 'block';
  if (areaHa > WARN_AREA_HA) return 'warn';
  return 'ok';
}

/** Color del medidor de hectáreas: normal → ámbar → rojo. */
export const AREA_LEVEL_COLOR: Record<AreaLevel, string> = {
  ok: '#FFD700',
  warn: '#FF9500',
  block: '#FF3B30',
};

/** Miles con coma, sin depender de Intl (Hermes no siempre lo trae completo). */
export function formatHa(areaHa: number): string {
  const n = Math.round(Number.isFinite(areaHa) ? areaHa : 0);
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Mensaje de bloqueo (tope duro superado). */
export function areaBlockMessage(areaHa: number): string {
  return (
    `Zona muy grande (${formatHa(areaHa)} ha). Para resultados precisos, analiza ` +
    `zonas de hasta ${formatHa(MAX_AREA_HA)} ha. Divide tu área en partes más pequeñas.`
  );
}

/** Mensaje de aviso suave (zona grande pero analizable). */
export const AREA_WARN_MESSAGE =
  'Zona grande: la resolución baja. Zonas más pequeñas dan mejores resultados.';

/**
 * geo.ts — helpers geográficos del análisis en la PWA.
 *
 * Son copias LITERALES de dos funciones locales de app/(tabs)/index.tsx (no exportadas, por
 * eso no se pueden importar): calcPolygonArea y getDrySeasonDates. Deben dar los mismos
 * números que la app nativa, porque los umbrales de areaLimits.ts (5k/10k ha) se aplican
 * sobre este cálculo y de él depende el tamaño de celda. Si cambian allá, cambian aquí.
 */
export type Coordinate = { latitude: number; longitude: number };

/** Área en m² (proyección equirectangular local + fórmula del área de Gauss). */
export function calcPolygonArea(coords: Coordinate[]): number {
  if (!coords || coords.length < 3) return 0;
  const R = 6378137;
  let sumY = 0;
  for (const c of coords) sumY += c.latitude;
  const avgLat = (sumY / coords.length) * Math.PI / 180;

  const points = coords.map(c => ({
    x: c.longitude * Math.PI / 180 * R * Math.cos(avgLat),
    y: c.latitude * Math.PI / 180 * R,
  }));

  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    area += (p1.x * p2.y - p2.x * p1.y);
  }
  return Math.abs(area / 2);
}

export const polygonAreaHa = (coords: Coordinate[]): number => calcPolygonArea(coords) / 10_000;

/** Ventana de estación seca para Sentinel-2 según la zona (misma lógica que la app nativa). */
export function getDrySeasonDates(centLat: number, centLng: number): { fecha_inicio?: string; fecha_fin?: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-indexed
  // NW Mexico arid zone: dry season Feb–May
  if (centLat >= 20 && centLat <= 32 && centLng >= -118 && centLng <= -103) {
    const startYear = m >= 5 ? y : y - 1; // if we're past May, this year's dry season just ended; else use last year
    return { fecha_inicio: `${startYear}-02-01`, fecha_fin: `${startYear}-05-31` };
  }
  // Tropical/south Mexico: dry season Nov–Apr (spans year boundary)
  if (centLat >= 14 && centLat < 20 && centLng >= -95 && centLng <= -86) {
    const startYear = m >= 4 ? y : y - 1;
    return { fecha_inicio: `${startYear}-11-01`, fecha_fin: `${startYear + 1}-04-30` };
  }
  // Other zones: let GEE auto-select (no override)
  return {};
}

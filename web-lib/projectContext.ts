/**
 * projectContext.ts — arma el bloque de DATOS del proyecto que se manda como `context`
 * al endpoint de Villegas. Es el mismo formato de datos que `formatContext` del chat
 * nativo (app/(tabs)/geologo.tsx), SIN las instrucciones de respuesta ("Responde con…"):
 * esas las agrega el servidor. Sin waypoints: la PWA no los tiene (no se sincronizan).
 *
 * Solo datos reales del proyecto; nada se inventa aquí.
 */
import type { WebProject, WebSample } from '../app/core/webData';
import { displayScore } from '../app/core/displayScore';
import { anomalyFromPct } from '../app/core/theme';

/** null si el proyecto no tiene celdas analizadas (no hay nada que interpretar). */
export function buildProjectContext(p: WebProject, samples: WebSample[]): string | null {
  const points: any[] = p.analisis_resultado || [];
  if (points.length === 0) return null;

  const topPoints = points.slice(0, 5).map((pt, i) => {
    const score = displayScore(pt);
    const level = anomalyFromPct(score).label;
    const conf = pt.consensus === 'PRIORITY_TARGET'
      ? ' OBJETIVO PRIORITARIO S2+ASTER+Estructura'
      : pt.consensus === 'CONFIRMED' ? ' CONFIRMADA S2+ASTER' : '';
    return `  #${i + 1} Lat:${pt.lat?.toFixed(5)}, Lng:${pt.lng?.toFixed(5)} — ${level} alteracion (score:${Math.round(score)})${conf}`;
  }).join('\n');

  const lineamentCount = points.filter((pt) => pt.near_lineament).length;
  const priorityCount = points.filter((pt) => pt.consensus === 'PRIORITY_TARGET').length;
  const structuralLines: string[] = [];
  if (lineamentCount > 0) {
    structuralLines.push(`LINEAMIENTOS: ${lineamentCount} punto${lineamentCount > 1 ? 's' : ''} cruzan con estructuras (posibles fallas/fracturas)`);
  }
  if (priorityCount > 0) {
    structuralLines.push(`OBJETIVOS PRIORITARIOS: ${priorityCount} zona${priorityCount > 1 ? 's' : ''} con anomalia espectral confirmada + control estructural`);
  }
  const emitCount = points.filter((pt) => pt.emitScore !== null && pt.emitScore !== undefined && pt.emitScore >= 65).length;
  if (emitCount > 0) {
    structuralLines.push(`EMIT hiperspectral: ${emitCount} celdas con senal mineral >=65`);
  }
  const structuralSection = structuralLines.length > 0 ? `\n${structuralLines.join('\n')}` : '';

  const sampleLines = samples.slice(0, 5).map((s, i) => {
    const ia = s.analisis_ia;
    const mineral = ia?.mineral_detectado || s.mineral_detectado || '—';
    const prob = ia?.probabilidad ? ` (${ia.probabilidad}%)` : '';
    const nota = s.descripcion_texto ? ` — "${s.descripcion_texto}"` : '';
    return `  ${i + 1}. ${mineral}${prob}${nota}`;
  }).join('\n');

  const source = p.satdata_source || 'Sentinel-2';
  const dateStr = p.acquisition_date ? ` · imagen ${p.acquisition_date}` : '';
  const area = p.coordenadas?.length > 0 ? ` · ${p.coordenadas.length} vertices` : '';

  return `[CONTEXTO — ULTIMO ANALISIS]
Mineral objetivo: ${p.mineral?.toUpperCase()}
Terreno: ${p.terrain}  Roca: ${p.rock_type}
Fuente: ${source}${dateStr}${area}

Anomalias detectadas (top ${Math.min(5, points.length)} de ${points.length}):
${topPoints || '  (sin datos)'}${structuralSection}
${samples.length > 0 ? `\nMuestras de campo (${samples.length} total):\n${sampleLines}` : ''}`;
}

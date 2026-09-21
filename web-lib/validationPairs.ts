/**
 * validationPairs.ts — pares predicción-realidad que el usuario marca EN CAMPO desde la PWA (tabla `validation_pairs`).
 *
 * Módulo PURO (sin red ni React): define las claves, el formato y las reglas. La lectura/escritura en Supabase está en
 * validationStore.ts. Diseño y compatibilidad con la app nativa: docs/VALIDACION-EN-CAMPO.md.
 *
 * HONESTIDAD: el par registra lo que el usuario observó en UNA visita. "No encontré nada" significa "en mi visita no lo encontré";
 * NO prueba que no exista. Y por ahora NADA ajusta el análisis con estos pares (solo se registran).
 *
 * Formato (mismo que la app nativa donde coincide; los extras de la PWA van marcados):
 *   client_id          "web:<proyecto>:<lat5>,<lng5>"      ← la identidad del punto viaja aquí: sobrevive a cualquier reescritura
 *   project_client_id  <proyecto>
 *   predicted          { consensus, evidence, base_score, indices, metal, score*, rank* }   (* extras de la PWA)
 *   actual             { verdict, comment, threshold }      verdict ∈ CONFIRMED | PARTIAL | NOT_CONFIRMED (mismas claves que la nativa)
 *   data               { muestra_id:'', created_at, lat*, lng*, rank*, origen*:'pwa', nota_alcance*, analisis*:{fecha,fuentes} }
 */

export type Verdict = 'CONFIRMED' | 'PARTIAL' | 'NOT_CONFIRMED';
export const VERDICTS: Verdict[] = ['CONFIRMED', 'PARTIAL', 'NOT_CONFIRMED'];
export const NOTE_MAX = 280;

/** Etiquetas cortas (insignia) y explicación (hoja). Mismas claves que la app nativa. */
export const VERDICT_BADGE: Record<Verdict, string> = {
  CONFIRMED: '✅ Confirmado en campo',
  PARTIAL: '⚠️ Parcial',
  NOT_CONFIRMED: '❌ No lo encontré (en mi visita)',
};
export const VERDICT_BUTTON: Record<Verdict, string> = {
  CONFIRMED: 'Confirmado en campo',
  PARTIAL: 'Parcial',
  NOT_CONFIRMED: 'No encontré nada',
};
export const VERDICT_HELP: Record<Verdict, string> = {
  CONFIRMED: 'Lo que marca el análisis se cumple en el terreno.',
  PARTIAL: 'Encontré algo, pero distinto de lo esperado o solo en parte.',
  NOT_CONFIRMED: 'Significa que EN MI VISITA no lo encontré. No prueba que no exista: una visita puede no ver lo que hay.',
};
export const VERDICT_COLOR: Record<Verdict, string> = { CONFIRMED: '#4CAF50', PARTIAL: '#FF9800', NOT_CONFIRMED: '#E53935' };
/** Aviso permanente en la hoja: es un registro, no un ajuste del análisis. */
export const SCOPE_NOTICE = 'Es tu observación en esta visita. Por ahora solo se registra: no cambia el análisis.';
export const SCOPE_NOTE_STORED = 'observación de una visita; "no encontré" no prueba ausencia';

export const isVerdict = (v: unknown): v is Verdict => typeof v === 'string' && (VERDICTS as string[]).includes(v);

/** "lat5,lng5": 5 decimales (≈ 1 m). Normaliza el -0 y valida. */
export function pointKey(lat: number, lng: number): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('El punto no tiene coordenadas válidas.');
  const f = (v: number) => { const s = v.toFixed(5); return s === '-0.00000' ? '0.00000' : s; };
  return `${f(lat)},${f(lng)}`;
}

export const PAIR_PREFIX = 'web:';
export const pairClientId = (projectClientId: string, lat: number, lng: number) => `${PAIR_PREFIX}${projectClientId}:${pointKey(lat, lng)}`;

/** De un client_id "web:<proyecto>:<lat5>,<lng5>" saca la clave del punto (o null si no es de la PWA / no coincide con el proyecto). */
export function keyFromClientId(clientId: string, projectClientId: string): string | null {
  const prefix = `${PAIR_PREFIX}${projectClientId}:`;
  if (typeof clientId !== 'string' || !clientId.startsWith(prefix)) return null;
  const k = clientId.slice(prefix.length);
  return /^-?\d+\.\d{5},-?\d+\.\d{5}$/.test(k) ? k : null;
}

/** Recorta y limpia la nota: sin espacios extremos, máximo NOTE_MAX caracteres. */
export const cleanNote = (s: unknown): string => (typeof s === 'string' ? s.trim().slice(0, NOTE_MAX) : '');

export interface PairPoint { lat: number; lng: number; rank?: number; score?: number; base_score?: number; consensus?: string; evidence?: string; indices?: unknown }
export interface PairProject { id: string; mineral: string; analysis_meta?: { fecha?: string; fuentes?: unknown } | null }

/** Fila lista para el upsert (onConflict: 'user_id,client_id'). Lanza si el veredicto o el punto no son válidos. */
export function buildPairPayload(args: { userId: string; project: PairProject; point: PairPoint; verdict: Verdict; comment?: string; now?: Date }) {
  const { userId, project, point, verdict } = args;
  if (!userId) throw new Error('Falta la sesión del usuario.');
  if (!isVerdict(verdict)) throw new Error('Veredicto inválido.');
  const key = pointKey(point.lat, point.lng); // valida coordenadas
  const meta = project.analysis_meta ?? null;
  return {
    user_id: userId,
    client_id: pairClientId(project.id, point.lat, point.lng),
    project_client_id: project.id,
    predicted: {
      consensus: point.consensus ?? '',
      evidence: point.evidence ?? '',
      base_score: point.base_score ?? null, // ausente = null (un 0 se leería como medido)
      indices: point.indices ?? {},
      metal: project.mineral ?? '',
      score: point.score ?? null,
      rank: point.rank ?? null,
    },
    actual: { verdict, comment: cleanNote(args.comment), threshold: 0.5 },
    data: {
      muestra_id: '',
      created_at: (args.now ?? new Date()).toISOString(),
      lat: Number(key.split(',')[0]), lng: Number(key.split(',')[1]),
      rank: point.rank ?? null,
      origen: 'pwa',
      nota_alcance: SCOPE_NOTE_STORED,
      analisis: { fecha: meta?.fecha ?? null, fuentes: meta?.fuentes ?? null },
    },
  };
}

export interface PairView { verdict: Verdict; comment: string; created_at: string }

/** Fila leída de Supabase → vista para la interfaz. null si no es un par válido de este proyecto. */
export function parsePairRow(row: any, projectClientId: string): { key: string; view: PairView } | null {
  if (!row) return null;
  const key = keyFromClientId(row.client_id, projectClientId);
  const v = row.actual?.verdict;
  if (!key || !isVerdict(v)) return null;
  return { key, view: { verdict: v, comment: cleanNote(row.actual?.comment), created_at: String(row.data?.created_at ?? row.created_at ?? '') } };
}

/**
 * validationStore.ts — lectura/escritura de `validation_pairs` desde la PWA, con la sesión del usuario (RLS `validation_own`:
 * cada usuario solo ve y escribe lo suyo). Formato y reglas: validationPairs.ts. No escribe nada más.
 */
import { supabase } from '../app/core/supabase';
import {
  buildPairPayload, parsePairRow, PAIR_PREFIX, type PairPoint, type PairProject, type PairView, type Verdict,
} from './validationPairs';

/** Pares de la PWA de UN proyecto, por clave de punto ("lat5,lng5"). Los de la app nativa (otro client_id) se ignoran. */
export async function listPairs(projectClientId: string): Promise<Record<string, PairView>> {
  const { data, error } = await supabase
    .from('validation_pairs')
    .select('client_id, actual, data, created_at')
    .eq('project_client_id', projectClientId)
    .like('client_id', `${PAIR_PREFIX}%`);
  if (error) throw new Error(error.message);
  const out: Record<string, PairView> = {};
  for (const row of data ?? []) {
    const p = parsePairRow(row, projectClientId);
    if (p) out[p.key] = p.view;
  }
  return out;
}

async function currentUserId(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const id = data.session?.user?.id;
  if (!id) throw new Error('Tu sesión expiró. Inicia sesión de nuevo.');
  return id;
}

/** Guarda (o CAMBIA) el veredicto de un punto: un par por punto; guardar de nuevo actualiza el mismo. */
export async function savePair(project: PairProject, point: PairPoint, verdict: Verdict, comment: string): Promise<PairView> {
  const payload = buildPairPayload({ userId: await currentUserId(), project, point, verdict, comment });
  const { error } = await supabase.from('validation_pairs').upsert(payload, { onConflict: 'user_id,client_id' });
  if (error) throw new Error(error.message);
  return { verdict, comment: payload.actual.comment, created_at: payload.data.created_at };
}

/** Quita el veredicto de un punto (borra su par). */
export async function removePair(project: PairProject, point: PairPoint): Promise<void> {
  const payload = buildPairPayload({ userId: await currentUserId(), project, point, verdict: 'PARTIAL' });
  const { error } = await supabase.from('validation_pairs').delete().eq('user_id', payload.user_id).eq('client_id', payload.client_id);
  if (error) throw new Error(error.message);
}

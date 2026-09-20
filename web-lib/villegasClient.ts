/**
 * villegasClient.ts — cliente del endpoint POST /api/ai/villegas (prospectorai-ai).
 *
 * El bundle web NO lleva ningún prompt: solo manda mensajes de texto y, opcionalmente,
 * un bloque de DATOS del proyecto (`context`). El system prompt, el modelo y los
 * límites de salida los fija el servidor.
 */
import { supabase } from '../app/core/supabase';

// URL pública (ya está en eas.json); se puede sobreescribir en build con EXPO_PUBLIC_AI_SERVER_URL.
const AI_SERVER_URL =
  process.env.EXPO_PUBLIC_AI_SERVER_URL || 'https://prospectorai-ai-production.up.railway.app';

const TIMEOUT_MS = 90_000;

export type ChatMsg = { role: 'user' | 'assistant'; content: string };
export type VillegasUsage = {
  input_tokens: number; output_tokens: number;
  cache_creation_input_tokens: number; cache_read_input_tokens: number;
};

export async function askVillegas(
  messages: ChatMsg[],
  context?: string | null,
  mode: 'chat' | 'punto' = 'chat',
): Promise<{ reply: string; usage: VillegasUsage; truncated: boolean }> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Tu sesión expiró. Inicia sesión de nuevo.');

  const body: { messages: ChatMsg[]; context?: string; mode?: 'punto' } = { messages };
  if (context && mode === 'chat') body.context = context;
  if (mode === 'punto') body.mode = 'punto';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${AI_SERVER_URL}/api/ai/villegas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('El Ing. Villegas tardó demasiado. Intenta de nuevo.');
    throw new Error('Error de conexión — revisa tu internet e intenta de nuevo.');
  } finally {
    clearTimeout(timer);
  }

  let json: any = null;
  try { json = await res.json(); } catch { /* cuerpo no JSON */ }
  if (!res.ok) throw new Error(json?.error || `No se pudo consultar al Ing. Villegas (${res.status}).`);
  if (!json || typeof json.reply !== 'string') throw new Error('Respuesta inesperada del servidor.');
  return { reply: json.reply, usage: json.usage, truncated: json.truncated === true };
}

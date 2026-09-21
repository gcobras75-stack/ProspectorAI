/**
 * chatStore.ts — conversación del Ing. Villegas guardada en localStorage, una por proyecto ("general" si no hay).
 *
 * Las claves llevan el id del usuario (`pwa.chat.<userId>.<proyecto>`, ver userScope.ts): en un equipo compartido no se ve el chat del piloto anterior.
 * Sin usuario identificado no se lee ni se guarda nada (solo memoria).
 * Solo localStorage de ESTE navegador: la PWA no escribe chat_history en Supabase (no pisa el de la app nativa).
 * Todo acceso va en try/catch: sin storage (modo privado, bloqueado) el chat sigue funcionando en memoria.
 * Los mensajes de error no se guardan; se conservan los últimos MAX_MSGS.
 */
import type { ChatMsg } from './villegasClient';
import { getScopeUser } from './userScope';

export type StoredMsg = ChatMsg & { error?: boolean; truncated?: boolean };

export const GENERAL_KEY = 'general';
const PREFIX = 'pwa.chat.';
const MAX_MSGS = 60;

/** `pwa.chat.<userId>.<key>`, o null si no hay usuario. */
const storageKey = (key: string): string | null => { const u = getScopeUser(); return u ? `${PREFIX}${u}.${key}` : null; };

export function loadChat(key: string): StoredMsg[] {
  try {
    const sk = storageKey(key);
    if (!sk) return [];
    const raw = window.localStorage.getItem(sk);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
  } catch { return []; }
}

export function saveChat(key: string, msgs: StoredMsg[]): void {
  try {
    const sk = storageKey(key);
    if (!sk) return;
    const keep = msgs.filter((m) => !m.error).slice(-MAX_MSGS);
    if (keep.length === 0) window.localStorage.removeItem(sk);
    else window.localStorage.setItem(sk, JSON.stringify(keep));
  } catch { /* cuota llena o storage bloqueado: solo memoria */ }
}

/** Agrega un mensaje a una conversación guardada (respuesta que llegó cuando ya se había cambiado de proyecto). */
export function appendChat(key: string, msg: StoredMsg): void {
  saveChat(key, [...loadChat(key), msg]);
}

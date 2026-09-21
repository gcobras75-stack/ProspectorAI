/**
 * userScope.ts — todo lo que la PWA guarda en localStorage pertenece a UN usuario.
 *
 * Problema (auditoría A5): las claves eran globales (`pwa.chat.<proyecto>`, `pwa.selectedProjectId`, `pwa.analysisPrefs`). En un equipo
 * compartido, el piloto siguiente veía el chat y la selección del anterior, y al salir no se borraba nada.
 *
 * Reglas:
 *  - Las claves llevan el id del usuario: `pwa.chat.<userId>.<proyecto>`, `pwa.selectedProjectId.<userId>`, `pwa.analysisPrefs.<userId>`.
 *  - Sin usuario identificado NO se lee ni se escribe storage (`scopedKey` da null): todo queda en memoria.
 *  - Al cambiar de usuario (o cerrar sesión) se BORRA de localStorage todo `pwa.*` que no sea del usuario que queda —incluidas las claves
 *    antiguas sin id— y se avisa a los módulos con estado en memoria para que lo reinicien.
 *  - Solo se tocan claves `pwa.*`: la sesión de Supabase (`sb-…`) y cualquier otra clave ajena no se borran.
 *
 * Módulo sin dependencias de React/Expo (se prueba con node --test: scripts/test-user-scope.mjs).
 */

const PREFIX = 'pwa.';

let currentUser: string | null = null;
const listeners: Array<() => void> = [];

function storage(): Storage | null {
  try { return (globalThis as any).window?.localStorage ?? null; } catch { return null; }
}

export function getScopeUser(): string | null { return currentUser; }

/** Clave de storage del usuario actual (`<base>.<userId>`), o null si no hay usuario. */
export function scopedKey(base: string): string | null {
  return currentUser ? `${base}.${currentUser}` : null;
}

/** ¿Esta clave `pwa.*` pertenece a `userId`? (`pwa.chat.<id>.*`, `pwa.selectedProjectId.<id>`, `pwa.analysisPrefs.<id>`) */
export function belongsTo(key: string, userId: string | null): boolean {
  if (!userId) return false;
  return key.startsWith(`pwa.chat.${userId}.`) || key === `pwa.selectedProjectId.${userId}` || key === `pwa.analysisPrefs.${userId}`;
}

/** Borra de localStorage todo `pwa.*` que no sea de `keepUser`. Devuelve cuántas claves borró. */
export function purgeStorage(keepUser: string | null): number {
  const s = storage();
  if (!s) return 0;
  let n = 0;
  try {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k) keys.push(k); }
    for (const k of keys) {
      if (k.startsWith(PREFIX) && !belongsTo(k, keepUser)) { s.removeItem(k); n++; }
    }
  } catch { /* storage bloqueado: nada que limpiar */ }
  return n;
}

/** Módulos con estado propio en memoria (selección, interpretación pendiente) se reinician al cambiar de usuario. */
export function onScopeChange(fn: () => void): void { listeners.push(fn); }

/** Fija el usuario de la sesión (null = sin sesión). Si cambia: limpia lo ajeno y reinicia la memoria. */
export function setScopeUser(userId: string | null): void {
  if (userId === currentUser) return;
  currentUser = userId;
  purgeStorage(userId);
  for (const fn of listeners) { try { fn(); } catch { /* un oyente roto no impide limpiar */ } }
}

/** Solo para pruebas. */
export function _resetForTests(): void { currentUser = null; listeners.length = 0; }

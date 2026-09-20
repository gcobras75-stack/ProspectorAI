/**
 * geeAuth.ts (web) — el envoltorio de fetch de la PWA para el servidor GEE.
 *
 * SatelliteEngine (compartido con la app nativa) trata CUALQUIER fallo como "sin datos". Este módulo
 * envuelve window.fetch SOLO para las peticiones a ese servidor y recuerda el último 401/429/503 para que
 * runAnalysis pueda decir el motivo real en vez de "conéctate a internet".
 *
 * La identidad va en `Authorization: Bearer <JWT de la sesión de Supabase>` (app/core/geeAuth.ts, dentro de
 * SatelliteEngine). NO hay ningún token compartido en el bundle: un secreto en un bundle web es público.
 */
const GEE_URL = (() => {
  const env = process.env.EXPO_PUBLIC_SERVER_URL;
  const base = env && env !== 'undefined' && env !== '' ? env : 'https://prospector-gee-server-production.up.railway.app';
  return base.replace(/\/$/, '');
})();

export type GeeFailure = { status: 401 | 429 | 503; at: number };
let lastFailure: GeeFailure | null = null;
let installed = false;

export function installGeeAuth(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  const original = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const res = await original(input, init);
    if (url.startsWith(GEE_URL) && (res.status === 401 || res.status === 429 || res.status === 503)) {
      lastFailure = { status: res.status as 401 | 429 | 503, at: Date.now() };
    }
    return res;
  };
}

/** Marca el inicio de un análisis: descarta fallos de antes. */
export function resetGeeFailure(): void { lastFailure = null; }

/** Último 401/429/503 del servidor GEE desde resetGeeFailure(), o null. */
export function getGeeFailure(): GeeFailure | null { return lastFailure; }

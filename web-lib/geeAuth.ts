/**
 * geeAuth.ts — acceso de la PWA al servidor GEE (prospector-gee-server).
 *
 * SatelliteEngine (compartido con la app nativa, que NO se toca) llama a fetch() sin
 * cabeceras de autenticación y trata cualquier fallo como "sin conexión". Este módulo
 * envuelve window.fetch SOLO para las peticiones a ese servidor y hace dos cosas:
 *
 *  1) Si hay EXPO_PUBLIC_GEE_APP_TOKEN, agrega X-App-Token (el servidor lo exige cuando
 *     APP_SHARED_TOKEN está definido en Railway). Sin token configurado no manda nada,
 *     que es lo que el servidor espera hoy.
 *  2) Recuerda el último 401/429 para que runAnalysis pueda decir el motivo real
 *     ("límite de peticiones", "acceso no autorizado") en vez de "conéctate a internet".
 *
 * OJO: un token compartido dentro de un bundle web es PÚBLICO (cualquiera lo lee con F12).
 * Frena a quien no lo conoce y da un interruptor de corte, pero no es un secreto; la
 * protección de cuota real es el limitador por IP del servidor.
 */
const GEE_URL = (() => {
  const env = process.env.EXPO_PUBLIC_SERVER_URL;
  const base = env && env !== 'undefined' && env !== '' ? env : 'https://prospector-gee-server-production.up.railway.app';
  return base.replace(/\/$/, '');
})();
const TOKEN = process.env.EXPO_PUBLIC_GEE_APP_TOKEN || '';

export type GeeFailure = { status: 401 | 429; at: number };
let lastFailure: GeeFailure | null = null;
let installed = false;

export function installGeeAuth(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  const original = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(GEE_URL)) return original(input, init);

    let nextInit = init;
    if (TOKEN) {
      const headers = new Headers(init?.headers ?? (typeof input !== 'string' && !(input instanceof URL) ? input.headers : undefined));
      headers.set('X-App-Token', TOKEN);
      nextInit = { ...init, headers };
    }
    const res = await original(input, nextInit);
    if (res.status === 401 || res.status === 429) lastFailure = { status: res.status, at: Date.now() };
    return res;
  };
}

/** Marca el inicio de un análisis: descarta fallos de antes. */
export function resetGeeFailure(): void { lastFailure = null; }

/** Último 401/429 del servidor GEE desde resetGeeFailure(), o null. */
export function getGeeFailure(): GeeFailure | null { return lastFailure; }

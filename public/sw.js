/* sw.js — service worker básico de la PWA de consulta.
 *
 * Solo cachea ESTÁTICOS del mismo origen. NUNCA toca Supabase, la API de IA ni los tiles
 * del mapa (otro origen): los datos siempre vienen frescos de la red.
 *
 *  - /_expo/static/** y /assets/**  → cache-first (nombres con hash: inmutables)
 *  - navegación (index.html)        → network-first; sin red, sirve el shell cacheado
 *  - iconos, manifest, vendor       → stale-while-revalidate
 *
 * Subir VERSION invalida los cachés anteriores (se borran en `activate`).
 */
const VERSION = 'v2';
const STATIC_CACHE = `prospector-static-${VERSION}`;
const SHELL_CACHE = `prospector-shell-${VERSION}`;
const SHELL_URLS = ['/', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png', '/vendor/leaflet.css'];
const NAV_TIMEOUT_MS = 6000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL_URLS))
      .catch(() => { /* un fallo al precachear no debe impedir instalar */ })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== STATIC_CACHE && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function networkFirstNav(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NAV_TIMEOUT_MS)),
    ]);
    if (res.ok) cache.put('/', res.clone()); // SPA: cualquier ruta sirve el mismo index.html
    return res;
  } catch {
    const shell = await cache.match('/');
    if (shell) return shell;
    return new Response('Sin conexión. Abre la app cuando tengas internet.', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request);
  const network = fetch(request).then((res) => { if (res.ok) cache.put(request, res.clone()); return res; }).catch(() => null);
  return hit || (await network) || new Response('', { status: 504 });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Supabase, IA, tiles: siempre red
  if (url.pathname === '/sw.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNav(request));
  } else if (url.pathname.startsWith('/_expo/static/') || url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
  } else if (url.pathname.startsWith('/icons/') || url.pathname.startsWith('/vendor/') || url.pathname === '/manifest.json' || url.pathname === '/favicon.ico') {
    event.respondWith(staleWhileRevalidate(request));
  }
});

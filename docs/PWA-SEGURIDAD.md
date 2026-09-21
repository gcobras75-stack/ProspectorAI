# PWA — almacenamiento local y cabeceras de seguridad

## localStorage por usuario (A5)
Todo lo que la PWA guarda en el navegador pertenece a UN usuario (`web-lib/userScope.ts`):

| Dato | Clave |
|---|---|
| Chat con el Ing. Villegas | `pwa.chat.<userId>.<proyecto>` (`general` si no hay proyecto) |
| Proyecto elegido | `pwa.selectedProjectId.<userId>` |
| Preferencias de Nuevo análisis | `pwa.analysisPrefs.<userId>` |

- Sin usuario identificado NO se lee ni se escribe storage (todo queda en memoria).
- `app-web/_layout.tsx` fija el usuario desde la sesión (cuando ya terminó de cargar) y remonta las pantallas al cambiar de usuario (`<Stack key={uid}>`).
- Al **salir** o **cambiar de usuario** se borra todo `pwa.*` que no sea del usuario que queda, incluidas las claves antiguas sin id, y se reinician selección e interpretación pendiente. Solo se tocan claves `pwa.*`: la sesión de Supabase (`sb-…`) no.
- Pruebas: `node --import ./scripts/ts-resolve.mjs --test scripts/test-user-scope.mjs`.

## Cabeceras (A8) — `public/vercel.json` (se copia a `dist-web/`)
- **Content-Security-Policy:** `default-src 'self'`; `script-src 'self'` (sin inline: el bundle es un archivo externo); `style-src 'self' 'unsafe-inline'` (react-native-web y Leaflet ponen estilos en línea); `img-src 'self' data: blob: https://services.arcgisonline.com` (tiles de Esri; los íconos de Geoman son `data:`); `font-src 'self' data:`; `worker-src 'self'`; `manifest-src 'self'`; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`; `frame-ancestors 'none'`.
- **connect-src:** `'self'`, Supabase (`kjprkyuaghzwjatcjnyx.supabase.co`), servidor GEE y servidor de IA en Railway, `macrostrat.org` (carta geológica) y `mrdata.usgs.gov` (MRDS).
- **X-Content-Type-Options: nosniff**, **Referrer-Policy: strict-origin-when-cross-origin**, **X-Frame-Options: DENY**.

**Si cambia un origen** (otro proyecto de Supabase, otro dominio de Railway, otro proveedor de tiles) hay que actualizar `connect-src`/`img-src` a la vez: la CSP lo bloquea en silencio y en la consola solo sale "Refused to connect".

### Cómo se probó (y cómo repetirlo)
```bash
node scripts/export-web.js
node scripts/serve-web.js 8099     # sirve dist-web con los MISMOS rewrites y cabeceras de vercel.json
```
Chromium (Playwright) contra ese servidor, con Supabase y el servidor de IA simulados (la CSP se evalúa antes de la red) y tiles de Esri **reales**: mapa del proyecto con 15 de 15 tiles cargados, pantalla de dibujo con Geoman (barra de 5 botones, 3 vértices dibujados), service worker activo, cada origen de `connect-src` alcanzable y un origen ajeno (`evil.example.com`) y un script inline **bloqueados**; 0 violaciones no esperadas. Línea base sin CSP: mismo resultado. **Control negativo** (la misma CSP sin `services.arcgisonline.com`): tiles 15 → 0 y violaciones de `img-src`. Con `CSP_OVERRIDE="…" node scripts/serve-web.js` se sirve otra CSP para estos controles.

**No cubierto:** los popups de marcadores y los puntos dibujados sobre canvas no se pudieron activar en la prueba (igual con y sin CSP; se arman con `textContent`, sin relación con la CSP). Las fuentes de íconos no se usan en las pantallas probadas.

**No incluido:** `Permissions-Policy` y `Strict-Transport-Security` (Vercel ya sirve HSTS).

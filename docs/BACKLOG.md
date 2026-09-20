# Backlog

Pendientes anotados, sin investigar todavía. Cada uno se revisa en una sesión aparte.

## Revisar en la app nativa

### Posible inconsistencia entre "SUMA +" del panel y la evidencia de los puntos
- **Dónde:** proyecto "Dr Macías 1" (visto en la PWA de consulta, que usa el mismo `ResultsPanel` que la app).
- **Qué se ve:** el panel muestra "SUMA + · 3 satélites coinciden", mientras que el punto #1 del mismo proyecto dice "1 satélite detectó señal" (consenso `SINGLE`).
- **Origen:** viene del `prospectivity` guardado, no de la PWA. Causa sin investigar.
- **Acción:** revisar en la app nativa, en una sesión aparte.

## Servidor GEE (`prospector-gee-server`)

### Token compartido del servidor GEE (`APP_SHARED_TOKEN`) — NO reutilizarlo en la PWA
- **Estado verificado con el CLI de Railway (2026-09-20):** `AUTH_MODE=warn` y `APP_SHARED_TOKEN` YA EXISTÍAN en producción (`prospector-gee-server`). Mi nota anterior decía que el token "no estaba definido": era una inferencia sin base (un token falso también da 400 en modo `warn`, no solo en `off`).
- **De quién es:** el valor empieza por `agrocrop_` (+ 43 caracteres url-safe, ~32 bytes aleatorios): es el token de **AgroCrop**, no de Quinval ni algo generado por ProspectorAI. Quinval no depende de él: sus ~60 rutas (`/campo`, `/panel`, `/productor`…) están FUERA de `/api` y usan sus propias llaves (`X-Org-Key`, `QUINVAL_PANEL_SECRET`, `FONDO_DEMO_API_KEY`, `QUINVAL_API_KEY`). El middleware `requireAppToken` solo cubre `/api/*` y `/agroinsumos/*`.
- **Por qué NO ponerlo en el bundle de la PWA:** un token dentro de un bundle web lo lee cualquiera con F12, y este también abre rutas de AgroCrop que gastan Anthropic (`/api/chat`, `/api/agronomo`, `/api/analisis-claude`, `/api/ocr-titulo`). El propio `auth.js` documenta este principio ("el navegador nunca debe conocer ese token"). Por eso `web-lib/geeAuth.ts` solo lo manda si se define `EXPO_PUBLIC_GEE_APP_TOKEN` y **no se debe definir con este valor**.
- **Alternativas (decidir):** (A) un token propio de ProspectorAI aceptado solo en las rutas de minería (`/api/mining/*`, `/api/structural/*`, `/api/emit/*`, `/api/zone/*`); (B) validar el JWT de Supabase en esas rutas, lo que da control por usuario; (C) mientras tanto, la PWA sin token y el limitador por IP (30/min) ya activo. Cualquier cambio del servidor va por `develop` (staging) y merge a `master` solo con OK humano.
- **Pasar a `enforce`:** rompería la app nativa de ProspectorAI (no manda el header) y cualquier cliente sin token; primero medir en logs (`[auth] SIN TOKEN (gracia)`).

### BUG en producción: `/api/structural/grid` falla siempre (Sentinel-1 + DEM)
- **Síntoma (2026-09-20):** `POST /api/structural/grid` devuelve 500 `{"cells":[],"error":"Image.load: Asset 'COPERNICUS/DEM/GLO30' is not an Image."}` para cualquier zona (probado en 3 ha y en 822 ha). Con el análisis profundo, la fuente estructural nunca aporta: sin `structuralScore`, sin "Estructura ✓" y sin `PRIORITY_TARGET` (que exige S2+ASTER+estructura). Afecta a la app nativa igual que a la PWA (ambas caen en silencio a "sin datos").
- **Causa localizada (sin tocar):** `index.js:468` de `prospector-gee-server` hace `ee.Image('COPERNICUS/DEM/GLO30')`, pero ese asset es una `ImageCollection`. Arreglo probable: `ee.ImageCollection('COPERNICUS/DEM/GLO30').select('DSM').mosaic().clip(region)`.
- **Ojo:** el servidor lo comparten AgroCrop y ProspectorAI; cambiarlo va por `develop` (staging) y merge a `master` solo con OK humano (regla de la casa del repo del servidor). Verificar también que el resto del handler (ventana S1, pendiente) funciona una vez cargado el DEM.

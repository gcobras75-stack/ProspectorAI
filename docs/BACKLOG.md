# Backlog

Pendientes anotados, sin investigar todavía. Cada uno se revisa en una sesión aparte.

## Revisar en la app nativa

### Posible inconsistencia entre "SUMA +" del panel y la evidencia de los puntos
- **Dónde:** proyecto "Dr Macías 1" (visto en la PWA de consulta, que usa el mismo `ResultsPanel` que la app).
- **Qué se ve:** el panel muestra "SUMA + · 3 satélites coinciden", mientras que el punto #1 del mismo proyecto dice "1 satélite detectó señal" (consenso `SINGLE`).
- **Origen:** viene del `prospectivity` guardado, no de la PWA. Causa sin investigar.
- **Acción:** revisar en la app nativa, en una sesión aparte.

## Servidor GEE (`prospector-gee-server`)

### Identidad por usuario en las rutas de minería del servidor GEE (Opción B — JWT de Supabase)
- **Decisión (2026-09-20):** las rutas `/api/mining|structural|emit|zone` verifican el JWT de Supabase (ES256, JWKS público, local; sin secretos). El token compartido `APP_SHARED_TOKEN` es de AgroCrop y **no se usa ni se define en la PWA** (un secreto en un bundle web es público).
- **Servidor** (`prospector-gee-server`; **promovido a `master`/producción el 2026-09-20, merge 18abd78, con `MINING_AUTH_MODE` sin definir = `off`**, verificado idéntico salvo `Authorization` en CORS): `mining-auth.js`, modos `MINING_AUTH_MODE` off|warn|enforce, `MINING_ALLOW_APP_TOKEN` (transitorio), límite por usuario `MINING_USER_RATE_MAX`. Detalle y variables en el README del servidor.
- **Cliente** (rama `feature/pwa-analisis`): `app/core/geeAuth.ts` manda `Authorization: Bearer <JWT de sesión>` desde `SatelliteEngine` y `ReportGenerator` (nativa y PWA). Inocuo con el servidor en off/warn.
- **Orden obligatorio hacia producción:** (1) ✅ HECHO — merge `develop`→`master` del servidor con `MINING_AUTH_MODE` sin definir (=off; CORS ya permite `Authorization`); (2) definir `SUPABASE_URL` y `MINING_AUTH_MODE=warn` y leer los logs `[mining-auth] jwt=…`; (3) publicar la app nativa (OTA) y la PWA con el cambio; (4) SOLO con los logs limpios y OK explícito, `enforce`. Desplegar la PWA antes que el servidor rompe sus llamadas (preflight CORS sin `Authorization`).
- **Después de migrar:** `MINING_ALLOW_APP_TOKEN=0`. Rollback siempre por variable de entorno (`warn`/`off`).
- **La app nativa actual (sin JWT) queda FUERA en `enforce`** (verificado en staging: 401 en minería). Por eso `enforce` en producción depende de la OTA y de medir cuántas peticiones `sin_jwt` siguen llegando.

### BUG en producción: `/api/structural/grid` falla siempre (Sentinel-1 + DEM) — ya listado como K1 / issue #1 en `scripts/regress.sh` del servidor
- **Síntoma (2026-09-20):** `POST /api/structural/grid` devuelve 500 `{"cells":[],"error":"Image.load: Asset 'COPERNICUS/DEM/GLO30' is not an Image."}` para cualquier zona (probado en 3 ha y en 822 ha). Con el análisis profundo, la fuente estructural nunca aporta: sin `structuralScore`, sin "Estructura ✓" y sin `PRIORITY_TARGET` (que exige S2+ASTER+estructura). Afecta a la app nativa igual que a la PWA (ambas caen en silencio a "sin datos").
- **Causa localizada (sin tocar):** `index.js:468` de `prospector-gee-server` hace `ee.Image('COPERNICUS/DEM/GLO30')`, pero ese asset es una `ImageCollection`. Arreglo probable: `ee.ImageCollection('COPERNICUS/DEM/GLO30').select('DSM').mosaic().clip(region)`.
- **Ojo:** el servidor lo comparten AgroCrop y ProspectorAI; cambiarlo va por `develop` (staging) y merge a `master` solo con OK humano (regla de la casa del repo del servidor). Verificar también que el resto del handler (ventana S1, pendiente) funciona una vez cargado el DEM.

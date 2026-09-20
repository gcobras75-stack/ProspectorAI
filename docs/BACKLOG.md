# Backlog

Pendientes anotados, sin investigar todavía. Cada uno se revisa en una sesión aparte.

## Revisar en la app nativa

### Posible inconsistencia entre "SUMA +" del panel y la evidencia de los puntos
- **Dónde:** proyecto "Dr Macías 1" (visto en la PWA de consulta, que usa el mismo `ResultsPanel` que la app).
- **Qué se ve:** el panel muestra "SUMA + · 3 satélites coinciden", mientras que el punto #1 del mismo proyecto dice "1 satélite detectó señal" (consenso `SINGLE`).
- **Origen:** viene del `prospectivity` guardado, no de la PWA. Causa sin investigar.
- **Acción:** revisar en la app nativa, en una sesión aparte.

## Servidor GEE (`prospector-gee-server`)

### Activar el token compartido (`APP_SHARED_TOKEN`) — hoy está DESACTIVADO en producción
- **Estado verificado (2026-09-20):** el código (`auth.js`) ya tiene `X-App-Token` y limitador por IP (30/min, `RATE_LIMIT_MAX`). El limitador está activo en producción (cabeceras `ratelimit-*`). El token NO: `APP_SHARED_TOKEN` no está definido en Railway, así que `/api/*` está abierto (un token falso también da 400, no 401).
- **Por qué no es un simple interruptor:** el servidor lo comparten AgroCrop y ProspectorAI; la app nativa de ProspectorAI (SatelliteEngine) no manda el header. Activarlo en `enforce` la rompería. Usar primero `AUTH_MODE=warn` (gracia: deja pasar y registra), medir en logs, y solo entonces `enforce`.
- **Pasos:** (1) definir `APP_SHARED_TOKEN` + `AUTH_MODE=warn` en el servicio **staging** y probar; (2) lo mismo en producción; (3) poner el mismo valor en `EXPO_PUBLIC_GEE_APP_TOKEN` del build de la PWA (`.env`, luego `node scripts/export-web.js`); la PWA ya lo envía si existe (`web-lib/geeAuth.ts`); (4) publicar la app nativa con el header (OTA) antes de pasar a `enforce`.
- **Límite honesto:** un token dentro de un bundle web/APK es público. Frena a quien no lo conoce y da un interruptor de corte; la protección de cuota real es el limitador por IP. Un límite POR USUARIO exigiría validar el JWT de Supabase en el servidor GEE (no existe hoy).

### BUG en producción: `/api/structural/grid` falla siempre (Sentinel-1 + DEM)
- **Síntoma (2026-09-20):** `POST /api/structural/grid` devuelve 500 `{"cells":[],"error":"Image.load: Asset 'COPERNICUS/DEM/GLO30' is not an Image."}` para cualquier zona (probado en 3 ha y en 822 ha). Con el análisis profundo, la fuente estructural nunca aporta: sin `structuralScore`, sin "Estructura ✓" y sin `PRIORITY_TARGET` (que exige S2+ASTER+estructura). Afecta a la app nativa igual que a la PWA (ambas caen en silencio a "sin datos").
- **Causa localizada (sin tocar):** `index.js:468` de `prospector-gee-server` hace `ee.Image('COPERNICUS/DEM/GLO30')`, pero ese asset es una `ImageCollection`. Arreglo probable: `ee.ImageCollection('COPERNICUS/DEM/GLO30').select('DSM').mosaic().clip(region)`.
- **Ojo:** el servidor lo comparten AgroCrop y ProspectorAI; cambiarlo va por `develop` (staging) y merge a `master` solo con OK humano (regla de la casa del repo del servidor). Verificar también que el resto del handler (ventana S1, pendiente) funciona una vez cargado el DEM.

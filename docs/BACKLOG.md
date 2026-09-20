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

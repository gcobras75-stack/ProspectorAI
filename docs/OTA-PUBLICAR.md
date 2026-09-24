# Publicar una OTA (EAS Update) — checklist y trampas

Canal `preview`, `runtimeVersion` = política `sdkVersion` (`exposdk:54.0.0`): una OTA solo llega a builds del mismo SDK y sin cambios nativos.

## Antes de publicar
1. **Base y diferencia:** la última publicación sale de `eas update:list --branch preview`; su commit es el del `git log` con ese mensaje (los metadatos de EAS no traen el hash; confirmar con las horas: `curl` al manifiesto da `createdAt`). Listar `git diff --stat <base>..HEAD -- app assets package.json app.json app.config.js`.
2. **Compatibilidad nativa:** ningún módulo nativo nuevo en `package.json` (las librerías solo-web, como Leaflet, no cuentan) ni cambios de `app.json`.
3. `npx tsc --noEmit -p .` debe dar 0 errores.

## TRAMPA 1 — variables `EXPO_PUBLIC_*` (rompe la IA nativa en silencio)
Las variables de `eas.json` (perfil `build.preview.env`) **solo se aplican a los builds, NO a `eas update`**, y en EAS no hay variables definidas para `preview`. El `.env` local no define `EXPO_PUBLIC_AI_SERVER_URL`, y `app/core/ClaudeServices.ts` la lee **sin valor de respaldo** (`?? ''`): la OTA quedaría con la URL vacía y Villegas / el análisis con IA / el texto del reporte fallarían. (La PWA sí tiene respaldo en `web-lib/villegasClient.ts`.)
**Publicar siempre así:**
```
EXPO_PUBLIC_AI_SERVER_URL="https://prospectorai-ai-production.up.railway.app" \
  npx eas-cli update --branch preview --platform ios     --clear-cache --non-interactive --message "..."
EXPO_PUBLIC_AI_SERVER_URL="https://prospectorai-ai-production.up.railway.app" \
  npx eas-cli update --branch preview --platform android --clear-cache --non-interactive --message "..."
```
Verificación previa: `npx expo export --platform android --no-bytecode --clear` con esa variable, y buscar `prospectorai-ai-production` en el bundle (debe aparecer 1 vez; sin la variable aparece `A("/api/ai/chat"` con ruta relativa). **`--clear` es necesario**: Metro no invalida su caché al cambiar una variable de entorno.
El `.env` también define `EXPO_PUBLIC_N2YO_API_KEY`: hoy **nada en el código la referencia**, así que no se hornea; si alguna vez se referencia, viajaría dentro del bundle público. Nunca pongas llaves secretas (Anthropic, service_role) con prefijo `EXPO_PUBLIC_`.

## TRAMPA 2 — `--platform all`
Falla: incluye la exportación web y `app/` importa `react-native-maps`. Publicar `ios` y `android` por separado (así se hizo siempre).

## Después
Comprobar que el canal sirve la publicación nueva pidiendo el manifiesto (`Accept: multipart/mixed`, cabeceras `expo-platform`, `expo-runtime-version`, `expo-channel-name: preview`).

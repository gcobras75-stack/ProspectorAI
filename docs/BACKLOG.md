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

### Contraste regional (`POST /api/background-contrast`) — PROMOVIDO a producción (2026-09-20, servidor `master` `8d399c5`)
- Anillo de 1–3 km por kernel de imagen; mediana + IQR/1.349; `null` sin relleno; capas ópticas (`iron_oxide`, `ferroso`, `clay`, `ndvi`) + `slope_deg`/`elevation_m` como contexto. **Sentinel-1 EXCLUIDO del contrato** (pedir `vv_*` → 400; la respuesta no trae campos de S1). Diseño: `BACKLOG.md` del servidor.
- Verificado antes de promover: `regress.sh` en staging 19 OK / 0 FAIL / 0 DIFF; en producción, una llamada real (modo gracia `warn`) respondió con `ring_n` = 2516.
- **Siguiente bloque (pendiente de OK):** cablear el botón "requiere análisis de contraste regional" (`app/core/saturation.ts`) al endpoint. Sin hacer todavía.
- **spectral-grid — CORREGIDO y PROMOVIDO a producción (2026-09-20, servidor `master` `3616117`):** `iron_oxide`/`ferroso`/`clay` enmascaran los píxeles con denominador < 1 % de reflectancia (el promedio sigue siendo promedio). `iron_oxide` máx 283.7 → 4.84 en las 10 zonas de verificación; idéntico en 97.1 % de las celdas. Los proyectos ya guardados NO se recalculan. Detalle: `BACKLOG.md` del servidor. Sin corregir aún: el mismo patrón `max(B,1e-6)` en los índices ASTER (no medido).

### Estructura por satélite — PAUSADA (decisión 2026-09-20; se pospone, no se abandona)
- **Estructura por satélite:** `near_lineament` (DEM solo o DEM+S1) validado con AUC ~0.37-0.53 contra fallas reales de USGS — no detecta, mide pendiente de terreno. Requeriría un detector de rasgos lineales dedicado (extracción de líneas/filtros direccionales), proyecto aparte, sin fecha. Sin validar aún: pesos 0.7/0.3 y umbral 0.4 del intento actual.
- **En producción NO cambia nada:** `POST /api/structural/grid` sigue devolviendo error y la app nativa y la PWA siguen sin "Estructura ✓" ni `structuralScore`. Nada del bloque estructural/Sentinel-1 se promueve (ni servidor ni cliente).
- **Ramas vivas, SIN mergear (por si se retoma):**
  - Servidor GEE `develop`: trae `2e1d66e`/`f32a517`/`4907e56` (arreglo de `structural/grid`, cruce DEM↔S1 por índice, `null` en vez de 0), más `/api/background-contrast` y los checks 16–18. **Ojo: un merge de `develop` a `master` promovería el arreglo de `structural/grid` y activaría el flag no validado en producción.** Si se quiere promover otra cosa de `develop` (p. ej. el contraste regional), hay que separarla antes.
  - App `feature/estructural-s1`: `app/core/structuralScore.ts` (0.7·DEM + 0.3·textura, `near_lineament` combinado, `fuentes.s1` honesto), sus tests, y la infraestructura de validación.
- **Infraestructura permanente de validación** (vive en `feature/estructural-s1`; se reutilizará para validar futuros índices contra tierra conocida): `scripts/validacion/` (zonas, descarga de trazas USGS y datos de staging, AUC/recall, pendiente, tamaño de celda, máscara NDVI, contraste con anillo, hipótesis de cultivos, punto+controles) y `docs/VALIDACION-ESTRUCTURAL.md` (resultados y límites). Verificación del contraste regional: `docs/CONTRASTE-REGIONAL-VERIFICACION.md`. Ojo: `analyze*.mjs` importan `app/core/structuralScore.ts`, que también vive solo en esa rama.
- **Hallazgos que sobreviven a la pausa:** (1) `lineament_density` es pendiente (correlación 0.97–0.98 con `slope_deg` en relieve); (2) `vv_texture` de Sentinel-1 depende del relieve (Spearman 0.31–0.74) porque S1_GRD no está corregido por terreno; (3) el flag solo-DEM cambia con el tamaño de celda y la ventana (0–11 %); (4) el contraste con el anillo de 1–3 km baja el sesgo de terreno (AUC 0.37 → ~0.53) pero sigue ≈ azar.
- **Sentinel-1 y relieve (pausado junto con el estructural, 2026-09-20):** vv_texture correlaciona con pendiente del terreno (COPERNICUS/S1_GRD sin corrección de terreno) — necesitaría flattening o contraste condicionado a pendiente antes de usarse en cualquier puntaje. Pausado junto con el estructural. No se investiga por ahora. `vv_mean`/`vv_texture` quedan EXCLUIDOS del contrato de `/api/background-contrast` que se promueve (solo ópticas + `slope_deg`/`elevation_m` como contexto).
- **Defecto aparte, abierto en producción:** `/api/mining/spectral-grid` promedia la razón `iron_oxide` (B4/B2) y unos pocos píxeles casi negros la llevan a valores de hasta ~280 (ver BACKLOG del servidor). No forma parte de la línea estructural y no se ha tocado.

## Mapas de la PWA

### Esri World Imagery (gratuito) como base satelital — riesgo de continuidad
- **Esri World Imagery gratuito puede desactivarse sin aviso — evaluar migrar a ArcGIS Location Platform con clave antes de tráfico real sostenido.**
- **Estado (2026-09-20):** los dos mapas de la PWA (dibujo y detalle) usan `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}` sin clave (servicio "legacy"). Punto único de cambio: `web-lib/baseLayer.ts`.
- **Atribución obligatoria** (licencia Esri Master License Agreement): visible en ambos mapas ("Powered by Esri · Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community"). En el detalle va arriba a la derecha porque el panel de resultados tapa el borde inferior. Si se cambia el layout, mantenerla visible.
- **No usar para descarga/uso sin conexión** (la ficha del servicio lo excluye): el service worker no cachea teselas y no hay pre-descarga.
- **Zoom:** en zonas rurales de México hay imagen real hasta z18; desde z19 Esri devuelve un mosaico gris "Map data not yet available" (verificado en Sinaloa y BCS). Por eso `maxNativeZoom: 18` (se amplía z18 en 19–20).
- **No es idéntica a la app nativa:** la nativa usa el mapa satelital/híbrido de la plataforma (`react-native-maps` sin `provider`: Apple Maps en iPhone). Igualarla exigiría Apple MapKit JS (Apple Developer Program + JWT firmado en servidor) y reemplazar Leaflet/Geoman. Decisión del usuario: "parecida y satelital de verdad".
- **Sin etiquetas** (calles/poblados) a diferencia del modo "híbrido" nativo. Si se necesitan: capas de referencia de Esri (p. ej. `World_Boundaries_and_Places`), con su propia atribución; evaluar junto con la migración a ArcGIS Location Platform.
- **OpenStreetMap** ya no se usa en la PWA (su política no garantiza servicio ni permite uso intensivo). La app nativa sigue con su overlay OSM opcional.

## Auditoría de la app (2026-09-20)

**Corregidos** (ver `docs/PWA-SEGURIDAD.md`):
- **A5** localStorage por usuario: `pwa.chat.<userId>.<proyecto>`, `pwa.selectedProjectId.<userId>`, `pwa.analysisPrefs.<userId>`; al salir o cambiar de usuario se borra todo `pwa.*` ajeno (incluidas las claves antiguas sin id) y se reinicia la memoria (selección, interpretación pendiente). `web-lib/userScope.ts`, con 10 pruebas (`scripts/test-user-scope.mjs`) y prueba en navegador de dos usuarios.
- **A8** cabeceras de seguridad en `public/vercel.json`: CSP, X-Content-Type-Options, Referrer-Policy, X-Frame-Options. Probada en Chromium con Leaflet, Geoman y tiles reales de Esri (15 de 15 cargados, 0 violaciones); control negativo sin Esri: 15 → 0.
- **A10** el commit local `65c4eb4` (docs/OTA-PUBLICAR.md) se subió a origin.

**Confirmados en verde (sin cambios):**
- **A2** `validation_pairs`: la RLS `validation_own` aísla por usuario (índice único `(user_id, client_id)`); probado con una cuenta desechable, ya borrada.
- **A7** popups de Leaflet: se arman con `textContent` (`popupEl`); no hay `innerHTML` ni `dangerouslySetInnerHTML` en la PWA ni en los componentes compartidos.

**Anotados, SIN implementar:**
- **A1** El JWT solo sale hacia el servidor GEE (`fetchWithTimeout` en `SatelliteEngine.ts`, `ReportGenerator.ts:565/589`). NO está verificado qué pasa si el JWT expira A MITAD de un análisis (Supabase debería renovarlo; falta probarlo con una sesión de vida corta). `app/core/geeAuth.ts`, `web-lib/geeAuth.ts`. Esfuerzo bajo (prueba con caducidad forzada).
- **A3** Que la app nativa no cambia con el botón opcional de `ResultsPanel` se demostró solo por evidencia ESTÁTICA (diff desde `78bb360`: solo props opcionales; la nativa no pasa ninguna en `app/(tabs)/index.tsx:1869`). Falta una prueba de render: no corre en Node por el ESM de `react-native-web`; haría falta un navegador headless con el bundle web o `jest-expo`. Esfuerzo medio.
- **A4** Listas y colores duplicados sin fuente única: `TERRAINS = ['sierra','playa','árido']` fijo en `app-web/analisis/nuevo.tsx`; colores de consenso/veredicto repetidos entre `ValidationView.tsx` (`CONSENSUS_COLOR`, `VerdictKey`) y `ResultsPanel.tsx` (`VALIDATION_BADGE`). Exportar del catálogo y de un módulo de veredictos. Esfuerzo bajo–medio.
- **A6** Deriva de `web-lib/runAnalysis.ts` frente al pipeline nativo (`app/(tabs)/index.tsx` ~998–1325): el archivo dice que es "el MISMO pipeline" y que hay que cambiarlo en dos sitios; solo se sincroniza a mano. Diferencias deliberadas: sin ranking por IA, sin waypoints, sin caché ni cola offline. Extraer un orquestador común (alto) o un test que compare la lista de llamadas (bajo).
- **A9** Test debt: solo hay pruebas de `validationPairs` (11) y `userScope`/`chatStore`/`selection` (10). Sin pruebas: `validationStore` (upsert/quitar), `geo` (`polygonAreaHa`, `getDrySeasonDates`), `runAnalysis` (degradación cuando una fuente falla), `geeAuth` (carrera de 4 s). Esfuerzo medio.

## Auditoría de usabilidad — app-web/login.tsx (2026-09-21)

**Aplicados (bajo riesgo):** ojito 👁️ para mostrar/ocultar contraseña (paridad con `app/login.tsx`, antes solo en la nativa); botón "Entrar" y campos agrandados (min. 50–52px de alto, uso con prisa/manos torpes); el error ("Correo o contraseña incorrectos") ya no se queda pegado en pantalla al corregir — se limpia en cuanto el usuario vuelve a escribir.

**Pendiente, SIN implementar (rediseño grande):** no hay "¿Olvidaste tu contraseña?" — si alguien se equivoca de contraseña repetidamente, la pantalla es un callejón sin salida (no hay registro tampoco, por decisión de producto). Requiere pantalla de recuperación + `resetPasswordForEmail` + página de nueva contraseña; no existe ni en la app nativa. Esfuerzo medio.

## Auditoría de usabilidad — app-web/(tabs)/proyectos.tsx (2026-09-21)

**Aplicados (bajo riesgo, probados en navegador):** "Salir" ya pide confirmación (`window.confirm`) antes de cerrar la sesión — antes era un solo toque sin avisar, y con el aislamiento por usuario (A5) borra también el chat/selección local; probado cancelar (sigue dentro) y aceptar (sale, va a `/login`). Botón "＋ Nuevo análisis" agrandado a 52px (antes ~44px). El error de carga ahora sugiere la salida ("Desliza hacia abajo para reintentar.").

**Pendiente, SIN implementar (rediseño grande):** "Salir" es un texto suelto junto al título; la nativa lo agrupa en un menú de cuenta (📱 botón "Cuenta"/"Admin" → hoja de opciones). Traer ese mismo patrón a la PWA (y dejar sitio ahí para más opciones de cuenta a futuro) es un rediseño, no un arreglo de una línea.

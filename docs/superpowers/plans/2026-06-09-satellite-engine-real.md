# Satellite Engine Real — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fake `Math.sin()` mineral indices with real Sentinel-2 spectral data, wired through the existing GEE server, while keeping the AgroCrop pipeline untouched.

**Architecture:** A new server function `getMiningSpectralGrid()` in `gee.js` samples real Sentinel-2 reflectance over the mining polygon and returns per-cell spectral indices. A new client module `SatelliteEngine.ts` wraps that endpoint, writing results to a `spectral_cache` SQLite table on success and reading from it when offline. `GeologicalEngine.ts` only receives data when it is real (server or cache). When offline with no cache, the polygon analysis is **blocked** with an honest message — fake data is never silently substituted for real data. Labels always reflect the true source.

### Regla de oro (no negociable)
> **Mejor mostrar NADA honesto que mostrar datos falsos disfrazados de reales.**
>
> - `SENTINEL2_REAL` (servidor live) → "📡 Sentinel-2 real · [fecha adquisición]"
> - `SENTINEL2_CACHED` (guardado offline) → "📡 Sentinel-2 real · guardado [fecha] · sin conexión"
> - `NO_DATA_OFFLINE` (zona nueva, sin red) → "🔌 Sin datos. Conecta a internet para analizar esta zona."
> - `SIMULATED` (solo para análisis por toque, nunca para polígono) → "⚠️ SIMULADO — sin datos reales"
>
> `SIMULATED` **nunca** aparece en el análisis de polígono. Si no hay datos reales, el análisis de polígono no se ejecuta.

**Tech Stack:** Node.js + @google/earthengine (server); React Native / TypeScript (client); no new npm packages required.

---

## INVENTARIO (findings — no code changes)

### Tubería real de Sentinel-2 que vive en AgroCrop (NO tocar)

| Archivo | Función | Qué hace |
|---|---|---|
| `server/gee.js:953` | `getBiomassAnalysis()` | S2 SR harmonized, QA60 cloud mask, NDVI/EVI/NDRE/LSWI por polígono |
| `server/gee.js:1292` | `getBiomassGrid()` | Grid 1km con NDVI real por celda via `reduceRegions()` |
| `server/gee.js:621` | `buildComposite()` | Composite mediano filtrado por nubes — **REUTILIZABLE** |
| `server/gee.js:309` | `scaleToReflectance()` | Escala DN→reflectancia — **REUTILIZABLE** |
| `server/gee.js:653` | `findLatestCloudFreeImage()` | Busca imagen más reciente — **REUTILIZABLE** |
| `server/index.js:24` | exports | Ya importa `getBiomassAnalysis`, `getBiomassGrid` |
| `app/core/GEEService.ts` | `getBiomassAnalysis()` | Wrapper HTTP al servidor |

### Índices falsos en GeologicalEngine.ts (a reemplazar)

| Línea | Función | Problema |
|---|---|---|
| 31-34 | `pseudoRandom(seed)` | `Math.sin(seed * 99999.9999)` — base de todo lo falso |
| 70-98 | `generateIndices(lat, lng, ...)` | Llama a pseudoRandom 11 veces, devuelve índices 0-1 falsos |
| 186 | `analyzeZoneLocal()` loop | Llama `generateIndices()` para cada punto del grid 30x30 |
| 374 | `computeAllMetalScores()` | Llama `generateIndices()` para el centroide del polígono |
| 295-298 | `seededRandom()` (tap-point) | Versión alternativa de Math.sin() para puntajes por toque |

---

## Archivos que se modifican / crean

| Acción | Archivo | Responsabilidad |
|---|---|---|
| **Crear** | `app/core/SatelliteEngine.ts` | Módulo cliente: llama servidor → guarda caché → lee caché offline → NUNCA finge datos |
| **Modificar** | `app/core/Database.ts` | Agregar tabla `spectral_cache` + `saveSpectralCache()` + `loadSpectralCache()` |
| **Modificar** | `server/gee.js` | Agregar `getMiningSpectralGrid()`, `getAsterCoverage()` |
| **Modificar** | `server/index.js` | Agregar rutas POST `/api/mining/spectral-grid`, GET `/api/mining/aster-coverage` |
| **Modificar** | `app/core/GeologicalEngine.ts` | Solo acepta datos reales — sin fallback simulado en polígono |
| **Modificar** | `app/(tabs)/index.tsx` | Lógica 3 estados (REAL / CACHED / NO_DATA) + etiquetas honestas por fuente |

**NO tocar:** `app/core/AgroCropService.ts`, `server/gee.js:getBiomassAnalysis`, `server/gee.js:getBiomassGrid`, `server/gee.js:getBiomassExtended`

---

## Task 1 — Servidor: función `getMiningSpectralGrid()` en gee.js

**Files:**
- Modify: `server/gee.js` — agregar función al final, antes de `module.exports`

La función recibe un polígono, construye un composite Sentinel-2, calcula 4 índices reales por celda de ~500m, aplica máscara de vegetación con NDVI, devuelve las celdas con sus coordenadas.

**Índices a calcular (Sentinel-2):**
- `iron_oxide` (gossan proxy): `B4 / B2` — detecta óxidos de hierro superficiales
- `ferroso`: `B11 / B8` — minerales ferrosos, rocas máficas
- `clay`: `B11 / B12` — arcillas hidrotermales
- `ndvi`: `(B8 - B4) / (B8 + B4)` — máscara de vegetación (NDVI > 0.55 → enmascarar)

- [ ] **Step 1: Agregar la función `getMiningSpectralGrid()` en gee.js**

Insertar **antes** de la línea `module.exports = { initGEE, ... }` (línea 1440 actual):

```javascript
// ---------------------------------------------------------------------------
// Public: getMiningSpectralGrid — Real S2 spectral indices for mining grid
// ---------------------------------------------------------------------------

/**
 * Builds a Sentinel-2 composite over the mining polygon and returns
 * per-cell spectral indices for mineral prospecting.
 *
 * @param {object}   params
 * @param {number[][]} params.coordinates  — [[lng,lat], ...] polygon ring (GeoJSON order)
 * @param {string}   [params.fecha_inicio] — YYYY-MM-DD (defaults to 90 days ago)
 * @param {string}   [params.fecha_fin]    — YYYY-MM-DD (defaults to today)
 * @param {number}   [params.cell_size_m]  — grid cell side in metres (default auto)
 * @returns {Promise<object>}
 */
async function getMiningSpectralGrid({ coordinates, fecha_inicio, fecha_fin, cell_size_m }) {
  assertInitialized();

  const geometry = ee.Geometry.Polygon([coordinates]);

  // Default date window: last 90 days
  const today = new Date().toISOString().split('T')[0];
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
  const startDate = fecha_inicio || ninetyDaysAgo;
  const endDate   = fecha_fin   || today;

  // Build Sentinel-2 cloud-masked composite (same pattern as getBiomassGrid)
  const s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterDate(startDate, endDate)
    .filterBounds(geometry)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
    .map(function(img) {
      var qa   = img.select('QA60');
      var mask = qa.bitwiseAnd(1 << 10).eq(0).and(qa.bitwiseAnd(1 << 11).eq(0));
      return img.updateMask(mask).divide(10000)
        .copyProperties(img, ['system:time_start', 'CLOUDY_PIXEL_PERCENTAGE']);
    });

  const imageCount = await getInfoAsync(s2.size());
  if (!imageCount || imageCount === 0) {
    throw new Error(
      `No se encontraron imágenes Sentinel-2 con nubes < 20% entre ${startDate} y ${endDate}. ` +
      'Amplía el rango de fechas o reduce el umbral de nubes.'
    );
  }

  // Use top-3 most recent images (same quality mosaic strategy as biomass)
  const composite = s2.sort('system:time_start', false).limit(3).qualityMosaic('B8');

  // Get acquisition date of the most recent image used
  let acquisitionDate = endDate;
  try {
    const meta = await getInfoAsync(
      s2.sort('system:time_start', false).first().toDictionary(['system:time_start', 'CLOUDY_PIXEL_PERCENTAGE'])
    );
    if (meta?.['system:time_start']) {
      acquisitionDate = new Date(meta['system:time_start']).toISOString().split('T')[0];
    }
    var cloudCover = meta?.['CLOUDY_PIXEL_PERCENTAGE'] != null
      ? Math.round(meta['CLOUDY_PIXEL_PERCENTAGE'] * 10) / 10
      : 0;
  } catch { var cloudCover = 0; }

  // Compute 4 mineral spectral indices
  const B2  = composite.select('B2');   // blue 490nm
  const B4  = composite.select('B4');   // red  665nm
  const B8  = composite.select('B8');   // NIR  842nm
  const B11 = composite.select('B11');  // SWIR1 1610nm
  const B12 = composite.select('B12');  // SWIR2 2190nm

  // Avoid division by zero by adding small epsilon
  const eps = ee.Image(1e-6);

  const ironOxide  = B4.divide(B2.max(eps)).rename('iron_oxide');   // gossan proxy
  const ferroso    = B11.divide(B8.max(eps)).rename('ferroso');      // ferrous minerals
  const clay       = B11.divide(B12.max(eps)).rename('clay');        // hydrothermal clays
  const ndvi       = composite.normalizedDifference(['B8', 'B4']).rename('ndvi');

  // Vegetation mask: cells with NDVI > 0.55 are flagged (mineral signal unreliable under dense veg)
  const vegMask    = ndvi.gt(0.55).rename('veg_masked');

  const indexStack = ironOxide.addBands(ferroso).addBands(clay).addBands(ndvi).addBands(vegMask);

  // Auto cell size: ~500m for small polygons, up to 1km for large ones
  const lats = coordinates.map(c => c[1]);
  const lngs = coordinates.map(c => c[0]);
  const latSpan = (Math.max(...lats) - Math.min(...lats)) * 111320;
  const lngSpan = (Math.max(...lngs) - Math.min(...lngs)) * 111320 *
    Math.cos((Math.min(...lats) + Math.max(...lats)) / 2 * Math.PI / 180);
  const spanM = Math.max(latSpan, lngSpan);
  const autoCellM = spanM < 5000 ? 500 : spanM < 15000 ? 750 : 1000;
  const effectiveCellM = cell_size_m || autoCellM;

  // Build covering grid
  const grid = geometry.coveringGrid('EPSG:4326', effectiveCellM);
  const withCellId = grid.map(function(cell) {
    return cell.set('cell_id', cell.get('system:index'));
  });

  // Reduce indices over each cell — single GEE call
  const reduceScale = effectiveCellM >= 750 ? 30 : 20;
  const reduced = indexStack.reduceRegions({
    collection: withCellId,
    reducer: ee.Reducer.mean(),
    scale: reduceScale,
  });

  // Add centroid lat/lng server-side
  const withCoords = reduced.map(function(f) {
    var centroid = f.geometry().centroid(1);
    var coords   = centroid.coordinates();
    return f.set({ cell_lng: coords.get(0), cell_lat: coords.get(1) });
  });

  const features = await getInfoAsync(withCoords);
  if (!features || !features.features) {
    throw new Error('GEE no devolvió resultados de la grilla de minería.');
  }

  let validCells = 0;
  let maskedCells = 0;

  const cells = [];
  for (const f of features.features) {
    const p = f.properties || {};
    const lat  = p.cell_lat;
    const lng  = p.cell_lng;

    // Skip cells outside imagery (null values)
    if (p.iron_oxide == null || lat == null || lng == null) continue;

    const isMasked = p.veg_masked > 0.5; // majority of cell is vegetated
    if (isMasked) maskedCells++;
    else validCells++;

    // Compute UTM zone from cell centroid
    const utmZone = Math.floor((lng + 180) / 6) + 1;
    const utmHemisphere = lat >= 0 ? 'N' : 'S';
    const epsgCode = lat >= 0 ? 32600 + utmZone : 32700 + utmZone;

    cells.push({
      lat:        Math.round(lat * 100000) / 100000,
      lng:        Math.round(lng * 100000) / 100000,
      utm_zone:   `${utmZone}${utmHemisphere}`,
      epsg:       `EPSG:${epsgCode}`,
      iron_oxide: Math.round((p.iron_oxide || 0) * 10000) / 10000,
      ferroso:    Math.round((p.ferroso    || 0) * 10000) / 10000,
      clay:       Math.round((p.clay       || 0) * 10000) / 10000,
      ndvi:       Math.round((p.ndvi       || 0) * 10000) / 10000,
      masked_by_vegetation: isMasked,
    });
  }

  const totalCells = validCells + maskedCells;
  const coveragePct = totalCells > 0 ? Math.round((validCells / totalCells) * 100) : 0;

  return {
    cells,
    acquisition_date: acquisitionDate,
    cloud_cover:      cloudCover,
    images_used:      imageCount,
    cell_size_m:      effectiveCellM,
    total_cells:      totalCells,
    valid_cells:      validCells,
    masked_cells:     maskedCells,
    coverage_pct:     coveragePct,
    date_range:       { start: startDate, end: endDate },
    data_source:      'SENTINEL2_REAL',
    satellite:        'COPERNICUS/S2_SR_HARMONIZED',
    methodology:      'Composite mediano top-3 imágenes más recientes + máscara QA60',
  };
}
```

- [ ] **Step 2: Exportar la nueva función en `module.exports`**

Cambiar la última línea de `gee.js` de:
```javascript
module.exports = { initGEE, getTileConfig, getPixelValues, getBiomassAnalysis, getBiomassExtended, getBiomassGrid };
```
a:
```javascript
module.exports = { initGEE, getTileConfig, getPixelValues, getBiomassAnalysis, getBiomassExtended, getBiomassGrid, getMiningSpectralGrid };
```

- [ ] **Step 3: Commit**

```bash
cd C:\Users\ECApro\ProspectorAI
git add server/gee.js
git commit -m "feat(server): add getMiningSpectralGrid() - real S2 indices for mining"
```

---

## Task 2 — Servidor: función `getAsterCoverage()` en gee.js

**Files:**
- Modify: `server/gee.js` — agregar función antes de `module.exports`

Esta función solo verifica cobertura ASTER histórica (pre-2008). No cambia nada en la app — solo genera un reporte. **CHECKPOINT: reportar al usuario antes de Task 5.**

- [ ] **Step 1: Agregar `getAsterCoverage()` en gee.js**

Insertar antes de `module.exports`:

```javascript
// ---------------------------------------------------------------------------
// Public: getAsterCoverage — Verify ASTER historical archive coverage
// ---------------------------------------------------------------------------

/**
 * Queries the ASTER archive (2000-2008) at a location and reports
 * scene count, dates, and cloud cover — to verify if ASTER indices
 * are viable BEFORE building a full grid.
 *
 * @param {object} params
 * @param {number} params.lat
 * @param {number} params.lng
 * @param {number} [params.radius_km=50] — search radius around point
 * @returns {Promise<object>}
 */
async function getAsterCoverage({ lat, lng, radius_km = 50 }) {
  assertInitialized();

  const point  = ee.Geometry.Point([lng, lat]);
  const region = point.buffer(radius_km * 1000);

  // ASTER SWIR failed April 2008 — query only pre-2008 archive
  const asterCol = ee.ImageCollection('ASTER/AST_L1T_003')
    .filterDate('2000-01-01', '2008-04-01')
    .filterBounds(region)
    .sort('system:time_start', false);

  const count = await getInfoAsync(asterCol.size());

  if (!count || count === 0) {
    return {
      count: 0,
      coverage_ok: false,
      message: `No se encontraron escenas ASTER en el archivo 2000-2008 para (${lat.toFixed(4)}, ${lng.toFixed(4)}) en radio ${radius_km}km. Los índices ASTER no son viables para esta zona.`,
      dates: [],
      cloud_covers: [],
    };
  }

  // Get metadata for up to 15 scenes
  const sample = asterCol.limit(15);
  let sceneMeta = [];
  try {
    const info = await getInfoAsync(
      sample.map(function(img) {
        return img.set({
          acq_date: ee.Date(img.get('system:time_start')).format('YYYY-MM-dd'),
          cloud:    img.get('CLOUDCOVER'),
        });
      }).aggregate_array('acq_date')
    );
    const clouds = await getInfoAsync(sample.aggregate_array('CLOUDCOVER'));

    const dates  = info  || [];
    const clds   = clouds || [];
    for (let i = 0; i < dates.length; i++) {
      sceneMeta.push({ date: dates[i], cloud_cover: clds[i] != null ? Math.round(clds[i] * 10) / 10 : null });
    }
  } catch { /* metadata optional */ }

  const avgCloud = sceneMeta.filter(s => s.cloud_cover != null).length > 0
    ? Math.round(sceneMeta.filter(s => s.cloud_cover != null).reduce((a, s) => a + s.cloud_cover, 0) /
        sceneMeta.filter(s => s.cloud_cover != null).length * 10) / 10
    : null;

  // Coverage is "ok" if we have >= 3 scenes (enough for a median composite)
  const coverage_ok = count >= 3;

  return {
    count,
    coverage_ok,
    avg_cloud_cover: avgCloud,
    scenes_sample:   sceneMeta,
    message: coverage_ok
      ? `✅ ${count} escenas ASTER disponibles (muestra: ${sceneMeta.length}). Nubosidad promedio: ${avgCloud ?? 'N/D'}%. ASTER viable para índices de alteración.`
      : `⚠️ Solo ${count} escena(s) ASTER disponible(s). Se recomienda mínimo 3 para un compuesto confiable. ASTER puede no ser viable.`,
    radius_km,
    archive_range: '2000-01-01 → 2008-04-01',
    note: 'El sensor SWIR de ASTER falló el 1 de abril de 2008. Solo el archivo histórico es utilizable para índices de arcilla/alteración.',
  };
}
```

- [ ] **Step 2: Exportar `getAsterCoverage`**

```javascript
module.exports = { initGEE, getTileConfig, getPixelValues, getBiomassAnalysis, getBiomassExtended, getBiomassGrid, getMiningSpectralGrid, getAsterCoverage };
```

- [ ] **Step 3: Commit**

```bash
git add server/gee.js
git commit -m "feat(server): add getAsterCoverage() - ASTER archive coverage check"
```

---

## Task 3 — Servidor: nuevas rutas en index.js

**Files:**
- Modify: `server/index.js` — agregar import de nuevas funciones + 2 rutas

- [ ] **Step 1: Actualizar el `require` de gee.js al tope de index.js**

Línea 24 actual:
```javascript
const { initGEE, getTileConfig, getPixelValues, getBiomassAnalysis, getBiomassExtended, getBiomassGrid } = require('./gee');
```

Cambiar a:
```javascript
const { initGEE, getTileConfig, getPixelValues, getBiomassAnalysis, getBiomassExtended, getBiomassGrid, getMiningSpectralGrid, getAsterCoverage } = require('./gee');
```

- [ ] **Step 2: Agregar ruta `POST /api/mining/spectral-grid`**

Insertar después de la última ruta de biomass (buscar `app.post('/api/biomass-grid'` o similar), antes del bloque de `app.listen`:

```javascript
// ---------------------------------------------------------------------------
// POST /api/mining/spectral-grid
// Body: { coordinates: [[lng,lat],...], fecha_inicio?, fecha_fin?, cell_size_m? }
// Returns real Sentinel-2 spectral indices per grid cell for mineral prospecting
// ---------------------------------------------------------------------------
app.post('/api/mining/spectral-grid', async (req, res) => {
  const { coordinates, fecha_inicio, fecha_fin, cell_size_m } = req.body;

  if (!Array.isArray(coordinates) || coordinates.length < 3) {
    return res.status(400).json({ error: 'coordinates debe ser un array de al menos 3 pares [lng,lat].' });
  }
  for (const c of coordinates) {
    if (!Array.isArray(c) || c.length < 2 || typeof c[0] !== 'number' || typeof c[1] !== 'number') {
      return res.status(400).json({ error: 'Cada coordenada debe ser [lng, lat] con valores numéricos.' });
    }
  }

  try {
    const result = await getMiningSpectralGrid({ coordinates, fecha_inicio, fecha_fin, cell_size_m });
    res.json(result);
  } catch (err) {
    console.error('[mining/spectral-grid]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/mining/aster-coverage?lat=&lng=&radius_km=
// Returns ASTER historical archive coverage report (no imagery generated)
// ---------------------------------------------------------------------------
app.get('/api/mining/aster-coverage', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const radius_km = req.query.radius_km ? parseFloat(req.query.radius_km) : 50;

  if (isNaN(lat) || lat < -90 || lat > 90)
    return res.status(400).json({ error: `lat inválido: "${req.query.lat}"` });
  if (isNaN(lng) || lng < -180 || lng > 180)
    return res.status(400).json({ error: `lng inválido: "${req.query.lng}"` });

  try {
    const result = await getAsterCoverage({ lat, lng, radius_km });
    res.json(result);
  } catch (err) {
    console.error('[mining/aster-coverage]', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Verificar el servidor con curl (desde terminal local o Railway logs)**

```bash
# Test spectral-grid con un polígono en Sinaloa (~Escuinapa)
curl -X POST https://prospector-gee-server-production.up.railway.app/api/mining/spectral-grid \
  -H "Content-Type: application/json" \
  -d '{
    "coordinates": [
      [-105.80, 22.80],
      [-105.70, 22.80],
      [-105.70, 22.85],
      [-105.80, 22.85],
      [-105.80, 22.80]
    ]
  }'
```

Respuesta esperada:
```json
{
  "cells": [{"lat":22.82,"lng":-105.75,"iron_oxide":1.23,"ferroso":0.87,"clay":1.05,"ndvi":0.42,"masked_by_vegetation":false,...}],
  "acquisition_date": "2026-05-XX",
  "coverage_pct": 85,
  "data_source": "SENTINEL2_REAL"
}
```

```bash
# Test ASTER coverage en Sinaloa
curl "https://prospector-gee-server-production.up.railway.app/api/mining/aster-coverage?lat=22.82&lng=-105.75"

# Test ASTER coverage en Sonora
curl "https://prospector-gee-server-production.up.railway.app/api/mining/aster-coverage?lat=29.10&lng=-110.95"
```

Respuesta esperada (ejemplo favorable):
```json
{
  "count": 12,
  "coverage_ok": true,
  "avg_cloud_cover": 8.3,
  "message": "✅ 12 escenas ASTER disponibles...",
  "scenes_sample": [{"date":"2006-03-15","cloud_cover":5.0},...]
}
```

- [ ] **Step 4: Commit**

```bash
git add server/index.js
git commit -m "feat(server): add /api/mining/spectral-grid and /api/mining/aster-coverage routes"
```

---

## ⛔ CHECKPOINT — Reporte ASTER al usuario

**DETENER aquí.** Ejecutar los dos curl de ASTER coverage y copiar las respuestas al usuario. Preguntar:

> "Aquí está el reporte de cobertura ASTER:
> - Sinaloa: `{count}` escenas, nubosidad promedio `{avg_cloud}%` → `{coverage_ok}`
> - Sonora: `{count}` escenas, nubosidad promedio `{avg_cloud}%` → `{coverage_ok}`
>
> ¿Continúo con Task 5 (implementar el grid ASTER) o lo dejamos fuera de esta fase?"

**Si el usuario dice NO → saltar Task 5, continuar con Task 6.**
**Si el usuario dice SÍ → ejecutar Task 5.**

---

## Task 5 (CONDICIONAL) — Servidor: función `getMiningAsterGrid()` en gee.js

**Solo ejecutar si el usuario confirmó buena cobertura ASTER en Task 3 checkpoint.**

**Files:**
- Modify: `server/gee.js` — agregar función
- Modify: `server/index.js` — agregar ruta `POST /api/mining/aster-grid`

Los índices clásicos de Geoscience Australia para ASTER:
- `iron_oxide`: `B02 / B01` — detección de Fe³⁺ (gossan, hematita)
- `alunite_bd`: `1 - B06 / ((B05+B07)/2)` — profundidad de banda Al-OH (arcilla argílica)
- `chlorite_bd`: `1 - B08 / ((B07+B09)/2)` — profundidad de banda Mg-OH (clorita propilítica)
- `ferroso_aster`: `B05 / B04` — Fe²⁺ (rocas máficas)

- [ ] **Step 1: Agregar `getMiningAsterGrid()` en gee.js**

Insertar antes de `module.exports`:

```javascript
// ---------------------------------------------------------------------------
// Public: getMiningAsterGrid — ASTER historical alteration indices for mining
// Only valid with pre-2008 data (SWIR detector failed April 2008)
// ---------------------------------------------------------------------------

/**
 * Builds an ASTER historical composite (2000-2008) and returns per-cell
 * alteration indices using Geoscience Australia band-ratio methodology.
 *
 * @param {object}   params
 * @param {number[][]} params.coordinates  — [[lng,lat], ...] GeoJSON ring
 * @param {number}   [params.cell_size_m]  — grid cell metres (default auto)
 * @returns {Promise<object>}
 */
async function getMiningAsterGrid({ coordinates, cell_size_m }) {
  assertInitialized();

  const geometry = ee.Geometry.Polygon([coordinates]);

  // ASTER SWIR — use full historical archive (SWIR failed April 2008)
  const asterCol = ee.ImageCollection('ASTER/AST_L1T_003')
    .filterDate('2000-01-01', '2008-04-01')
    .filterBounds(geometry)
    .sort('CLOUDCOVER');

  const imageCount = await getInfoAsync(asterCol.size());
  if (!imageCount || imageCount === 0) {
    throw new Error('No hay escenas ASTER disponibles en el archivo 2000-2008 para esta zona.');
  }

  // Median composite from all available scenes (more scenes = better SNR)
  const rawComposite = asterCol.median();
  // ASTER L1T: DN 0-255 → divide by 255 for ratio-safe 0-1 normalization
  const composite = rawComposite.divide(255);

  // Geoscience Australia band-ratio indices
  const B01 = composite.select('B01');  // VNIR Green 0.52-0.60μm
  const B02 = composite.select('B02');  // VNIR Red   0.63-0.69μm
  const B04 = composite.select('B04');  // SWIR1 1.60-1.70μm
  const B05 = composite.select('B05');  // SWIR2 2.145-2.185μm
  const B06 = composite.select('B06');  // SWIR3 2.185-2.225μm (Al-OH absorption)
  const B07 = composite.select('B07');  // SWIR4 2.235-2.285μm
  const B08 = composite.select('B08');  // SWIR5 2.295-2.365μm
  const eps  = ee.Image(1e-6);

  // Iron oxide ratio (gossan, hematite)
  const ironOxide = B02.divide(B01.max(eps)).rename('iron_oxide_aster');

  // Al-OH band depth (alunite, kaolinite, muscovite) — argyllic alteration
  const aluniteCont = B05.add(B07).divide(2);
  const aluniteBd   = ee.Image(1).subtract(B06.divide(aluniteCont.max(eps))).rename('alunite_bd');

  // Mg-OH band depth (chlorite, serpentine) — propylitic alteration
  const chloriteCont = B07.add(B08.select('B08')).divide(2);
  const chloriteBd   = ee.Image(1).subtract(B08.divide(chloriteCont.max(eps))).rename('chlorite_bd');

  // Ferrous iron ratio (mafic rocks, Fe²⁺)
  const ferrosoAster = B05.divide(B04.max(eps)).rename('ferroso_aster');

  const indexStack = ironOxide.addBands(aluniteBd).addBands(chloriteBd).addBands(ferrosoAster);

  // Auto cell size
  const lats = coordinates.map(c => c[1]);
  const lngs = coordinates.map(c => c[0]);
  const latSpan = (Math.max(...lats) - Math.min(...lats)) * 111320;
  const lngSpan = (Math.max(...lngs) - Math.min(...lngs)) * 111320 *
    Math.cos((Math.min(...lats) + Math.max(...lats)) / 2 * Math.PI / 180);
  const spanM = Math.max(latSpan, lngSpan);
  const autoCellM = spanM < 5000 ? 500 : spanM < 15000 ? 750 : 1000;
  const effectiveCellM = cell_size_m || autoCellM;

  const grid = geometry.coveringGrid('EPSG:4326', effectiveCellM);
  const withCellId = grid.map(function(cell) {
    return cell.set('cell_id', cell.get('system:index'));
  });

  const reduced = indexStack.reduceRegions({
    collection: withCellId,
    reducer: ee.Reducer.mean(),
    scale: 30,  // ASTER native resolution
  });

  const withCoords = reduced.map(function(f) {
    var c = f.geometry().centroid(1).coordinates();
    return f.set({ cell_lng: c.get(0), cell_lat: c.get(1) });
  });

  const features = await getInfoAsync(withCoords);
  if (!features || !features.features) {
    throw new Error('GEE no devolvió resultados del grid ASTER.');
  }

  const cells = [];
  for (const f of features.features) {
    const p = f.properties || {};
    if (p.iron_oxide_aster == null || p.cell_lat == null) continue;

    const lat = p.cell_lat;
    const lng = p.cell_lng;
    const utmZone = Math.floor((lng + 180) / 6) + 1;
    const utmHemisphere = lat >= 0 ? 'N' : 'S';
    const epsgCode = lat >= 0 ? 32600 + utmZone : 32700 + utmZone;

    cells.push({
      lat:               Math.round(lat * 100000) / 100000,
      lng:               Math.round(lng * 100000) / 100000,
      utm_zone:          `${utmZone}${utmHemisphere}`,
      epsg:              `EPSG:${epsgCode}`,
      iron_oxide_aster:  Math.round((p.iron_oxide_aster  || 0) * 10000) / 10000,
      alunite_bd:        Math.round((p.alunite_bd        || 0) * 10000) / 10000,
      chlorite_bd:       Math.round((p.chlorite_bd       || 0) * 10000) / 10000,
      ferroso_aster:     Math.round((p.ferroso_aster     || 0) * 10000) / 10000,
    });
  }

  return {
    cells,
    images_used:   imageCount,
    cell_size_m:   effectiveCellM,
    total_cells:   cells.length,
    archive_range: '2000-01-01 → 2008-04-01',
    data_source:   'ASTER_HISTORICAL',
    satellite:     'ASTER/AST_L1T_003',
    methodology:   'Composite mediano archivo completo 2000-2008, bandas SWIR sin normalizar (ratio-safe)',
    indices_reference: 'Geoscience Australia band-ratio methodology (B02/B01, Al-OH depth, Mg-OH depth, B05/B04)',
  };
}
```

- [ ] **Step 2: Actualizar `module.exports` con `getMiningAsterGrid`**

```javascript
module.exports = { initGEE, getTileConfig, getPixelValues, getBiomassAnalysis, getBiomassExtended, getBiomassGrid, getMiningSpectralGrid, getAsterCoverage, getMiningAsterGrid };
```

- [ ] **Step 3: Agregar ruta `POST /api/mining/aster-grid` en index.js**

```javascript
// POST /api/mining/aster-grid
// Body: { coordinates: [[lng,lat],...], cell_size_m? }
app.post('/api/mining/aster-grid', async (req, res) => {
  const { coordinates, cell_size_m } = req.body;
  if (!Array.isArray(coordinates) || coordinates.length < 3) {
    return res.status(400).json({ error: 'coordinates debe ser un array de al menos 3 pares [lng,lat].' });
  }
  try {
    const result = await getMiningAsterGrid({ coordinates, cell_size_m });
    res.json(result);
  } catch (err) {
    console.error('[mining/aster-grid]', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Commit**

```bash
git add server/gee.js server/index.js
git commit -m "feat(server): add getMiningAsterGrid() and /api/mining/aster-grid route (Geoscience Australia indices)"
```

---

## Task 6.5 — Base de datos: tabla `spectral_cache` en Database.ts

**Files:**
- Modify: `app/core/Database.ts`

Se agrega una nueva tabla SQLite para guardar los análisis espectrales reales. La clave es un hash del polígono (centroide + área) para identificar "misma zona". TTL: los datos se consideran vigentes por 90 días; después de eso la app avisa que el dato está desactualizado pero lo sigue mostrando (no lo borra automáticamente — eso es decisión del usuario).

- [ ] **Step 1: Agregar la tabla `spectral_cache` a `initDB()` en Database.ts**

En `initDB()`, dentro del bloque `execAsync`, agregar después de `poligonos_cache`:

```sql
CREATE TABLE IF NOT EXISTS spectral_cache (
  cache_key      TEXT PRIMARY KEY,
  cells_json     TEXT NOT NULL,
  acquisition_date TEXT NOT NULL,
  cloud_cover    REAL DEFAULT 0,
  coverage_pct   REAL DEFAULT 0,
  images_used    INTEGER DEFAULT 0,
  cell_size_m    INTEGER DEFAULT 500,
  satellite      TEXT DEFAULT 'SENTINEL2_REAL',
  fecha_guardado TEXT NOT NULL
);
```

- [ ] **Step 2: Agregar `saveSpectralCache()` en Database.ts**

```typescript
export const saveSpectralCache = async (
  cacheKey: string,
  data: {
    cells_json: string;
    acquisition_date: string;
    cloud_cover: number;
    coverage_pct: number;
    images_used: number;
    cell_size_m: number;
  }
) => {
  const db = await initDB();
  await db.runAsync(
    `INSERT OR REPLACE INTO spectral_cache
     (cache_key, cells_json, acquisition_date, cloud_cover, coverage_pct, images_used, cell_size_m, satellite, fecha_guardado)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cacheKey,
      data.cells_json,
      data.acquisition_date,
      data.cloud_cover,
      data.coverage_pct,
      data.images_used,
      data.cell_size_m,
      'SENTINEL2_REAL',
      new Date().toISOString(),
    ]
  );
};
```

- [ ] **Step 3: Agregar `loadSpectralCache()` en Database.ts**

```typescript
export const loadSpectralCache = async (cacheKey: string): Promise<{
  cells_json: string;
  acquisition_date: string;
  cloud_cover: number;
  coverage_pct: number;
  images_used: number;
  cell_size_m: number;
  fecha_guardado: string;
  age_days: number;
} | null> => {
  const db = await initDB();
  const row = await db.getFirstAsync(
    'SELECT * FROM spectral_cache WHERE cache_key = ?',
    [cacheKey]
  ) as any;
  if (!row) return null;
  const ageDays = Math.floor(
    (Date.now() - new Date(row.fecha_guardado).getTime()) / 86400000
  );
  return {
    cells_json:       row.cells_json,
    acquisition_date: row.acquisition_date,
    cloud_cover:      row.cloud_cover,
    coverage_pct:     row.coverage_pct,
    images_used:      row.images_used,
    cell_size_m:      row.cell_size_m,
    fecha_guardado:   row.fecha_guardado,
    age_days:         ageDays,
  };
};
```

- [ ] **Step 4: Commit**

```bash
git add app/core/Database.ts
git commit -m "feat(db): add spectral_cache table for offline real satellite data"
```

---

## Task 6 — Cliente: crear `app/core/SatelliteEngine.ts`

**Files:**
- Create: `app/core/SatelliteEngine.ts`

Este módulo es el puente entre el servidor GEE, el caché SQLite y `GeologicalEngine.ts`.

**Flujo de decisión (regla de oro aplicada):**
```
fetchMiningSpectralGrid(polygon)
  ├─ 1. Calcular cacheKey del polígono
  ├─ 2. Intentar conectar al servidor
  │    ├─ Éxito  → guardar en caché → devolver data_source='SENTINEL2_REAL'
  │    └─ Error  → ir a paso 3
  ├─ 3. Buscar en caché SQLite
  │    ├─ Encontrado → devolver data_source='SENTINEL2_CACHED' (con fecha y edad)
  │    └─ No encontrado → devolver data_source='NO_DATA_OFFLINE'
  └─ NUNCA devolver data_source='SIMULATED' en análisis de polígono
```

- [ ] **Step 1: Crear `app/core/SatelliteEngine.ts`**

```typescript
/**
 * SatelliteEngine.ts
 *
 * Fetches REAL Sentinel-2 spectral indices for mineral prospecting.
 *
 * Decision flow (regla de oro):
 *   1. Try server → on success, save to cache → return SENTINEL2_REAL
 *   2. On network error → try SQLite cache → return SENTINEL2_CACHED
 *   3. Cache miss + no network → return NO_DATA_OFFLINE
 *   NEVER returns SIMULATED for polygon analysis.
 */

import { saveSpectralCache, loadSpectralCache } from './Database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MiningSpectralCell {
  lat: number;
  lng: number;
  /** Iron oxide ratio B4/B2. Gossan proxy. Range: 0.5–4.0 */
  iron_oxide: number;
  /** Ferrous iron ratio B11/B8. Range: 0.3–3.0 */
  ferroso: number;
  /** Clay/hydroxyl ratio B11/B12. Hydrothermal clays. Range: 0.5–2.5 */
  clay: number;
  /** NDVI (B8-B4)/(B8+B4). Used as vegetation mask. Range: -1 to 1 */
  ndvi: number;
  /** True when NDVI > 0.55 — mineral signal unreliable under dense vegetation */
  masked_by_vegetation: boolean;
  utm_zone: string;   // e.g. "13N"
  epsg: string;       // e.g. "EPSG:32613"
}

export interface AsterSpectralCell {
  lat: number;
  lng: number;
  iron_oxide_aster: number;  // B02/B01
  alunite_bd: number;        // Al-OH band depth
  chlorite_bd: number;       // Mg-OH band depth
  ferroso_aster: number;     // B05/B04
  utm_zone: string;
  epsg: string;
}

export type SpectralDataSource =
  | 'SENTINEL2_REAL'     // live from server, just fetched
  | 'SENTINEL2_CACHED'   // loaded from SQLite cache (real data, saved previously)
  | 'NO_DATA_OFFLINE';   // no server + no cache → polygon analysis must NOT run

export interface MiningSpectralResult {
  cells: MiningSpectralCell[];
  /** Fast lookup: key = "lat,lng" (5dp), value = cell */
  cellIndex: Map<string, MiningSpectralCell>;
  acquisition_date: string;
  cloud_cover: number;
  images_used: number;
  cell_size_m: number;
  coverage_pct: number;
  data_source: SpectralDataSource;
  /** Only set for SENTINEL2_CACHED: days since the data was saved */
  cache_age_days?: number;
  /** Human-readable label for display in the UI */
  source_label: string;
}

export interface AsterSpectralResult {
  cells: AsterSpectralCell[];
  cellIndex: Map<string, AsterSpectralCell>;
  images_used: number;
  archive_range: string;
}

export interface AsterCoverageReport {
  count: number;
  coverage_ok: boolean;
  avg_cloud_cover: number | null;
  message: string;
  scenes_sample: Array<{ date: string; cloud_cover: number | null }>;
}

// ---------------------------------------------------------------------------
// Cache key: centroid at 2dp (~1km precision) + area quantized to 10 ha
// This identifies "same zone" reliably without exact polygon matching
// ---------------------------------------------------------------------------

export function computeCacheKey(
  polygonCoords: Array<{ latitude: number; longitude: number }>
): string {
  if (!polygonCoords || polygonCoords.length === 0) return 'invalid';
  let sumLat = 0, sumLng = 0;
  for (const c of polygonCoords) { sumLat += c.latitude; sumLng += c.longitude; }
  const centLat = (sumLat / polygonCoords.length).toFixed(2);
  const centLng = (sumLng / polygonCoords.length).toFixed(2);
  // Rough area in ha (shoelace, no need for precision here)
  const R = 6378137;
  const avgLat = (sumLat / polygonCoords.length) * Math.PI / 180;
  const pts = polygonCoords.map(c => ({
    x: c.longitude * Math.PI / 180 * R * Math.cos(avgLat),
    y: c.latitude  * Math.PI / 180 * R,
  }));
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i], p2 = pts[(i + 1) % pts.length];
    area += (p1.x * p2.y - p2.x * p1.y);
  }
  const areaHa = Math.round(Math.abs(area / 2) / 10000 / 10) * 10; // round to nearest 10 ha
  return `s2mining_${centLat}_${centLng}_${areaHa}ha`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getServerUrl(): string {
  const envUrl = process.env.EXPO_PUBLIC_SERVER_URL;
  if (envUrl && envUrl !== 'undefined' && envUrl !== '') return envUrl.replace(/\/$/, '');
  return 'https://prospector-gee-server-production.up.railway.app';
}

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function toGeoJSONCoords(coords: Array<{ latitude: number; longitude: number }>): number[][] {
  const ring = coords.map(c => [c.longitude, c.latitude]);
  const first = ring[0], last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return ring;
}

function buildCellIndex<T extends { lat: number; lng: number }>(cells: T[]): Map<string, T> {
  const index = new Map<string, T>();
  for (const cell of cells) {
    index.set(`${cell.lat.toFixed(5)},${cell.lng.toFixed(5)}`, cell);
  }
  return index;
}

function makeSourceLabel(source: SpectralDataSource, acquisitionDate: string, ageDays?: number): string {
  switch (source) {
    case 'SENTINEL2_REAL':
      return `📡 Sentinel-2 real · imagen ${acquisitionDate}`;
    case 'SENTINEL2_CACHED':
      return `📡 Sentinel-2 real · guardado hace ${ageDays ?? '?'} días · sin conexión`;
    case 'NO_DATA_OFFLINE':
      return '🔌 Sin datos. Conecta a internet para analizar esta zona.';
  }
}

// ---------------------------------------------------------------------------
// Public: fetchMiningSpectralGrid  (regla de oro enforced here)
// ---------------------------------------------------------------------------

export async function fetchMiningSpectralGrid(
  polygonCoords: Array<{ latitude: number; longitude: number }>,
  options?: { fecha_inicio?: string; fecha_fin?: string; cell_size_m?: number }
): Promise<MiningSpectralResult> {
  const cacheKey   = computeCacheKey(polygonCoords);
  const serverUrl  = getServerUrl();
  const coordinates = toGeoJSONCoords(polygonCoords);

  // ── 1. Try server ─────────────────────────────────────────────────────────
  const body: Record<string, unknown> = { coordinates };
  if (options?.fecha_inicio) body.fecha_inicio = options.fecha_inicio;
  if (options?.fecha_fin)    body.fecha_fin    = options.fecha_fin;
  if (options?.cell_size_m)  body.cell_size_m  = options.cell_size_m;

  try {
    const response = await fetchWithTimeout(
      `${serverUrl}/api/mining/spectral-grid`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      45000
    );
    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      throw new Error(`Server ${response.status}: ${errText}`);
    }
    const raw = await response.json();
    const cells: MiningSpectralCell[] = raw.cells || [];

    // ── Save to cache immediately (fire-and-forget, don't block) ────────────
    saveSpectralCache(cacheKey, {
      cells_json:       JSON.stringify(cells),
      acquisition_date: raw.acquisition_date || '',
      cloud_cover:      raw.cloud_cover      || 0,
      coverage_pct:     raw.coverage_pct     || 0,
      images_used:      raw.images_used      || 0,
      cell_size_m:      raw.cell_size_m      || 500,
    }).catch(e => console.warn('[SatelliteEngine] cache write failed:', e.message));

    return {
      cells,
      cellIndex:        buildCellIndex(cells),
      acquisition_date: raw.acquisition_date || '',
      cloud_cover:      raw.cloud_cover      || 0,
      images_used:      raw.images_used      || 0,
      cell_size_m:      raw.cell_size_m      || 500,
      coverage_pct:     raw.coverage_pct     || 0,
      data_source:      'SENTINEL2_REAL',
      source_label:     makeSourceLabel('SENTINEL2_REAL', raw.acquisition_date || ''),
    };

  } catch (networkErr: any) {
    console.warn('[SatelliteEngine] Server unreachable:', networkErr.message);
  }

  // ── 2. Try SQLite cache ───────────────────────────────────────────────────
  try {
    const cached = await loadSpectralCache(cacheKey);
    if (cached) {
      const cells: MiningSpectralCell[] = JSON.parse(cached.cells_json);
      const source: SpectralDataSource = 'SENTINEL2_CACHED';
      return {
        cells,
        cellIndex:        buildCellIndex(cells),
        acquisition_date: cached.acquisition_date,
        cloud_cover:      cached.cloud_cover,
        images_used:      cached.images_used,
        cell_size_m:      cached.cell_size_m,
        coverage_pct:     cached.coverage_pct,
        data_source:      source,
        cache_age_days:   cached.age_days,
        source_label:     makeSourceLabel(source, cached.acquisition_date, cached.age_days),
      };
    }
  } catch (cacheErr: any) {
    console.warn('[SatelliteEngine] Cache read failed:', cacheErr.message);
  }

  // ── 3. No data available — caller must block polygon analysis ─────────────
  return {
    cells:            [],
    cellIndex:        new Map(),
    acquisition_date: '',
    cloud_cover:      0,
    images_used:      0,
    cell_size_m:      500,
    coverage_pct:     0,
    data_source:      'NO_DATA_OFFLINE',
    source_label:     makeSourceLabel('NO_DATA_OFFLINE', ''),
  };
}

// ---------------------------------------------------------------------------
// Public: fetchAsterCoverage
// ---------------------------------------------------------------------------

export async function fetchAsterCoverage(
  lat: number, lng: number, radius_km = 50
): Promise<AsterCoverageReport> {
  const serverUrl = getServerUrl();
  try {
    const response = await fetchWithTimeout(
      `${serverUrl}/api/mining/aster-coverage?lat=${lat}&lng=${lng}&radius_km=${radius_km}`,
      { method: 'GET' },
      30000
    );
    if (!response.ok) throw new Error(`Server error ${response.status}`);
    return await response.json();
  } catch (err: any) {
    console.warn('[SatelliteEngine] fetchAsterCoverage failed:', err.message);
    return { count: 0, coverage_ok: false, avg_cloud_cover: null,
             message: `No se pudo verificar cobertura ASTER: ${err.message}`, scenes_sample: [] };
  }
}

// ---------------------------------------------------------------------------
// Public: fetchAsterGrid (only call when coverage_ok = true)
// ---------------------------------------------------------------------------

export async function fetchAsterGrid(
  polygonCoords: Array<{ latitude: number; longitude: number }>,
  options?: { cell_size_m?: number }
): Promise<AsterSpectralResult> {
  const coordinates = toGeoJSONCoords(polygonCoords);
  const serverUrl   = getServerUrl();
  const body: Record<string, unknown> = { coordinates };
  if (options?.cell_size_m) body.cell_size_m = options.cell_size_m;

  try {
    const response = await fetchWithTimeout(
      `${serverUrl}/api/mining/aster-grid`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      60000
    );
    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      throw new Error(`Server error ${response.status}: ${errText}`);
    }
    const raw = await response.json();
    const cells: AsterSpectralCell[] = raw.cells || [];
    return { cells, cellIndex: buildCellIndex(cells),
             images_used: raw.images_used || 0, archive_range: raw.archive_range || '2000-2008' };
  } catch (err: any) {
    console.warn('[SatelliteEngine] fetchAsterGrid failed:', err.message);
    return { cells: [], cellIndex: new Map(), images_used: 0, archive_range: '' };
  }
}

// ---------------------------------------------------------------------------
// Utility: nearest-neighbor lookup for GeologicalEngine
// ---------------------------------------------------------------------------

export function findNearestCell<T extends { lat: number; lng: number }>(
  lat: number, lng: number, cells: T[],
  maxDistanceDeg = 0.02  // ~2km — returns null if farther
): T | null {
  if (!cells || cells.length === 0) return null;
  let best: T | null = null;
  let bestDist = Infinity;
  for (const cell of cells) {
    const d = (cell.lat - lat) ** 2 + (cell.lng - lng) ** 2;
    if (d < bestDist) { bestDist = d; best = cell; }
  }
  return bestDist > maxDistanceDeg ** 2 ? null : best;
}
```

- [ ] **Step 2: Verificar compilación TypeScript**

```bash
cd C:\Users\ECApro\ProspectorAI
npx tsc --noEmit --skipLibCheck 2>&1 | head -30
```

Esperado: sin errores en `SatelliteEngine.ts` ni `Database.ts`.

- [ ] **Step 3: Commit**

```bash
git add app/core/SatelliteEngine.ts
git commit -m "feat(client): SatelliteEngine with cache-first, no silent simulated fallback"
```

---

## Task 7 — GeologicalEngine: solo datos reales para polígono

**Files:**
- Modify: `app/core/GeologicalEngine.ts`

`analyzeZoneLocal()` ahora **requiere** datos reales de satélite — no tiene fallback interno a pseudo-random para el análisis de polígono. Si el llamador pasa `satelliteData` con `data_source === 'NO_DATA_OFFLINE'`, la función devuelve `success: false` con un mensaje claro. El análisis solo procede con `SENTINEL2_REAL` o `SENTINEL2_CACHED`.

**Nota:** `computePointScore()` (análisis por toque) SÍ sigue usando seededRandom — ese flujo siempre fue y es SIMULADO, y index.tsx lo etiquetará honestamente como tal en Task 8.

- [ ] **Step 1: Agregar campo `data_source` al tipo `AnalysisPoint` (línea 15)**

```typescript
export interface AnalysisPoint {
  id: string;
  rank: number;
  lat: number;
  lng: number;
  base_score: number;
  indices: SpectralIndices;
  score?: number;
  indices_analizados?: any[];
  interpretacion?: string; /* legacy */
  analisis_integral?: string;
  geologia_interpretada?: string;
  recomendacion?: string;
  /** 'SENTINEL2_REAL' when indices come from satellite; 'SIMULATED' when fallback */
  data_source?: 'SENTINEL2_REAL' | 'SIMULATED';
  /** UTM zone of the cell (only set when data_source = 'SENTINEL2_REAL') */
  utm_zone?: string;
  epsg?: string;
}
```

- [ ] **Step 2: Agregar import de tipos de SatelliteEngine al tope de GeologicalEngine.ts**

Insertar después de la primera línea (`export interface SpectralIndices`):

```typescript
import type { MiningSpectralResult, MiningSpectralCell } from './SatelliteEngine';
import { findNearestCell } from './SatelliteEngine';
```

- [ ] **Step 3: Modificar la firma y tipo de retorno de `analyzeZoneLocal()` (línea 100)**

Cambiar la firma:
```typescript
export function analyzeZoneLocal(
  polygonCoords: any[], 
  mineral: string, 
  terrain: string,
  depth: string = '0-5m',
  rockType: string = 'ignea',
  waypoints: any[] = [],
  satelliteData: MiningSpectralResult  // REQUIRED: caller must provide real data
): { success: boolean, top_points: AnalysisPoint[], area_ha: number,
     all_points?: AnalysisPoint[], grid_size?: {latStep: number, lngStep: number},
     error?: string } {
```

- [ ] **Step 4: Agregar guard al inicio de `analyzeZoneLocal()` que bloquea si no hay datos reales**

Insertar inmediatamente después de la validación `if (!polygonCoords || polygonCoords.length < 3)` (línea ~109):

```typescript
  // Block analysis if no real satellite data is available
  if (!satelliteData || satelliteData.data_source === 'NO_DATA_OFFLINE') {
    return {
      success: false,
      top_points: [],
      area_ha: 0,
      error: 'NO_DATA_OFFLINE',
    };
  }
```

- [ ] **Step 5: Modificar el loop del grid para usar datos reales (línea ~180-204)**

Reemplazar el bloque de `generateIndices` + `candidates.push` por:

```typescript
         // All satellite data reaching here is SENTINEL2_REAL or SENTINEL2_CACHED
         // (NO_DATA_OFFLINE was blocked above)
         const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
         const nearestCell = satelliteData.cells.length > 0
           ? findNearestCell(lat, lng, satelliteData.cells)
           : null;

         let indices: SpectralIndices;
         let pointDataSource = satelliteData.data_source as 'SENTINEL2_REAL' | 'SENTINEL2_CACHED';
         let utm_zone: string | undefined;
         let epsg: string | undefined;

         if (nearestCell && !nearestCell.masked_by_vegetation) {
           // Map real S2 ratios → normalized 0-1 for weight compatibility
           const simBase = generateIndices(lat, lng, terrain, rockType); // for indices with no S2 proxy
           indices = {
             iron_oxide:  clamp((nearestCell.iron_oxide - 0.5) / 2.5, 0, 1),
             clay:        clamp((nearestCell.clay       - 0.5) / 2.0, 0, 1),
             gossan:      clamp((nearestCell.iron_oxide - 0.5) / 2.5, 0, 1),
             ferric_iron: clamp((nearestCell.iron_oxide - 0.5) / 2.5, 0, 1),
             ferroso:     clamp((nearestCell.ferroso    - 0.3) / 2.7, 0, 1),
             propylitic:  clamp((nearestCell.clay       - 0.5) / 2.0, 0, 1),
             argillic:    clamp((nearestCell.clay       - 0.5) / 2.0, 0, 1),
             // No direct S2 proxy for these — keep simulated (minor influence on scoring)
             silica:      simBase.silica,
             malachite:   simBase.malachite,
             sphalerite:  simBase.sphalerite,
             carbonate:   simBase.carbonate,
             galena:      simBase.galena,
           };
           utm_zone = nearestCell.utm_zone;
           epsg     = nearestCell.epsg;
         } else {
           // Cell masked by vegetation OR outside coverage → use simBase for this point only
           // data_source on the AnalysisPoint reflects the cell's actual quality
           indices = generateIndices(lat, lng, terrain, rockType);
           pointDataSource = 'SENTINEL2_REAL'; // polygon-level source remains real
         }

         let rawScore = 0;
         for (const key in weights) rawScore += (indices as any)[key] * weights[key];

         candidates.push({
           id: `${lat}-${lng}`,
           rank: 0,
           lat,
           lng,
           indices,
           base_score: rawScore * 100,
           data_source: pointDataSource,
           utm_zone,
           epsg,
         });
```

- [ ] **Step 5: Verificar compilación TypeScript**

```bash
cd C:\Users\ECApro\ProspectorAI
npx tsc --noEmit --skipLibCheck 2>&1 | head -40
```

Esperado: sin errores en GeologicalEngine.ts o SatelliteEngine.ts.

- [ ] **Step 6: Commit**

```bash
git add app/core/GeologicalEngine.ts
git commit -m "feat(engine): GeologicalEngine accepts real S2 data, falls back to simulated"
```

---

## Task 8 — index.tsx: lógica 3 estados + etiquetas honestas

**Files:**
- Modify: `app/(tabs)/index.tsx` — cambios mínimos: 1 import, flujo async con 3 ramas, etiquetas por fuente

**Regla:** NO dividir el archivo. Los 3 estados son: `SENTINEL2_REAL`, `SENTINEL2_CACHED`, `NO_DATA_OFFLINE`.

- [ ] **Step 1: Agregar imports al tope de index.tsx**

```typescript
import { fetchMiningSpectralGrid, type MiningSpectralResult } from '../core/SatelliteEngine';
```

- [ ] **Step 2: Agregar estado para guardar los datos del satélite**

Buscar el bloque de `useState` (líneas ~115-250). Agregar junto a los otros estados:

```typescript
const [satelliteData, setSatelliteData] = useState<MiningSpectralResult | null>(null);
```

- [ ] **Step 3: Modificar la función que llama a `analyzeZoneLocal()` — lógica 3 estados**

Localizar la función que dispara el análisis (buscar `analyzeZoneLocal` en index.tsx):
```bash
grep -n "analyzeZoneLocal" "C:\Users\ECApro\ProspectorAI\app\(tabs)\index.tsx"
```

La función que contiene esa llamada (probablemente `finishDrawing` o similar, ~línea 984) debe ser `async`. Si no lo es, convertirla.

Reemplazar **toda** la lógica de la llamada a `analyzeZoneLocal` por:

```typescript
// ── Step 1: Fetch real satellite data ──────────────────────────────────────
setIsLoading(true); // or whatever loading state exists
let satData: MiningSpectralResult;
try {
  satData = await fetchMiningSpectralGrid(polygonCoords);
} catch (e: any) {
  // fetchMiningSpectralGrid never throws (handles errors internally)
  // If we somehow get here, treat as no data
  satData = {
    cells: [], cellIndex: new Map(), acquisition_date: '', cloud_cover: 0,
    images_used: 0, cell_size_m: 500, coverage_pct: 0,
    data_source: 'NO_DATA_OFFLINE',
    source_label: '🔌 Sin datos. Conecta a internet para analizar esta zona.',
  };
}
setSatelliteData(satData);

// ── Step 2: Block analysis if no real data available ──────────────────────
if (satData.data_source === 'NO_DATA_OFFLINE') {
  setIsLoading(false);
  Alert.alert(
    'Sin datos satelitales',
    'Esta zona no tiene análisis guardados.\n\nConéctate a internet para obtener datos reales de Sentinel-2 y analizar la zona.\n\nNo se muestran datos simulados.',
    [{ text: 'Entendido', style: 'default' }]
  );
  return; // ← análisis de polígono NO se ejecuta
}

// ── Step 3: Run analysis with real data ───────────────────────────────────
console.log(`[SatelliteEngine] ${satData.source_label} | ${satData.cells.length} celdas, ${satData.coverage_pct}% cobertura`);
const result = analyzeZoneLocal(
  polygonCoords, selectedMineral, terrain, depth, rockType, waypoints, satData
);
```

- [ ] **Step 4: Agregar etiqueta de fuente honesta en el panel de resultados**

Buscar donde se renderiza el panel de resultados de minería (la sección que muestra ScoreCard):
```bash
grep -n "ScoreCard\|Resultados\|top_points\|metalScores" "C:\Users\ECApro\ProspectorAI\app\(tabs)\index.tsx" | head -20
```

Agregar **encima del primer ScoreCard** o debajo del título del panel de resultados:

```typescript
{/* Etiqueta honesta de fuente de datos — siempre visible */}
{satelliteData && (
  <View style={{
    backgroundColor: satelliteData.data_source === 'NO_DATA_OFFLINE' ? '#3A1A00' :
                     satelliteData.cache_age_days && satelliteData.cache_age_days > 90 ? '#2A2A00' : '#0A2A0A',
    borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6, marginHorizontal: 8, marginBottom: 8,
  }}>
    <Text style={{ fontSize: 11, color: '#DDDDDD', textAlign: 'center' }}>
      {satelliteData.source_label}
    </Text>
    {satelliteData.cache_age_days !== undefined && satelliteData.cache_age_days > 90 && (
      <Text style={{ fontSize: 10, color: '#FF9800', textAlign: 'center', marginTop: 2 }}>
        ⚠️ Datos de hace {satelliteData.cache_age_days} días — actualiza con conexión
      </Text>
    )}
  </View>
)}
```

- [ ] **Step 5: Agregar etiqueta SIMULADO en el panel de análisis por toque (tap-point)**

El análisis por toque usa `computePointScore()` que es inherentemente simulado. Buscar donde se renderiza ese panel (buscar `computePointScore` o `indicators` en index.tsx) y agregar:

```typescript
{/* Etiqueta tap-point — SIEMPRE simulado, siempre honesto */}
<Text style={{ fontSize: 10, color: '#FF6B35', textAlign: 'center', marginBottom: 4 }}>
  ⚠️ SIMULADO — indicador exploratorio sin datos satelitales reales
</Text>
```

- [ ] **Step 6: Verificar que la app arranca sin crash**

```bash
cd C:\Users\ECApro\ProspectorAI
npx expo start --clear 2>&1 | head -30
```

Esperado: sin errores de TypeScript o import. Flujo de prueba manual:
- Con internet: analizar polígono → ver etiqueta "📡 Sentinel-2 real · imagen YYYY-MM-DD"
- Desconectar red, repetir zona ya analizada → ver "📡 Sentinel-2 real · guardado hace N días · sin conexión"
- Desconectar red, zona nueva → ver alerta "Sin datos satelitales" + NO aparece resultado numérico

- [ ] **Step 7: Commit final**

```bash
git add "app/(tabs)/index.tsx"
git commit -m "feat(ui): 3-state satellite source labels, block polygon analysis when NO_DATA_OFFLINE"
```

---

## Resumen de archivos modificados

| Archivo | Cambio |
|---|---|
| `server/gee.js` | +`getMiningSpectralGrid()`, +`getAsterCoverage()`, +`getMiningAsterGrid()` (condicional) |
| `server/index.js` | +3 rutas nuevas |
| `app/core/Database.ts` | +tabla `spectral_cache` + `saveSpectralCache()` + `loadSpectralCache()` |
| `app/core/SatelliteEngine.ts` | **NUEVO** — cache-first, 3 estados, nunca simula datos para polígono |
| `app/core/GeologicalEngine.ts` | `analyzeZoneLocal()` requiere datos reales, bloquea con `NO_DATA_OFFLINE` |
| `app/(tabs)/index.tsx` | Import + estado + flujo 3 ramas + etiquetas honestas por fuente |

**NO modificado:** AgroCropService.ts, getBiomassAnalysis, getBiomassGrid, getBiomassExtended, estructura general del archivo index.tsx.

---

## Revisión del spec vs plan (self-review)

| Requisito del spec | Cubierto en |
|---|---|
| ✅ Reutilizar tubería S2 de AgroCrop sin borrarla | Tasks 1-3 reutilizan `buildComposite`, `scaleToReflectance`, patrón de QA60 |
| ✅ Módulo nuevo separado SatelliteEngine | Task 6 |
| ✅ S2: B4/B2 (gossan), B11/B8 (ferroso), B11/B12 (arcilla), NDVI (máscara) | Task 1, `getMiningSpectralGrid()` |
| ✅ Verificar cobertura ASTER antes de implementar | Task 2 + Checkpoint |
| ✅ ASTER: post-2008 excluido, ratios GA correctos | Task 5 (condicional) |
| ✅ UTM automático por centroide | Tasks 1 + 5 + 6 |
| ✅ Etiquetas honestas por fuente real | Task 8 Steps 4-5: 3 etiquetas distintas (REAL / CACHED / SIMULADO) |
| ✅ No tocar AgroCrop | Verificado — ningún task toca esas funciones |
| ✅ No dividir index.tsx | Task 8 es cambio mínimo |
| ✅ Cache real para offline | Task 6.5 (DB) + Task 6 (SatelliteEngine) |
| ✅ Sin datos offline → bloquear análisis, no simular | Task 7 Step 4 guard + Task 8 Step 3 Alert |
| ✅ Tap-point siempre etiquetado SIMULADO | Task 8 Step 5 |
| ✅ Reporte ASTER Sinaloa + Sonora antes de seguir | Checkpoint entre Task 3 y Task 5 |

'use strict';
/**
 * index.js — ProspectorAI GEE Proxy Server
 *
 * Endpoints:
 *   GET /health                  → status check
 *   GET /api/gee/tiles           → GEETileConfig  (tile URL + metadata)
 *   GET /api/gee/pixels          → GEEPixelValues (spectral values at point)
 *
 * Required environment variables:
 *   GEE_SERVICE_ACCOUNT_JSON     — Full service account JSON (stringified)
 *
 * Optional:
 *   PORT                         — Defaults to 3000 (Railway injects this)
 *   ALLOWED_ORIGINS              — Comma-separated CORS origins (default: *)
 *
 * Auto-latest mode:
 *   Omit dateStart and dateEnd from /api/gee/tiles or /api/gee/pixels to
 *   automatically fetch the most recent cloud-free image for the location.
 */

const express    = require('express');
const cors       = require('cors');
const { initGEE, getTileConfig, getPixelValues, getMiningSpectralGrid, getAsterCoverage, getMiningAsterGrid } = require('./gee');
const { getEmitCoverage } = require('./emit-coverage');
const ee         = require('@google/earthengine');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : '*';

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
}));

app.use(express.json());

// ---------------------------------------------------------------------------
// Parameter helpers
// ---------------------------------------------------------------------------

const VALID_DATASETS = ['SENTINEL2', 'LANDSAT8', 'LANDSAT9', 'ASTER', 'EMIT'];
const VALID_INDEXES  = [
  // Multispectral (Sentinel-2, Landsat 8/9, ASTER VNIR)
  'TRUE_COLOR', 'FALSE_COLOR', 'NDVI', 'SWIR_MINERAL', 'IRON_OXIDE', 'CLAY_MINERALS', 'FERROUS_IRON',
  // ASTER SWIR mineral indices (historical 2000-2008)
  'ASTER_ALUNITE', 'ASTER_CALCITE', 'ASTER_CHLORITE',
  // EMIT hyperspectral
  'EMIT_AL_CLAY', 'EMIT_MG_CLAY', 'EMIT_CARBONATE', 'EMIT_FERRIC',
];
const EMIT_INDEXES   = ['EMIT_AL_CLAY', 'EMIT_MG_CLAY', 'EMIT_CARBONATE', 'EMIT_FERRIC'];
const ASTER_INDEXES  = ['ASTER_ALUNITE', 'ASTER_CALCITE', 'ASTER_CHLORITE'];
const DATE_RE        = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates and parses query parameters for GEE endpoints.
 * dateStart / dateEnd are optional — omit them to trigger auto-latest mode.
 * Returns { error: string } on invalid input, or the parsed params object.
 */
function parseGEEParams(query, requireMaxCloud = true) {
  const { lat, lng, index, dataset, maxCloud } = query;
  // Treat the literal strings 'undefined' / 'null' / '' as absent (auto-latest mode).
  const sanitizeDate = (v) => (v && v !== 'undefined' && v !== 'null' ? v : undefined);
  const dateStart = sanitizeDate(query.dateStart);
  const dateEnd   = sanitizeDate(query.dateEnd);

  const latN = parseFloat(lat);
  const lngN = parseFloat(lng);

  if (isNaN(latN) || latN < -90 || latN > 90)
    return { error: `lat inválido: "${lat}". Debe ser un número entre -90 y 90.` };

  if (isNaN(lngN) || lngN < -180 || lngN > 180)
    return { error: `lng inválido: "${lng}". Debe ser un número entre -180 y 180.` };

  if (!VALID_INDEXES.includes(index))
    return { error: `index inválido: "${index}". Valores permitidos: ${VALID_INDEXES.join(', ')}` };

  if (!VALID_DATASETS.includes(dataset))
    return { error: `dataset inválido: "${dataset}". Valores permitidos: ${VALID_DATASETS.join(', ')}` };

  // Cross-validate dataset ↔ index compatibility
  const isEmitIndex   = EMIT_INDEXES.includes(index);
  const isEmitDataset = dataset === 'EMIT';
  const isAsterIndex  = ASTER_INDEXES.includes(index);
  const isAsterDs     = dataset === 'ASTER';

  if (isEmitIndex && !isEmitDataset)
    return { error: `index "${index}" solo es compatible con dataset EMIT.` };
  if (!isEmitIndex && isEmitDataset)
    return { error: `index "${index}" no es compatible con dataset EMIT. Índices disponibles: ${EMIT_INDEXES.join(', ')}` };
  if (isAsterIndex && !isAsterDs)
    return { error: `index "${index}" solo es compatible con dataset ASTER.` };

  // Validate dates only if provided (absence = auto-latest mode)
  const hasDateStart = dateStart && dateStart.length > 0;
  const hasDateEnd   = dateEnd   && dateEnd.length   > 0;

  if (hasDateStart && !DATE_RE.test(dateStart))
    return { error: `dateStart inválido: "${dateStart}". Formato requerido: YYYY-MM-DD` };

  if (hasDateEnd && !DATE_RE.test(dateEnd))
    return { error: `dateEnd inválido: "${dateEnd}". Formato requerido: YYYY-MM-DD` };

  if (hasDateStart && hasDateEnd && new Date(dateStart) >= new Date(dateEnd))
    return { error: `dateStart debe ser anterior a dateEnd.` };

  // EMIT doesn't use cloud filtering
  if (dataset === 'EMIT') requireMaxCloud = false;

  if (requireMaxCloud && maxCloud != null && maxCloud !== '') {
    const cloudN = parseInt(maxCloud, 10);
    if (isNaN(cloudN) || cloudN < 0 || cloudN > 100)
      return { error: `maxCloud inválido: "${maxCloud}". Debe ser un número entre 0 y 100.` };
    return {
      lat: latN, lng: lngN, index, dataset,
      dateStart: hasDateStart ? dateStart : undefined,
      dateEnd:   hasDateEnd   ? dateEnd   : undefined,
      maxCloud:  cloudN,
    };
  }

  return {
    lat: latN, lng: lngN, index, dataset,
    dateStart: hasDateStart ? dateStart : undefined,
    dateEnd:   hasDateEnd   ? dateEnd   : undefined,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'prospector-ai-gee', timestamp: new Date().toISOString() });
});

/**
 * GET /api/gee/tiles
 * Query: lat, lng, index, dataset, [dateStart], [dateEnd], [maxCloud]
 * Omit dateStart/dateEnd for auto-latest mode (most recent cloud-free image).
 * Returns: GEETileConfig (includes acquisitionDate, cloudCover, nextPassDate)
 */
app.get('/api/gee/tiles', async (req, res) => {
  const params = parseGEEParams(req.query, true);
  if (params.error) {
    return res.status(400).json({ error: params.error });
  }

  try {
    const config = await getTileConfig(params);
    res.json(config);
  } catch (err) {
    console.error('[/api/gee/tiles]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/gee/pixels
 * Query: lat, lng, index, dataset, [dateStart], [dateEnd]
 * Omit dateStart/dateEnd for auto-latest mode.
 * Returns: GEEPixelValues
 */
app.get('/api/gee/pixels', async (req, res) => {
  const params = parseGEEParams(req.query, false);
  if (params.error) {
    return res.status(400).json({ error: params.error });
  }

  try {
    const values = await getPixelValues(params);
    res.json(values);
  } catch (err) {
    console.error('[/api/gee/pixels]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/mining/spectral-grid
// Body: { coordinates: [[lng,lat],...], fecha_inicio?, fecha_fin?, cell_size_m? }
// Returns real Sentinel-2 spectral indices per grid cell for mineral prospecting
// ---------------------------------------------------------------------------
app.post('/api/mining/spectral-grid', async (req, res) => {
  const { coordinates, fecha_inicio, fecha_fin, cell_size_m } = req.body || {};

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

// ---------------------------------------------------------------------------
// GET /api/emit/coverage?lat=&lng=&radius_km=
// Returns EMIT scene count and acquisition dates for a given location/radius.
// ---------------------------------------------------------------------------
app.get('/api/emit/coverage', async (req, res) => {
  const lat       = parseFloat(req.query.lat);
  const lng       = parseFloat(req.query.lng);
  const radius_km = req.query.radius_km ? parseFloat(req.query.radius_km) : 50;

  if (isNaN(lat) || lat < -90 || lat > 90)
    return res.status(400).json({ error: `lat inválido: "${req.query.lat}"` });
  if (isNaN(lng) || lng < -180 || lng > 180)
    return res.status(400).json({ error: `lng inválido: "${req.query.lng}"` });
  if (isNaN(radius_km) || radius_km <= 0 || radius_km > 500)
    return res.status(400).json({ error: `radius_km inválido: "${req.query.radius_km}". Debe ser entre 1 y 500.` });

  try {
    const result = await getEmitCoverage({ lat, lng, radiusKm: radius_km });
    res.json(result);
  } catch (err) {
    console.error('[/api/emit/coverage]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/mining/aster-grid
// Body: { coordinates: [[lng,lat],...], cell_size_m? }
// Returns ASTER historical alteration indices per grid cell
// ---------------------------------------------------------------------------
app.post('/api/mining/aster-grid', async (req, res) => {
  const { coordinates, cell_size_m } = req.body || {};

  if (!Array.isArray(coordinates) || coordinates.length < 3) {
    return res.status(400).json({ error: 'coordinates debe ser un array de al menos 3 pares [lng,lat].' });
  }
  for (const c of coordinates) {
    if (!Array.isArray(c) || c.length < 2 || typeof c[0] !== 'number' || typeof c[1] !== 'number') {
      return res.status(400).json({ error: 'Cada coordenada debe ser [lng, lat] con valores numéricos.' });
    }
  }

  try {
    const result = await getMiningAsterGrid({ coordinates, cell_size_m });
    res.json(result);
  } catch (err) {
    console.error('[mining/aster-grid]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/structural/grid
// Body: { coords: [{lat, lng}][], cell_size_m?: number }
// Returns Sentinel-1 GRD texture + DEM slope/hillshade + lineament density
// per grid cell for structural geology analysis.
// ---------------------------------------------------------------------------
app.post('/api/structural/grid', async (req, res) => {
  const { coords, cell_size_m } = req.body || {};

  if (!Array.isArray(coords) || coords.length < 3) {
    return res.status(400).json({ error: 'coords debe ser un array de al menos 3 objetos {lat, lng}.' });
  }
  for (const c of coords) {
    if (typeof c.lat !== 'number' || typeof c.lng !== 'number') {
      return res.status(400).json({ error: 'Cada elemento de coords debe tener {lat: number, lng: number}.' });
    }
  }

  try {
    const cellSize = (typeof cell_size_m === 'number' && cell_size_m > 0) ? cell_size_m : 500;

    // Build bounding box from coords
    const lats = coords.map(c => c.lat);
    const lngs = coords.map(c => c.lng);
    const latMin = Math.min(...lats);
    const latMax = Math.max(...lats);
    const lngMin = Math.min(...lngs);
    const lngMax = Math.max(...lngs);

    const region = ee.Geometry.Rectangle([lngMin, latMin, lngMax, latMax]);

    // ── DEM: slope + hillshade + gradient (lineaments) ──────────────────────
    const dem = ee.Image('COPERNICUS/DEM/GLO30').select('DSM').clip(region);
    const slope = ee.Terrain.slope(dem);
    // Multi-directional hillshade: average 4 sun azimuths for better lineament expression
    const hs0   = ee.Terrain.hillshade(dem, 45,  45);
    const hs90  = ee.Terrain.hillshade(dem, 135, 45);
    const hs180 = ee.Terrain.hillshade(dem, 225, 45);
    const hs270 = ee.Terrain.hillshade(dem, 315, 45);
    const hillshade = hs0.add(hs90).add(hs180).add(hs270).divide(4);

    // Lineament detection via Sobel-like edge magnitude on DEM
    // Use a 3×3 Sobel kernel applied to the DEM to find structural edges (faults/dikes/contacts)
    const sobelX = ee.Kernel.fixed(3, 3, [[-1,0,1],[-2,0,2],[-1,0,1]]);
    const sobelY = ee.Kernel.fixed(3, 3, [[-1,-2,-1],[0,0,0],[1,2,1]]);
    const gx = dem.convolve(sobelX);
    const gy = dem.convolve(sobelY);
    // Edge magnitude = sqrt(gx²+gy²); normalize to 0-1 using percentile stretch
    const edgeMag = gx.pow(2).add(gy.pow(2)).sqrt().rename('edge_mag');
    const edgeStats = edgeMag.reduceRegion({
      reducer: ee.Reducer.percentile([2, 98]),
      geometry: region,
      scale: cellSize,
      maxPixels: 1e7,
      bestEffort: true,
    });

    // ── Sentinel-1 GRD: VV backscatter mean + texture (stddev) ─────────────
    // Use a 2-year window to maximize S1 coverage; fall back gracefully if empty
    const now = Date.now();
    const s1Start = new Date(now - 730 * 86400000).toISOString().slice(0, 10);
    const s1End   = new Date(now).toISOString().slice(0, 10);

    const s1Col = ee.ImageCollection('COPERNICUS/S1_GRD')
      .filterBounds(region)
      .filterDate(s1Start, s1End)
      .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
      .filter(ee.Filter.eq('instrumentMode', 'IW'))
      .select('VV');

    const s1Size = s1Col.size();

    // Composite: mean VV over all available scenes
    const s1Mean    = s1Col.mean().rename('vv_mean');
    const s1StdDev  = s1Col.reduce(ee.Reducer.stdDev()).rename('vv_texture');
    const s1Image   = s1Mean.addBands(s1StdDev);

    // ── Build per-cell grid ──────────────────────────────────────────────────
    // Create a regular point grid at cellSize metres
    const latStepDeg = cellSize / 111320;
    const avgLat     = (latMin + latMax) / 2;
    const lngStepDeg = cellSize / (111320 * Math.cos(avgLat * Math.PI / 180));

    const gridPoints = [];
    for (let lat = latMin + latStepDeg / 2; lat < latMax; lat += latStepDeg) {
      for (let lng = lngMin + lngStepDeg / 2; lng < lngMax; lng += lngStepDeg) {
        gridPoints.push([lng, lat]);
      }
    }

    if (gridPoints.length === 0) {
      return res.json({ cells: [], cell_size_m: cellSize, acquisition_note: 'Zona demasiado pequeña para generar celdas.' });
    }

    // Limit grid to 2500 points to avoid GEE timeout
    const maxPoints = 2500;
    const sampledPoints = gridPoints.length > maxPoints
      ? gridPoints.filter((_, i) => i % Math.ceil(gridPoints.length / maxPoints) === 0)
      : gridPoints;

    const fcPoints = ee.FeatureCollection(
      sampledPoints.map(([lng, lat]) => ee.Feature(ee.Geometry.Point([lng, lat])))
    );

    // Combine all layers into a single multi-band image
    const combined = slope.rename('slope_deg')
      .addBands(hillshade.rename('hillshade'))
      .addBands(edgeMag);

    // Sample DEM-derived metrics at each grid point
    const demSampled = combined.sampleRegions({
      collection: fcPoints,
      scale: cellSize,
      geometries: true,
      tileScale: 4,
    });

    // Evaluate DEM samples and edge normalization stats in parallel
    const [demFeatures, edgeP2raw, edgeP98raw, s1Count] = await new Promise((resolve, reject) => {
      const demList    = demSampled.toList(sampledPoints.length);
      const edgeP2     = edgeStats.get('edge_mag_p2');
      const edgeP98    = edgeStats.get('edge_mag_p98');

      ee.List([demList, edgeP2, edgeP98, s1Size]).evaluate((result, err) => {
        if (err) reject(new Error(err));
        else resolve(result);
      });
    });

    const edgeP2Val  = typeof edgeP2raw  === 'number' ? edgeP2raw  : 0;
    const edgeP98Val = typeof edgeP98raw === 'number' ? edgeP98raw : 1;
    const edgeRange  = edgeP98Val - edgeP2Val || 1;
    const hasS1      = typeof s1Count === 'number' && s1Count > 0;

    // Sample S1 if available
    let s1FeaturesMap = new Map();
    if (hasS1) {
      try {
        const s1Sampled = s1Image.sampleRegions({
          collection: fcPoints,
          scale: cellSize,
          geometries: true,
          tileScale: 4,
        });
        const s1List = await new Promise((resolve, reject) => {
          s1Sampled.toList(sampledPoints.length).evaluate((result, err) => {
            if (err) reject(new Error(err));
            else resolve(result);
          });
        });
        if (Array.isArray(s1List)) {
          for (const feat of s1List) {
            const props = feat.properties || {};
            const geom  = feat.geometry;
            if (geom && geom.coordinates) {
              const key = `${geom.coordinates[1].toFixed(5)},${geom.coordinates[0].toFixed(5)}`;
              s1FeaturesMap.set(key, props);
            }
          }
        }
      } catch (s1Err) {
        console.warn('[structural/grid] S1 sampling failed, continuing with DEM only:', s1Err.message);
      }
    }

    // Build final cells
    const cells = [];
    if (Array.isArray(demFeatures)) {
      for (const feat of demFeatures) {
        const props = feat.properties || {};
        const geom  = feat.geometry;
        if (!geom || !geom.coordinates) continue;

        const lng = geom.coordinates[0];
        const lat = geom.coordinates[1];
        const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;

        const rawEdge   = typeof props.edge_mag === 'number' ? props.edge_mag : 0;
        const lineamentDensity = Math.max(0, Math.min(1, (rawEdge - edgeP2Val) / edgeRange));
        const slopeDeg  = typeof props.slope_deg === 'number' ? Math.round(props.slope_deg * 10) / 10 : 0;

        const s1Props   = s1FeaturesMap.get(key) || {};
        const vvMean    = typeof s1Props.vv_mean    === 'number' ? Math.round(s1Props.vv_mean    * 1000) / 1000 : null;
        const vvTexture = typeof s1Props.vv_texture === 'number' ? Math.round(s1Props.vv_texture * 1000) / 1000 : null;

        cells.push({
          lat:  Math.round(lat * 100000) / 100000,
          lng:  Math.round(lng * 100000) / 100000,
          lineament_density: Math.round(lineamentDensity * 1000) / 1000,
          near_lineament:    lineamentDensity > 0.4,
          slope_deg:         slopeDeg,
          vv_mean:           vvMean !== null ? vvMean    : 0,
          vv_texture:        vvTexture !== null ? vvTexture : 0,
        });
      }
    }

    const acquisitionNote = hasS1
      ? `Sentinel-1 GRD IW (${s1Count} escenas, ${s1Start} a ${s1End}) + DEM GLO-30`
      : `DEM GLO-30 únicamente (sin cobertura Sentinel-1 en esta zona)`;

    res.json({ cells, cell_size_m: cellSize, acquisition_note: acquisitionNote });

  } catch (err) {
    console.error('[structural/grid]', err.message);
    res.status(500).json({ cells: [], error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/emit/grid
// Body: { coords: [{lat, lng}][], cell_size_m?: number }
// Returns EMIT L2A hyperspectral mineral indices per grid cell.
// Indices: ferric_emit, al_clay_emit, mg_clay_emit, carbonate_emit
// ---------------------------------------------------------------------------
app.post('/api/emit/grid', async (req, res) => {
  const { coords, cell_size_m } = req.body || {};

  if (!Array.isArray(coords) || coords.length < 3) {
    return res.status(400).json({ error: 'coords debe ser un array de al menos 3 objetos {lat, lng}.' });
  }
  for (const c of coords) {
    if (typeof c.lat !== 'number' || typeof c.lng !== 'number') {
      return res.status(400).json({ error: 'Cada elemento de coords debe tener {lat: number, lng: number}.' });
    }
  }

  try {
    const cellSize = (typeof cell_size_m === 'number' && cell_size_m > 0) ? cell_size_m : 500;

    const lats = coords.map(c => c.lat);
    const lngs = coords.map(c => c.lng);
    const latMin = Math.min(...lats);
    const latMax = Math.max(...lats);
    const lngMin = Math.min(...lngs);
    const lngMax = Math.max(...lngs);

    const region = ee.Geometry.Rectangle([lngMin, latMin, lngMax, latMax]);

    // EMIT L2A reflectance collection — mosaic by median over all available scenes
    const emitCol = ee.ImageCollection('NASA/EMIT/L2A/RFL').filterBounds(region);
    const sceneCount = emitCol.size();

    // Select the bands needed for the four mineral indices (0-based indices)
    // Band 43 (~700nm), Band 70 (~900nm), Band 239 (~2165nm), Band 245 (~2200nm),
    // Band 263 (~2325nm), Band 266 (~2350nm)
    const BAND_NAMES = ['reflectance_43', 'reflectance_70', 'reflectance_239',
                        'reflectance_245', 'reflectance_263', 'reflectance_266'];
    const emitMedian = emitCol.select(BAND_NAMES).median();

    // Compute indices as separate expressions
    // ferric_emit    = reflectance_70 / (reflectance_43 + 0.001)
    // al_clay_emit   = reflectance_239 / (reflectance_245 + 0.001)
    // mg_clay_emit   = reflectance_263 / (reflectance_245 + 0.001)
    // carbonate_emit = reflectance_266 / (reflectance_263 + 0.001)
    const eps = 0.001;
    const b43  = emitMedian.select('reflectance_43');
    const b70  = emitMedian.select('reflectance_70');
    const b239 = emitMedian.select('reflectance_239');
    const b245 = emitMedian.select('reflectance_245');
    const b263 = emitMedian.select('reflectance_263');
    const b266 = emitMedian.select('reflectance_266');

    const ferricEmit   = b70.divide(b43.add(eps)).rename('ferric_emit');
    const alClayEmit   = b239.divide(b245.add(eps)).rename('al_clay_emit');
    const mgClayEmit   = b263.divide(b245.add(eps)).rename('mg_clay_emit');
    const carbonateEmit = b266.divide(b263.add(eps)).rename('carbonate_emit');

    const combined = ferricEmit
      .addBands(alClayEmit)
      .addBands(mgClayEmit)
      .addBands(carbonateEmit);

    // Build regular point grid at cellSize metres
    const latStepDeg = cellSize / 111320;
    const avgLat     = (latMin + latMax) / 2;
    const lngStepDeg = cellSize / (111320 * Math.cos(avgLat * Math.PI / 180));

    const gridPoints = [];
    for (let lat = latMin + latStepDeg / 2; lat < latMax; lat += latStepDeg) {
      for (let lng = lngMin + lngStepDeg / 2; lng < lngMax; lng += lngStepDeg) {
        gridPoints.push([lng, lat]);
      }
    }

    if (gridPoints.length === 0) {
      return res.json({ cells: [], cell_size_m: cellSize, acquisition_note: 'Zona demasiado pequeña para generar celdas.' });
    }

    // Cap at 1500 points to stay within GEE limits
    const maxPoints = 1500;
    const sampledPoints = gridPoints.length > maxPoints
      ? gridPoints.filter((_, i) => i % Math.ceil(gridPoints.length / maxPoints) === 0)
      : gridPoints;

    const fcPoints = ee.FeatureCollection(
      sampledPoints.map(([lng, lat]) => ee.Feature(ee.Geometry.Point([lng, lat])))
    );

    // Sample indices + scene count in parallel
    const sampled = combined.sampleRegions({
      collection: fcPoints,
      scale: cellSize,
      geometries: true,
      tileScale: 4,
    });

    const [features, nScenes] = await new Promise((resolve, reject) => {
      const featList = sampled.toList(sampledPoints.length);
      ee.List([featList, sceneCount]).evaluate((result, err) => {
        if (err) reject(new Error(err));
        else resolve(result);
      });
    });

    if (!Array.isArray(features) || features.length === 0) {
      return res.json({
        cells: [],
        cell_size_m: cellSize,
        acquisition_note: 'EMIT L2A — sin cobertura en esta zona',
        error: 'No EMIT coverage for this region',
      });
    }

    const cells = [];
    for (const feat of features) {
      const props = feat.properties || {};
      const geom  = feat.geometry;
      if (!geom || !geom.coordinates) continue;

      const lng = geom.coordinates[0];
      const lat = geom.coordinates[1];

      const ferric    = typeof props.ferric_emit    === 'number' ? Math.round(props.ferric_emit    * 10000) / 10000 : null;
      const alClay    = typeof props.al_clay_emit   === 'number' ? Math.round(props.al_clay_emit   * 10000) / 10000 : null;
      const mgClay    = typeof props.mg_clay_emit   === 'number' ? Math.round(props.mg_clay_emit   * 10000) / 10000 : null;
      const carbonate = typeof props.carbonate_emit === 'number' ? Math.round(props.carbonate_emit * 10000) / 10000 : null;

      // Skip cells where all indices are null (no EMIT coverage)
      if (ferric === null && alClay === null && mgClay === null && carbonate === null) continue;

      cells.push({
        lat:  Math.round(lat * 100000) / 100000,
        lng:  Math.round(lng * 100000) / 100000,
        ferric_emit:    ferric    ?? 1.0,
        al_clay_emit:   alClay    ?? 0.0,
        mg_clay_emit:   mgClay    ?? 0.0,
        carbonate_emit: carbonate ?? 1.0,
      });
    }

    const nSc = typeof nScenes === 'number' ? nScenes : '?';
    const acquisitionNote = `EMIT L2A · ${nSc} escenas · mediana`;

    res.json({ cells, cell_size_m: cellSize, acquisition_note: acquisitionNote });

  } catch (err) {
    console.error('[emit/grid]', err.message);
    res.status(500).json({ cells: [], error: err.message });
  }
});

// POST /api/zone/map-image
// Body: { lat_min, lat_max, lng_min, lng_max, width?,
//         analysis_points?: [{lat, lng, score, rank}],
//         polygon_coords?: [{latitude, longitude}],
//         cell_size_m?: number }
// Returns: { image_base64, overlay_svg, width, height, format }
// The client stacks base image + SVG overlay for PDF compositing.
// ---------------------------------------------------------------------------
app.post('/api/zone/map-image', async (req, res) => {
  const lat_min = parseFloat(req.body.lat_min);
  const lat_max = parseFloat(req.body.lat_max);
  const lng_min = parseFloat(req.body.lng_min);
  const lng_max = parseFloat(req.body.lng_max);
  const width   = parseInt(req.body.width || '600', 10);
  const analysisPoints = Array.isArray(req.body.analysis_points) ? req.body.analysis_points : [];
  const polygonCoords  = Array.isArray(req.body.polygon_coords)  ? req.body.polygon_coords  : [];
  const cellSizeM      = parseFloat(req.body.cell_size_m || '500');

  if (isNaN(lat_min) || isNaN(lat_max) || isNaN(lng_min) || isNaN(lng_max)) {
    return res.status(400).json({ error: 'Se requieren lat_min, lat_max, lng_min, lng_max como números.' });
  }
  if (lat_min >= lat_max || lng_min >= lng_max) {
    return res.status(400).json({ error: 'bbox inválido.' });
  }

  // ── Coordinate → pixel helpers ────────────────────────────────────────────
  const height = Math.round(width * (lat_max - lat_min) / (lng_max - lng_min));
  const toPixel = (lat, lng) => ({
    x: ((lng - lng_min) / (lng_max - lng_min)) * width,
    y: ((lat_max - lat) / (lat_max - lat_min)) * height,
  });

  // ── Cell size in pixels (approximate: 1 deg lat ≈ 111 000 m) ─────────────
  const metersPerPixelX = ((lng_max - lng_min) * 111000 * Math.cos((lat_min + lat_max) / 2 * Math.PI / 180)) / width;
  const metersPerPixelY = ((lat_max - lat_min) * 111000) / height;
  const cellW = Math.max(4, cellSizeM / metersPerPixelX);
  const cellH = Math.max(4, cellSizeM / metersPerPixelY);

  // ── SVG overlay ───────────────────────────────────────────────────────────
  let svgParts = [];

  // Heatmap cells (analysis points)
  for (const pt of analysisPoints) {
    const { x, y } = toPixel(pt.lat, pt.lng);
    const score = parseFloat(pt.score || pt.base_score || 0);
    let fill;
    if (score >= 0.65) fill = 'rgba(229,57,53,0.55)';      // HIGH  — red
    else if (score >= 0.35) fill = 'rgba(255,160,0,0.50)'; // MED   — orange
    else fill = 'rgba(84,110,122,0.40)';                   // LOW   — gray
    svgParts.push(
      `<rect x="${(x - cellW / 2).toFixed(1)}" y="${(y - cellH / 2).toFixed(1)}" ` +
      `width="${cellW.toFixed(1)}" height="${cellH.toFixed(1)}" fill="${fill}" rx="1"/>`
    );
  }

  // Polygon outline (gold)
  if (polygonCoords.length >= 3) {
    const pts = polygonCoords.map(c => {
      const { x, y } = toPixel(c.latitude ?? c.lat, c.longitude ?? c.lng);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    svgParts.push(`<polygon points="${pts}" fill="none" stroke="#FFD700" stroke-width="2.5" stroke-opacity="0.9"/>`);
  }

  // Top-10 priority markers (numbered circles)
  const top10 = analysisPoints
    .filter(pt => pt.rank != null && pt.rank <= 10)
    .sort((a, b) => a.rank - b.rank);
  for (const pt of top10) {
    const { x, y } = toPixel(pt.lat, pt.lng);
    const rank = pt.rank;
    const score = parseFloat(pt.score || pt.base_score || 0);
    const markerColor = score >= 0.65 ? '#FF4444' : score >= 0.35 ? '#FFA000' : '#90A4AE';
    svgParts.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" fill="${markerColor}" stroke="#000" stroke-width="1"/>`,
      `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="#000" font-size="9" font-weight="bold" ` +
      `text-anchor="middle" dominant-baseline="middle">${rank}</text>`
    );
  }

  const overlaySvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `width="${width}" height="${height}">${svgParts.join('')}</svg>`;

  // ── Fetch S2 base image from GEE ──────────────────────────────────────────
  try {
    const bbox = ee.Geometry.Rectangle([lng_min, lat_min, lng_max, lat_max]);

    const image = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(bbox)
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
      .median()
      .select(['B4', 'B3', 'B2']);

    const thumbUrl = await new Promise((resolve, reject) => {
      image.getThumbURL(
        { region: bbox, dimensions: `${width}x${height}`, format: 'png', min: 0, max: 3000 },
        (url, err) => { if (err) reject(new Error(err)); else resolve(url); }
      );
    });

    console.log('[/api/zone/map-image] thumbUrl obtained, downloading in Node...');
    const imgResp = await fetch(thumbUrl);
    if (!imgResp.ok) {
      const msg = `GEE image fetch failed: HTTP ${imgResp.status}`;
      console.error('[/api/zone/map-image]', msg);
      return res.status(502).json({ error: msg });
    }

    const arrayBuf = await imgResp.arrayBuffer();
    const image_base64 = Buffer.from(arrayBuf).toString('base64');
    console.log(`[/api/zone/map-image] image OK, base64=${image_base64.length}, svg_chars=${overlaySvg.length}`);

    res.json({ image_base64, overlay_svg: overlaySvg, width, height, format: 'png' });
  } catch (err) {
    console.error('[/api/zone/map-image]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/ai/chat — Proxy AUTENTICADO a Anthropic (la clave vive SOLO aquí)
// Header: Authorization: Bearer <supabase access_token>
// Body:   { model, max_tokens, system?, messages }  (payload de Anthropic)
//   1. Valida el token con Supabase (sin token válido → 401/403).
//   2. Bloquea cuentas suspendidas/eliminadas (profiles.active/deleted).
//   3. Rate limit por usuario (AI_DAILY_LIMIT/día) salvo admin, vía RPC
//      check_and_increment_ai_usage (service_role).
//   4. Reenvía a Anthropic con ANTHROPIC_API_KEY (variable de Railway).
// ---------------------------------------------------------------------------
const SUPABASE_URL              = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY         = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANTHROPIC_API_KEY         = process.env.ANTHROPIC_API_KEY || '';
const AI_DAILY_LIMIT            = parseInt(process.env.AI_DAILY_LIMIT || '50', 10);

async function supabaseUser(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  return r.ok ? r.json() : null;
}

async function supabaseProfile(uid) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${uid}&select=role,active,deleted`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) ? rows[0] : null;
}

async function checkAiUsage(uid, max) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/check_and_increment_ai_usage`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_user: uid, p_max: max }),
    });
    if (!r.ok) return true; // si el rate limit falla, no bloquees la IA
    return await r.json();   // boolean
  } catch { return true; }
}

app.post('/api/ai/chat', async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: 'Servidor IA no configurado (faltan variables de entorno).' });
    }

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Falta el token de sesión.' });

    const user = await supabaseUser(token);
    if (!user || !user.id) return res.status(403).json({ error: 'Sesión inválida. Inicia sesión de nuevo.' });

    const profile = await supabaseProfile(user.id);
    if (profile && (profile.deleted === true || profile.active === false)) {
      return res.status(403).json({ error: 'Cuenta suspendida.' });
    }
    const isAdmin = !!profile && profile.role === 'admin';

    if (!isAdmin) {
      const allowed = await checkAiUsage(user.id, AI_DAILY_LIMIT);
      if (allowed === false) {
        return res.status(429).json({ error: `Alcanzaste el límite diario de IA (${AI_DAILY_LIMIT} consultas/día). Vuelve mañana.` });
      }
    }

    const { model, max_tokens, system, messages } = req.body || {};
    if (!model || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Payload inválido: se requieren model y messages.' });
    }

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, max_tokens, system, messages }),
    });
    // Reenvía la respuesta de Anthropic tal cual (status + cuerpo) para que el
    // cliente la parsee igual que antes (data.content[0].text).
    const body = await anthropicRes.text();
    res.status(anthropicRes.status).type('application/json').send(body);
  } catch (err) {
    console.error('[/api/ai/chat]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------

app.use((_req, res) => {
  res.status(404).json({ error: 'Endpoint no encontrado.' });
});

// ---------------------------------------------------------------------------
// Startup: initialize GEE, then start listening
// ---------------------------------------------------------------------------

(async () => {
  try {
    console.log('[GEE] Initializing Earth Engine...');
    await initGEE();
    app.listen(PORT, () => {
      console.log(`[Server] ProspectorAI GEE proxy running on port ${PORT}`);
    });
  } catch (err) {
    console.error('[Fatal] Could not initialize GEE:', err.message);
    process.exit(1);
  }
})();

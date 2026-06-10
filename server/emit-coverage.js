'use strict';
/**
 * emit-coverage.js
 * GEE-based EMIT coverage checker for ProspectorAI.
 *
 * getEmitCoverage({ lat, lng, radiusKm })
 *   → { scene_count, dates: string[], quality_ok: boolean, note: string }
 *
 * Requires GEE to be already initialized (via gee.js initGEE).
 * The @google/earthengine module is a Node.js singleton so the initialized
 * state is shared across all require() calls in the same process.
 */

const ee = require('@google/earthengine');

const EMIT_COLLECTION = 'NASA/EMIT/L2A/RFL';

/**
 * Returns EMIT scene coverage metadata for a circle around (lat, lng).
 *
 * @param {Object} params
 * @param {number} params.lat       - Latitude in decimal degrees
 * @param {number} params.lng       - Longitude in decimal degrees
 * @param {number} params.radiusKm  - Search radius in kilometres
 * @returns {Promise<{scene_count: number, dates: string[], quality_ok: boolean, note: string}>}
 */
function getEmitCoverage({ lat, lng, radiusKm }) {
  return new Promise((resolve) => {
    try {
      const center     = ee.Geometry.Point([lng, lat]);
      const aoi        = center.buffer(radiusKm * 1000); // metres
      const collection = ee.ImageCollection(EMIT_COLLECTION).filterBounds(aoi);

      // Retrieve acquisition dates from system:time_start property
      const dateList = collection.aggregate_array('system:time_start');

      dateList.evaluate((timestamps, error) => {
        if (error) {
          console.error('[emit-coverage] GEE evaluate error:', error);
          resolve({
            scene_count: 0,
            dates: [],
            quality_ok: false,
            note: `GEE error: ${error}`,
          });
          return;
        }

        if (!Array.isArray(timestamps) || timestamps.length === 0) {
          resolve({
            scene_count: 0,
            dates: [],
            quality_ok: false,
            note: 'No EMIT scenes found for this location and radius.',
          });
          return;
        }

        // Convert millisecond timestamps to ISO date strings (YYYY-MM-DD), deduplicate & sort
        const dateStrings = [...new Set(
          timestamps.map((ms) => new Date(ms).toISOString().slice(0, 10))
        )].sort();

        const scene_count = dateStrings.length;
        // quality_ok: at least 3 distinct acquisition dates available
        const quality_ok  = scene_count >= 3;

        const note = quality_ok
          ? `${scene_count} EMIT scene(s) found. Coverage is sufficient for mineral analysis.`
          : `${scene_count} EMIT scene(s) found. Coverage may be limited — consider widening the search radius or using ASTER/Sentinel-2 as fallback.`;

        resolve({ scene_count, dates: dateStrings, quality_ok, note });
      });
    } catch (err) {
      console.error('[emit-coverage] Unexpected error:', err.message);
      resolve({
        scene_count: 0,
        dates: [],
        quality_ok: false,
        note: `Unexpected error: ${err.message}`,
      });
    }
  });
}

module.exports = { getEmitCoverage };

export interface SpectralIndices {
  iron_oxide: number;
  clay: number;
  gossan: number;
  silica: number;
  ferric_iron: number;
  malachite: number;
  propylitic: number;
  argillic: number;
  sphalerite: number;
  carbonate: number;
  galena: number;
}

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
}

// Generador pseudo-aleatorio basado en una semilla determinista
function pseudoRandom(seed: number): number {
  let x = Math.sin(seed * 99999.9999) * 10000;
  return x - Math.floor(x);
}

// Ray casting algorithm for polygon bounds
function pointInPolygon(point: {lat: number, lng: number}, vs: any[]) {
    let x = point.lat, y = point.lng;
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        let xi = vs[i].latitude, yi = vs[i].longitude;
        let xj = vs[j].latitude, yj = vs[j].longitude;
        let intersect = ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// Calculate Area in Hectares
function calcAreaHectares(coords: any[]): number {
  if (!coords || coords.length < 3) return 0;
  const R = 6378137;
  let sumY = 0;
  for (const c of coords) sumY += c.latitude;
  const avgLat = (sumY / coords.length) * Math.PI / 180;
  const points = coords.map((c:any) => ({
    x: c.longitude * Math.PI / 180 * R * Math.cos(avgLat),
    y: c.latitude * Math.PI / 180 * R
  }));
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    area += (p1.x * p2.y - p2.x * p1.y);
  }
  return Math.abs(area / 2) / 10000;
}

// Generate deterministic indices (0.0 to 1.0)
function generateIndices(lat: number, lng: number, terrain: string, rockType: string): SpectralIndices {
   const seed = lat * 10000 + lng * 10000;
   const generate = (offset: number) => 0.1 + pseudoRandom(seed + offset) * 0.9;
   
   let indices: SpectralIndices = {
     iron_oxide: generate(1),
     clay: generate(2),
     gossan: generate(3),
     silica: generate(4),
     ferric_iron: generate(5),
     malachite: generate(6),
     propylitic: generate(7),
     argillic: generate(8),
     sphalerite: generate(9),
     carbonate: generate(10),
     galena: generate(11)
   };

   // Geological context simulated influence
   if (terrain === 'sierra') { indices.iron_oxide *= 1.2; indices.gossan *= 1.2; }
   if (rockType === 'ignea') { indices.silica *= 1.3; indices.propylitic *= 1.2; }
   if (rockType === 'sedimentaria') { indices.clay *= 1.3; indices.carbonate *= 1.4; }

   // Normalize caps
   for (let key in indices) {
     (indices as any)[key] = Math.min(1.0, (indices as any)[key]);
   }
   return indices;
}

export function analyzeZoneLocal(
  polygonCoords: any[], 
  mineral: string, 
  terrain: string,
  depth: string = '0-5m',
  rockType: string = 'ignea',
  waypoints: any[] = []
): { success: boolean, top_points: AnalysisPoint[], area_ha: number, all_points?: AnalysisPoint[], grid_size?: {latStep: number, lngStep: number} } {
  
  if (!polygonCoords || polygonCoords.length < 3) return { success: false, top_points: [], area_ha: 0 };

  const areaHa = calcAreaHectares(polygonCoords);
  let targetCount = 5;
  if (areaHa >= 200) targetCount = 20;
  else if (areaHa >= 50) targetCount = 15;
  else if (areaHa >= 10) targetCount = 10;

  // 1. Base Weights
  const baseWeights: Record<string, Record<string, number>> = {
    oro: { gossan: 0.35, iron_oxide: 0.30, clay: 0.20, silica: 0.15 },
    plata: { clay: 0.40, argillic: 0.30, propylitic: 0.30 },
    cobre: { ferric_iron: 0.40, malachite: 0.35, propylitic: 0.25 },
    zinc: { sphalerite: 0.45, carbonate: 0.35, clay: 0.20 },
    plomo: { galena: 0.40, gossan: 0.35, iron_oxide: 0.25 }
  };

  let weights = { ...(baseWeights[mineral.toLowerCase()] || baseWeights['oro']) };

  // 2. Field Sample Auto-calibration
  // Find successful samples for this mineral nearby
  const successfulSamples = waypoints.filter(wp => 
    wp.mineral_detectado?.toLowerCase() === mineral.toLowerCase() && wp.score_ia > 80
  );

  if (successfulSamples.length > 0) {
    // Determine the dominant index from successful samples
    let dominantIndex = '';
    let maxVal = 0;
    for (const wp of successfulSamples) {
       const wLat = wp.lat || wp.latitude;
       const wLng = wp.lng || wp.longitude;
       if (!wLat || !wLng) continue;
       const simIndices = generateIndices(wLat, wLng, terrain, rockType);
       for (const key of Object.keys(weights)) {
          const val = (simIndices as any)[key];
          if (val > maxVal) {
             maxVal = val;
             dominantIndex = key;
          }
       }
    }
    
    // Boost the dominant index weight slightly (local recalibration)
    if (dominantIndex && weights[dominantIndex] !== undefined) {
       const boost = 0.10; // 10% boost
       weights[dominantIndex] += boost;
       // Normalize weights to sum to 1.0
       let sum = 0;
       for (const k in weights) sum += weights[k];
       for (const k in weights) weights[k] = weights[k] / sum;
    }
  }

  // Bounding box
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const pt of polygonCoords) {
      if (pt.latitude < minLat) minLat = pt.latitude;
      if (pt.latitude > maxLat) maxLat = pt.latitude;
      if (pt.longitude < minLng) minLng = pt.longitude;
      if (pt.longitude > maxLng) maxLng = pt.longitude;
  }

  // Grid search to find candidates inside polygon
  const candidates: AnalysisPoint[] = [];
  const gridSteps = 30; // 30x30 grid ~ 900 points tested
  const latStep = (maxLat - minLat) / gridSteps;
  const lngStep = (maxLng - minLng) / gridSteps;

  for (let i = 0; i < gridSteps; i++) {
    for (let j = 0; j < gridSteps; j++) {
      const lat = minLat + latStep * i;
      const lng = minLng + lngStep * j;
      if (pointInPolygon({lat, lng}, polygonCoords)) {
         
         const indices = generateIndices(lat, lng, terrain, rockType);
         let rawScore = 0;
         for (const key in weights) {
            rawScore += (indices as any)[key] * weights[key];
         }
         // rawScore is 0-1. Convert to 0-100
         const score100 = rawScore * 100;
         
         candidates.push({
           id: `${lat}-${lng}`,
           rank: 0,
           lat,
           lng,
           indices,
           base_score: score100
         });
      }
    }
  }

  // Sort by base_score DESC
  candidates.sort((a, b) => b.base_score - a.base_score);
  
  // Select Top N
  const topPoints = candidates.slice(0, targetCount);
  topPoints.forEach((p, idx) => p.rank = idx + 1);

  return { success: true, top_points: topPoints, area_ha: areaHa, all_points: candidates, grid_size: {latStep, lngStep} };
}

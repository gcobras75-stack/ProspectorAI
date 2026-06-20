// app/core/coordParse.ts
// Parser puro de coordenadas en varios formatos → { lat, lng } en grados decimales (WGS84).
// Formatos soportados:
//   1) Decimal:  "19.4326, -99.1332"  |  "19.4326 -99.1332"  |  "19.4326°N, 99.1332°W"
//   2) DMS/GMS:  "19°25'57\"N 99°07'59\"W"  (símbolos ° ' " o letras, con N/S/E/W)
//   3) UTM:      "14Q 478000 2148000"  |  "14 N 478000 2148000"  |  "14N 478000mE 2148000mN"
//
// La conversión UTM→lat/lng usa la inversa estándar de la proyección Transversa de Mercator
// (WGS84, k0=0.9996) — algoritmo USGS (Snyder), preciso a ~1 m. No es una aproximación.

export type ParseResult = { lat: number; lng: number } | { error: string };

// ── Elipsoide WGS84 ──────────────────────────────────────────────────────────
const A = 6378137.0;                 // semieje mayor (m)
const F = 1 / 298.257223563;         // achatamiento
const E2 = F * (2 - F);              // excentricidad²
const EP2 = E2 / (1 - E2);           // excentricidad² prima
const K0 = 0.9996;

const isFiniteNum = (n: number) => typeof n === 'number' && Number.isFinite(n);

function inRange(lat: number, lng: number): ParseResult {
  if (!isFiniteNum(lat) || !isFiniteNum(lng)) return { error: 'No pude leer la coordenada.' };
  if (lat < -90 || lat > 90)  return { error: `Latitud fuera de rango (${lat.toFixed(5)}). Debe estar entre -90 y 90.` };
  if (lng < -180 || lng > 180) return { error: `Longitud fuera de rango (${lng.toFixed(5)}). Debe estar entre -180 y 180.` };
  return { lat, lng };
}

// ── UTM → lat/lng (inversa Transverse Mercator, WGS84) ───────────────────────
// Letras de banda C–M = hemisferio sur; N–X = norte (se excluyen I y O).
function bandIsNorthern(band: string): boolean {
  const b = band.toUpperCase();
  if (b === 'N' || b === 'S') {
    // Ambigüedad: "N"/"S" pueden ser hemisferio explícito o banda. Como hemisferio:
    return b === 'N';
  }
  return b >= 'N'; // N..X norte ; C..M sur
}

function utmToLatLng(zone: number, band: string, easting: number, northing: number): ParseResult {
  if (!Number.isInteger(zone) || zone < 1 || zone > 60) return { error: `Zona UTM inválida (${zone}). Debe ser 1–60.` };
  const northern = bandIsNorthern(band);

  const x = easting - 500000.0;          // remueve falso este
  const y = northern ? northing : northing - 10000000.0; // remueve falso norte en sur

  const M = y / K0;
  const mu = M / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 * E2 * E2) / 256));

  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 =
    mu +
    (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) +
    (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) +
    (151 * e1 ** 3 / 96) * Math.sin(6 * mu) +
    (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);

  const C1 = EP2 * cosPhi1 ** 2;
  const T1 = tanPhi1 ** 2;
  const N1 = A / Math.sqrt(1 - E2 * sinPhi1 ** 2);
  const R1 = (A * (1 - E2)) / Math.pow(1 - E2 * sinPhi1 ** 2, 1.5);
  const D = x / (N1 * K0);

  const lat =
    phi1 -
    (N1 * tanPhi1 / R1) *
      (D ** 2 / 2 -
        (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * EP2) * D ** 4 / 24 +
        (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * EP2 - 3 * C1 ** 2) * D ** 6 / 720);

  const lonRad =
    (D -
      (1 + 2 * T1 + C1) * D ** 3 / 6 +
      (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * EP2 + 24 * T1 ** 2) * D ** 5 / 120) /
    cosPhi1;

  const lon0 = (zone * 6 - 183) * (Math.PI / 180); // meridiano central de la zona (rad)
  const latDeg = lat * (180 / Math.PI);
  const lngDeg = (lon0 + lonRad) * (180 / Math.PI);
  return inRange(latDeg, lngDeg);
}

// ── DMS → decimal ────────────────────────────────────────────────────────────
function dmsToDecimal(deg: number, min: number, sec: number, hemi: string): number {
  let v = Math.abs(deg) + (min || 0) / 60 + (sec || 0) / 3600;
  const h = (hemi || '').toUpperCase();
  if (h === 'S' || h === 'W' || h === 'O' || deg < 0) v = -v; // O = Oeste (español)
  return v;
}

// Extrae un componente DMS de un string: "19°25'57\"N", "19 25 57 N", "19:25:57N"
const DMS_RE = /(-?\d+(?:\.\d+)?)\s*[°ºd:\s]\s*(?:(\d+(?:\.\d+)?)\s*['′m:\s]\s*)?(?:(\d+(?:\.\d+)?)\s*["″s]?\s*)?\s*([NSEWO])?/i;

function tryDecimal(input: string): ParseResult | null {
  // Limpia símbolos de grado y deja números con signo + posibles hemisferios sueltos.
  const cleaned = input.replace(/[°º]/g, ' ').trim();
  // Hemisferios como letras finales por componente (ej. "19.43 N, 99.13 W")
  const compRe = /(-?\d+(?:\.\d+)?)\s*([NSEWO])?/gi;
  const comps: { val: number; hemi: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = compRe.exec(cleaned)) !== null) {
    if (m[0].trim() === '') continue;
    comps.push({ val: parseFloat(m[1]), hemi: (m[2] || '').toUpperCase() });
  }
  if (comps.length < 2) return null;
  const a = comps[0];
  const b = comps[1];
  if (!isFiniteNum(a.val) || !isFiniteNum(b.val)) return null;

  // Resuelve cuál es lat y cuál lng usando hemisferios si existen.
  let lat: number | null = null;
  let lng: number | null = null;
  const assign = (c: { val: number; hemi: string }) => {
    let v = c.val;
    if (c.hemi === 'S' || c.hemi === 'W' || c.hemi === 'O') v = -Math.abs(v);
    if (c.hemi === 'N' || c.hemi === 'E') v = Math.abs(v);
    if (c.hemi === 'N' || c.hemi === 'S') lat = v;
    else if (c.hemi === 'E' || c.hemi === 'W' || c.hemi === 'O') lng = v;
    return v;
  };
  const va = assign(a);
  const vb = assign(b);
  if (lat === null && lng === null) { lat = va; lng = vb; }       // sin hemisferios → orden lat,lng
  else if (lat === null) lat = (b === a ? vb : va === lng ? vb : va);
  else if (lng === null) lng = (va === lat ? vb : va);
  if (lat === null || lng === null) { lat = va; lng = vb; }
  return inRange(lat, lng);
}

function tryDMS(input: string): ParseResult | null {
  // Necesita al menos un símbolo DMS para considerarse DMS (evita pisar al decimal).
  if (!/[°º'′"″]/.test(input) && !/\d+\s+\d+\s+\d+/.test(input)) return null;
  const re = new RegExp(DMS_RE.source, 'gi');
  const parts: { val: number; deg: number; min: number; sec: number; hemi: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    if (!m[0] || m[0].trim() === '') { re.lastIndex++; continue; }
    const deg = parseFloat(m[1]);
    if (!isFiniteNum(deg)) continue;
    const min = m[2] ? parseFloat(m[2]) : 0;
    const sec = m[3] ? parseFloat(m[3]) : 0;
    const hemi = (m[4] || '').toUpperCase();
    parts.push({ val: dmsToDecimal(deg, min, sec, hemi), deg, min, sec, hemi });
    if (parts.length >= 2) break;
  }
  if (parts.length < 2) return null;
  let lat: number | null = null;
  let lng: number | null = null;
  for (const p of parts) {
    if (p.hemi === 'N' || p.hemi === 'S') lat = p.val;
    else if (p.hemi === 'E' || p.hemi === 'W' || p.hemi === 'O') lng = p.val;
  }
  if (lat === null || lng === null) { lat = parts[0].val; lng = parts[1].val; }
  return inRange(lat, lng);
}

function tryUTM(input: string): ParseResult | null {
  // "14Q 478000 2148000" | "14 N 478000 2148000" | "14N 478000mE 2148000mN"
  const cleaned = input.replace(/m?[EN]\b/gi, ' ').replace(/[,]/g, ' ').trim();
  const m = cleaned.match(/^(\d{1,2})\s*([C-HJ-NP-X])?\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const zone = parseInt(m[1], 10);
  const band = (m[2] || 'N').toUpperCase();
  const easting = parseFloat(m[3]);
  const northing = parseFloat(m[4]);
  if (!isFiniteNum(easting) || !isFiniteNum(northing)) return null;
  // Heurística: easting típico 100k–900k, northing 0–10M. Evita confundir decimal.
  if (easting < 100000 || easting > 900000) return null;
  return utmToLatLng(zone, band, easting, northing);
}

/**
 * Convierte un string de coordenada (decimal, DMS o UTM) a { lat, lng } en grados WGS84.
 * Devuelve { error } legible si no se puede interpretar.
 */
export function parseCoordinate(raw: string): ParseResult {
  const input = (raw || '').trim();
  if (!input) return { error: 'Escribe una coordenada.' };

  // Orden: UTM (tiene forma muy específica) → DMS (requiere símbolos) → decimal.
  const looksUTM = /^\d{1,2}\s*[C-HJ-NP-X]?\s+\d{4,}/i.test(input.replace(/[,]/g, ' '));
  if (looksUTM) {
    const u = tryUTM(input);
    if (u && !('error' in u)) return u;
    if (u && 'error' in u) return u;
  }
  const d = tryDMS(input);
  if (d && !('error' in d)) return d;

  const dec = tryDecimal(input);
  if (dec && !('error' in dec)) return dec;

  // Último intento UTM por si la heurística inicial falló.
  const u2 = tryUTM(input);
  if (u2) return u2;

  if (d && 'error' in d) return d;
  if (dec && 'error' in dec) return dec;
  return { error: 'Formato no reconocido. Usa decimal (19.43, -99.13), GMS (19°25\'57"N 99°07\'59"W) o UTM (14Q 478000 2148000).' };
}

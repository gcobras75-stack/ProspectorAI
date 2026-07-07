/**
 * ReportGenerator.ts
 *
 * Generates a professional PDF exploration report using expo-print and expo-sharing.
 * Integrates the Ing. Villegas (AI assistant) section, satellite map image, and field sample photos.
 */

import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import {
  loadReportContent,
  saveReportContent,
  loadMuestrasForReport,
  saveSampleResena,
} from './Database';
import { generateReportSection, generateSampleResena } from './ClaudeServices';
import type { ZoneProspectivity } from './ConsensusFusion';
import type { MetalScore } from './GeologicalEngine';
import { INDEX_GLOSSARY, S2_REAL_INDEX_KEYS, NON_S2_INDEX_KEYS } from './indexGlossary';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReportInput {
  projectId: string;
  projectName: string;
  metalName: string;
  terrainType: string;
  areaHa: string;
  analysisPoints: any[];
  satelitesSources: string;
  acquisitionDates: string;                  // kept for compat, may be empty
  sourceDates: {                             // per-satellite dates
    s2?: string;
    aster?: string;
    emit?: string;
    sentinel1?: string;
  };
  cellSizeM: number;
  zoneCenter: { lat: number; lng: number };
  polygonCoords: Array<{ latitude: number; longitude: number }>;
  lat_min: number;
  lat_max: number;
  lng_min: number;
  lng_max: number;
  geeServerUrl: string;
  /** Favorabilidad de zona (SEÑAL + CONFIANZA). Opcional: si no se pasa, la sección se omite. */
  zoneProspectivity?: ZoneProspectivity | null;
  /** Scores por metal (con requires_deep). Opcional: si no se pasa, la sección se omite. */
  metalScores?: MetalScore[];
}

// ---------------------------------------------------------------------------
// UTM helper (approximation — zone + degrees, no full projection needed)
// ---------------------------------------------------------------------------

function getUTMZoneLetter(lat: number): string {
  const letters = 'CDEFGHJKLMNPQRSTUVWXX';
  const idx = Math.max(0, Math.min(20, Math.floor((lat + 80) / 8)));
  return letters[idx];
}

function latLngToUTM(lat: number, lng: number): string {
  const a = 6378137.0;
  const e2 = 0.00669437999014;
  const k0 = 0.9996;
  const latR = lat * Math.PI / 180;
  const zoneNum = Math.floor((lng + 180) / 6) + 1;
  const zoneLetter = getUTMZoneLetter(lat);
  const cm = ((zoneNum - 1) * 6 - 180 + 3) * Math.PI / 180;
  const N0 = a / Math.sqrt(1 - e2 * Math.sin(latR) ** 2);
  const T = Math.tan(latR) ** 2;
  const C = (e2 / (1 - e2)) * Math.cos(latR) ** 2;
  const A = Math.cos(latR) * ((lng * Math.PI / 180) - cm);
  const e4 = e2 ** 2; const e6 = e2 ** 3;
  const M = a * (
    (1 - e2/4 - 3*e4/64 - 5*e6/256) * latR
    - (3*e2/8 + 3*e4/32 + 45*e6/1024) * Math.sin(2*latR)
    + (15*e4/256 + 45*e6/1024) * Math.sin(4*latR)
    - (35*e6/3072) * Math.sin(6*latR)
  );
  const easting  = Math.round(k0 * N0 * (A + (1-T+C)*A**3/6 + (5-18*T+T**2+72*C-58*e2/(1-e2))*A**5/120) + 500000);
  let   northing = k0 * (M + N0 * Math.tan(latR) * (A**2/2 + (5-T+9*C+4*C**2)*A**4/24 + (61-58*T+T**2+600*C-330*e2/(1-e2))*A**6/720));
  if (lat < 0) northing += 10000000;
  return `${zoneNum}${zoneLetter} ${easting} E · ${Math.round(northing)} N`;
}

// ---------------------------------------------------------------------------
// Convert a local file URI to base64 data URI (for embedding photos in PDF)
// ---------------------------------------------------------------------------

async function fileUriToBase64(uri: string): Promise<string | null> {
  try {
    // If already a data URI or http URL, return as-is for img src use
    if (uri.startsWith('data:') || uri.startsWith('http')) return uri;
    const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
    return `data:image/jpeg;base64,${b64}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTML builder helpers
// ---------------------------------------------------------------------------

const CSS = `
<style>
  @page { margin: 15mm; @bottom-right { content: counter(page); font-size: 10pt; color: #888; } }
  * { box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 14px; margin: 0; padding: 0; color: #222; counter-reset: page; }

  /* ── Portada ── */
  .portada {
    background: #1A1A1A; min-height: 100vh; display: flex; flex-direction: column;
    justify-content: center; align-items: center; text-align: center;
    padding: 40px 30px; page-break-after: always;
  }
  .portada h1 { color: #FFD700; font-size: 42px; margin: 0 0 10px 0; letter-spacing: 3px; }
  .portada h2 { color: #FFFFFF; font-size: 28px; margin: 0 0 8px 0; font-weight: 300; }
  .portada .subtitle { color: #AAAAAA; font-size: 14px; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 40px; }
  .portada .meta-table { border-collapse: collapse; margin-top: 20px; min-width: 340px; }
  .portada .meta-table td { padding: 9px 16px; font-size: 13px; border-bottom: 1px solid #333; }
  .portada .meta-table td:first-child { color: #888; text-align: right; padding-right: 20px; }
  .portada .meta-table td:last-child { color: #FFD700; text-align: left; font-weight: bold; }
  .portada .logo-line { color: #555; font-size: 11px; margin-top: 40px; }

  /* ── Interior pages ── */
  .page { background: #FFFFFF; padding: 30px 40px; page-break-after: always; counter-increment: page; }
  .page:last-child { page-break-after: auto; }
  .page-num::after { content: counter(page); }
  .page h2 {
    color: #1A1A1A; font-size: 20px; font-weight: 900;
    border-bottom: 3px solid #FFD700; padding-bottom: 8px;
    margin-bottom: 20px; letter-spacing: 1px; text-transform: uppercase;
  }
  .page h3 { color: #333; font-size: 16px; font-weight: 700; margin: 22px 0 10px 0; }
  .page p  { color: #444; font-size: 13px; line-height: 1.8; margin: 0 0 14px 0; }
  .page pre { color: #333; font-size: 12px; line-height: 1.9; white-space: pre-wrap;
    font-family: 'Courier New', monospace; background: #F9F9F9;
    padding: 14px 16px; border-radius: 4px; border-left: 3px solid #FFD700; }

  /* ── Map ── */
  .map-wrap { position: relative; width: 100%; max-width: 600px; margin: 0 auto; }
  .map-img  { width: 100%; max-height: 420px; object-fit: contain; border: 1px solid #DDD; border-radius: 4px; display: block; }
  .map-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
  .map-placeholder { width: 100%; height: 220px; background: #E8E8E8; display: flex;
    align-items: center; justify-content: center; border-radius: 4px; border: 1px dashed #BBB; }
  .map-placeholder p { color: #777; font-size: 13px; text-align: center; padding: 0 16px; }
  .leyenda { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 16px; padding: 12px 16px; background: #F5F5F5; border-radius: 6px; }
  .leyenda span { font-size: 12px; font-weight: 600; }
  .nota-mapa { color: #888; font-size: 11px; margin-top: 10px; font-style: italic; }

  /* ── Tables ── */
  .data-table, .points-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 12px; }
  .data-table th, .points-table th { background: #1A1A1A; color: #FFD700; padding: 10px 14px; text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  .data-table td, .points-table td { padding: 9px 14px; border-bottom: 1px solid #EEEEEE; vertical-align: top; font-size: 12px; }
  .data-table tr:nth-child(even) td, .points-table tr:nth-child(even) td { background: #FAFAFA; }

  /* ── Ing. Villegas ── */
  .section-label { color: #888; font-size: 12px; margin-bottom: 20px; font-style: italic; }

  /* ── Nivel badges ── */
  .badge { display: inline-block; padding: 3px 9px; border-radius: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; }
  .badge-priority { background: #FFD700; color: #000; }
  .badge-triple    { background: #00BCD4; color: #FFF; }
  .badge-confirmed { background: #00E676; color: #000; }
  .badge-single    { background: #546E7A; color: #FFF; }
  .badge-veg       { background: #4CAF50; color: #FFF; }

  /* ── Muestras de campo ── */
  .sample-page { display: flex; gap: 24px; align-items: flex-start; margin-bottom: 28px; }
  .sample-photo { width: 200px; min-width: 200px; height: 200px; object-fit: cover; border-radius: 6px; border: 1px solid #DDD; }
  .sample-photo-placeholder { width: 200px; min-width: 200px; height: 200px; background: #EEE;
    border-radius: 6px; display: flex; align-items: center; justify-content: center; border: 1px dashed #CCC; }
  .sample-info { flex: 1; }
  .sample-info h4 { color: #1A1A1A; font-size: 15px; font-weight: 700; margin: 0 0 6px 0; }
  .sample-info .sample-coord { color: #888; font-size: 11px; font-family: monospace; margin-bottom: 8px; }
  .sample-info .sample-resena { color: #444; font-size: 13px; line-height: 1.7; }
  .sample-info .sample-analisis { color: #666; font-size: 12px; margin-top: 8px; font-style: italic; }

  /* ── Disclaimer ── */
  .disclaimer p { color: #555; font-size: 13px; line-height: 1.9; }
  .disclaimer h2 { color: #999; }

  /* ── Favorabilidad / medidores ── */
  .fav-band { font-size: 26px; font-weight: 900; letter-spacing: 1px; margin: 4px 0 18px; }
  .meter { margin: 0 0 16px; }
  .meter-label { font-size: 13px; font-weight: 700; color: #333; margin-bottom: 5px; display: flex; justify-content: space-between; }
  .meter-label span { color: #666; font-weight: 600; }
  .meter-bar { width: 100%; height: 14px; background: #ECECEC; border-radius: 7px; overflow: hidden; }
  .meter-fill { height: 100%; border-radius: 7px; }
  .why-cols { display: flex; gap: 24px; margin-top: 18px; }
  .why-col { flex: 1; }
  .why-col h3 { font-size: 13px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: .5px; }
  .why-col ul { margin: 0; padding-left: 4px; list-style: none; }
  .why-plus { color: #2e7d32; font-size: 12px; line-height: 1.7; }
  .why-minus { color: #c62828; font-size: 12px; line-height: 1.7; }
  .why-none { color: #aaa; font-size: 12px; }
  .fav-rel { font-size: 12px; color: #555; font-style: italic; margin-top: 6px; }
  .fav-note { font-size: 11px; color: #666; margin-top: 18px; line-height: 1.7; border-top: 1px solid #eee; padding-top: 10px; }

  /* ── Índices interpretados ── */
  .idx-row { margin: 0 0 12px; }
  .idx-head { display: flex; justify-content: space-between; font-size: 13px; }
  .idx-name { font-weight: 700; color: #222; }
  .idx-val { color: #666; font-weight: 600; }
  .idx-bar { width: 100%; height: 10px; background: #ECECEC; border-radius: 5px; overflow: hidden; margin: 4px 0; }
  .idx-fill { height: 100%; background: #C49B0B; border-radius: 5px; }
  .idx-fill-deep { background: #00838F; }
  .idx-desc { font-size: 11px; color: #777; }
  .idx-missing { font-size: 11px; color: #666; background: #FAFAFA; border-left: 3px solid #BBB; padding: 10px 12px; margin-top: 14px; line-height: 1.6; }
  .pill { display: inline-block; font-size: 9px; font-weight: 700; padding: 1px 6px; border-radius: 8px; vertical-align: middle; }
  .pill-deep { background: #00838F; color: #fff; }

  /* ── Metales ── */
  .metal-grid { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 14px; }
  .metal-card { flex: 1 1 30%; min-width: 150px; border: 1px solid #E2E2E2; border-radius: 8px; padding: 14px; background: #FCFCFC; }
  .metal-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .metal-icon { font-size: 20px; }
  .metal-label { font-weight: 700; font-size: 14px; color: #222; }
  .metal-score { font-size: 26px; font-weight: 900; color: #1A1A1A; }
  .metal-note { font-size: 10px; color: #999; margin-top: 6px; }
  .metal-deep { font-size: 13px; font-weight: 700; color: #00838F; background: #E0F2F4; padding: 6px 8px; border-radius: 5px; }
  .metal-warn { font-size: 10px; color: #e65100; margin-top: 6px; }
</style>
`;

function buildSatelliteRows(
  satelitesSources: string,
  sourceDates: ReportInput['sourceDates'],
  fallbackDate: string
): string {
  const sources = satelitesSources.split('·').map(s => s.trim()).filter(Boolean);
  const rows = sources.map(src => {
    const sl = src.toLowerCase();
    let collection = '—', resolution = '—', fecha = fallbackDate || 'N/D';
    if (sl.includes('sentinel-2') || sl.includes('s2')) {
      collection = 'COPERNICUS/S2_SR_HARMONIZED'; resolution = '10–20 m';
      fecha = sourceDates.s2 || fallbackDate || 'N/D';
    } else if (sl.includes('aster')) {
      collection = 'ASTER/AST_L1T_003'; resolution = '15–90 m';
      fecha = sourceDates.aster || 'Archivo 2000–2008';
    } else if (sl.includes('emit')) {
      collection = 'NASA/EMIT/L2A/RFL'; resolution = '60 m';
      fecha = sourceDates.emit || 'Archivo EMIT';
    } else if (sl.includes('sentinel-1') || sl.includes('s1')) {
      collection = 'COPERNICUS/S1_GRD'; resolution = '10 m';
      fecha = sourceDates.sentinel1 || fallbackDate || 'N/D';
    }
    return `<tr><td>${src}</td><td style="font-size:11px;color:#555">${collection}</td><td style="text-align:center">${resolution}</td><td style="font-size:12px">${fecha}</td></tr>`;
  });
  return rows.join('');
}

function buildTopPointsRows(analysisPoints: any[], metalName: string): string {
  const top = analysisPoints
    .filter(p => p.base_score !== undefined || p.score !== undefined)
    .slice(0, 10);

  if (top.length === 0) return '<tr><td colspan="5" style="color:#888;padding:16px;text-align:center">Sin puntos analizados</td></tr>';

  return top.map((p, i) => {
    // Consensus level → badge
    const consensus = p.consensus_level || '';
    let badge = '';
    if (consensus === 'PRIORITY_TARGET') badge = '<span class="badge badge-priority">Prioritario</span>';
    else if (consensus === 'TRIPLE_SPECTRAL') badge = '<span class="badge badge-triple">Triple</span>';
    else if (consensus === 'CONFIRMED')  badge = '<span class="badge badge-confirmed">Confirmado</span>';
    else if (consensus === 'VEGETATION') badge = '<span class="badge badge-veg">Vegetación</span>';
    else badge = '<span class="badge badge-single">Individual</span>';

    // Score display — use spectral base_score (0-1 range)
    const score = parseFloat(p.base_score ?? p.score ?? 0);
    const scorePct = score <= 1 ? Math.round(score * 100) : Math.round(score);
    const scoreStr = `${scorePct}%`;

    // Evidence string (from ConsensusFusion)
    const evidence = p.evidence || p.evidence_string || '—';

    // p.indices is an object {key: value} from GEE — e.g. {iron_oxide: 0.43, clay: 0.21}
    const indices = Object.entries(p.indices || {})
      .slice(0, 3)
      .map(([name, val]) => {
        const v = typeof val === 'number' ? (val as number).toFixed(3) : '';
        return v ? `${name}: ${v}` : name;
      })
      .filter(Boolean)
      .join(', ') || metalName;

    return `<tr>
      <td><strong>${i + 1}</strong></td>
      <td style="font-family:monospace;font-size:10px">${latLngToUTM(p.lat, p.lng)}</td>
      <td>${badge}<br/><span style="font-size:11px;color:#888">${scoreStr}</span></td>
      <td style="font-size:12px">${evidence}</td>
      <td style="font-size:12px">${indices}</td>
    </tr>`;
  }).join('');
}

function buildSamplePages(muestras: any[]): string {
  const withPhoto = muestras.filter(m => m.foto_uri);
  if (withPhoto.length === 0) return '';

  let pages = '';
  for (let i = 0; i < withPhoto.length; i += 2) {
    const pair = withPhoto.slice(i, i + 2);
    let pairHtml = '';
    for (const m of pair) {
      const photoHtml = m._base64
        ? `<img class="sample-photo" src="${m._base64}" />`
        : `<div class="sample-photo-placeholder"><p>Sin foto</p></div>`;
      const analisisObj = m.analisis_texto ? (() => { try { return JSON.parse(m.analisis_texto); } catch { return null; } })() : null;
      const analisisStr = analisisObj?.analisis_detallado || analisisObj?.recomendacion || m.analisis_texto || '';
      // Lab results if available
      const hasLab = m.lab_au_gt != null || m.lab_ag_gt != null || m.lab_cu_pct != null;
      const labHtml = hasLab ? `
        <div style="margin-top:8px;padding:8px;background:#f0f8f0;border-radius:4px;border-left:3px solid #4CAF50">
          <div style="font-size:11px;font-weight:bold;color:#2e7d32;margin-bottom:4px">RESULTADOS DE LABORATORIO</div>
          ${m.lab_au_gt != null ? `<div style="font-size:12px">Au: <strong>${m.lab_au_gt} g/t</strong></div>` : ''}
          ${m.lab_ag_gt != null ? `<div style="font-size:12px">Ag: <strong>${m.lab_ag_gt} g/t</strong></div>` : ''}
          ${m.lab_cu_pct != null ? `<div style="font-size:12px">Cu: <strong>${m.lab_cu_pct}%</strong></div>` : ''}
          ${m.lab_pb_pct != null ? `<div style="font-size:12px">Pb: <strong>${m.lab_pb_pct}%</strong></div>` : ''}
          ${m.lab_zn_pct != null ? `<div style="font-size:12px">Zn: <strong>${m.lab_zn_pct}%</strong></div>` : ''}
          ${m.lab_laboratorio ? `<div style="font-size:11px;color:#555;margin-top:4px">${m.lab_laboratorio}</div>` : ''}
          ${m.validation_verdict ? `<div style="font-size:11px;font-weight:bold;color:${m.validation_verdict === 'CONFIRMED' ? '#2e7d32' : m.validation_verdict === 'PARTIAL' ? '#e65100' : '#c62828'};margin-top:4px">${m.validation_verdict === 'CONFIRMED' ? '✅ Confirmada' : m.validation_verdict === 'PARTIAL' ? '⚠️ Parcial' : '❌ No confirmada'}</div>` : ''}
        </div>` : '';
      pairHtml += `
        <div class="sample-page">
          ${photoHtml}
          <div class="sample-info">
            <h4>${m.muestra_codigo || `Muestra #${m.id}`}</h4>
            <div class="sample-coord">${latLngToUTM(m.lat, m.lng)} · ${m.fecha ? new Date(m.fecha).toLocaleDateString('es-MX') : ''}</div>
            <div class="sample-resena">${m.reporte_resena || 'Sin reseña generada.'}</div>
            ${analisisStr ? `<div class="sample-analisis">Análisis IA: ${analisisStr.substring(0, 200)}</div>` : ''}
            ${labHtml}
          </div>
        </div>`;
    }
    pages += `<div class="page"><h2>Evidencia de Campo</h2>${pairHtml}</div>`;
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Resumen ejecutivo — Favorabilidad (SEÑAL + CONFIANZA, nunca un % único)
// ---------------------------------------------------------------------------

function confidenceDots(label: string): string {
  return label === 'ALTA' ? '●●●○' : label === 'MEDIA' ? '●●○○' : '●○○○';
}

function buildFavorabilidadSection(zp?: ZoneProspectivity | null): string {
  if (!zp) return '';
  const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
  const plus  = (zp.reasons_plus  || []).map(r => `<li class="why-plus">+ ${r}</li>`).join('');
  const minus = (zp.reasons_minus || []).map(r => `<li class="why-minus">− ${r}</li>`).join('');
  const relLine = (typeof zp.relative_percentile === 'number')
    ? `<p class="fav-rel">Entre tus zonas analizadas, esta queda en el percentil ${zp.relative_percentile}.</p>`
    : '';
  return `
<!-- ══════ RESUMEN EJECUTIVO ══════ -->
<div class="page">
  <h2>Resumen Ejecutivo — Favorabilidad Exploratoria</h2>
  <div class="fav-band" style="color:${zp.band_color}">${zp.band_label}</div>
  <div class="meter">
    <div class="meter-label"><span style="color:#333">SEÑAL espectral</span><span>${clamp(zp.signal)}/100</span></div>
    <div class="meter-bar"><div class="meter-fill" style="width:${clamp(zp.signal)}%;background:${zp.band_color}"></div></div>
  </div>
  <div class="meter">
    <div class="meter-label"><span style="color:#333">CONFIANZA</span><span>${zp.confidence_label} ${confidenceDots(zp.confidence_label)}</span></div>
    <div class="meter-bar"><div class="meter-fill" style="width:${clamp(zp.confidence)}%;background:#888"></div></div>
  </div>
  ${relLine}
  <div class="why-cols">
    <div class="why-col"><h3 style="color:#2e7d32">Por qué suma</h3><ul>${plus || '<li class="why-none">—</li>'}</ul></div>
    <div class="why-col"><h3 style="color:#c62828">Por qué resta</h3><ul>${minus || '<li class="why-none">—</li>'}</ul></div>
  </div>
  <p class="fav-note">La <strong>favorabilidad exploratoria</strong> expresa qué tan compatible es la firma espectral con rasgos de alteración del metal objetivo, y con cuánta confianza. <strong>No es una probabilidad de yacimiento</strong> ni indica ley, tonelaje o profundidad.</p>
</div>`;
}

// ---------------------------------------------------------------------------
// Índices espectrales interpretados (glosario; marca lo no medido)
// ---------------------------------------------------------------------------

function buildIndicesSection(points: any[]): string {
  const pts = (points || []).filter(p => p && p.indices);
  if (pts.length === 0) return '';

  const avg = (key: string, onlyPositive = false): number | null => {
    let sum = 0, n = 0;
    for (const p of pts) {
      const v = Number(p.indices?.[key]);
      if (!Number.isFinite(v)) continue;
      if (onlyPositive && v <= 0) continue;
      sum += v; n++;
    }
    return n > 0 ? sum / n : null;
  };
  const anyEnriched = (key: string) =>
    pts.some(p => Array.isArray(p.enriched_indices) && p.enriched_indices.includes(key));

  const realRows = (S2_REAL_INDEX_KEYS as readonly string[]).map(key => {
    const a = avg(key);
    if (a == null) return '';
    const info = INDEX_GLOSSARY[key];
    const pct = Math.round(Math.max(0, Math.min(1, a)) * 100);
    return `<div class="idx-row">
      <div class="idx-head"><span class="idx-name">${info?.label || key}</span><span class="idx-val">${pct}%</span></div>
      <div class="idx-bar"><div class="idx-fill" style="width:${pct}%"></div></div>
      <div class="idx-desc">${info?.short || ''}</div>
    </div>`;
  }).filter(Boolean).join('');

  const enrichedRows: string[] = [];
  const missing: string[] = [];
  for (const key of (NON_S2_INDEX_KEYS as readonly string[])) {
    const info = INDEX_GLOSSARY[key];
    if (anyEnriched(key)) {
      const a = avg(key, true);
      const pct = a != null ? Math.round(Math.max(0, Math.min(1, a)) * 100) : 0;
      enrichedRows.push(`<div class="idx-row">
        <div class="idx-head"><span class="idx-name">${info?.label || key} <span class="pill pill-deep">ASTER/EMIT</span></span><span class="idx-val">${pct}%</span></div>
        <div class="idx-bar"><div class="idx-fill idx-fill-deep" style="width:${pct}%"></div></div>
        <div class="idx-desc">${info?.short || ''}</div>
      </div>`);
    } else {
      missing.push(info?.label || key);
    }
  }

  const missingHtml = missing.length
    ? `<p class="idx-missing"><strong>Sin dato directo de Sentinel-2 (requiere ASTER/EMIT):</strong> ${missing.join(' · ')}. No se reportan como medición — la ausencia de valor no implica ausencia del mineral.</p>`
    : '';

  return `
<!-- ══════ ÍNDICES ESPECTRALES ══════ -->
<div class="page">
  <h2>Índices Espectrales Interpretados</h2>
  <p>Promedio de los índices de alteración sobre los puntos analizados. Solo se reportan como <strong>medidos</strong> los índices con respaldo satelital real (Sentinel-2, o ASTER/EMIT donde hubo cobertura).</p>
  ${realRows}
  ${enrichedRows.join('')}
  ${missingHtml}
</div>`;
}

// ---------------------------------------------------------------------------
// Favorabilidad por metal (MetalScore; requires_deep → "Requiere ASTER/EMIT")
// ---------------------------------------------------------------------------

function buildMetalsSection(metalScores?: MetalScore[]): string {
  const ms = metalScores || [];
  if (ms.length === 0) return '';
  const cards = ms.map(m => {
    const valueHtml = m.requires_deep
      ? `<div class="metal-deep">Requiere ASTER/EMIT</div>`
      : `<div class="metal-score">${Math.round(m.score_percent)}%</div>`;
    const synth = (m.synthetic_weight_pct && m.synthetic_weight_pct > 0 && !m.requires_deep)
      ? `<div class="metal-note">${m.synthetic_weight_pct}% del modelo no es medible por Sentinel-2</div>`
      : '';
    const warn = m.warning ? `<div class="metal-warn">${m.warning}</div>` : '';
    return `<div class="metal-card">
      <div class="metal-head"><span class="metal-icon">${m.icon || '⛏️'}</span><span class="metal-label">${m.label || m.metal}</span></div>
      ${valueHtml}
      ${synth}
      ${warn}
    </div>`;
  }).join('');
  return `
<!-- ══════ FAVORABILIDAD POR METAL ══════ -->
<div class="page">
  <h2>Favorabilidad por Metal</h2>
  <p>Calculada desde los mismos índices espectrales reales, con la ponderación de cada metal. Los metales sin firma óptica directa (sulfuros) se marcan <strong>"Requiere ASTER/EMIT"</strong> en vez de un número engañoso.</p>
  <div class="metal-grid">${cards}</div>
  <p class="idx-missing">Valores de <strong>favorabilidad exploratoria</strong> (compatibilidad espectral), no probabilidad de yacimiento, ley ni tonelaje.</p>
</div>`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function generateAndShareReport(input: ReportInput): Promise<void> {
  // ── A. Obtain/generate Ing. Villegas section (cached) ─────────────────────────
  // Compute hash from current analysis (top-5 coords + base_scores + metal + area)
  const analisisHash =
    input.analysisPoints.slice(0, 5).map(p => `${p.lat?.toFixed(4)},${p.lng?.toFixed(4)},${(p.base_score || 0).toFixed(3)}`).join('|')
    + `|${input.metalName}|${input.areaHa}`;

  let saved = await loadReportContent(input.projectId);
  let geologoTexto = saved?.geologoTexto ?? '';
  const cachedHashMatches = saved?.analisisHash === analisisHash;

  if (!geologoTexto || !cachedHashMatches) {
    console.log('[Report] Generating Ing. Villegas section. Reason:', !geologoTexto ? 'no cache' : 'analysis changed');
    geologoTexto = await generateReportSection(
      input.analysisPoints,
      input.metalName,
      input.terrainType,
      input.areaHa,
      input.satelitesSources,
      input.zoneCenter
    );
    await saveReportContent(input.projectId, geologoTexto, analisisHash);
  } else {
    console.log('[Report] Using cached Ing. Villegas section (hash match).');
  }

  const parts = geologoTexto.split('\n\n--- SECCIÓN ---\n\n');
  const resumenEjec   = parts[0] || geologoTexto;
  const interpretacion = parts[1] || '';
  const planCampo      = parts[2] || '';

  // ── B. Map image (POST) — server returns S2 base + SVG heatmap overlay ────
  const mapUrl = `${input.geeServerUrl}/api/zone/map-image`;
  let mapDataUri = '';
  let overlaySvg = '';
  let mapErrorReason = 'no se pudo contactar al servidor GEE';

  console.log('[PDF Map] (a) POST URL:', mapUrl);
  try {
    const mapBody = {
      lat_min: input.lat_min,
      lat_max: input.lat_max,
      lng_min: input.lng_min,
      lng_max: input.lng_max,
      width: 600,
      cell_size_m: input.cellSizeM,
      analysis_points: input.analysisPoints.map(p => ({
        lat: p.lat, lng: p.lng,
        score: p.base_score ?? 0,
        rank: p.rank ?? 99,
      })),
      polygon_coords: (input.polygonCoords || []).map(c => ({
        latitude: c.latitude, longitude: c.longitude,
      })),
    };

    const mapResp = await fetch(mapUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mapBody),
    });
    console.log('[PDF Map] (b) HTTP status:', mapResp.status, mapResp.ok ? 'OK' : 'FAIL');

    if (mapResp.ok) {
      const json = await mapResp.json() as { image_base64?: string; overlay_svg?: string; error?: string };
      const b64 = json.image_base64 ?? '';
      overlaySvg = json.overlay_svg ?? '';
      console.log('[PDF Map] (c) image_base64 length:', b64.length, '| overlay_svg chars:', overlaySvg.length);

      if (b64.length > 1000) {
        mapDataUri = `data:image/png;base64,${b64}`;
        console.log('[PDF Map] (d) mapDataUri OK, (e) embeds in HTML: YES');
      } else {
        mapErrorReason = `base64 vacío o muy corto (${b64.length} chars)${json.error ? ': ' + json.error : ''}`;
        console.log('[PDF Map] (d) FAIL:', mapErrorReason);
      }
    } else {
      let errBody = '';
      try { errBody = ((await mapResp.json()) as any).error ?? ''; } catch {}
      mapErrorReason = `servidor respondió HTTP ${mapResp.status}${errBody ? ': ' + errBody : ''}`;
      console.log('[PDF Map] (b) FAIL:', mapErrorReason);
    }
  } catch (err: any) {
    mapErrorReason = `excepción de red: ${err?.message ?? 'desconocida'}`;
    console.log('[PDF Map] (e) EXCEPTION:', mapErrorReason);
  }

  console.log('[PDF Map] resultado final:', mapDataUri.length > 0 ? 'SE EMBEDE' : 'PLACEHOLDER: ' + mapErrorReason);


  // ── C. Load muestras and generate reseñas for photos ─────────────────────
  const muestras = await loadMuestrasForReport(input.projectId);
  for (const m of muestras) {
    if (m.foto_uri && !m.reporte_resena) {
      try {
        const b64data = await fileUriToBase64(m.foto_uri);
        // Extract plain base64 from data URI
        const rawB64 = b64data
          ? b64data.replace(/^data:image\/\w+;base64,/, '')
          : '';
        if (rawB64) {
          const analisisObj = m.analisis_texto
            ? (() => { try { return JSON.parse(m.analisis_texto); } catch { return null; } })()
            : null;
          const analisisStr = analisisObj?.analisis_detallado || m.analisis_texto || '';
          const resena = await generateSampleResena(
            rawB64,
            analisisStr,
            'MEDIA',
            `${m.lat.toFixed(4)}, ${m.lng.toFixed(4)}`
          );
          await saveSampleResena(m.id, resena);
          m.reporte_resena = resena;
        }
      } catch {
        // Graceful degradation: skip if resena generation fails
      }
    }
    // Attach base64 for embedding in PDF
    if (m.foto_uri) {
      try {
        (m as any)._base64 = await fileUriToBase64(m.foto_uri);
      } catch {
        (m as any)._base64 = null;
      }
    }
  }

  // ── D. Generate fecha ─────────────────────────────────────────────────────
  const fechaGeneracion = new Date().toLocaleDateString('es-MX', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  // ── E. Build HTML ─────────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reporte ${input.projectName}</title>
  ${CSS}
</head>
<body>

<!-- ══════ PORTADA ══════ -->
<div class="portada">
  <h1>ProspectorAI</h1>
  <h2>${input.projectName}</h2>
  <p class="subtitle">Reporte de Exploración Mineral</p>
  <table class="meta-table">
    <tr><td>Fecha</td><td>${fechaGeneracion}</td></tr>
    <tr><td>Mineral objetivo</td><td>${input.metalName.toUpperCase()}</td></tr>
    <tr><td>Terreno</td><td>${input.terrainType}</td></tr>
    <tr><td>Área analizada</td><td>${input.areaHa} ha</td></tr>
    <tr><td>Centro de zona</td><td>${input.zoneCenter.lat.toFixed(4)}°N · ${Math.abs(input.zoneCenter.lng).toFixed(4)}°O</td></tr>
    <tr><td>Malla de análisis</td><td>${input.cellSizeM} m</td></tr>
    <tr><td>Fuentes satelitales</td><td>${input.satelitesSources}</td></tr>
  </table>
  <p class="logo-line">Generado por ProspectorAI · Ing. Villegas — Asistente geológico de IA · ${fechaGeneracion}</p>
</div>

${buildFavorabilidadSection(input.zoneProspectivity)}

<!-- ══════ MAPA DE ANOMALÍAS ══════ -->
<div class="page">
  <h2>Mapa de Anomalías</h2>
  ${mapDataUri
    ? `<div class="map-wrap">
        <img class="map-img" src="${mapDataUri}" />
        ${overlaySvg ? `<img class="map-overlay" src="data:image/svg+xml,${encodeURIComponent(overlaySvg)}" />` : ''}
      </div>`
    : `<div class="map-placeholder"><p>Imagen no disponible: ${mapErrorReason}</p></div>`
  }
  <div class="leyenda">
    <span style="color:#E53935">&#9632; ALTA anomalía</span>
    <span style="color:#FFA000">&#9632; MEDIA</span>
    <span style="color:#546E7A">&#9632; BAJA</span>
    <span style="color:#FFD700">&#9733; OBJETIVO PRIORITARIO</span>
    <span style="color:#00E676">&#10003; CONFIRMADA (S2+ASTER)</span>
    <span style="color:#00BCD4">&#9670; TRIPLE (S2+ASTER+EMIT)</span>
  </div>
  <p class="nota-mapa">Imagen compuesta Sentinel-2 · Anomalías espectrales superpuestas · Malla ${input.cellSizeM} m</p>
</div>

<!-- ══════ FUENTES DE DATOS ══════ -->
<div class="page">
  <h2>Fuentes de Datos</h2>
  <table class="data-table">
    <tr><th>Satélite</th><th>Colección GEE</th><th>Resolución</th><th>Fecha imagen</th></tr>
    ${buildSatelliteRows(input.satelitesSources, input.sourceDates, input.acquisitionDates)}
  </table>
  <p style="margin-top:20px">Malla de análisis: <strong>${input.cellSizeM} m</strong>. Puntos analizados: <strong>${input.analysisPoints.length}</strong>.</p>
  <p>Las imágenes fueron seleccionadas con criterio de menor cobertura nubosa (&lt;20%) durante la temporada seca.</p>
</div>

<!-- ══════ ZONAS PRIORITARIAS ══════ -->
<div class="page">
  <h2>Zonas Prioritarias — Top ${Math.min(input.analysisPoints.length, 10)}</h2>
  <table class="points-table">
    <tr><th>#</th><th>Coordenadas (UTM / Grados)</th><th>Nivel</th><th>Evidencias</th><th>Minerales</th></tr>
    ${buildTopPointsRows(input.analysisPoints, input.metalName)}
  </table>
</div>

${buildIndicesSection(input.analysisPoints)}
${buildMetalsSection(input.metalScores)}

<!-- ══════ ING. VILLEGAS (IA) ══════ -->
<div class="page">
  <h2>Interpretación del Geólogo</h2>
  <div class="section-label">Ing. Villegas — Asistente geológico de IA de ProspectorAI · Interpretación asistida por IA · ${fechaGeneracion}</div>
  <h3>Resumen Ejecutivo</h3>
  <p>${resumenEjec.replace(/\n/g, '<br />')}</p>
  <h3>Interpretación Geológica</h3>
  <p>${interpretacion.replace(/\n/g, '<br />')}</p>
  <h3>Plan de Campo Recomendado</h3>
  <pre>${planCampo}</pre>
</div>

<!-- ══════ EVIDENCIA DE CAMPO ══════ -->
${buildSamplePages(muestras)}

<!-- ══════ DISCLAIMER ══════ -->
<div class="page disclaimer">
  <h2>Aviso Profesional</h2>
  <p>Los indicadores presentados en este reporte son exploratorios y derivan del análisis
  de imágenes de percepción remota (teledetección satelital). No constituyen certificación
  de mineralización ni sustituto de un estudio geológico convencional. Los resultados
  requieren verificación mediante trabajo de campo, muestreo geoquímico y análisis de
  laboratorio.</p>
  <p>ProspectorAI es una herramienta de apoyo a la exploración, no una garantía de
  presencia de minerales económicamente explotables. Los patrones espectrales identificados
  son compatibles con ciertos tipos de alteración hidrotermal o mineralización, pero
  su presencia económica debe confirmarse mediante métodos directos.</p>
  <p>Los valores de favorabilidad (SEÑAL y CONFIANZA) <strong>no representan una probabilidad
  de yacimiento</strong> ni indican ley, tonelaje o profundidad. La interpretación de
  "Ing. Villegas" es generada por un asistente de inteligencia artificial de ProspectorAI —no por
  un geólogo humano— y debe ser revisada por un geólogo profesional colegiado antes de
  cualquier decisión de inversión.</p>
  <p style="color:#999;font-size:11px;margin-top:30px">ProspectorAI · Análisis satelital con Sentinel-2, ASTER y EMIT · ${fechaGeneracion}</p>
</div>

</body>
</html>`;

  // ── F. Generate PDF and share ─────────────────────────────────────────────
  const { uri } = await Print.printToFileAsync({ html, base64: false });
  await Sharing.shareAsync(uri, {
    mimeType: 'application/pdf',
    dialogTitle: `Reporte ${input.projectName}`,
    UTI: 'com.adobe.pdf',
  });
}

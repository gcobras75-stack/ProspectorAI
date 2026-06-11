/**
 * ReportGenerator.ts
 *
 * Generates a professional PDF exploration report using expo-print and expo-sharing.
 * Integrates Dr. Marco Ruiz AI section, satellite map image, and field sample photos.
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

  /* ── Dr. Ruiz ── */
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

    // Real spectral indices: p.indices is the raw array from GEE
    const indices = (p.indices || [])
      .slice(0, 3)
      .map((idx: any) => {
        const name = idx.name || idx.nombre || '';
        const val  = typeof idx.value === 'number' ? idx.value.toFixed(3) : '';
        return val ? `${name}: ${val}` : name;
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
      pairHtml += `
        <div class="sample-page">
          ${photoHtml}
          <div class="sample-info">
            <h4>Muestra #${m.id}</h4>
            <div class="sample-coord">${latLngToUTM(m.lat, m.lng)} · ${m.fecha ? new Date(m.fecha).toLocaleDateString('es-MX') : ''}</div>
            <div class="sample-resena">${m.reporte_resena || 'Sin reseña generada.'}</div>
            ${analisisStr ? `<div class="sample-analisis">Análisis IA: ${analisisStr.substring(0, 200)}</div>` : ''}
          </div>
        </div>`;
    }
    pages += `<div class="page"><h2>Evidencia de Campo</h2>${pairHtml}</div>`;
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function generateAndShareReport(input: ReportInput): Promise<void> {
  // ── A. Obtain/generate Dr. Ruiz section (cached) ─────────────────────────
  // Compute hash from current analysis (top-5 coords + base_scores + metal + area)
  const analisisHash =
    input.analysisPoints.slice(0, 5).map(p => `${p.lat?.toFixed(4)},${p.lng?.toFixed(4)},${(p.base_score || 0).toFixed(3)}`).join('|')
    + `|${input.metalName}|${input.areaHa}`;

  let saved = await loadReportContent(input.projectId);
  let geologoTexto = saved?.geologoTexto ?? '';
  const cachedHashMatches = saved?.analisisHash === analisisHash;

  if (!geologoTexto || !cachedHashMatches) {
    console.log('[Report] Generating Dr. Ruiz section. Reason:', !geologoTexto ? 'no cache' : 'analysis changed');
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
    console.log('[Report] Using cached Dr. Ruiz section (hash match).');
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
  <p class="logo-line">Generado por ProspectorAI · Dr. Marco Ruiz · ${fechaGeneracion}</p>
</div>

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

<!-- ══════ DR. MARCO RUIZ ══════ -->
<div class="page">
  <h2>Interpretación del Geólogo</h2>
  <div class="section-label">Dr. Marco Ruiz · Geólogo Explorador · ProspectorAI · ${fechaGeneracion}</div>
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

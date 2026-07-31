/**
 * excelExport.ts — Exporta un proyecto completo a un archivo .xlsx (SheetJS).
 *
 * Solo exporta datos REALES (los mismos que ya están en la BD / el motor). Los
 * índices sin proxy directo de Sentinel-2 se marcan explícitamente como "sin dato";
 * los metales no medibles por óptico se marcan "Requiere ASTER/EMIT". No inventa nada.
 */
import * as XLSX from 'xlsx';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { getMuestras, loadProjectState } from './Database';
import { applyEvidenceCeiling } from './ConsensusFusion';
import { computeAllMetalScores } from './GeologicalEngine';
import { INDEX_GLOSSARY, NON_S2_INDEX_KEYS, S2_REAL_INDEX_KEYS } from './indexGlossary';

const SAFE = (s: string) => (s || 'proyecto').replace(/[^\w\-]+/g, '_').slice(0, 40);
const num3 = (v: any) => (typeof v === 'number' && isFinite(v) ? Number(v.toFixed(3)) : '');

/** Genera y comparte un .xlsx con las hojas: Proyecto, Puntos, Muestras, Metales. */
export async function exportProjectToExcel(projectId: string, projectName?: string): Promise<void> {
  const proj = await loadProjectState(projectId);
  if (!proj) throw new Error('No se pudo cargar el proyecto.');

  const muestras = await getMuestras(projectId);
  const points: any[] = Array.isArray(proj.analisis_resultado) ? proj.analisis_resultado : [];
  // TECHO DE EVIDENCIA: el objeto viene de la base y puede ser de un análisis previo a
  // esta versión, con la CONFIANZA sin capar. Misma función que pantalla y PDF.
  const prosp: any = applyEvidenceCeiling(proj.prospectivity, proj.mineral);
  const metals = points.length && points[0]?.indices
    ? computeAllMetalScores(points as any, proj.terrain)
    : [];

  const wb = XLSX.utils.book_new();

  // ── Hoja 1: Proyecto ───────────────────────────────────────────────────────
  const projRows: any[][] = [
    ['ProspectorAI — Exportación de proyecto'],
    [],
    ['Proyecto', proj.nombre],
    ['Mineral objetivo', proj.mineral],
    ['Terreno', proj.terrain],
    ['Profundidad', proj.depth],
    ['Área (ha)', proj.area_ha],
    ['Fuente satelital', proj.satdata_source],
    ['Fecha de adquisición', proj.acquisition_date],
    [],
    ['ÍNDICE DE FAVORABILIDAD DE ZONA (medidas separadas — NO es probabilidad de yacimiento)'],
  ];
  if (prosp) {
    projRows.push(['Señal espectral (0-100)', prosp.signal]);
    projRows.push(['Confianza (0-100)', prosp.confidence, prosp.confidence_label || '']);
    if (typeof prosp.acquisition_quality === 'number') {
      // Se reporta aparte y con su nombre: es la calidad de la TOMA, no la confianza.
      projRows.push(['Calidad de la toma satelital (0-100)', prosp.acquisition_quality]);
    }
    projRows.push(['Favorabilidad', prosp.band_label || prosp.band || '']);
    if (Array.isArray(prosp.reasons_plus) && prosp.reasons_plus.length) {
      projRows.push(['A favor (+)', prosp.reasons_plus.join(' · ')]);
    }
    if (Array.isArray(prosp.reasons_minus) && prosp.reasons_minus.length) {
      projRows.push(['En contra (−)', prosp.reasons_minus.join(' · ')]);
    }
  } else {
    projRows.push(['(Sin índice de zona guardado para este proyecto)']);
  }
  projRows.push([]);
  projRows.push([
    'Aviso',
    'Indicador exploratorio. SEÑAL = intensidad de alteración espectral; CONFIANZA = fiabilidad del dato. ' +
      'No indica probabilidad de yacimiento, ley, tonelaje ni profundidad. Requiere verificación en campo.',
  ]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(projRows), 'Proyecto');

  // ── Hoja 2: Puntos ─────────────────────────────────────────────────────────
  const idxKeys = [...S2_REAL_INDEX_KEYS];
  const pointsHeader = [
    'Rank', 'Lat', 'Lng', 'UTM zona', 'Señal (0-100)', 'Consenso', 'Evidencia',
    ...idxKeys.map(k => INDEX_GLOSSARY[k]?.label ?? k),
  ];
  const pointsBody = points.map(p => [
    p.rank ?? '', p.lat ?? '', p.lng ?? '', p.utm_zone ?? '',
    typeof p.base_score === 'number' ? Math.round(p.base_score) : '',
    p.consensus_level ?? p.consensus ?? '', p.evidence ?? '',
    ...idxKeys.map(k => num3(p.indices?.[k])),
  ]);
  const pointsRows: any[][] = [
    ['Nota: los índices listados son los medidos por Sentinel-2. Sin dato directo de S2 (requiere ASTER/EMIT): ' +
      NON_S2_INDEX_KEYS.map(k => INDEX_GLOSSARY[k]?.label ?? k).join(', ')],
    [],
    pointsHeader,
    ...(pointsBody.length ? pointsBody : [['(Sin puntos de análisis)']]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pointsRows), 'Puntos');

  // ── Hoja 3: Muestras ───────────────────────────────────────────────────────
  const mHeader = [
    'Código', 'Lat', 'Lng', 'UTM zona', 'Fecha', 'Tipo', 'Mineral detectado', 'Score IA',
    'Descripción', 'Au g/t', 'Ag g/t', 'Cu %', 'Pb %', 'Zn %', 'Laboratorio',
    'Validación', 'Comentario',
  ];
  const mBody = (muestras || []).map((m: any) => [
    m.muestra_codigo ?? '', m.lat ?? '', m.lng ?? '', m.utm_zona ?? '', m.fecha_hora ?? '',
    m.tipo_captura ?? '', m.mineral_detectado ?? '', m.score_ia ?? '', m.descripcion_texto ?? '',
    m.lab_au_gt ?? '', m.lab_ag_gt ?? '', m.lab_cu_pct ?? '', m.lab_pb_pct ?? '', m.lab_zn_pct ?? '',
    m.lab_laboratorio ?? '', m.validation_verdict ?? '', m.validation_comment ?? '',
  ]);
  const mRows: any[][] = [mHeader, ...(mBody.length ? mBody : [['(Sin muestras)']])];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mRows), 'Muestras');

  // ── Hoja 4: Metales ────────────────────────────────────────────────────────
  const metHeader = ['Metal', 'Señal %', 'Nivel', 'Requiere ASTER/EMIT', '% sin proxy óptico directo'];
  const metBody = metals.map((mt: any) => [
    mt.label ?? mt.metal, mt.score_percent ?? '', mt.detected ?? '',
    mt.requires_deep ? 'Sí' : 'No', mt.synthetic_weight_pct ?? 0,
  ]);
  const metRows: any[][] = [metHeader, ...(metBody.length ? metBody : [['(Sin análisis para calcular metales)']])];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(metRows), 'Metales');

  // ── Escribir + compartir ───────────────────────────────────────────────────
  const base64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
  const fileUri = `${FileSystem.cacheDirectory}ProspectorAI_${SAFE(projectName ?? proj.nombre)}.xlsx`;
  await FileSystem.writeAsStringAsync(fileUri, base64, { encoding: FileSystem.EncodingType.Base64 });

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(fileUri, {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      dialogTitle: 'Exportar proyecto a Excel',
      UTI: 'org.openxmlformats.spreadsheetml.sheet',
    });
  } else {
    throw new Error('Compartir no está disponible en este dispositivo.');
  }
}

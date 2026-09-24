// El cliente ignora POR COMPLETO lo estructural del servidor (near_lineament / structuralScore / lineamientos).
// Correr: node --import ./scripts/ts-resolve.mjs --import ./scripts/test-stubs.mjs --test scripts/test-no-structural.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fuseAnalysisPoints, computeZoneProspectivity } from '../app/core/ConsensusFusion.ts';

const LAT = 31.0, LNG = -110.3;
const s2 = { cells: [{ lat: LAT, lng: LNG, iron_oxide: 3.0, clay: 2.5, ferroso: 3.0 }], has_coverage: true, data_source: 'SENTINEL2_REAL' };
const aster = { cells: [{ lat: LAT, lng: LNG, iron_oxide_aster: 3.0, alunite_bd: 0.3, chlorite_bd: 0.3, ferroso_aster: 2.5 }], has_coverage: true, data_source: 'ASTER_HISTORICAL' };
// El servidor "arreglado": responde 200 con lineamiento fuerte justo sobre el punto.
const structuralQueRespondeOK = { cells: [{ lat: LAT, lng: LNG, lineament_density: 0.95, near_lineament: true, slope_deg: 20 }], data_source: 'SENTINEL1_DEM' };
const pts = () => [{ lat: LAT, lng: LNG, rank: 1, base_score: 70, score: 70, id: 'p1' }];

test('el servidor responde 200 con near_lineament:true → el consenso queda IDÉNTICO a no tener la ruta', () => {
  const con = fuseAnalysisPoints(pts(), s2, aster, null, structuralQueRespondeOK, 'oro');
  const sin = fuseAnalysisPoints(pts(), s2, aster, null, null, 'oro');
  assert.deepEqual(con, sin);
  assert.equal(con[0].near_lineament, false);
  assert.equal(con[0].structuralScore, null);
  assert.notEqual(con[0].consensus, 'PRIORITY_TARGET');
  assert.doesNotMatch(con[0].evidence, /Estructura/);
});

test('el puntaje no lleva el empujón de "objetivo prioritario" (x1.25)', () => {
  const con = fuseAnalysisPoints(pts(), s2, aster, null, structuralQueRespondeOK, 'oro')[0];
  const top = Math.max(con.s2Score, con.asterScore ?? 0);
  assert.equal(con.score, Math.min(100, Math.round(top * 1.15)));   // CONFIRMED (x1.15), nunca PRIORITY (x1.25)
});

test('puntos GUARDADOS con near_lineament:true (análisis viejos) tampoco cambian el resumen de zona', () => {
  const base = fuseAnalysisPoints(pts(), s2, aster, null, null, 'oro');
  const viejo = base.map((p) => ({ ...p, near_lineament: true, structuralScore: 90 }));
  const a = computeZoneProspectivity(base, 'oro', 'sierra');
  const b = computeZoneProspectivity(viejo, 'oro', 'sierra');
  assert.deepEqual(b, a);
  assert.doesNotMatch(JSON.stringify(b), /falla|lineamiento|Estructura/i);
});

const FILES = [
  'app/core/ClaudeServices.ts', 'server-ai/villegas-prompts.js', 'app/components/ResultsPanel.tsx', 'app/(tabs)/geologo.tsx',
  'web-lib/projectContext.ts', 'web-lib/LeafletMap.tsx', 'app/core/pointInterpretation.ts', 'app-web/analisis/nuevo.tsx',
  'app-web/proyecto/[id].tsx', 'app/(tabs)/index.tsx', 'web-lib/runAnalysis.ts', 'app/components/ConfigModal.tsx',
];
const PROHIBIDO = /near_lineament|structuralScore|lineamiento|lineament|posible falla|falla geol|\+ falla|Sentinel-1|Estructura ✓|control estructural|fetchStructuralGrid|structural\/grid|GEOLOGÍA ESTRUCTURAL/i;

test('ningún texto ni código de las apps menciona lo estructural ni llama a la ruta', () => {
  for (const f of FILES) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    const m = src.match(PROHIBIDO);
    assert.equal(m, null, `${f} menciona «${m && m[0]}»`);
  }
});

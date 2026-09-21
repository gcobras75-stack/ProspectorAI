// Tests de web-lib/validationPairs.ts (módulo puro). Correr: node --test scripts/test-validation-pairs.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  pointKey, pairClientId, keyFromClientId, cleanNote, buildPairPayload, parsePairRow, isVerdict,
  VERDICTS, VERDICT_BADGE, VERDICT_BUTTON, VERDICT_HELP, SCOPE_NOTICE, NOTE_MAX,
} from '../web-lib/validationPairs.ts';

const project = { id: 'web_1758000000000', mineral: 'oro', analysis_meta: { fecha: '2026-09-20T10:00:00.000Z', fuentes: { s2: true, aster: false } } };
const point = { lat: 23.757579, lng: -106.264932, rank: 2, score: 71, base_score: 64.2, consensus: 'CONFIRMED', evidence: 'S2 ✓ · ASTER ✓', indices: { iron_oxide: 0.8, clay: 0.6 } };

test('pointKey: 5 decimales, negativos, -0 y coordenadas inválidas', () => {
  assert.equal(pointKey(23.757579, -106.264932), '23.75758,-106.26493');
  assert.equal(pointKey(-0.000001, 0.000001), '0.00000,0.00000'); // sin "-0.00000"
  assert.equal(pointKey(-27.1, -69.05), '-27.10000,-69.05000');
  for (const bad of [[NaN, 1], [1, Infinity], [undefined, 1]]) assert.throws(() => pointKey(...bad), /coordenadas/);
});

test('client_id EXACTO: "web:<proyecto>:<lat5>,<lng5>"', () => {
  assert.equal(pairClientId('web_1758000000000', 23.757579, -106.264932), 'web:web_1758000000000:23.75758,-106.26493');
});

test('keyFromClientId: inversa; ignora otro proyecto, ids de la app nativa y formatos rotos', () => {
  const id = pairClientId('web_1', 25.04267, -107.49256);
  assert.equal(keyFromClientId(id, 'web_1'), '25.04267,-107.49256');
  assert.equal(keyFromClientId(id, 'web_2'), null);
  assert.equal(keyFromClientId('vp_lkj3h2', 'web_1'), null);           // id de la app nativa
  assert.equal(keyFromClientId('web:web_1:25.04,-107.4', 'web_1'), null); // menos de 5 decimales
  assert.equal(keyFromClientId(undefined, 'web_1'), null);
});

test('cleanNote: recorta espacios y a 280 caracteres', () => {
  assert.equal(cleanNote('  hola  '), 'hola');
  assert.equal(cleanNote('x'.repeat(500)).length, NOTE_MAX);
  assert.equal(cleanNote(undefined), '');
  assert.equal(cleanNote(42), '');
});

test('buildPairPayload: forma y claves documentadas', () => {
  const now = new Date('2026-09-20T12:00:00.000Z');
  const p = buildPairPayload({ userId: 'u-1', project, point, verdict: 'NOT_CONFIRMED', comment: '  vi solo roca sana  ', now });
  assert.equal(p.user_id, 'u-1');
  assert.equal(p.client_id, 'web:web_1758000000000:23.75758,-106.26493');
  assert.equal(p.project_client_id, 'web_1758000000000');
  assert.deepEqual(p.predicted, { consensus: 'CONFIRMED', evidence: 'S2 ✓ · ASTER ✓', base_score: 64.2, indices: { iron_oxide: 0.8, clay: 0.6 }, metal: 'oro', score: 71, rank: 2 });
  assert.deepEqual(p.actual, { verdict: 'NOT_CONFIRMED', comment: 'vi solo roca sana', threshold: 0.5 });
  assert.equal(p.data.muestra_id, '');
  assert.equal(p.data.created_at, '2026-09-20T12:00:00.000Z');
  assert.equal(p.data.origen, 'pwa');
  assert.equal(p.data.lat, 23.75758); assert.equal(p.data.lng, -106.26493); assert.equal(p.data.rank, 2);
  assert.deepEqual(p.data.analisis, { fecha: '2026-09-20T10:00:00.000Z', fuentes: { s2: true, aster: false } });
  assert.match(p.data.nota_alcance, /no prueba ausencia/);
});

test('buildPairPayload: lo inválido se rechaza (nada se guarda a medias)', () => {
  const base = { userId: 'u-1', project, point, verdict: 'CONFIRMED' };
  assert.throws(() => buildPairPayload({ ...base, verdict: 'MAYBE' }), /Veredicto/);
  assert.throws(() => buildPairPayload({ ...base, userId: '' }), /sesión/);
  assert.throws(() => buildPairPayload({ ...base, point: { ...point, lat: NaN } }), /coordenadas/);
});

test('buildPairPayload: punto sin datos del análisis → null/vacío, sin inventar valores', () => {
  const p = buildPairPayload({ userId: 'u', project: { id: 'p', mineral: 'oro' }, point: { lat: 1, lng: 2 }, verdict: 'PARTIAL' });
  assert.deepEqual(p.predicted.indices, {});
  assert.equal(p.predicted.base_score, null);
  assert.equal(p.predicted.score, null);
  assert.equal(p.predicted.rank, null);
  assert.deepEqual(p.data.analisis, { fecha: null, fuentes: null });
});

test('mismas claves de veredicto que la app nativa', () => {
  assert.deepEqual(VERDICTS, ['CONFIRMED', 'PARTIAL', 'NOT_CONFIRMED']);
  const native = fs.readFileSync(new URL('../app/components/SampleDetailModal.tsx', import.meta.url), 'utf8');
  for (const k of VERDICTS) assert.ok(native.includes(k), `la nativa usa ${k}`);
  assert.ok(isVerdict('PARTIAL') && !isVerdict('partial') && !isVerdict(null));
});

test('COMPATIBILIDAD con la nativa: upsertValidationFromRemote lee esta fila sin problema', () => {
  const row = buildPairPayload({ userId: 'u', project, point, verdict: 'PARTIAL', comment: 'algo de óxido' });
  // Réplica de las lecturas de Database.ts → upsertValidationFromRemote
  const id = row.client_id; const p = row.predicted || {}; const a = row.actual || {}; const d = row.data || {};
  const local = [id, d.muestra_id || '', row.project_client_id || 'default', d.created_at || 'ahora', p.consensus || '', p.evidence || '', p.base_score || 0,
    JSON.stringify(p.indices ?? {}), p.metal || '', a.au_gt ?? null, a.ag_gt ?? null, a.cu_pct ?? null, a.pb_pct ?? null, a.zn_pct ?? null, a.verdict || '', a.comment || '', a.threshold ?? 0.5];
  assert.equal(local.length, 17);
  assert.equal(local[0], row.client_id);
  assert.equal(local[1], '');            // muestra_id NOT NULL en SQLite: '' es válido
  assert.equal(local[14], 'PARTIAL'); assert.equal(local[15], 'algo de óxido'); assert.equal(local[16], 0.5);
  assert.ok(local.slice(9, 14).every((v) => v === null)); // sin laboratorio: NULL, no 0
});

test('parsePairRow: ida y vuelta, e ignora filas ajenas', () => {
  const row = buildPairPayload({ userId: 'u', project, point, verdict: 'CONFIRMED', comment: 'vetilla con óxidos', now: new Date('2026-09-20T12:00:00.000Z') });
  const parsed = parsePairRow(row, project.id);
  assert.equal(parsed.key, '23.75758,-106.26493');
  assert.deepEqual(parsed.view, { verdict: 'CONFIRMED', comment: 'vetilla con óxidos', created_at: '2026-09-20T12:00:00.000Z' });
  assert.equal(parsePairRow(row, 'otro'), null);
  assert.equal(parsePairRow({ client_id: 'vp_x', actual: { verdict: 'CONFIRMED' } }, project.id), null);
  assert.equal(parsePairRow({ client_id: row.client_id, actual: { verdict: 'RARO' } }, project.id), null);
  assert.equal(parsePairRow(null, project.id), null);
});

test('HONESTIDAD: "No encontré nada" = "en mi visita no lo encontré", no "no existe"; y no ajusta el análisis', () => {
  assert.equal(VERDICT_BUTTON.NOT_CONFIRMED, 'No encontré nada');
  assert.match(VERDICT_HELP.NOT_CONFIRMED, /EN MI VISITA/);
  assert.match(VERDICT_HELP.NOT_CONFIRMED, /No prueba que no exista/);
  assert.match(VERDICT_BADGE.NOT_CONFIRMED, /en mi visita/);
  assert.match(SCOPE_NOTICE, /no cambia el análisis/);
  for (const v of VERDICTS) assert.ok(VERDICT_BADGE[v] && VERDICT_BUTTON[v] && VERDICT_HELP[v]);
  // Ninguna etiqueta afirma ausencia ni "aprende"
  const all = JSON.stringify([VERDICT_BADGE, VERDICT_BUTTON, VERDICT_HELP, SCOPE_NOTICE]).toLowerCase();
  assert.ok(!all.includes('no existe.') && !all.includes('aprende'));
});

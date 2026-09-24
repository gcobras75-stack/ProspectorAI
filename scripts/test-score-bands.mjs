// Umbrales únicos de alto/medio/bajo. Correr: node --import ./scripts/ts-resolve.mjs --test scripts/test-score-bands.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
const { AnomalyLevel, anomalyFromPct, detectedFromPct, prospectivityFromSignal } = await import('../app/core/theme.ts');
const { anomalyFromPct: fromHelpers, tapMessage } = await import('../app/core/spectralHelpers.ts');

test('65/35 en TODAS las funciones de banda, en los bordes', () => {
  for (const [pct, label, det] of [[100,'ALTA','high'],[65,'ALTA','high'],[64,'MEDIA','medium'],[35,'MEDIA','medium'],[34,'BAJA','low'],[0,'BAJA','low']]) {
    assert.equal(anomalyFromPct(pct).label, label, `theme ${pct}`);
    assert.equal(fromHelpers(pct).level, label, `spectralHelpers ${pct}`);
    assert.equal(detectedFromPct(pct), det, `detected ${pct}`);
  }
  assert.equal(AnomalyLevel.high.minPct, 65);
  assert.equal(AnomalyLevel.med.minPct, 35);
});
test('la favorabilidad de zona usa los mismos cortes', () => {
  assert.equal(prospectivityFromSignal(65).band, 'FUERTE');
  assert.equal(prospectivityFromSignal(64).band, 'MODERADA');
  assert.equal(prospectivityFromSignal(34).band, 'DEBIL');
  assert.match(tapMessage(65).text, /significativa/);
  assert.match(tapMessage(64).text, /moderada/);
});

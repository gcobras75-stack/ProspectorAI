// Tests de app/core/displayScore.ts y de su efecto en la fusión. Correr:
// node --import ./scripts/ts-resolve.mjs --test scripts/test-display-score.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
const { displayScore } = await import('../app/core/displayScore.ts');

test('prefiere score (IA/consenso) y cae a base_score', () => {
  assert.equal(displayScore({ score: 91, base_score: 74 }), 91);
  assert.equal(displayScore({ base_score: 74 }), 74);
  assert.equal(displayScore({ score: 0, base_score: 74 }), 0);   // un 0 real de la IA es un 0
  assert.equal(displayScore({ score: NaN, base_score: 74 }), 74);
});
test('nunca inventa: sin datos → 0, sin lanzar', () => {
  assert.equal(displayScore({}), 0);
  assert.equal(displayScore(null), 0);
  assert.equal(displayScore({ score: '80', base_score: undefined }), 0);
});

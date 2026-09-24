// Sugerencia de Análisis profundo por material. Correr: node --import ./scripts/ts-resolve.mjs --test scripts/test-deep-advice.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deepAdvice, deepAdviceText, deepCeilings, effectiveDeep } from '../app/core/deepAdvice.ts';
import { CATALOG_WEIGHTS } from '../app/core/materialsCatalog.ts';

const SUBEN = ['caliza', 'marmol', 'onix', 'barita', 'yeso', 'plomo_zinc'];
const NO_SUBEN_NUNCA = ['cobre', 'oro', 'tierras_raras', 'cantera', 'granito', 'silice'];
const GRUPO4 = ['hierro', 'manganeso', 'fluorita', 'arcillas_caolin', 'laja', 'agregados', 'pomez', 'bancos_jales', 'placeres'];
const PLATA = ['plata'];

test('cubre los 22 materiales del catálogo, cada uno en un solo grupo', () => {
  const todos = [...SUBEN, ...NO_SUBEN_NUNCA, ...GRUPO4, ...PLATA];
  assert.equal(new Set(todos).size, 22);
  assert.deepEqual([...todos].sort(), Object.keys(CATALOG_WEIGHTS).sort());
});

test('los que se benefician: con el profundo apagado se sugiere; encendido, silencio', () => {
  for (const id of SUBEN) {
    const off = deepAdvice(id, false);
    assert.equal(off?.kind, 'suggest', id);
    assert.ok(off.ceilingWithDeepPct - off.ceilingPct >= 20, id);
    assert.equal(deepAdvice(id, true), null, id);
  }
});

test('oro/cobre/tierras_raras/cantera/granito/sílice: apagado silencio; encendido, aviso honesto', () => {
  for (const id of NO_SUBEN_NUNCA) {
    assert.equal(deepAdvice(id, false), null, id);
    assert.equal(deepAdvice(id, true)?.kind, 'unneeded', id);
  }
});

test('grupo 4 (techo 100%, mejora de calidad) y plata: NUNCA hay aviso, ni apagado ni encendido', () => {
  for (const id of [...GRUPO4, ...PLATA]) {
    assert.equal(deepAdvice(id, false), null, id);
    assert.equal(deepAdvice(id, true), null, id);
  }
});

test('valor por defecto: apagado en todos salvo plata; la elección manual manda', () => {
  for (const id of [...SUBEN, ...NO_SUBEN_NUNCA, ...GRUPO4]) assert.equal(effectiveDeep(id, false, null), false, id);
  assert.equal(effectiveDeep('plata', false, null), true);       // arranca encendido
  assert.equal(effectiveDeep('plata', false, false), false);     // lo apagó: se respeta
  assert.equal(effectiveDeep('plata', true, null), true);
  assert.equal(effectiveDeep('yeso', false, true), true);        // lo encendió a mano en otro material
  assert.equal(effectiveDeep('cobre', true, null), true);        // preferencia guardada (comportamiento previo)
});

test('cobre y oro: el techo NO cambia con el profundo (malachite y silica sin proxy real)', () => {
  assert.deepEqual(deepCeilings('cobre'), { off: 65, on: 65 });
  assert.deepEqual(deepCeilings('oro'), { off: 85, on: 85 });
});

test('yeso y plomo_zinc: números del aviso', () => {
  assert.deepEqual(deepCeilings('yeso'), { off: 75, on: 100 });
  assert.deepEqual(deepCeilings('plomo_zinc'), { off: 25, on: 55 });
});

test('ids heredados y desconocidos', () => {
  assert.equal(deepAdvice('zinc', false)?.kind, 'suggest');   // → plomo_zinc
  // normalizeMaterialId manda lo desconocido a 'oro' (comportamiento existente): mismo aviso que oro
  assert.deepEqual(deepAdvice('no_existe', true), deepAdvice('oro', true));
});

test('los textos: sugerir menciona "tarda más" y el salto; el otro no promete de más', () => {
  const t1 = deepAdviceText('Yeso', deepAdvice('yeso', false));
  assert.match(t1, /mejora mucho con Análisis profundo \(tarda más\)/);
  assert.match(t1, /75% a 100%/);
  assert.match(t1, /¿Activarlo\?/);
  const t2 = deepAdviceText('Cobre', deepAdvice('cobre', true));
  assert.match(t2, /Cobre/);
  assert.match(t2, /sin esperar más/);
});

test('el valor por defecto sigue APAGADO (base) y el estado efectivo sale de effectiveDeep en las dos apps', () => {
  const nativa = readFileSync(new URL('../app/(tabs)/index.tsx', import.meta.url), 'utf8');
  const web = readFileSync(new URL('../app-web/analisis/nuevo.tsx', import.meta.url), 'utf8');
  assert.ok(nativa.includes('const [deepBase, setDeepBase] = useState(false)'));
  assert.ok(nativa.includes('effectiveDeep(selectedMineral, deepBase, deepManual)'));
  assert.ok(web.includes('deep: false'));
  assert.ok(web.includes('effectiveDeep(mineral, deepBase, deepManual)'));
});

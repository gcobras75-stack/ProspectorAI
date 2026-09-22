// Tests de web-lib/confirmAction.ts. Correr: node --import ./scripts/ts-resolve.mjs --test scripts/test-confirm-action.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const { confirmAction } = await import('../web-lib/confirmAction.ts');

test('junta pregunta y consecuencia con un espacio, en ese orden', () => {
  const real = globalThis.window;
  let seen = null;
  globalThis.window = { confirm: (msg) => { seen = msg; return true; } };
  assert.equal(confirmAction('¿Borrar esto?', 'No se puede deshacer.'), true);
  assert.equal(seen, '¿Borrar esto? No se puede deshacer.');
  globalThis.window = real;
});

test('devuelve lo que el usuario elige (aceptar / cancelar)', () => {
  const real = globalThis.window;
  globalThis.window = { confirm: () => false };
  assert.equal(confirmAction('¿Seguro?', 'Se pierde todo.'), false);
  globalThis.window = real;
});

test('sin window (prerender/servidor) no bloquea: deja pasar', () => {
  const real = globalThis.window;
  // @ts-ignore
  delete globalThis.window;
  assert.equal(confirmAction('¿Algo?', 'Consecuencia.'), true);
  globalThis.window = real;
});

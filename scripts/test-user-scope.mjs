// Tests del aislamiento de localStorage por usuario (A5). Correr: node --test scripts/test-user-scope.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

// localStorage falso, con la misma interfaz que usa el código (length / key / getItem / setItem / removeItem)
class FakeStorage {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  keys() { return [...this.m.keys()].sort(); }
}
globalThis.window = { localStorage: new FakeStorage() };
const ls = () => globalThis.window.localStorage;

const scope = await import('../web-lib/userScope.ts');
const chat = await import('../web-lib/chatStore.ts');
const sel = await import('../web-lib/selection.ts');

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const msg = (t) => [{ role: 'user', content: t }];

test('sin usuario identificado: no se lee ni se escribe storage', () => {
  scope.setScopeUser(null);
  chat.saveChat('general', msg('hola'));
  sel.setSelectedProjectId('web_1');
  assert.deepEqual(ls().keys(), []);
  assert.deepEqual(chat.loadChat('general'), []);
  assert.equal(scope.scopedKey('pwa.analysisPrefs'), null);
});

test('las claves llevan el id del usuario, con el formato acordado', () => {
  scope.setScopeUser(A);
  chat.saveChat('general', msg('a1'));
  chat.saveChat('web_9', msg('a2'));
  sel.setSelectedProjectId('web_9');
  ls().setItem(scope.scopedKey('pwa.analysisPrefs'), '{"mineral":"cobre"}');
  assert.deepEqual(ls().keys(), [`pwa.analysisPrefs.${A}`, `pwa.chat.${A}.general`, `pwa.chat.${A}.web_9`, `pwa.selectedProjectId.${A}`]);
  assert.equal(chat.loadChat('web_9')[0].content, 'a2');
  assert.equal(sel.getSelectedProjectId(), 'web_9');
});

test('CAMBIO de usuario en el mismo navegador: B no ve NADA de A, y lo de A se borra', () => {
  scope.setScopeUser(B);
  assert.deepEqual(chat.loadChat('general'), []);
  assert.deepEqual(chat.loadChat('web_9'), []);
  assert.equal(sel.getSelectedProjectId(), null);            // ni de memoria ni de storage
  assert.deepEqual(ls().keys(), []);                          // lo de A ya no está en el disco
  chat.saveChat('general', msg('b1'));
  assert.equal(chat.loadChat('general')[0].content, 'b1');
});

test('signOut (usuario → null): se borra todo lo del usuario que sale', () => {
  scope.setScopeUser(A);
  chat.saveChat('general', msg('a3'));
  sel.setSelectedProjectId('web_9');
  assert.ok(ls().keys().length >= 2);
  scope.setScopeUser(null);
  assert.deepEqual(ls().keys(), []);
  assert.equal(sel.getSelectedProjectId(), null);
});

test('la interpretación pendiente (memoria) tampoco pasa al usuario siguiente', () => {
  scope.setScopeUser(A);
  sel.setPendingInterpretation('punto 1', 'web_9');
  assert.ok(sel.peekPendingInterpretation());
  scope.setScopeUser(B);
  assert.equal(sel.peekPendingInterpretation(), null);
});

test('claves antiguas SIN id (pwa.chat.<x>, pwa.selectedProjectId, pwa.analysisPrefs) se purgan al identificar a cualquiera', () => {
  scope.setScopeUser(null);
  ls().setItem('pwa.chat.general', '[{"role":"user","content":"del piloto anterior"}]');
  ls().setItem('pwa.chat.web_9', '[]');
  ls().setItem('pwa.selectedProjectId', 'web_9');
  ls().setItem('pwa.analysisPrefs', '{"mineral":"oro"}');
  scope.setScopeUser(A);
  assert.deepEqual(ls().keys(), []);
  assert.deepEqual(chat.loadChat('general'), []);             // ya no se "hereda" el chat viejo
});

test('solo se tocan claves pwa.*: la sesión de Supabase y claves ajenas sobreviven', () => {
  scope.setScopeUser(A);
  ls().setItem('sb-proyecto-auth-token', '{"access_token":"x"}');
  ls().setItem('otra.cosa', '1');
  chat.saveChat('general', msg('a4'));
  scope.setScopeUser(B);
  scope.setScopeUser(null);
  assert.deepEqual(ls().keys(), ['otra.cosa', 'sb-proyecto-auth-token']);
});

test('mismo usuario otra vez: no borra nada (setScopeUser es idempotente)', () => {
  scope.setScopeUser(A);
  chat.saveChat('general', msg('a5'));
  scope.setScopeUser(A);
  assert.equal(chat.loadChat('general')[0].content, 'a5');
});

test('belongsTo: un id que es prefijo de otro no confunde usuarios', () => {
  assert.equal(scope.belongsTo(`pwa.chat.${A}.general`, A), true);
  assert.equal(scope.belongsTo(`pwa.chat.${A}x.general`, A), false);
  assert.equal(scope.belongsTo('pwa.chat.general', A), false);
  assert.equal(scope.belongsTo(`pwa.chat.${A}.general`, null), false);
});

test('storage bloqueado: no lanza', () => {
  const real = globalThis.window;
  globalThis.window = { get localStorage() { throw new Error('SecurityError'); } };
  assert.doesNotThrow(() => { scope.setScopeUser(B); chat.saveChat('general', msg('x')); chat.loadChat('general'); sel.setSelectedProjectId('p'); });
  globalThis.window = real;
});

// Solo para pruebas en Node: sustituye por stubs vacíos los módulos con dependencias nativas (Database → expo-sqlite,
// geeAuth → supabase/AsyncStorage) que SatelliteEngine importa al cargarse. Se usa junto a ts-resolve.mjs.
const STUBS = {
  './Database': 'export const saveSpectralCache = () => {}; export const loadSpectralCache = () => null;',
  './geeAuth': 'export const geeAuthHeaders = async () => ({});',
};
export async function resolve(spec, ctx, next) {
  if (STUBS[spec] && ctx.parentURL && ctx.parentURL.includes('/app/core/')) {
    return { url: 'data:text/javascript,' + encodeURIComponent(STUBS[spec]), shortCircuit: true };
  }
  return next(spec, ctx);
}

// Los .ts se transpilan con sucrase (elide los imports que son solo tipos, como hace Metro/tsc); Node solo los "borra" y falla.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { transform } = createRequire(import.meta.url)('sucrase');
export async function load(url, ctx, next) {
  if (url.startsWith('file:') && url.endsWith('.ts')) {
    const src = readFileSync(fileURLToPath(url), 'utf8');
    return { format: 'module', shortCircuit: true, source: transform(src, { transforms: ['typescript'], disableESTransforms: true }).code };
  }
  return next(url, ctx);
}

/**
 * Stub web de app/core/Database.ts (ver metro.config.js). La PWA no tiene SQLite ni caché
 * espectral local: SatelliteEngine importa estas dos funciones, pero la PWA nunca las llama
 * (solo lee resultados ya guardados en Supabase).
 */
export const saveSpectralCache = async (..._args: any[]): Promise<void> => {};
export const loadSpectralCache = async (_cacheKey: string): Promise<null> => null;

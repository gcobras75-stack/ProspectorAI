-- 0011_analytics_cache_tokens.sql
-- Prompt caching de Anthropic: los tokens cacheados se facturan distinto que los
-- normales (escritura de caché ~1.25× a 5 min / 2× a 1 h; lectura ~0.1×), así que
-- NO pueden mezclarse con input_tokens si queremos ver el ahorro real.
--
-- `usage` de la API los devuelve por separado y así se guardan aquí:
--   cache_creation_input_tokens → se escribió el prefijo en caché (se paga con premium)
--   cache_read_input_tokens     → se leyó de la caché (≈90% más barato)
--   input_tokens                → resto NO cacheado (precio completo)
--
-- Migración aditiva: columnas nuevas, nulas para las filas históricas.

alter table public.analytics_costos
  add column if not exists cache_creation_input_tokens integer,
  add column if not exists cache_read_input_tokens     integer;

comment on column public.analytics_costos.cache_creation_input_tokens is
  'Tokens escritos a la caché de prompts en esta llamada (premium de escritura).';
comment on column public.analytics_costos.cache_read_input_tokens is
  'Tokens servidos desde la caché de prompts (~0.1x del precio de entrada). Si es 0 en llamadas repetidas, la caché NO está funcionando.';

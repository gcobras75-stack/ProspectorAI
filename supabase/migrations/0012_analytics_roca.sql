-- ════════════════════════════════════════════════════════════════════════════
-- ProspectorAI · Tipo de roca propuesto por ubicación
--
-- La app ya no pide el tipo de roca a ciegas: lo propone desde la carta geológica
-- (Macrostrat/GLiM hoy; SGM 1:50,000 en Etapa 3) y el usuario puede corregirlo.
--
-- Estas columnas responden a UNA pregunta: ¿qué tan buena es la propuesta?
-- Si `roca_origen` = 'usuario' con frecuencia, el usuario está corrigiendo mucho y
-- la fuente (o el mapeo litológico) no sirve. Comparar roca_propuesta vs roca_final
-- da la tasa de acierto directa.
--
-- ADITIVA: solo añade columnas. No toca nada existente.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.analytics_costos add column if not exists roca_propuesta text;  -- lo que sugirió la carta (null si no hubo propuesta)
alter table public.analytics_costos add column if not exists roca_final     text;  -- lo que se usó de verdad en el análisis
alter table public.analytics_costos add column if not exists roca_origen    text;  -- 'macrostrat' | 'glim' | 'sgm' | 'usuario' | 'default'

-- Consulta de utilidad — tasa de acierto de la propuesta:
--
--   select roca_origen,
--          count(*) as analisis,
--          count(*) filter (where roca_propuesta is not null
--                             and roca_propuesta = roca_final) as acertadas
--   from analytics_costos
--   where tipo = 'analisis_zona'
--   group by roca_origen;

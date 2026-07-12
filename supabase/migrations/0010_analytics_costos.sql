-- 0010_analytics_costos.sql
-- Telemetría de costos de IA / análisis para ProspectorAI.
--
-- ⚠️ SUPABASE COMPARTIDO CON CitaFácil — migración 100% ADITIVA.
--    Solo CREATE de objetos NUEVOS (tabla, índices, políticas, vista).
--    NO hay ALTER / DROP / UPDATE sobre ninguna tabla existente.
--    NO referencia ninguna tabla existente (de ProspectorAI ni de CitaFácil):
--    la única dependencia es la función auth.uid() (RLS estándar de Supabase).

create table if not exists public.analytics_costos (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid(),
  created_at         timestamptz not null default now(),
  tipo               text not null,   -- 'analisis_zona'|'interpretacion'|'reporte'|'foto'|'lote'|'chat'|'muestra'
  analisis_id        text,            -- agrupa las llamadas de un mismo análisis
  modelo             text,            -- 'claude-haiku-4-5' | 'claude-sonnet-4-6' | null
  input_tokens       integer,
  output_tokens      integer,
  costo_usd          numeric(12,6),
  hectareas          numeric,
  fuentes            jsonb,           -- {"s2":bool,"emit":bool,"aster":bool,"s1":bool,"dem":bool}
  n_interpretaciones integer default 0,
  n_fotos            integer default 0,
  material           text
);

create index if not exists analytics_costos_user_created_idx
  on public.analytics_costos (user_id, created_at desc);
create index if not exists analytics_costos_analisis_idx
  on public.analytics_costos (analisis_id);

alter table public.analytics_costos enable row level security;

-- Cada usuario solo inserta filas a su propio nombre.
create policy "analytics_costos_own_insert" on public.analytics_costos
  for insert to authenticated
  with check (auth.uid() = user_id);

-- Cada usuario solo LEE sus registros. El admin obtiene el resumen global vía
-- service_role (SQL editor / backend), que salta RLS por diseño — sin necesidad
-- de referenciar la tabla profiles.
create policy "analytics_costos_own_select" on public.analytics_costos
  for select to authenticated
  using (auth.uid() = user_id);

grant insert, select on public.analytics_costos to authenticated;

-- Vista de resumen SEMANAL. security_invoker = respeta el RLS de quien consulta:
--   • usuario normal (app)      → ve solo lo suyo
--   • admin (service_role / SQL) → ve todo (para el resumen global)
create or replace view public.analytics_costos_semana
  with (security_invoker = true) as
select
  date_trunc('week', created_at)                                             as semana,
  count(distinct analisis_id) filter (where analisis_id is not null)         as n_analisis,
  count(distinct user_id)                                                    as usuarios_activos,
  round(coalesce(sum(costo_usd), 0)::numeric, 4)                             as costo_total_usd,
  round((coalesce(sum(costo_usd) filter (where analisis_id is not null), 0)
         / nullif(count(distinct analisis_id) filter (where analisis_id is not null), 0))::numeric, 4)
                                                                             as costo_prom_por_analisis,
  round((coalesce(sum(costo_usd), 0)
         / nullif(count(distinct user_id), 0))::numeric, 4)                  as costo_prom_por_usuario,
  coalesce(sum(input_tokens), 0)                                            as tokens_entrada,
  coalesce(sum(output_tokens), 0)                                           as tokens_salida
from public.analytics_costos
group by 1
order by 1 desc;

grant select on public.analytics_costos_semana to authenticated;

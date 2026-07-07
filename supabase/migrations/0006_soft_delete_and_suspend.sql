-- ════════════════════════════════════════════════════════════════════════════
-- ProspectorAI · Etapa 2 · D-2 — flags de perfil + rate limit por usuario
-- active/deleted (suspender / soft-delete) y daily_limit (diseño abierto a
-- niveles futuros sin nueva migración: null → usa el tope general).
-- Rate limit: los ADMIN nunca se bloquean; el resto usa su daily_limit
-- (fallback al tope general). Se cuenta a todos para métricas honestas.
-- ════════════════════════════════════════════════════════════════════════════
alter table public.profiles add column if not exists active      boolean not null default true;
alter table public.profiles add column if not exists deleted     boolean not null default false;
alter table public.profiles add column if not exists daily_limit integer;
alter table public.profiles add column if not exists last_seen   timestamptz;

create or replace function public.check_and_increment_ai_usage(p_user uuid, p_max int default 50)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_count int; v_role text; v_limit int;
begin
  select role, coalesce(daily_limit, p_max) into v_role, v_limit
    from public.profiles where id = p_user;

  insert into public.ai_usage (user_id, day, count)
    values (p_user, (now() at time zone 'utc')::date, 0)
    on conflict (user_id, day) do nothing;
  select count into v_count from public.ai_usage
    where user_id = p_user and day = (now() at time zone 'utc')::date
    for update;

  if coalesce(v_role, '') <> 'admin' and v_count >= coalesce(v_limit, p_max) then
    return false;
  end if;

  update public.ai_usage set count = count + 1
    where user_id = p_user and day = (now() at time zone 'utc')::date;
  return true;
end $$;

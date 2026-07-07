-- ════════════════════════════════════════════════════════════════════════════
-- ProspectorAI · Etapa 2 · D-2 — RPCs del dashboard admin
-- TODAS protegidas por is_admin() en la base (no se da service_role al cliente).
-- Devuelven jsonb para consumo directo desde la app.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.admin_list_codes()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED' using errcode='P0001'; end if;
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v from (
    select ic.code, ic.created_at, ic.uses, ic.max_uses, ic.active, ic.expires_at,
      case when not ic.active then 'revocado'
           when ic.expires_at is not null and ic.expires_at < now() then 'expirado'
           when ic.uses >= ic.max_uses then 'agotado'
           else 'activo' end as estado,
      coalesce(array_agg(u.email) filter (where u.email is not null), array[]::text[]) as usado_por
    from public.invite_codes ic
    left join public.profiles p on p.codigo_usado = ic.code and not p.deleted
    left join auth.users u on u.id = p.id
    group by ic.code, ic.created_at, ic.uses, ic.max_uses, ic.active, ic.expires_at
    order by ic.created_at desc
  ) t;
  return v;
end $$;

create or replace function public.admin_update_code(
  p_code text, p_max_uses int default null, p_expires_at timestamptz default null,
  p_clear_expiry boolean default false, p_active boolean default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED' using errcode='P0001'; end if;
  update public.invite_codes set
    max_uses   = coalesce(p_max_uses, max_uses),
    expires_at = case when p_clear_expiry then null else coalesce(p_expires_at, expires_at) end,
    active     = coalesce(p_active, active)
  where code = p_code;
end $$;

create or replace function public.admin_list_users()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED' using errcode='P0001'; end if;
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v from (
    select p.id, u.email, p.nombre, p.role, p.active, p.deleted, p.codigo_usado,
           p.daily_limit, u.created_at, u.last_sign_in_at as last_seen
    from public.profiles p join auth.users u on u.id = p.id
    order by u.created_at desc
  ) t;
  return v;
end $$;

create or replace function public.admin_suspend_user(p_user uuid, p_suspend boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED' using errcode='P0001'; end if;
  update public.profiles set active = not p_suspend where id = p_user;
end $$;

create or replace function public.admin_set_role(p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED' using errcode='P0001'; end if;
  if p_role not in ('user','admin') then raise exception 'INVALID_ROLE' using errcode='P0001'; end if;
  update public.profiles set role = p_role where id = p_user;
end $$;

create or replace function public.admin_soft_delete_user(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED' using errcode='P0001'; end if;
  update public.profiles set deleted = true, active = false where id = p_user;
end $$;

create or replace function public.admin_metrics()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb; d date := (now() at time zone 'utc')::date;
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED' using errcode='P0001'; end if;
  select jsonb_build_object(
    'users_total',     (select count(*) from public.profiles where not deleted),
    'users_active',    (select count(*) from public.profiles where active and not deleted),
    'users_suspended', (select count(*) from public.profiles where not active and not deleted),
    'users_deleted',   (select count(*) from public.profiles where deleted),
    'ai_today',        (select coalesce(sum(count),0) from public.ai_usage where day = d),
    'ai_week',         (select coalesce(sum(count),0) from public.ai_usage where day >= d - 6),
    'ai_month',        (select coalesce(sum(count),0) from public.ai_usage where day >= d - 29),
    'samples_total',   (select count(*) from public.samples),
    'samples_24h',     (select count(*) from public.samples where created_at >= now() - interval '24 hours'),
    'codes_generated', (select count(*) from public.invite_codes),
    'codes_used',      (select coalesce(sum(uses),0) from public.invite_codes),
    'ai_top', (select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
        select u.email, sum(a.count) as consultas
        from public.ai_usage a join auth.users u on u.id = a.user_id
        where a.day >= d - 29 group by u.email order by sum(a.count) desc limit 10) x),
    'projects_top', (select coalesce(jsonb_agg(row_to_json(y)), '[]'::jsonb) from (
        select u.email, count(*) as proyectos
        from public.projects pr join auth.users u on u.id = pr.user_id
        group by u.email order by count(*) desc limit 10) y)
  ) into v;
  return v;
end $$;

grant execute on function public.admin_list_codes()                                       to authenticated;
grant execute on function public.admin_update_code(text,int,timestamptz,boolean,boolean)   to authenticated;
grant execute on function public.admin_list_users()                                        to authenticated;
grant execute on function public.admin_suspend_user(uuid,boolean)                          to authenticated;
grant execute on function public.admin_set_role(uuid,text)                                 to authenticated;
grant execute on function public.admin_soft_delete_user(uuid)                              to authenticated;
grant execute on function public.admin_metrics()                                           to authenticated;

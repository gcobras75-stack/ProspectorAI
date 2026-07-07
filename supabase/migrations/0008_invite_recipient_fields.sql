-- ════════════════════════════════════════════════════════════════════════════
-- ProspectorAI · D-2.1 — datos de destinatario en los códigos de invitación
-- Campos opcionales para llevar control de a quién se entrega cada código.
-- Solo admins los ven (invite_codes ya tiene RLS admin-only). Estructura
-- extensible: en producción se sumarán plan / estado_pago sobre esta misma tabla.
-- ════════════════════════════════════════════════════════════════════════════
alter table public.invite_codes add column if not exists nombre_destinatario text;
alter table public.invite_codes add column if not exists correo_destinatario text;
alter table public.invite_codes add column if not exists nota                text;

drop function if exists public.generate_invite_code(int, timestamptz);

create or replace function public.generate_invite_code(
  p_max_uses int default 1,
  p_expires_at timestamptz default null,
  p_nombre text default null,
  p_correo text default null,
  p_nota text default null
) returns text language plpgsql security definer set search_path = public as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code text;
  v_try  int := 0;
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED' using errcode = 'P0001';
  end if;
  loop
    v_code := 'PROSP-'
      || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1)
      || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1)
      || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1)
      || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    exit when not exists (select 1 from public.invite_codes where code = v_code);
    v_try := v_try + 1;
    if v_try > 50 then raise exception 'CODE_GEN_FAILED'; end if;
  end loop;
  insert into public.invite_codes
    (code, created_by, max_uses, expires_at, nombre_destinatario, correo_destinatario, nota)
  values
    (v_code, auth.uid(), greatest(p_max_uses, 1), p_expires_at,
     nullif(trim(coalesce(p_nombre,'')), ''), nullif(trim(coalesce(p_correo,'')), ''), nullif(trim(coalesce(p_nota,'')), ''));
  return v_code;
end $$;

grant   execute on function public.generate_invite_code(int, timestamptz, text, text, text) to authenticated;
revoke  execute on function public.generate_invite_code(int, timestamptz, text, text, text) from public, anon;

-- admin_list_codes ahora incluye los datos de destinatario.
create or replace function public.admin_list_codes()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED' using errcode='P0001'; end if;
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v from (
    select ic.code, ic.created_at, ic.uses, ic.max_uses, ic.active, ic.expires_at,
      ic.nombre_destinatario, ic.correo_destinatario, ic.nota,
      case when not ic.active then 'revocado'
           when ic.expires_at is not null and ic.expires_at < now() then 'expirado'
           when ic.uses >= ic.max_uses then 'agotado'
           else 'activo' end as estado,
      coalesce(array_agg(u.email) filter (where u.email is not null), array[]::text[]) as usado_por
    from public.invite_codes ic
    left join public.profiles p on p.codigo_usado = ic.code and not p.deleted
    left join auth.users u on u.id = p.id
    group by ic.code, ic.created_at, ic.uses, ic.max_uses, ic.active, ic.expires_at,
             ic.nombre_destinatario, ic.correo_destinatario, ic.nota
    order by ic.created_at desc
  ) t;
  return v;
end $$;

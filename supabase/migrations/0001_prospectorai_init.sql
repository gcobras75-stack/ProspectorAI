-- ════════════════════════════════════════════════════════════════════════════
-- ProspectorAI · Etapa 2 · Migración inicial
-- Cuentas con código de invitación + aislamiento de datos por usuario (RLS)
--
-- Aplica UNA sola vez sobre el proyecto Supabase "prospectorai".
-- Todo dato de usuario lleva user_id y una política RLS "solo el dueño ve/edita
-- lo suyo". El registro está BLINDADO por código de invitación vía trigger.
-- ════════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- PROFILES — 1:1 con auth.users. role controla acceso admin (Antonio).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  nombre       text,
  codigo_usado text,
  role         text not null default 'user' check (role in ('user', 'admin')),
  created_at   timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- INVITE_CODES — control del dueño. Formato PROSP-XXXX, con límite y revocables.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.invite_codes (
  code       text primary key,
  created_by uuid references auth.users(id) on delete set null,
  max_uses   integer not null default 1 check (max_uses >= 1),
  uses       integer not null default 0 check (uses >= 0),
  active     boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- DATOS DE USUARIO — projects, samples, analyses, validation_pairs.
-- id = UUID estable (el cliente lo genera para casar con la caché SQLite local).
-- updated_at para resolución de conflictos en la sincronización.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.projects (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  name               text,
  mineral            text,
  terrain            text,
  rock_type          text,
  depth              text,
  area_ha            numeric,
  coordenadas        jsonb,
  analisis_resultado jsonb,
  prospectivity      jsonb,
  data               jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_projects_user on public.projects(user_id);

create table if not exists public.samples (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  project_id        uuid references public.projects(id) on delete cascade,
  lat               double precision,
  lng               double precision,
  mineral_detectado text,
  analisis_ia       jsonb,
  descripcion_texto text,
  foto_path         text,      -- ruta en Supabase Storage (la foto no va en la fila)
  lab_result        jsonb,
  data              jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_samples_user on public.samples(user_id);
create index if not exists idx_samples_project on public.samples(project_id);

create table if not exists public.analyses (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  project_id       uuid references public.projects(id) on delete cascade,
  mineral          text,
  terrain          text,
  satdata_source   text,
  acquisition_date text,
  coordenadas      jsonb,
  resultado        jsonb,
  data             jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_analyses_user on public.analyses(user_id);

create table if not exists public.validation_pairs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  sample_id  uuid references public.samples(id) on delete set null,
  predicted  jsonb,
  actual     jsonb,
  data       jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_validation_user on public.validation_pairs(user_id);

-- AI_USAGE — rate limit por usuario/día para el endpoint de IA (Parte D).
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null default (now() at time zone 'utc')::date,
  count   integer not null default 0,
  primary key (user_id, day)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at automático
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create trigger trg_projects_updated before update on public.projects
  for each row execute function public.set_updated_at();
create trigger trg_samples_updated before update on public.samples
  for each row execute function public.set_updated_at();
create trigger trg_analyses_updated before update on public.analyses
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- is_admin() — SECURITY DEFINER para saltar RLS al leer el rol propio.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- REGISTRO BLINDADO POR CÓDIGO — trigger sobre auth.users.
-- Si el código falta / es inválido / revocado / expirado / agotado → EXCEPTION,
-- lo que ABORTA el alta (no se crea la cuenta). Sin código válido, no hay registro.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_code   text;
  v_nombre text;
  v_rec    public.invite_codes%rowtype;
begin
  v_code   := upper(trim(coalesce(new.raw_user_meta_data->>'invite_code', '')));
  v_nombre := trim(coalesce(new.raw_user_meta_data->>'nombre', ''));

  if v_code = '' then
    raise exception 'INVITE_CODE_REQUIRED' using errcode = 'P0001';
  end if;

  select * into v_rec from public.invite_codes where code = v_code for update;
  if not found then
    raise exception 'INVITE_CODE_INVALID' using errcode = 'P0001';
  end if;
  if not v_rec.active then
    raise exception 'INVITE_CODE_REVOKED' using errcode = 'P0001';
  end if;
  if v_rec.expires_at is not null and v_rec.expires_at < now() then
    raise exception 'INVITE_CODE_EXPIRED' using errcode = 'P0001';
  end if;
  if v_rec.uses >= v_rec.max_uses then
    raise exception 'INVITE_CODE_EXHAUSTED' using errcode = 'P0001';
  end if;

  update public.invite_codes set uses = uses + 1 where code = v_code;
  insert into public.profiles (id, nombre, codigo_usado, role)
    values (new.id, nullif(v_nombre, ''), v_code, 'user');

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Impide que un usuario se auto-promueva a admin editando su profile.
create or replace function public.prevent_role_escalation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role and not public.is_admin() then
    raise exception 'ROLE_CHANGE_NOT_ALLOWED' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger trg_profiles_role_guard before update on public.profiles
  for each row execute function public.prevent_role_escalation();

-- ─────────────────────────────────────────────────────────────────────────────
-- RPCs de administración de códigos (Parte B) — solo admin.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.generate_invite_code(
  p_max_uses int default 1,
  p_expires_at timestamptz default null
) returns text language plpgsql security definer set search_path = public as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; -- sin 0/O/1/I/L
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
  insert into public.invite_codes (code, created_by, max_uses, expires_at)
    values (v_code, auth.uid(), greatest(p_max_uses, 1), p_expires_at);
  return v_code;
end $$;

create or replace function public.revoke_invite_code(p_code text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED' using errcode = 'P0001';
  end if;
  update public.invite_codes set active = false where code = upper(trim(p_code));
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- RATE LIMIT IA (Parte D) — llamada por el servidor con service_role.
-- Devuelve true si el usuario aún tiene cupo hoy (e incrementa), false si no.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.check_and_increment_ai_usage(p_user uuid, p_max int default 50)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  insert into public.ai_usage (user_id, day, count)
    values (p_user, (now() at time zone 'utc')::date, 0)
    on conflict (user_id, day) do nothing;
  select count into v_count from public.ai_usage
    where user_id = p_user and day = (now() at time zone 'utc')::date
    for update;
  if v_count >= p_max then
    return false;
  end if;
  update public.ai_usage set count = count + 1
    where user_id = p_user and day = (now() at time zone 'utc')::date;
  return true;
end $$;

-- ping() — keep-alive para el free tier (lo llama el cron de Hermes cada 6 h).
create or replace function public.ping()
returns timestamptz language sql as $$ select now(); $$;

-- ════════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ════════════════════════════════════════════════════════════════════════════
alter table public.profiles         enable row level security;
alter table public.invite_codes     enable row level security;
alter table public.projects         enable row level security;
alter table public.samples          enable row level security;
alter table public.analyses         enable row level security;
alter table public.validation_pairs enable row level security;
alter table public.ai_usage         enable row level security;

-- PROFILES: el usuario ve/edita el suyo; el admin ve todos. El alta la hace el
-- trigger (SECURITY DEFINER, salta RLS). role protegido por trigger aparte.
create policy profiles_select on public.profiles
  for select using (id = auth.uid() or public.is_admin());
create policy profiles_update on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- INVITE_CODES: solo admin (generación/listado/revocación). La validación en el
-- registro corre por el trigger SECURITY DEFINER, que no depende de estas políticas.
create policy invite_admin_all on public.invite_codes
  for all using (public.is_admin()) with check (public.is_admin());

-- DATOS: cada quien SOLO ve/edita lo suyo.
create policy projects_own on public.projects
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy samples_own on public.samples
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy analyses_own on public.analyses
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy validation_own on public.validation_pairs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ai_usage: sin políticas → nadie (anon/authenticated) accede. Solo service_role
-- (que salta RLS) vía la RPC check_and_increment_ai_usage.

-- ─────────────────────────────────────────────────────────────────────────────
-- GRANTS de RPC
-- ─────────────────────────────────────────────────────────────────────────────
grant execute on function public.generate_invite_code(int, timestamptz) to authenticated;
grant execute on function public.revoke_invite_code(text) to authenticated;
grant execute on function public.ping() to anon, authenticated;
-- rate limit: fuera del alcance del cliente; solo el servidor (service_role) la usa.
revoke execute on function public.check_and_increment_ai_usage(uuid, int) from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- SEED — primer código de arranque para que Antonio pueda registrarse.
-- Tras registrarse, promuévelo a admin (ver README, paso "bootstrap admin").
-- ════════════════════════════════════════════════════════════════════════════
insert into public.invite_codes (code, max_uses, active)
  values ('PROSP-START', 5, true)
  on conflict (code) do nothing;

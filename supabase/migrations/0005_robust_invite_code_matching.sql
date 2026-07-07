-- ════════════════════════════════════════════════════════════════════════════
-- ProspectorAI · Etapa 2 · Fix de producción — matching robusto del código
-- El teclado de iOS (smart punctuation) convierte el guion "-" en guion largo
-- "–", así que el código no coincidía y el signup fallaba con 500. Ahora el
-- matching normaliza AMBOS lados (quita todo lo no alfanumérico + mayúsculas),
-- y una RPC de pre-chequeo permite dar el mensaje exacto antes del signup.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_raw text; v_norm text; v_nombre text; v_rec public.invite_codes%rowtype;
begin
  v_raw    := coalesce(new.raw_user_meta_data->>'invite_code', '');
  v_nombre := trim(coalesce(new.raw_user_meta_data->>'nombre', ''));
  v_norm   := upper(regexp_replace(v_raw, '[^A-Za-z0-9]', '', 'g'));

  if v_norm = '' then
    raise exception 'INVITE_CODE_REQUIRED' using errcode = 'P0001';
  end if;

  select * into v_rec from public.invite_codes
    where upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g')) = v_norm
    for update;
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

  update public.invite_codes set uses = uses + 1 where code = v_rec.code;
  insert into public.profiles (id, nombre, codigo_usado, role)
    values (new.id, nullif(v_nombre, ''), v_rec.code, 'user');
  return new;
end $$;

-- Pre-chequeo (anon): OK / INVALID / REVOKED / EXPIRED / EXHAUSTED
create or replace function public.check_invite_code(p_code text)
returns text language plpgsql security definer set search_path = public as $$
declare v_norm text; v_rec public.invite_codes%rowtype;
begin
  v_norm := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if v_norm = '' then return 'INVALID'; end if;
  select * into v_rec from public.invite_codes
    where upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g')) = v_norm;
  if not found then return 'INVALID'; end if;
  if not v_rec.active then return 'REVOKED'; end if;
  if v_rec.expires_at is not null and v_rec.expires_at < now() then return 'EXPIRED'; end if;
  if v_rec.uses >= v_rec.max_uses then return 'EXHAUSTED'; end if;
  return 'OK';
end $$;

grant execute on function public.check_invite_code(text) to anon, authenticated;

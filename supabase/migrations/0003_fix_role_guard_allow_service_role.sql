-- ════════════════════════════════════════════════════════════════════════════
-- ProspectorAI · Etapa 2 · Fix del guard de rol
-- prevent_role_escalation bloqueaba TODO cambio de rol si is_admin() era falso,
-- lo que impedía el bootstrap del admin desde el SQL editor (auth.uid() nulo).
-- Ahora solo bloquea la auto-promoción de un usuario NORMAL logueado; el service
-- role (dashboard / bootstrap) y los admin sí pueden cambiar roles.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.prevent_role_escalation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role
     and auth.uid() is not null
     and not public.is_admin() then
    raise exception 'ROLE_CHANGE_NOT_ALLOWED' using errcode = 'P0001';
  end if;
  return new;
end $$;

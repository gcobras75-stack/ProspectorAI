-- ════════════════════════════════════════════════════════════════════════════
-- ProspectorAI · Etapa 2 · Endurecimiento de funciones (advisors de seguridad)
-- Fija search_path en funciones que faltaban y quita del API RPC las funciones
-- de trigger + reduce la superficie de las SECURITY DEFINER.
-- ════════════════════════════════════════════════════════════════════════════

-- search_path fijo en las dos funciones que lo tenían mutable
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;

create or replace function public.ping()
returns timestamptz language sql set search_path = public as $$ select now(); $$;

-- Funciones de trigger: NUNCA invocables directamente vía /rest/v1/rpc
revoke execute on function public.handle_new_user()          from public, anon, authenticated;
revoke execute on function public.prevent_role_escalation()  from public, anon, authenticated;
revoke execute on function public.set_updated_at()           from public, anon, authenticated;

-- RPCs de admin: fuera de anon (además validan is_admin internamente)
revoke execute on function public.generate_invite_code(int, timestamptz) from public, anon;
revoke execute on function public.revoke_invite_code(text)               from public, anon;

-- is_admin: solo authenticated (lo usan las políticas RLS)
revoke execute on function public.is_admin() from public, anon;
grant  execute on function public.is_admin() to authenticated;

-- ping sigue disponible para el keep-alive
grant execute on function public.ping() to anon, authenticated;

-- Nota: quedan como WARN intencionales (by-design, seguros):
--  · generate_invite_code / revoke_invite_code ejecutables por authenticated
--    → necesario para la pantalla admin; protegidos por is_admin() interno.
--  · is_admin ejecutable por authenticated → requerido por las políticas RLS;
--    solo revela el estado admin del PROPIO llamador.
--  · ai_usage con RLS sin políticas → denegar todo salvo service_role (deseado).

-- ════════════════════════════════════════════════════════════════════════════
-- ProspectorAI · Etapa 2 · Checkpoint C — sincronización offline-first
-- Ids generados por el cliente (SQLite): client_id casa el id local con la fila
-- remota; único por (user_id, client_id) → cada usuario tiene su propio 'default'
-- sin colisionar con otros. Enlace lógico proyecto→muestra por project_client_id.
-- ════════════════════════════════════════════════════════════════════════════
alter table public.projects         add column if not exists client_id text;
alter table public.samples          add column if not exists client_id text;
alter table public.samples          add column if not exists project_client_id text;
alter table public.validation_pairs add column if not exists client_id text;
alter table public.validation_pairs add column if not exists project_client_id text;

create unique index if not exists projects_user_client   on public.projects(user_id, client_id);
create unique index if not exists samples_user_client    on public.samples(user_id, client_id);
create unique index if not exists validation_user_client on public.validation_pairs(user_id, client_id);

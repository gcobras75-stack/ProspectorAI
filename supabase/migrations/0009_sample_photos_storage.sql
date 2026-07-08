-- ════════════════════════════════════════════════════════════════════════════
-- ProspectorAI · Storage de fotos de muestras (base para que las fotos
-- sobrevivan a reinstalación). Bucket público de lectura; escritura solo en la
-- carpeta {user_id}/ del dueño. La subida/guardado de URL se integra en el cliente.
-- ════════════════════════════════════════════════════════════════════════════
insert into storage.buckets (id, name, public) values ('sample-photos', 'sample-photos', true)
  on conflict (id) do nothing;

drop policy if exists "sample_photos_insert_own" on storage.objects;
drop policy if exists "sample_photos_update_own" on storage.objects;
drop policy if exists "sample_photos_delete_own" on storage.objects;
drop policy if exists "sample_photos_read"       on storage.objects;

create policy "sample_photos_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'sample-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "sample_photos_update_own" on storage.objects for update to authenticated
  using (bucket_id = 'sample-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "sample_photos_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'sample-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "sample_photos_read" on storage.objects for select to public
  using (bucket_id = 'sample-photos');

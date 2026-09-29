-- Secure RFQ document storage. Original client documents must never be public/vendor-readable.
insert into storage.buckets (id, name, public)
values ('rfq-documents', 'rfq-documents', false)
on conflict (id) do update set public = false;

-- Attachment metadata required by the upload pipeline.
alter table public.attachments add column if not exists storage_bucket text;
alter table public.attachments add column if not exists storage_path text;
alter table public.attachments add column if not exists mime_type text;
alter table public.attachments add column if not exists file_size bigint;
alter table public.attachments add column if not exists sanitized_filename text;
alter table public.attachments add column if not exists processing_status text default 'pending';
alter table public.attachments add column if not exists ai_status text default 'queued';
alter table public.attachments add column if not exists ai_detected_format text;
alter table public.attachments add column if not exists ai_extraction_confidence numeric;
alter table public.attachments add column if not exists ai_rejection_reason text;
alter table public.attachments add column if not exists ai_processed_at timestamptz;
alter table public.attachments add column if not exists classification jsonb;
alter table public.attachments add column if not exists detected_format text;
alter table public.attachments add column if not exists processing_route text;
alter table public.attachments add column if not exists rejection_reason text;

alter table public.rfq_documents add column if not exists storage_bucket text default 'rfq-documents';
alter table public.rfq_documents add column if not exists storage_path text;
alter table public.rfq_documents add column if not exists file_size bigint;
alter table public.rfq_documents add column if not exists detected_format text;
alter table public.rfq_documents add column if not exists classification text;
alter table public.rfq_documents add column if not exists processing_route text;
alter table public.rfq_documents add column if not exists classification_result jsonb;
alter table public.rfq_documents add column if not exists rejection_reason text;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'rfq documents owner upload') then
    create policy "rfq documents owner upload" on storage.objects
    for insert to authenticated
    with check (
      bucket_id = 'rfq-documents'
      and (storage.foldername(name))[1] = (select auth.uid()::text)
    );
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'rfq documents owner read') then
    create policy "rfq documents owner read" on storage.objects
    for select to authenticated
    using (
      bucket_id = 'rfq-documents'
      and (storage.foldername(name))[1] = (select auth.uid()::text)
    );
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'rfq documents owner delete') then
    create policy "rfq documents owner delete" on storage.objects
    for delete to authenticated
    using (
      bucket_id = 'rfq-documents'
      and (storage.foldername(name))[1] = (select auth.uid()::text)
    );
  end if;
end $$;

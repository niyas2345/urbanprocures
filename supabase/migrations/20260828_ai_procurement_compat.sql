-- Compatibility layer between legacy marketplace tables and AI procurement foundation.
-- Do NOT drop legacy tables. Live UI still uses text RFQ ids.

create table if not exists public.rfq_documents (
  id uuid primary key default gen_random_uuid(),
  rfq_id text not null,
  storage_key text not null,
  document_role text not null default 'source'
    check (document_role in ('source','sanitized_vendor','sanitized_client')),
  original_filename text,
  mime_type text,
  processing_status text not null default 'pending'
    check (processing_status in ('pending','processing','ready','blocked','failed')),
  requires_human_review boolean not null default false,
  extraction jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.document_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  rfq_id text,
  document_id uuid references public.rfq_documents(id) on delete cascade,
  job_type text not null default 'extract'
    check (job_type in ('extract','sanitize','normalize_rfq','normalize_quotation','leak_check')),
  status text not null default 'pending'
    check (status in ('pending','processing','completed','blocked','failed')),
  provider text,
  model text,
  result jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.rfqs add column if not exists mode text;
alter table public.rfqs add column if not exists processing_status text;
alter table public.rfqs add column if not exists sanitized_ready boolean default false;

alter table public.attachments add column if not exists ai_status text default 'queued';
alter table public.attachments add column if not exists ai_detected_format text;
alter table public.attachments add column if not exists ai_extraction_confidence numeric;
alter table public.attachments add column if not exists ai_rejection_reason text;
alter table public.attachments add column if not exists ai_processed_at timestamptz;

insert into storage.buckets (id, name, public)
values ('rfq-documents', 'rfq-documents', false)
on conflict (id) do update set public = false;

insert into storage.buckets (id, name, public)
values ('quote-documents', 'quote-documents', false)
on conflict (id) do update set public = false;

alter table public.rfq_documents enable row level security;
alter table public.document_processing_jobs enable row level security;

drop policy if exists "rfq_documents_deny_anon" on public.rfq_documents;
create policy "rfq_documents_deny_anon" on public.rfq_documents
  as restrictive for all to anon using (false) with check (false);

drop policy if exists "document_jobs_deny_anon" on public.document_processing_jobs;
create policy "document_jobs_deny_anon" on public.document_processing_jobs
  as restrictive for all to anon using (false) with check (false);

-- Legacy experimental RPC is not part of the public client contract. Keep it
-- server-only so browser clients cannot invoke SECURITY DEFINER privileges.
do $$
begin
  if to_regprocedure('public.validate_rfq_upload(text,text,boolean,numeric,text)') is not null then
    revoke execute on function public.validate_rfq_upload(text,text,boolean,numeric,text) from public, anon, authenticated;
    grant execute on function public.validate_rfq_upload(text,text,boolean,numeric,text) to service_role;
  end if;
end $$;

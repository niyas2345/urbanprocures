-- Additive completion migration for persistent extraction and quotation intake.
-- Apply through the Supabase migration workflow; no existing protection is removed.

create table if not exists public.quotations (
  id uuid primary key default gen_random_uuid(), rfq_id text not null, vendor_user_id uuid not null,
  vendor_reference text, subtotal numeric, vat numeric, total numeric not null default 0, currency text not null default 'AED',
  validity_days integer, completion_period text, warranty text, inclusions jsonb not null default '[]'::jsonb,
  exclusions jsonb not null default '[]'::jsonb, payment_terms text, status text not null default 'processing',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.quotation_items (
  id uuid primary key default gen_random_uuid(), quotation_id uuid not null references public.quotations(id) on delete cascade,
  description text not null, specification text, quantity numeric, unit text, unit_rate numeric, amount numeric, sort_order integer not null default 0
);
alter table public.quotations enable row level security;
alter table public.quotation_items enable row level security;
drop policy if exists "quotations_deny_anon" on public.quotations;
create policy "quotations_deny_anon" on public.quotations as restrictive for all to anon using (false) with check (false);
drop policy if exists "quotation_items_deny_anon" on public.quotation_items;
create policy "quotation_items_deny_anon" on public.quotation_items as restrictive for all to anon using (false) with check (false);
create unique index if not exists document_jobs_document_type_unique on public.document_processing_jobs(document_id, job_type) where document_id is not null;

create table if not exists public.quote_documents (
  id uuid primary key default gen_random_uuid(),
  quotation_id uuid references public.quotations(id) on delete cascade,
  rfq_id text not null,
  vendor_user_id uuid not null,
  storage_bucket text not null default 'quote-documents',
  storage_key text not null,
  original_filename text,
  mime_type text,
  processing_status text not null default 'pending' check (processing_status in ('pending','processing','ready','blocked','failed')),
  requires_human_review boolean not null default false,
  extraction jsonb,
  created_at timestamptz not null default now()
);

alter table public.rfq_documents add column if not exists storage_bucket text default 'rfq-documents';
alter table public.rfq_documents add column if not exists storage_path text;
alter table public.rfq_documents add column if not exists file_size bigint;
alter table public.rfq_documents add column if not exists detected_format text;
alter table public.rfq_documents add column if not exists classification jsonb;
alter table public.rfq_documents add column if not exists processing_route text;
alter table public.rfq_documents add column if not exists rejection_reason text;
alter table public.rfq_documents add column if not exists review_reasons jsonb not null default '[]'::jsonb;
alter table public.document_processing_jobs add column if not exists attempts integer not null default 0;
alter table public.document_processing_jobs add column if not exists locked_at timestamptz;
alter table public.document_processing_jobs add column if not exists warnings jsonb not null default '[]'::jsonb;

alter table public.quote_documents enable row level security;
drop policy if exists "quote documents deny anon" on public.quote_documents;
create policy "quote documents deny anon" on public.quote_documents as restrictive for all to anon using (false) with check (false);

insert into storage.buckets (id, name, public) values ('quote-documents', 'quote-documents', false)
on conflict (id) do update set public = false;

-- Keep trigger functions deterministic even when session search_path is changed.
alter function public.bump_vendor_profile_updated_at() set search_path = public, pg_temp;
alter function public.bump_updated_at() set search_path = public, pg_temp;
alter function public.set_ai_procurement_jobs_updated_at() set search_path = public, pg_temp;

-- Urban Procure AI procurement foundation
-- Apply after the existing schema. Originals are internal-only; external files
-- must be generated as separate sanitized objects.

create table if not exists public.rfqs (
  id uuid primary key default gen_random_uuid(),
  rfq_number text not null unique,
  client_user_id uuid not null,
  mode text not null check (mode in ('ready_to_quote', 'technical_assistance')),
  category text not null,
  title text,
  location text,
  scope_summary text,
  status text not null default 'draft' check (status in ('draft','processing','review','published','awarded','closed','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rfq_items (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid not null references public.rfqs(id) on delete cascade,
  description text not null,
  specification text,
  quantity numeric,
  unit text,
  sort_order integer not null default 0
);

create table if not exists public.rfq_documents (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid not null references public.rfqs(id) on delete cascade,
  storage_key text not null,
  document_role text not null check (document_role in ('source','sanitized_vendor','sanitized_client')),
  original_filename text,
  mime_type text,
  processing_status text not null default 'pending' check (processing_status in ('pending','processing','ready','blocked','failed')),
  requires_human_review boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.quotations (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid not null references public.rfqs(id) on delete cascade,
  vendor_user_id uuid not null,
  vendor_reference text,
  subtotal numeric,
  vat numeric,
  total numeric not null,
  currency text not null default 'AED',
  validity_days integer,
  completion_period text,
  warranty text,
  inclusions jsonb not null default '[]'::jsonb,
  exclusions jsonb not null default '[]'::jsonb,
  payment_terms text,
  status text not null default 'submitted' check (status in ('processing','submitted','review','selected','rejected','withdrawn')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.quotation_items (
  id uuid primary key default gen_random_uuid(),
  quotation_id uuid not null references public.quotations(id) on delete cascade,
  description text not null,
  specification text,
  quantity numeric,
  unit text,
  unit_rate numeric,
  amount numeric,
  sort_order integer not null default 0
);

create table if not exists public.document_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid references public.rfqs(id) on delete cascade,
  document_id uuid references public.rfq_documents(id) on delete cascade,
  job_type text not null check (job_type in ('extract','sanitize','normalize_rfq','normalize_quotation','leak_check')),
  status text not null default 'pending' check (status in ('pending','processing','completed','blocked','failed')),
  provider text,
  model text,
  result jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid references public.rfqs(id) on delete set null,
  actor_user_id uuid,
  event_type text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists rfqs_client_idx on public.rfqs(client_user_id);
create index if not exists rfq_documents_rfq_idx on public.rfq_documents(rfq_id);
create index if not exists quotations_rfq_idx on public.quotations(rfq_id);
create index if not exists quotations_vendor_idx on public.quotations(vendor_user_id);
create index if not exists processing_jobs_status_idx on public.document_processing_jobs(status);
create index if not exists audit_events_rfq_idx on public.audit_events(rfq_id);

alter table public.rfqs enable row level security;
alter table public.rfq_items enable row level security;
alter table public.rfq_documents enable row level security;
alter table public.quotations enable row level security;
alter table public.quotation_items enable row level security;
alter table public.document_processing_jobs enable row level security;
alter table public.audit_events enable row level security;

-- No public/anon policies are created intentionally. The server-side worker
-- should mediate all cross-party reads and document access.

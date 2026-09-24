-- URBAN PROCURES — additive marketplace tables
-- Project: vdlrwekoyvvspxuyzgrx (https://vdlrwekoyvvspxuyzgrx.supabase.co)
-- Safe: does NOT drop or alter terms_documents, terms_acceptances, vendor_profiles.
--
-- Apply once:
--   Supabase → SQL Editor → paste this file → Run
-- or:
--   supabase link --project-ref vdlrwekoyvvspxuyzgrx
--   supabase db push

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- RFQs
-- ---------------------------------------------------------------------------
create table if not exists public.rfqs (
  id text primary key,
  client_id uuid,
  title text not null,
  category text not null,
  emirate text not null default 'Dubai',
  scope text not null default '',
  budget numeric(14,2),
  deadline date,
  visit text not null default 'TBD',
  status text not null default 'Submitted'
    check (status in (
      'Submitted','Under Review','Matching','Quoting',
      'Comparing','Awarded','Closed','Withdrawn'
    )),
  file_count integer not null default 0,
  source text not null default 'web'
    check (source in ('web','whatsapp','admin','import')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists rfqs_client_idx on public.rfqs (client_id);
create index if not exists rfqs_status_idx on public.rfqs (status);
create index if not exists rfqs_category_idx on public.rfqs (category);

-- ---------------------------------------------------------------------------
-- Quotations (vendor identity stays in this table; UI must mask until award)
-- ---------------------------------------------------------------------------
create table if not exists public.quotes (
  id text primary key,
  rfq_id text not null references public.rfqs(id) on delete cascade,
  vendor_id uuid,
  vendor_label text not null default 'Vendor',
  amount numeric(14,2) not null default 0,
  vat_pct numeric(5,2) not null default 5,
  vat_inc text not null default 'excluded' check (vat_inc in ('included','excluded')),
  duration text not null default '',
  inclusions text not null default '',
  exclusions text not null default '',
  status text not null default 'Submitted'
    check (status in ('Draft','Submitted','Withdrawn','Awarded','Unsuccessful')),
  file_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists quotes_rfq_idx on public.quotes (rfq_id);
create index if not exists quotes_vendor_idx on public.quotes (vendor_id);

-- ---------------------------------------------------------------------------
-- Awards + service charge (2.5%, floor AED 500 — recorded, not collected here)
-- ---------------------------------------------------------------------------
create table if not exists public.awards (
  id uuid primary key default gen_random_uuid(),
  rfq_id text not null unique references public.rfqs(id) on delete restrict,
  quote_id text not null references public.quotes(id) on delete restrict,
  winner_vendor_id uuid,
  awarded_amount numeric(14,2) not null default 0,
  fee_rate numeric(6,4) not null default 0.025,
  fee_floor numeric(12,2) not null default 500,
  fee_amount numeric(14,2) not null default 0,
  confirmed_by uuid,
  notes text not null default '',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Attachment metadata only. Bytes go to Storage / R2. Never store blobs here.
-- ---------------------------------------------------------------------------
create table if not exists public.attachments (
  id text primary key,
  owner_type text not null check (owner_type in ('rfq','quote','vendor','award')),
  owner_id text not null,
  name text not null,
  ext text not null default '',
  mime text not null default 'application/octet-stream',
  size_bytes bigint not null default 0,
  sha256 text,
  storage_bucket text not null default 'attachments',
  storage_path text,
  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists attachments_owner_idx on public.attachments (owner_type, owner_id);

-- ---------------------------------------------------------------------------
-- WhatsApp Cloud API thread log (no message bodies that contain secrets)
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_events (
  id uuid primary key default gen_random_uuid(),
  direction text not null check (direction in ('in','out')),
  wa_id text not null,
  wamid text,
  rfq_id text references public.rfqs(id) on delete set null,
  template_name text,
  msg_type text not null default 'text',
  status text not null default 'received',
  created_at timestamptz not null default now()
);

create index if not exists whatsapp_events_wa_idx on public.whatsapp_events (wa_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at bump
-- ---------------------------------------------------------------------------
create or replace function public.bump_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists rfqs_updated_at on public.rfqs;
create trigger rfqs_updated_at
before update on public.rfqs
for each row execute function public.bump_updated_at();

drop trigger if exists quotes_updated_at on public.quotes;
create trigger quotes_updated_at
before update on public.quotes
for each row execute function public.bump_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: clients see own RFQs; vendors see own quotes; public cannot read quotes.
-- Service role (Worker) bypasses RLS for admin desk.
-- ---------------------------------------------------------------------------
alter table public.rfqs enable row level security;
alter table public.quotes enable row level security;
alter table public.awards enable row level security;
alter table public.attachments enable row level security;
alter table public.whatsapp_events enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'rfqs_read_own') then
    create policy rfqs_read_own on public.rfqs
      for select to authenticated
      using (client_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where policyname = 'rfqs_insert_own') then
    create policy rfqs_insert_own on public.rfqs
      for insert to authenticated
      with check (client_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where policyname = 'rfqs_update_own') then
    create policy rfqs_update_own on public.rfqs
      for update to authenticated
      using (client_id = auth.uid())
      with check (client_id = auth.uid());
  end if;

  if not exists (select 1 from pg_policies where policyname = 'quotes_read_own') then
    create policy quotes_read_own on public.quotes
      for select to authenticated
      using (vendor_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where policyname = 'quotes_insert_own') then
    create policy quotes_insert_own on public.quotes
      for insert to authenticated
      with check (vendor_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where policyname = 'quotes_update_own') then
    create policy quotes_update_own on public.quotes
      for update to authenticated
      using (vendor_id = auth.uid() and status in ('Draft','Submitted'))
      with check (vendor_id = auth.uid());
  end if;

  if not exists (select 1 from pg_policies where policyname = 'awards_read_related') then
    create policy awards_read_related on public.awards
      for select to authenticated
      using (
        confirmed_by = auth.uid()
        or winner_vendor_id = auth.uid()
        or exists (select 1 from public.rfqs r where r.id = awards.rfq_id and r.client_id = auth.uid())
      );
  end if;

  if not exists (select 1 from pg_policies where policyname = 'attachments_read_own') then
    create policy attachments_read_own on public.attachments
      for select to authenticated
      using (created_by = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where policyname = 'attachments_insert_own') then
    create policy attachments_insert_own on public.attachments
      for insert to authenticated
      with check (created_by = auth.uid());
  end if;

  -- WhatsApp events: no anon/authenticated access. Worker uses service role.
end $$;

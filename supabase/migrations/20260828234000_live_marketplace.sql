-- Complete the persistent Urban Procure desk without weakening existing RLS.
-- Browser clients do not receive direct table policies; all cross-party reads
-- continue through the authenticated server boundary.

create table if not exists public.client_profiles (
  id uuid primary key,
  company_name text not null,
  contact_name text not null default '',
  designation text not null default '',
  phone text not null default '',
  whatsapp text not null default '',
  emirate text not null default 'Dubai',
  company_type text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vendor_profiles add column if not exists trading_name text not null default '';
alter table public.vendor_profiles add column if not exists contact_name text not null default '';
alter table public.vendor_profiles add column if not exists contact_email text not null default '';
alter table public.vendor_profiles add column if not exists phone text not null default '';
alter table public.vendor_profiles add column if not exists subcategories text[] not null default '{}';
alter table public.vendor_profiles add column if not exists capacity integer not null default 0;
alter table public.vendor_profiles add column if not exists available boolean not null default true;

alter table public.rfqs add column if not exists project text not null default '';
alter table public.rfqs add column if not exists subcategory text not null default '';
alter table public.rfqs add column if not exists location text not null default '';
alter table public.rfqs add column if not exists start_date date;
alter table public.rfqs add column if not exists duration text not null default '';
alter table public.rfqs add column if not exists special_requirements text not null default '';
alter table public.rfqs add column if not exists review_state text not null default 'awaiting_processing';
alter table public.rfqs add column if not exists published_at timestamptz;
alter table public.rfqs add column if not exists sanitized_payload jsonb;

alter table public.quotations add column if not exists vat_included boolean not null default false;
alter table public.quotations add column if not exists mobilization text not null default '';
alter table public.quotations add column if not exists notes text not null default '';
alter table public.quotations add column if not exists deviations jsonb not null default '[]'::jsonb;
alter table public.quotations add column if not exists arithmetic_valid boolean;
alter table public.quotations add column if not exists comparison_flags jsonb not null default '[]'::jsonb;

create unique index if not exists quotations_one_vendor_per_rfq
  on public.quotations(rfq_id, vendor_user_id);

create table if not exists public.rfq_invitations (
  id uuid primary key default gen_random_uuid(),
  rfq_id text not null references public.rfqs(id) on delete cascade,
  vendor_user_id uuid not null,
  status text not null default 'invited'
    check (status in ('invited','viewed','declined','quoted','withdrawn')),
  match_score integer not null default 0,
  match_reasons jsonb not null default '[]'::jsonb,
  invited_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rfq_id, vendor_user_id)
);

create table if not exists public.procurement_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  role text not null check (role in ('client','vendor','admin')),
  rfq_id text references public.rfqs(id) on delete cascade,
  event_type text not null,
  message text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.procurement_audit_events (
  id uuid primary key default gen_random_uuid(),
  rfq_id text references public.rfqs(id) on delete set null,
  actor_user_id uuid,
  actor_role text not null,
  event_type text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.rfq_clarifications (
  id uuid primary key default gen_random_uuid(),
  rfq_id text not null references public.rfqs(id) on delete cascade,
  vendor_user_id uuid not null,
  question text not null,
  answer text not null default '',
  status text not null default 'open' check (status in ('open','answered','closed')),
  created_at timestamptz not null default now(),
  answered_at timestamptz
);

alter table public.awards add column if not exists disclosed_at timestamptz;
alter table public.awards add column if not exists disclosure_details jsonb not null default '{}'::jsonb;

create index if not exists rfq_invitations_vendor_idx
  on public.rfq_invitations(vendor_user_id, status, created_at desc);
create index if not exists procurement_notifications_user_idx
  on public.procurement_notifications(user_id, created_at desc);
create index if not exists procurement_notifications_role_idx
  on public.procurement_notifications(role, created_at desc);
create index if not exists procurement_audit_rfq_idx
  on public.procurement_audit_events(rfq_id, created_at desc);
create index if not exists rfq_clarifications_rfq_idx
  on public.rfq_clarifications(rfq_id, created_at desc);

alter table public.client_profiles enable row level security;
alter table public.rfq_invitations enable row level security;
alter table public.procurement_notifications enable row level security;
alter table public.procurement_audit_events enable row level security;
alter table public.rfq_clarifications enable row level security;

-- Explicitly fail closed if table grants change later. The server secret key
-- remains the only cross-party data path.
drop policy if exists client_profiles_deny_browser on public.client_profiles;
create policy client_profiles_deny_browser on public.client_profiles
  as restrictive for all to anon, authenticated using (false) with check (false);
drop policy if exists rfq_invitations_deny_browser on public.rfq_invitations;
create policy rfq_invitations_deny_browser on public.rfq_invitations
  as restrictive for all to anon, authenticated using (false) with check (false);
drop policy if exists procurement_notifications_deny_browser on public.procurement_notifications;
create policy procurement_notifications_deny_browser on public.procurement_notifications
  as restrictive for all to anon, authenticated using (false) with check (false);
drop policy if exists procurement_audit_deny_browser on public.procurement_audit_events;
create policy procurement_audit_deny_browser on public.procurement_audit_events
  as restrictive for all to anon, authenticated using (false) with check (false);
drop policy if exists rfq_clarifications_deny_browser on public.rfq_clarifications;
create policy rfq_clarifications_deny_browser on public.rfq_clarifications
  as restrictive for all to anon, authenticated using (false) with check (false);

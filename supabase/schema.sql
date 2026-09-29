-- URBAN PROCURE terms + vendor hardening schema
-- Run this in Supabase SQL editor.

create extension if not exists pgcrypto;

create table if not exists public.terms_documents (
  id uuid primary key default gen_random_uuid(),
  doc_type text not null check (doc_type in ('vendor_tnc', 'client_tnc', 'annex_a')),
  version text not null,
  content text not null,
  published_at timestamptz not null default now(),
  unique (doc_type, version)
);

create table if not exists public.terms_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  doc_type text not null check (doc_type in ('vendor_tnc', 'client_tnc', 'annex_a')),
  terms_version text not null,
  accepted_at timestamptz not null default now(),
  ip_address inet,
  user_agent text,
  method text not null default 'clickwrap',
  contact_email text
);

create table if not exists public.vendor_profiles (
  id uuid primary key,
  company_name text not null,
  trade_license_no text not null,
  license_expiry date not null,
  categories text[] not null default '{}',
  emirate text not null default '',
  status text not null default 'pending_verification' check (status in ('pending_verification', 'verified', 'rejected', 'suspended')),
  verified_at timestamptz,
  verification_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.terms_documents enable row level security;
alter table public.terms_acceptances enable row level security;
alter table public.vendor_profiles enable row level security;

revoke update, delete on public.terms_documents from anon, authenticated;
revoke update, delete on public.terms_acceptances from anon, authenticated;
revoke update, delete on public.vendor_profiles from anon, authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'terms_documents' and policyname = 'terms_documents_read_all'
  ) then
    create policy "terms_documents_read_all" on public.terms_documents
      for select to anon, authenticated using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'terms_acceptances' and policyname = 'terms_acceptances_read_own'
  ) then
    create policy "terms_acceptances_read_own" on public.terms_acceptances
      for select to authenticated using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'terms_acceptances' and policyname = 'terms_acceptances_insert_own'
  ) then
    create policy "terms_acceptances_insert_own" on public.terms_acceptances
      for insert to authenticated with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'terms_acceptances' and policyname = 'terms_acceptances_update_denied'
  ) then
    create policy "terms_acceptances_update_denied" on public.terms_acceptances
      for update to anon, authenticated using (false) with check (false);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'terms_acceptances' and policyname = 'terms_acceptances_delete_denied'
  ) then
    create policy "terms_acceptances_delete_denied" on public.terms_acceptances
      for delete to anon, authenticated using (false);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'vendor_profiles' and policyname = 'vendor_profiles_read_own'
  ) then
    create policy "vendor_profiles_read_own" on public.vendor_profiles
      for select to authenticated using (auth.uid() = id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'vendor_profiles' and policyname = 'vendor_profiles_insert_own'
  ) then
    create policy "vendor_profiles_insert_own" on public.vendor_profiles
      for insert to authenticated with check (auth.uid() = id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'vendor_profiles' and policyname = 'vendor_profiles_update_own'
  ) then
    create policy "vendor_profiles_update_own" on public.vendor_profiles
      for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);
  end if;
end $$;

create or replace function public.bump_vendor_profile_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists vendor_profiles_updated_at on public.vendor_profiles;
create trigger vendor_profiles_updated_at
before update on public.vendor_profiles
for each row execute function public.bump_vendor_profile_updated_at();

-- Supplier Discovery & Growth Engine
-- Autonomous supplier network: PROSPECT → IDENTIFIED → QUALIFIED → PRIORITIZED → CONTACTED → RESPONDED → INVITED → REGISTERED → DOCUMENTS_SUBMITTED → VERIFIED → ACTIVE → QUOTING → PERFORMING

create extension if not exists pgcrypto;

-- Supplier prospects discovered from legitimate sources
create table if not exists public.supplier_prospects (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('directory', 'referral', 'web_search', 'trade_show', 'chamber_of_commerce', 'municipality_list', 'free_zone_list', 'manual')),
  source_reference text not null, -- URL, document ID, or reference
  company_name text not null,
  trade_license_no text,
  license_expiry date,
  categories text[] not null default '{}',
  subcategories text[] not null default '{}',
  emirate text not null default '',
  city text not null default '',
  address text,
  contact_name text,
  contact_email text,
  contact_phone text,
  website text,
  employee_count integer,
  annual_revenue_aed numeric(18,2),
  certifications text[] not null default '{}',
  project_references jsonb not null default '[]'::jsonb,
  status text not null default 'prospect' check (status in ('prospect', 'identified', 'qualified', 'prioritized', 'contacted', 'responded', 'invited', 'registered', 'documents_submitted', 'verified', 'active', 'quoting', 'performing', 'suspended', 'rejected', 'archived')),
  qualification_score integer not null default 0,
  priority_score integer not null default 0,
  last_contact_at timestamptz,
  next_followup_at timestamptz,
  followup_count integer not null default 0,
  response_received_at timestamptz,
  registered_user_id uuid,
  verified_at timestamptz,
  verification_note text,
  verification_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (trade_license_no) where trade_license_no is not null,
  unique (contact_email) where contact_email is not null
);

-- Supplier outreach communications log
create table if not exists public.supplier_outreach (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references public.supplier_prospects(id) on delete cascade,
  channel text not null check (channel in ('email', 'whatsapp', 'phone', 'linkedin', 'portal', 'in_person')),
  direction text not null check (direction in ('outbound', 'inbound')),
  template_id text,
  subject text,
  body text not null,
  sent_at timestamptz not null default now(),
  delivered_at timestamptz,
  opened_at timestamptz,
  replied_at timestamptz,
  response_text text,
  response_sentiment text check (response_sentiment in ('positive', 'neutral', 'negative', 'unsubscribe')),
  automation_level integer not null default 2 check (automation_level in (0,1,2,3,4)), -- 0=human, 1=assisted, 2=approval, 3=autonomous_policy, 4=autonomous_default
  triggered_by uuid, -- user_id or job_id
  metadata jsonb not null default '{}'::jsonb
);

-- Supplier gap detection: when RFQs have no matched vendors
create table if not exists public.supplier_gaps (
  id uuid primary key default gen_random_uuid(),
  rfq_id text not null,
  category text not null,
  subcategory text,
  emirate text not null,
  required_capacity integer,
  matched_vendor_count integer not null default 0,
  invited_vendor_count integer not null default 0,
  responded_vendor_count integer not null default 0,
  gap_severity text not null default 'moderate' check (gap_severity in ('low', 'moderate', 'high', 'critical')),
  discovery_triggered boolean not null default false,
  discovery_job_id uuid,
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Supplier performance memory for future matching
create table if not exists public.supplier_performance (
  id uuid primary key default gen_random_uuid(),
  vendor_user_id uuid not null,
  rfq_id text not null,
  quotation_id uuid,
  award_id uuid,
  -- Performance metrics
  submitted_on_time boolean,
  quote_competitiveness_score integer, -- 0-100 relative to market
  technical_compliance_score integer, -- 0-100
  commercial_compliance_score integer, -- 0-100
  responsiveness_score integer, -- 0-100
  awarded boolean not null default false,
  project_completed_on_time boolean,
  project_quality_rating integer, -- 1-5
  client_satisfaction_rating integer, -- 1-5
  payment_disputes integer not null default 0,
  service_fee_paid_on_time boolean,
  notes text,
  recorded_at timestamptz not null default now(),
  recorded_by uuid
);

-- Supplier discovery jobs (async background tasks)
create table if not exists public.supplier_discovery_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null check (job_type in ('directory_search', 'web_search', 'referral_processing', 'gap_triggered_discovery', 'verification', 'outreach_campaign')),
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed', 'blocked')),
  trigger_rfq_id text,
  trigger_gap_id uuid,
  parameters jsonb not null default '{}'::jsonb,
  results jsonb not null default '{}'::jsonb,
  prospects_found integer not null default 0,
  prospects_qualified integer not null default 0,
  prospects_contacted integer not null default 0,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

-- Outreach templates for automated communication
create table if not exists public.outreach_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  channel text not null check (channel in ('email', 'whatsapp', 'phone', 'linkedin', 'portal')),
  stage text not null check (stage in ('initial_contact', 'followup_1', 'followup_2', 'followup_3', 'final_notice', 'registration_invite', 'document_request', 'verification_complete', 'rfq_invitation', 'rfq_reminder', 'rfq_deadline')),
  subject_template text,
  body_template text not null,
  variables jsonb not null default '[]'::jsonb, -- list of variable names used in template
  automation_level integer not null default 2 check (automation_level in (0,1,2,3,4)),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Indexes
create index if not exists supplier_prospects_status_idx on public.supplier_prospects(status);
create index if not exists supplier_prospects_category_idx on public.supplier_prospects using gin(categories);
create index if not exists supplier_prospects_emirate_idx on public.supplier_prospects(emirate);
create index if not exists supplier_prospects_priority_idx on public.supplier_prospects(priority_score desc);
create index if not exists supplier_outreach_prospect_idx on public.supplier_outreach(prospect_id, sent_at desc);
create index if not exists supplier_gaps_category_emirate_idx on public.supplier_gaps(category, emirate);
create index if not exists supplier_gaps_resolved_idx on public.supplier_gaps(resolved_at) where resolved_at is null;
create index if not exists supplier_performance_vendor_idx on public.supplier_performance(vendor_user_id, recorded_at desc);
create index if not exists supplier_discovery_jobs_status_idx on public.supplier_discovery_jobs(status);
create index if not exists outreach_templates_stage_channel_idx on public.outreach_templates(stage, channel, active);

-- RLS: All supplier discovery tables are server-side only (deny browser access)
alter table public.supplier_prospects enable row level security;
alter table public.supplier_outreach enable row level security;
alter table public.supplier_gaps enable row level security;
alter table public.supplier_performance enable row level security;
alter table public.supplier_discovery_jobs enable row level security;
alter table public.outreach_templates enable row level security;

do $$
begin
  -- supplier_prospects
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'supplier_prospects' and policyname = 'supplier_prospects_deny_browser') then
    create policy supplier_prospects_deny_browser on public.supplier_prospects as restrictive for all to anon, authenticated using (false) with check (false);
  end if;
  -- supplier_outreach
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'supplier_outreach' and policyname = 'supplier_outreach_deny_browser') then
    create policy supplier_outreach_deny_browser on public.supplier_outreach as restrictive for all to anon, authenticated using (false) with check (false);
  end if;
  -- supplier_gaps
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'supplier_gaps' and policyname = 'supplier_gaps_deny_browser') then
    create policy supplier_gaps_deny_browser on public.supplier_gaps as restrictive for all to anon, authenticated using (false) with check (false);
  end if;
  -- supplier_performance
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'supplier_performance' and policyname = 'supplier_performance_deny_browser') then
    create policy supplier_performance_deny_browser on public.supplier_performance as restrictive for all to anon, authenticated using (false) with check (false);
  end if;
  -- supplier_discovery_jobs
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'supplier_discovery_jobs' and policyname = 'supplier_discovery_jobs_deny_browser') then
    create policy supplier_discovery_jobs_deny_browser on public.supplier_discovery_jobs as restrictive for all to anon, authenticated using (false) with check (false);
  end if;
  -- outreach_templates
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'outreach_templates' and policyname = 'outreach_templates_deny_browser') then
    create policy outreach_templates_deny_browser on public.outreach_templates as restrictive for all to anon, authenticated using (false) with check (false);
  end if;
end $$;

-- Updated_at triggers
create or replace function public.bump_supplier_prospects_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
drop trigger if exists supplier_prospects_updated_at on public.supplier_prospects;
create trigger supplier_prospects_updated_at before update on public.supplier_prospects for each row execute function public.bump_supplier_prospects_updated_at();

create or replace function public.bump_supplier_gaps_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
drop trigger if exists supplier_gaps_updated_at on public.supplier_gaps;
create trigger supplier_gaps_updated_at before update on public.supplier_gaps for each row execute function public.bump_supplier_gaps_updated_at();

create or replace function public.bump_outreach_templates_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
drop trigger if exists outreach_templates_updated_at on public.outreach_templates;
create trigger outreach_templates_updated_at before update on public.outreach_templates for each row execute function public.bump_outreach_templates_updated_at();

-- Negotiations table
create table if not exists public.negotiations (
  id uuid primary key default gen_random_uuid(),
  rfq_id text not null references public.rfqs(id) on delete cascade,
  quotation_id uuid not null references public.quotations(id) on delete cascade,
  vendor_user_id uuid not null,
  client_user_id uuid not null,
  stage text not null default 'initiated' check (stage in ('initiated','vendor_responded','client_countered','vendor_accepted','vendor_declined','client_accepted','client_declined','expired','withdrawn','awarded')),
  terms jsonb not null,
  current_terms jsonb not null,
  round integer not null default 1,
  initiated_by uuid,
  initiated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'active' check (status in ('active','concluded')),
  notes text,
  concluded_at timestamptz,
  concluded_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists negotiations_rfq_idx on public.negotiations(rfq_id);
create index if not exists negotiations_quotation_idx on public.negotiations(quotation_id);
create index if not exists negotiations_vendor_idx on public.negotiations(vendor_user_id);
create index if not exists negotiations_status_idx on public.negotiations(status);

alter table public.negotiations enable row level security;
drop policy if exists negotiations_deny_browser on public.negotiations;
create policy negotiations_deny_browser on public.negotiations as restrictive for all to anon, authenticated using (false) with check (false);

create or replace function public.bump_negotiations_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
drop trigger if exists negotiations_updated_at on public.negotiations;
create trigger negotiations_updated_at before update on public.negotiations for each row execute function public.bump_negotiations_updated_at();

-- Scheduled jobs table for resilience
create table if not exists public.scheduled_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null,
  status text not null default 'pending' check (status in ('pending','processing','completed','failed','dead_letter')),
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  error_message text,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  scheduled_at timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  locked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists scheduled_jobs_status_scheduled_idx on public.scheduled_jobs(status, scheduled_at) where status in ('pending','processing');

alter table public.scheduled_jobs enable row level security;
drop policy if exists scheduled_jobs_deny_browser on public.scheduled_jobs;
create policy scheduled_jobs_deny_browser on public.scheduled_jobs as restrictive for all to anon, authenticated using (false) with check (false);

-- Dead letters table
create table if not exists public.dead_letters (
  id uuid primary key default gen_random_uuid(),
  job_type text not null,
  payload jsonb not null,
  error text,
  attempts integer not null default 0,
  original_job_id uuid,
  failed_at timestamptz not null default now(),
  status text not null default 'dead_letter' check (status in ('dead_letter','resolved','requeued')),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists dead_letters_status_idx on public.dead_letters(status);
create index if not exists dead_letters_job_type_idx on public.dead_letters(job_type);

alter table public.dead_letters enable row level security;
drop policy if exists dead_letters_deny_browser on public.dead_letters;
create policy dead_letters_deny_browser on public.dead_letters as restrictive for all to anon, authenticated using (false) with check (false);

-- Circuit breaker state
create table if not exists public.circuit_breakers (
  id text primary key, -- service identifier
  state text not null default 'closed' check (state in ('closed','open','half_open')),
  failure_count integer not null default 0,
  success_count integer not null default 0,
  last_failure_at timestamptz,
  last_success_at timestamptz,
  opened_at timestamptz,
  threshold integer not null default 5,
  timeout_seconds integer not null default 60,
  updated_at timestamptz not null default now()
);

alter table public.circuit_breakers enable row level security;
drop policy if exists circuit_breakers_deny_browser on public.circuit_breakers;
create policy circuit_breakers_deny_browser on public.circuit_breakers as restrictive for all to anon, authenticated using (false) with check (false);

-- Default outreach templates
insert into public.outreach_templates (name, channel, stage, subject_template, body_template, variables, automation_level) values
  ('initial_email', 'email', 'initial_contact',
   'Invitation to Join Urban Procure Verified Supplier Network',
   'Dear {{contact_name}},\n\nUrban Procure is a construction procurement platform operated by Urban Fixperts Technical Services LLC (Dubai, UAE). We connect verified suppliers with clients for Civil, MEP, HVAC, and Manpower Supply projects.\n\nWe identified {{company_name}} as a potential match for our network based on your {{categories}} expertise in {{emirate}}.\n\nJoining our verified network gives you:\n- Direct access to RFQs from vetted clients\n- Blind bidding (your identity protected until award)\n- Standardized quotation format for faster comparison\n- Performance tracking and priority matching\n\nTo get started, please reply to this email or register at: {{registration_link}}\n\nBest regards,\nThe Urban Procure Team',
   '["contact_name", "company_name", "categories", "emirate", "registration_link"]', 3),
  ('followup_1_email', 'email', 'followup_1',
   'Following up: Join Urban Procure Verified Supplier Network',
   'Dear {{contact_name}},\n\nFollowing up on our invitation to {{company_name}} to join the Urban Procure verified supplier network.\n\nWe''re currently matching suppliers for {{category}} projects in {{emirate}} and your profile would be a strong fit.\n\nRegistration takes 5 minutes: {{registration_link}}\n\nIf you''re not interested, please let us know and we''ll remove you from our outreach.\n\nBest regards,\nThe Urban Procure Team',
   '["contact_name", "company_name", "category", "emirate", "registration_link"]', 3),
  ('rfq_invitation_email', 'email', 'rfq_invitation',
   'New {{category}} RFQ Opportunity: {{rfq_title}}',
   'Dear {{contact_name}},\n\nA new {{category}} RFQ matching {{company_name}}''s expertise has been published on Urban Procure.\n\nRFQ: {{rfq_title}}\nLocation: {{emirate}}\nDeadline: {{deadline}}\nBudget Band: {{budget_band}}\n\nLog in to your vendor dashboard to view the sanitized work pack and submit your quotation:\n{{vendor_dashboard_link}}\n\nYour identity remains protected until the client awards the project.\n\nBest regards,\nThe Urban Procure Team',
   '["contact_name", "company_name", "category", "rfq_title", "emirate", "deadline", "budget_band", "vendor_dashboard_link"]', 3),
  ('rfq_reminder_email', 'email', 'rfq_reminder',
   'Reminder: Quotation Deadline for {{rfq_title}}',
   'Dear {{contact_name}},\n\nThis is a reminder that the quotation deadline for {{rfq_title}} is approaching on {{deadline}}.\n\nYou have been invited to quote for this {{category}} project in {{emirate}}.\n\nSubmit your quotation here: {{vendor_dashboard_link}}\n\nIf you''ve already submitted, thank you!\n\nBest regards,\nThe Urban Procure Team',
   '["contact_name", "rfq_title", "deadline", "category", "emirate", "vendor_dashboard_link"]', 3),
  ('registration_invite_whatsapp', 'whatsapp', 'registration_invite',
   null,
   'Hi {{contact_name}}, Urban Procure here. We''d like to invite {{company_name}} to join our verified supplier network for {{categories}} work in {{emirate}}. Interested? Register here: {{registration_link}} - Urban Procure Team',
   '["contact_name", "company_name", "categories", "emirate", "registration_link"]', 2)
on conflict (name) do nothing;
-- Keep the internal WhatsApp event log inaccessible to browser roles.
alter table public.whatsapp_events enable row level security;
drop policy if exists "whatsapp_events_deny_browser" on public.whatsapp_events;
create policy "whatsapp_events_deny_browser" on public.whatsapp_events
  as restrictive for all to anon, authenticated using (false) with check (false);

/**
 * Supplier Discovery Job Processor
 * Background processor for supplier discovery jobs
 */

import { evaluateProspect, transitionStage, SUPPLIER_STAGES, buildRegistrationLink, growthInvite } from './supplier-discovery.js';
import { createOutreachJob, sendOutreach, scheduleFollowups } from './supplier-outreach.js';
import { createLicenseVerifier, VERIFICATION_STATUS } from './license-verifier.js';
import { createDiscoveryProvider, FirecrawlDiscoveryProvider, DISCOVERY_STATUS, isDeliverableEmail } from './discovery-provider.js';

const DISCOVERY_SOURCES = Object.freeze({
  DIRECTORY: 'directory',
  WEB_SEARCH: 'web_search',
  REFERRAL: 'referral',
  TRADE_SHOW: 'trade_show',
  CHAMBER_OF_COMMERCE: 'chamber_of_commerce',
  MUNICIPALITY_LIST: 'municipality_list',
  FREE_ZONE_LIST: 'free_zone_list',
  MANUAL: 'manual'
});

const GROWTH_SEARCHES = Object.freeze({
  vendor: ['civil contractor', 'MEP contractor', 'fit-out contractor', 'painting contractor', 'electrical contractor', 'plumbing contractor'],
  client: ['property developer', 'construction consultant', 'fit-out client', 'building contractor procurement']
});

export async function growVendorPool({ env, outreachProvider, dailyLimit = 20, batch = 5 } = {}) {
  const finder = new FirecrawlDiscoveryProvider(env);
  const vendor = await inviteAudience({ env, outreachProvider, finder, kind: 'vendor', dailyLimit, batch });
  const client = await inviteAudience({ env, outreachProvider, finder, kind: 'client', dailyLimit, batch });
  return { ok: true, vendor, client, created: vendor.created + client.created, invited: vendor.invited + client.invited, skipped: vendor.skipped + client.skipped };
}

function usableProspect(prospect) {
  const name = String(prospect?.company_name || '').trim();
  if (name.length < 4) return false;
  if (/^(pdf|docx?|xlsx?|csv|list|home|contact|about)$/i.test(name)) return false;
  if (/\b(pdf|directory|membership list|top rated|wikipedia|download)\b/i.test(name)) return false;
  if (/gotoprated|yellowpages|yelp|dubizzle/i.test(String(prospect?.website || ''))) return false;
  return true;
}

async function inviteAudience({ env, outreachProvider, finder, kind, dailyLimit, batch }) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const already = await rest(env, `/rest/v1/supplier_outreach?metadata->>source=eq.growth&metadata->>audience=eq.${kind}&metadata->>send_status=eq.sent&sent_at=gte.${encodeURIComponent(since)}&select=id`);
  const room = Math.max(0, dailyLimit - already.length);
  if (!room) return { ok: true, skipped: 'daily_invite_limit', invited: 0, created: 0 };

  const now = new Date().toISOString();
  const take = Math.min(room, batch);
  const audience = kind === 'client' ? 'subcategories=cs.{client-lead}' : 'subcategories=not.cs.{client-lead}';
  let targets = await rest(env, `/rest/v1/supplier_prospects?last_contact_at=is.null&contact_email=not.is.null&${audience}&order=created_at.asc&limit=${take}&select=*`);
  if (targets.length < take && kind === 'vendor') {
    const more = await rest(env, `/rest/v1/supplier_prospects?last_contact_at=is.null&website=not.is.null&contact_email=is.null&${audience}&or=(next_followup_at.is.null,next_followup_at.lte.${encodeURIComponent(now)})&order=created_at.asc&limit=${take - targets.length}&select=*`);
    targets = targets.concat(more);
  }
  let created = 0;
  const hour = new Date().getUTCHours();
  const minute = new Date().getUTCMinutes();
  const searchWindow = hour % 6 === 0 && minute < 15;
  if (targets.length < take && searchWindow) {
    const list = GROWTH_SEARCHES[kind];
    const category = list[new Date().getUTCDate() % list.length];
    const found = await finder.searchWeb({ query: `${category} Dubai contact email`, categories: [category], emirate: 'Dubai', limit: 5 });
    for (const prospectData of found.prospects || []) {
      if (targets.length >= take) break;
      const existing = await findProspectByReference(env, prospectData.source_reference);
      const prospect = existing ? await getProspect(env, existing.id) : await createProspect(env, {
        ...prospectData,
        source: DISCOVERY_SOURCES.WEB_SEARCH,
        status: 'prospect',
        subcategories: kind === 'client' ? ['client-lead'] : []
      });
      if (!existing && prospect?.id) created += 1;
      if (prospect?.id && !prospect.last_contact_at && !targets.some((row) => row.id === prospect.id)) targets.push(prospect);
    }
  }

  let invited = 0;
  let skipped = 0;
  for (const prospect of targets.slice(0, take)) {
    if (!usableProspect(prospect)) {
      await updateProspect(env, prospect.id, { status: 'archived', next_followup_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString() });
      skipped += 1;
      continue;
    }
    let email = String(prospect.contact_email || '').trim();
    if (!email && prospect.website) email = await finder.findPublicEmail(prospect.website);
    if (!email || !isDeliverableEmail(email)) {
      await updateProspect(env, prospect.id, {
        contact_email: null,
        status: prospect.contact_email ? 'archived' : prospect.status,
        next_followup_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      });
      skipped += 1;
      continue;
    }
    if (email !== prospect.contact_email) {
      try { await updateProspect(env, prospect.id, { contact_email: email }); }
      catch { skipped += 1; continue; }
    }
    const copy = growthInvite({ kind, company: prospect.company_name, link: buildRegistrationLink(prospect.id, env.PLATFORM_BASE_URL, kind) });
    const outreach = await createOutreachJob({
      env,
      prospectId: prospect.id,
      stage: 'initial_contact',
      channel: 'email',
      automationLevel: 3,
      variables: {
        source: 'growth',
        audience: kind,
        contact_email: email,
        subject_override: copy.subject,
        body_override: copy.body
      }
    });
    if (!outreach.ok) { skipped += 1; continue; }
    const sent = await sendOutreach({ env, outreachId: outreach.outreach.id, provider: outreachProvider });
    if (!sent.ok) { skipped += 1; continue; }
    await updateProspect(env, prospect.id, { status: 'contacted', last_contact_at: new Date().toISOString() });
    invited += 1;
  }
  return { ok: true, created, invited, skipped };
}

export async function processDiscoveryJob({ env, jobId, discoveryProvider, outreachProvider }) {
  const job = await getJob(env, jobId);
  if (!job) return { ok: false, error: 'Job not found' };
  if (['completed', 'blocked'].includes(job.status)) return { ok: true, idempotent: true, job };

  const claimed = await claimJob(env, jobId);
  if (!claimed) return { ok: false, error: 'Job already claimed' };

  try {
    let result;
    switch (job.job_type) {
      case 'directory_search':
        result = await processDirectorySearch({ env, job, discoveryProvider });
        break;
      case 'web_search':
        result = await processWebSearch({ env, job, discoveryProvider });
        break;
      case 'gap_triggered_discovery':
        result = await processGapTriggeredDiscovery({ env, job, discoveryProvider });
        break;
      case 'verification':
        result = await processVerification({ env, job });
        break;
      case 'outreach_campaign':
        result = await processOutreachCampaign({ env, job, outreachProvider });
        break;
      default:
        result = { ok: false, error: `Unknown job type: ${job.job_type}` };
    }

    await completeJob(env, jobId, { status: result.ok ? 'completed' : 'failed', result, error_message: result.error });
    return { ok: result.ok, job: await getJob(env, jobId) };
  } catch (error) {
    await completeJob(env, jobId, { status: 'failed', error_message: error.message });
    return { ok: false, error: error.message };
  }
}

async function processDirectorySearch({ env, job, discoveryProvider }) {
  const { source, categories, emirate, limit = 50 } = job.parameters;
  
  const provider = discoveryProvider || createDiscoveryProvider(env);
  const result = await provider.searchDirectory({ source, categories, emirate, limit });

  if (result.status !== DISCOVERY_STATUS.FOUND) {
    return { ok: false, error: result.reason || 'Directory search failed', status: result.status };
  }

  let created = 0;
  let qualified = 0;

  for (const prospectData of result.prospects) {
    const existing = await findProspectByLicense(env, prospectData.trade_license_no) || await findProspectByReference(env, prospectData.source_reference);
    if (existing) continue;

    const prospect = await createProspect(env, {
      ...prospectData,
      source: prospectData.source || DISCOVERY_SOURCES.DIRECTORY,
      source_reference: prospectData.source_reference || `${source}:${prospectData.trade_license_no}`,
      status: 'prospect'
    });

    if (!prospect) continue;
    created++;

    const evaluation = evaluateProspect(prospect, { categoryDemand: 1, emirateDemand: 1, gapSeverity: 0 });
    if (evaluation.suggested_stage !== 'prospect') {
      await updateProspect(env, prospect.id, { status: evaluation.suggested_stage, qualification_score: evaluation.qualification_score, priority_score: evaluation.priority_score });
      qualified++;
    }
  }

  return { ok: true, prospects_found: created, prospects_qualified: qualified, discovery_status: result.status };
}

async function processWebSearch({ env, job, discoveryProvider }) {
  const { query, categories, emirate, limit = 20 } = job.parameters;

  const provider = discoveryProvider || createDiscoveryProvider(env);
  const result = await provider.searchWeb({ query, categories, emirate, limit });

  if (result.status !== DISCOVERY_STATUS.FOUND) {
    return { ok: false, error: result.reason || 'Web search failed', status: result.status };
  }

  let created = 0;
  for (const prospectData of result.prospects) {
    const existing = await findProspectByLicense(env, prospectData.trade_license_no) || await findProspectByReference(env, prospectData.source_reference);
    if (existing) continue;

    const prospect = await createProspect(env, {
      ...prospectData,
      source: prospectData.source || DISCOVERY_SOURCES.WEB_SEARCH,
      source_reference: prospectData.source_reference || `web:${query}`,
      status: 'prospect'
    });

    if (prospect) created++;
  }

  return { ok: true, prospects_found: created, discovery_status: result.status };
}

async function processGapTriggeredDiscovery({ env, job, discoveryProvider }) {
  const { category, subcategory, emirate, required_capacity, gap_severity } = job.parameters;
  const limit = Math.max(required_capacity * 3, 10);

  const provider = discoveryProvider || createDiscoveryProvider(env);
  const result = await provider.searchDirectory({
    source: 'municipality_list',
    categories: [category, subcategory].filter(Boolean),
    emirate,
    limit
  });

  if (result.status !== DISCOVERY_STATUS.FOUND) {
    return { ok: false, error: result.reason || 'Gap-triggered discovery failed', status: result.status };
  }

  let created = 0;
  let qualified = 0;
  let contacted = 0;

  for (const prospectData of result.prospects) {
    const existing = await findProspectByLicense(env, prospectData.trade_license_no) || await findProspectByReference(env, prospectData.source_reference);
    if (existing) continue;

    const prospect = await createProspect(env, {
      ...prospectData,
      source: prospectData.source || DISCOVERY_SOURCES.MUNICIPALITY_LIST,
      source_reference: prospectData.source_reference || `gap:${job.trigger_gap_id}`,
      status: 'prospect'
    });

    if (!prospect) continue;
    created++;

    const evaluation = evaluateProspect(prospect, { categoryDemand: 3, emirateDemand: 2, gapSeverity: gap_severity === 'critical' ? 3 : 2 });
    if (evaluation.suggested_stage !== 'prospect') {
      await updateProspect(env, prospect.id, { status: evaluation.suggested_stage, qualification_score: evaluation.qualification_score, priority_score: evaluation.priority_score });
      qualified++;

      // Auto-contact high-priority prospects for critical gaps
      if (gap_severity === 'critical' && evaluation.priority_score >= 70) {
        const outreachResult = await createOutreachJob({
          env,
          prospectId: prospect.id,
          stage: 'initial_contact',
          channel: 'email',
          automationLevel: 3,
          triggeredBy: `job:${job.id}`,
          variables: {
            contact_name: prospectData.contact_name || 'Procurement Team',
            contact_email: prospectData.contact_email || prospect.contact_email || '',
            company_name: prospectData.company_name,
            categories: prospectData.categories?.join(', ') || category,
            emirate: prospectData.emirate,
            registration_link: buildRegistrationLink(prospect.id, env.PLATFORM_BASE_URL)
          }
        });

        if (outreachResult.ok) {
          await sendOutreach({ env, outreachId: outreachResult.outreach.id, provider: outreachProvider });
          await updateProspect(env, prospect.id, { status: 'contacted', last_contact_at: new Date().toISOString() });
          contacted++;
        }
      }
    }
  }

  return { ok: true, prospects_found: created, prospects_qualified: qualified, prospects_contacted: contacted, discovery_status: result.status };
}

async function processVerification({ env, job }) {
  const { prospect_id } = job.parameters;
  const prospect = await getProspect(env, prospect_id);
  if (!prospect) return { ok: false, error: 'Prospect not found' };

  // Verify trade license with municipality API
  const verified = await verifyTradeLicense(prospect.trade_license_no, prospect.emirate, env);

  if (verified.valid) {
    const updated = await transitionStage(prospect, 'verified', { reason: 'Trade license verified', actor: 'system' });
    await updateProspect(env, prospect_id, { ...updated, verified_at: new Date().toISOString(), verification_note: `Auto-verified via ${verified.authority || 'municipality API'}` });
    return { ok: true, verified: true, details: verified };
  } else {
    await updateProspect(env, prospect_id, { status: 'rejected', verification_note: verified.reason || 'Trade license invalid' });
    return { ok: true, verified: false, reason: verified.reason, details: verified };
  }
}

async function processOutreachCampaign({ env, job, outreachProvider }) {
  const { prospect_ids, stage, channel, automation_level } = job.parameters;
  let sent = 0;
  let failed = 0;

  for (const prospectId of prospect_ids) {
    const prospect = await getProspect(env, prospectId);
    if (!prospect) { failed++; continue; }

    const result = await createOutreachJob({
      env,
      prospectId,
      stage,
      channel,
      automationLevel: automation_level,
      triggeredBy: `job:${job.id}`,
      variables: {
        contact_name: prospect.contact_name || 'Procurement Team',
        contact_email: prospect.contact_email || '',
        company_name: prospect.company_name,
        categories: prospect.categories?.join(', ') || '',
        emirate: prospect.emirate,
        registration_link: buildRegistrationLink(prospect.id, env.PLATFORM_BASE_URL)
      }
    });

    if (result.ok) {
      const sendResult = await sendOutreach({ env, outreachId: result.outreach.id, provider: outreachProvider });
      if (sendResult.ok) sent++;
      else failed++;
    } else {
      failed++;
    }
  }

  return { ok: true, sent, failed };
}

async function verifyTradeLicense(licenseNo, emirate, env = {}) {
  if (!licenseNo) return { valid: false, reason: 'No trade license provided', status: VERIFICATION_STATUS.INVALID };

  const verifier = createLicenseVerifier(env);
  const result = await verifier.verify({ licenseNumber: licenseNo, emirate });

  return {
    valid: result.verified,
    reason: result.reason,
    status: result.status,
    companyName: result.company_name,
    expiryDate: result.license_expiry,
    activities: result.license_activities,
    authority: result.authority,
    checkedAt: result.checked_at
  };
}

// Database helpers
async function getJob(env, id) {
  return one(env, `/rest/v1/supplier_discovery_jobs?id=eq.${encodeURIComponent(id)}&select=*`);
}

async function claimJob(env, id) {
  await patch(env, 'supplier_discovery_jobs', `id=eq.${encodeURIComponent(id)}&status=eq.pending`, { status: 'processing', started_at: new Date().toISOString() });
  const job = await getJob(env, id);
  return job?.status === 'processing';
}

async function completeJob(env, id, changes) {
  const row = {
    status: changes.status,
    results: changes.result || changes.results || {},
    error_message: changes.error_message || changes.error || null,
    completed_at: new Date().toISOString()
  };
  if (changes.result?.prospects_found != null) row.prospects_found = changes.result.prospects_found;
  if (changes.result?.prospects_qualified != null) row.prospects_qualified = changes.result.prospects_qualified;
  if (changes.result?.prospects_contacted != null) row.prospects_contacted = changes.result.prospects_contacted;
  return patch(env, 'supplier_discovery_jobs', `id=eq.${encodeURIComponent(id)}`, row);
}

async function findProspectByLicense(env, licenseNo) {
  if (!licenseNo) return null;
  return one(env, `/rest/v1/supplier_prospects?trade_license_no=eq.${licenseNo}&select=*`);
}

async function findProspectByReference(env, reference) {
  if (!reference) return null;
  return one(env, `/rest/v1/supplier_prospects?source_reference=eq.${encodeURIComponent(reference)}&select=id`);
}

async function createProspect(env, prospect) {
  return insert(env, 'supplier_prospects', prospect);
}

async function getProspect(env, id) {
  return one(env, `/rest/v1/supplier_prospects?id=eq.${encodeURIComponent(id)}&select=*`);
}

async function updateProspect(env, id, changes) {
  return patch(env, 'supplier_prospects', `id=eq.${encodeURIComponent(id)}`, changes);
}

async function one(env, path) {
  const rows = await rest(env, path);
  return rows[0] || null;
}

async function rest(env, path, init = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
  const response = await fetch(`${env.SUPABASE_URL}${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `Supabase request failed (${response.status})`);
  return text ? JSON.parse(text) : [];
}

async function insert(env, table, row) {
  const rows = await rest(env, `/rest/v1/${table}`, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
  return rows[0] || row;
}

async function patch(env, table, filter, body) {
  const rows = await rest(env, `/rest/v1/${table}?${filter}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) });
  return rows[0] || body;
}
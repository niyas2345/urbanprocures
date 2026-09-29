/**
 * Supplier Gap Detection
 * Detects when RFQs have insufficient vendor coverage and triggers discovery
 */

import { detectSupplierGap, shouldTriggerDiscovery, calculateGapSeverity } from './supplier-discovery.js';

export async function analyzeRfqGap({ env, rfqId, matchedVendors, invitedVendors, respondedVendors }) {
  const rfq = await getRfq(env, rfqId);
  if (!rfq) return { ok: false, error: 'RFQ not found' };

  const gap = detectSupplierGap(rfq, matchedVendors, invitedVendors, respondedVendors);

  // Upsert gap record
  const existingGap = await getGapByRfq(env, rfqId);
  let gapRecord;
  if (existingGap) {
    gapRecord = await updateGap(env, existingGap.id, {
      matched_vendor_count: gap.matched_vendor_count,
      invited_vendor_count: gap.invited_vendor_count,
      responded_vendor_count: gap.responded_vendor_count,
      gap_severity: gap.gap_severity,
      updated_at: new Date().toISOString()
    });
  } else {
    gapRecord = await insertGap(env, {
      rfq_id: rfqId,
      category: gap.category,
      subcategory: gap.subcategory,
      emirate: gap.emirate,
      required_capacity: gap.required_capacity,
      matched_vendor_count: gap.matched_vendor_count,
      invited_vendor_count: gap.invited_vendor_count,
      responded_vendor_count: gap.responded_vendor_count,
      gap_severity: gap.gap_severity
    });
  }

  // Trigger discovery if needed
  let discoveryTriggered = false;
  let discoveryJobId = null;

  if (shouldTriggerDiscovery(gap) && !existingGap?.discovery_triggered) {
    const job = await createDiscoveryJob(env, {
      job_type: 'gap_triggered_discovery',
      trigger_rfq_id: rfqId,
      trigger_gap_id: gapRecord.id,
      parameters: {
        category: gap.category,
        subcategory: gap.subcategory,
        emirate: gap.emirate,
        required_capacity: gap.required_capacity,
        gap_severity: gap.gap_severity
      }
    });
    discoveryTriggered = true;
    discoveryJobId = job.id;

    await updateGap(env, gapRecord.id, { discovery_triggered: true, discovery_job_id: job.id });
  }

  return {
    ok: true,
    gap: gapRecord,
    discovery_triggered: discoveryTriggered,
    discovery_job_id: discoveryJobId
  };
}

export async function analyzeAllActiveGaps({ env }) {
  const rfqs = await getActiveRfqs(env);
  const results = [];

  for (const rfq of rfqs) {
    const matched = await getMatchedVendors(env, rfq.id);
    const invited = await getInvitedVendors(env, rfq.id);
    const responded = await getRespondedVendors(env, rfq.id);

    const result = await analyzeRfqGap({ env, rfqId: rfq.id, matchedVendors: matched, invitedVendors: invited, respondedVendors: responded });
    results.push({ rfq_id: rfq.id, ...result });
  }

  return { ok: true, analyzed: results.length, gaps: results };
}

export async function getUnresolvedGaps({ env, severity }) {
  let path = `/rest/v1/supplier_gaps?resolved_at=is.null&select=*&order=gap_severity.desc,created_at.desc`;
  if (severity) path += `&gap_severity=eq.${severity}`;
  return rest(env, path);
}

export async function resolveGap({ env, gapId, resolvedBy, note }) {
  return updateGap(env, gapId, {
    resolved_at: new Date().toISOString(),
    resolved_by: resolvedBy,
    verification_note: note
  });
}

export async function getGapStats({ env }) {
  const gaps = await rest(env, `/rest/v1/supplier_gaps?resolved_at=is.null&select=gap_severity,category,emirate`);
  const bySeverity = { critical: 0, high: 0, moderate: 0, low: 0 };
  const byCategory = {};
  const byEmirate = {};

  for (const gap of gaps) {
    bySeverity[gap.gap_severity] = (bySeverity[gap.gap_severity] || 0) + 1;
    byCategory[gap.category] = (byCategory[gap.category] || 0) + 1;
    byEmirate[gap.emirate] = (byEmirate[gap.emirate] || 0) + 1;
  }

  return { ok: true, by_severity: bySeverity, by_category: byCategory, by_emirate: byEmirate };
}

// Database helpers
async function getRfq(env, id) {
  return one(env, `/rest/v1/rfqs?id=eq.${encodeURIComponent(id)}&select=*`);
}

async function getActiveRfqs(env) {
  return rest(env, `/rest/v1/rfqs?status=in.(Submitted,Under Review,Matching,Quoting,Comparing)&select=id,category,subcategory,emirate,required_vendor_count`);
}

async function getMatchedVendors(env, rfqId) {
  return rest(env, `/rest/v1/rfq_invitations?rfq_id=eq.${encodeURIComponent(rfqId)}&status=in.(invited,viewed,quoted)&select=vendor_user_id`);
}

async function getInvitedVendors(env, rfqId) {
  return rest(env, `/rest/v1/rfq_invitations?rfq_id=eq.${encodeURIComponent(rfqId)}&status=in.(invited,viewed,quoted)&select=vendor_user_id`);
}

async function getRespondedVendors(env, rfqId) {
  return rest(env, `/rest/v1/quotations?rfq_id=eq.${encodeURIComponent(rfqId)}&status=in.(submitted,review,selected)&select=vendor_user_id`);
}

async function getGapByRfq(env, rfqId) {
  return one(env, `/rest/v1/supplier_gaps?rfq_id=eq.${encodeURIComponent(rfqId)}&select=*`);
}

async function insertGap(env, gap) {
  return insert(env, 'supplier_gaps', gap);
}

async function updateGap(env, id, changes) {
  return patch(env, 'supplier_gaps', `id=eq.${encodeURIComponent(id)}`, changes);
}

async function createDiscoveryJob(env, job) {
  return insert(env, 'supplier_discovery_jobs', { ...job, status: 'pending', created_at: new Date().toISOString() });
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
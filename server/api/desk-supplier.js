import { rest, one, insert, upsert, patch, params, inFilter, json, clean, list, readJson } from './desk-shared.js';
import { evaluateProspect, transitionStage, buildRegistrationLink, SUPPLIER_STAGES, STAGE_TRANSITIONS } from '../ai/supplier-discovery.js';
import { createOutreachJob, sendOutreach, scheduleFollowups, getNextFollowupStage } from '../ai/supplier-outreach.js';
import { createOutreachProvider } from '../ai/outreach-provider.js';
import { analyzeRfqGap, analyzeAllActiveGaps, getUnresolvedGaps, resolveGap, getGapStats as getGapStatsImpl } from '../ai/supplier-gap-detector.js';
import { processDiscoveryJob } from '../ai/supplier-discovery-processor.js';
import { getVendorPerformanceSummary, getTopVendorsByCategory as getTopVendors, recordQuotationPerformance as recQuotationPerf, recordProjectPerformance as recProjectPerf } from '../ai/supplier-performance.js';
import { initiateNegotiation as initNegotiation, respondToNegotiation as respNegotiation, getNegotiationHistory as getNegHistory } from '../ai/negotiation-workflow.js';
import { processScheduledJobs, getDeadLetters as getDL, requeueDeadLetter as requeueDL, getAllCircuitBreakers as getBreakerStatus } from '../ai/resilience.js';

export async function createSupplierProspect(request, env, actor) {
  const body = await readJson(request);
  const prospect = {
    source: clean(body.source, 40) || 'manual',
    source_reference: clean(body.source_reference, 200),
    company_name: clean(body.company_name, 180),
    trade_license_no: clean(body.trade_license_no, 120),
    license_expiry: body.license_expiry || null,
    categories: list(body.categories),
    subcategories: list(body.subcategories),
    emirate: clean(body.emirate, 80),
    city: clean(body.city, 80),
    address: clean(body.address, 500),
    contact_name: clean(body.contact_name, 160),
    contact_email: clean(body.contact_email, 200),
    contact_phone: clean(body.contact_phone, 60),
    website: clean(body.website, 200),
    employee_count: body.employee_count ? parseInt(body.employee_count) : null,
    annual_revenue_aed: body.annual_revenue_aed ? parseFloat(body.annual_revenue_aed) : null,
    certifications: list(body.certifications),
    project_references: body.project_references || [],
    status: 'prospect'
  };

  if (!prospect.company_name) throw new Error('Company name is required');

  const saved = await upsert(env, 'supplier_prospects', prospect, 'trade_license_no');
  await audit(env, actor, null, 'supplier_prospect_created', { prospect_id: saved.id });
  return json({ ok: true, prospect: saved }, 201);
}

export async function getSupplierProspects(env, actor, searchParams) {
  let path = `/rest/v1/supplier_prospects?select=*&order=updated_at.desc`;
  const status = searchParams.get('status');
  if (status) path += `&status=eq.${status}`;
  const category = searchParams.get('category');
  if (category) path += `&categories=cs.{${category}}`;
  const emirate = searchParams.get('emirate');
  if (emirate) path += `&emirate=eq.${emirate}`;
  const limit = searchParams.get('limit') || '50';
  path += `&limit=${limit}`;

  const prospects = await rest(env, path);
  return json({ ok: true, prospects });
}

export async function getSupplierProspect(env, actor, id) {
  const prospect = await one(env, `/rest/v1/supplier_prospects?id=eq.${encodeURIComponent(id)}&select=*`);
  if (!prospect) return json({ ok: false, error: 'Not found' }, 404);
  return json({ ok: true, prospect });
}

export async function updateSupplierProspect(request, env, actor, id) {
  const body = await readJson(request);
  const updates = {};
  const allowed = ['company_name', 'trade_license_no', 'license_expiry', 'categories', 'subcategories', 'emirate', 'city', 'address', 'contact_name', 'contact_email', 'contact_phone', 'website', 'employee_count', 'annual_revenue_aed', 'certifications', 'project_references', 'priority_score'];
  for (const key of allowed) {
    if (body[key] !== undefined) updates[key] = body[key];
  }
  updates.updated_at = new Date().toISOString();

  const saved = await patch(env, 'supplier_prospects', `id=eq.${encodeURIComponent(id)}`, updates);
  await audit(env, actor, null, 'supplier_prospect_updated', { prospect_id: id });
  return json({ ok: true, prospect: saved });
}

export async function transitionSupplierStage(request, env, actor, id) {
  const body = await readJson(request);
  const newStage = clean(body.stage, 40);
  const reason = clean(body.reason, 500);

  if (!SUPPLIER_STAGES.includes(newStage)) throw new Error('Invalid stage');

  const prospect = await one(env, `/rest/v1/supplier_prospects?id=eq.${encodeURIComponent(id)}&select=*`);
  if (!prospect) return json({ ok: false, error: 'Not found' }, 404);

  if (!STAGE_TRANSITIONS[prospect.status]?.has(newStage)) {
    return json({ ok: false, error: `Invalid transition: ${prospect.status} → ${newStage}` }, 400);
  }

  const updated = transitionStage(prospect, newStage, { reason, actor: actor.userId });
  const saved = await patch(env, 'supplier_prospects', `id=eq.${encodeURIComponent(id)}`, updated);

  await audit(env, actor, null, 'supplier_stage_changed', { prospect_id: id, from: prospect.status, to: newStage, reason });
  return json({ ok: true, prospect: saved });
}

export async function evaluateSupplierProspect(env, actor, id) {
  const prospect = await one(env, `/rest/v1/supplier_prospects?id=eq.${encodeURIComponent(id)}&select=*`);
  if (!prospect) return json({ ok: false, error: 'Not found' }, 404);

  // Get context for priority scoring
  const gaps = await rest(env, `/rest/v1/supplier_gaps?resolved_at=is.null&category=eq.${prospect.categories?.[0] || ''}&emirate=eq.${prospect.emirate || ''}&select=gap_severity`);
  const gapSeverity = gaps.length ? Math.max(...gaps.map(g => ['low','moderate','high','critical'].indexOf(g.gap_severity))) : 0;
  const severityLabels = ['low','moderate','high','critical'];

  const evaluation = evaluateProspect(prospect, {
    categoryDemand: 1,
    emirateDemand: 1,
    gapSeverity: severityLabels[gapSeverity] || 'low'
  });

  // Auto-update if stage should change
  if (evaluation.suggested_stage !== prospect.status && STAGE_TRANSITIONS[prospect.status]?.has(evaluation.suggested_stage)) {
    const updated = transitionStage(prospect, evaluation.suggested_stage, { reason: 'Auto-evaluation', actor: 'system' });
    await patch(env, 'supplier_prospects', `id=eq.${encodeURIComponent(id)}`, updated);
  }

  return json({ ok: true, evaluation });
}

export async function createSupplierOutreach(request, env, actor) {
  const body = await readJson(request);
  const { prospect_id, stage, channel, automation_level, variables } = body;

  const prospect = await one(env, `/rest/v1/supplier_prospects?id=eq.${encodeURIComponent(prospect_id)}&select=*`);
  if (!prospect) return json({ ok: false, error: 'Prospect not found' }, 404);

  const vars = {
    contact_name: prospect.contact_name || 'Procurement Team',
    company_name: prospect.company_name,
    categories: prospect.categories?.join(', ') || '',
    emirate: prospect.emirate,
    registration_link: buildRegistrationLink(prospect_id, env.PLATFORM_BASE_URL),
    ...variables
  };

  const outreachProvider = createOutreachProvider(env);
  const template = outreachProvider.getTemplate(channel, stage);
  
  if (!template) {
    return json({ ok: false, error: `No active template for stage ${stage} channel ${channel}` });
  }

  const rendered = renderTemplate(template, vars);
  const outreach = {
    prospect_id: prospect_id,
    channel,
    direction: 'outbound',
    template_id: template.id,
    subject: rendered.subject,
    body: rendered.body,
    sent_at: new Date().toISOString(),
    automation_level: automation_level || 2,
    triggered_by: actor.userId,
    metadata: { stage, variables: vars }
  };

  const saved = await insertOutreach(env, outreach);
  
  // If automation level allows, send immediately
  if (automation_level >= 3) {
    const outreachProvider = createOutreachProvider(env);
    const result = await outreachProvider.send({
      channel,
      to: channel === 'whatsapp' ? vars.contact_phone : vars.contact_email,
      subject: rendered.subject,
      body: rendered.body,
      templateId: template.id,
      variables: vars
    });
    
    if (result.sent) {
      await updateOutreach(env, saved.id, { 
        delivered_at: new Date().toISOString(),
        metadata: { ...outreach.metadata, provider_response: result.providerResponse, send_status: result.status }
      });
    }
  }

  return json({ ok: true, outreach: saved });
}

export async function sendSupplierOutreach(env, actor, outreachId) {
  const outreachProvider = createOutreachProvider(env);
  const result = await sendOutreach({ env, outreachId, provider: outreachProvider });
  return json(result);
}

export async function scheduleSupplierFollowups(request, env, actor, prospectId) {
  const body = await readJson(request);
  const { start_stage, channel, automation_level } = body;

  const prospect = await one(env, `/rest/v1/supplier_prospects?id=eq.${encodeURIComponent(prospectId)}&select=*`);
  if (!prospect) return json({ ok: false, error: 'Prospect not found' }, 404);

  const vars = {
    contact_name: prospect.contact_name || 'Procurement Team',
    company_name: prospect.company_name,
    categories: prospect.categories?.join(', ') || '',
    emirate: prospect.emirate,
    registration_link: buildRegistrationLink(prospectId, env.PLATFORM_BASE_URL)
  };

  const result = await scheduleFollowups({
    env,
    prospectId,
    startStage: start_stage || 'initial_contact',
    channel: channel || 'email',
    automationLevel: automation_level || 2,
    variables: vars
  });

  return json(result);
}

export async function getSupplierOutreachHistory(env, actor, prospectId) {
  const history = await rest(env, `/rest/v1/supplier_outreach?prospect_id=eq.${encodeURIComponent(prospectId)}&order=sent_at.desc&select=*`);
  return json({ ok: true, history });
}

export async function triggerGapDiscovery(request, env, actor) {
  const body = await readJson(request);
  const { rfq_id } = body;

  const rfq = await one(env, `/rest/v1/rfqs?id=eq.${encodeURIComponent(rfq_id)}&select=*`);
  if (!rfq) return json({ ok: false, error: 'RFQ not found' }, 404);

  const matched = await rest(env, `/rest/v1/rfq_invitations?rfq_id=eq.${encodeURIComponent(rfq_id)}&status=in.(invited,viewed,quoted)&select=vendor_user_id`);
  const invited = matched;
  const responded = await rest(env, `/rest/v1/quotations?rfq_id=eq.${encodeURIComponent(rfq_id)}&status=in.(submitted,review,selected)&select=vendor_user_id`);

  const result = await analyzeRfqGap({ env, rfqId: rfq_id, matchedVendors: matched, invitedVendors: invited, respondedVendors: responded });
  return json(result);
}

export async function getGapStats(env, actor) {
  const result = await getGapStatsImpl({ env });
  return json(result);
}

export async function getSupplierGaps(env, actor, searchParams) {
  let path = `/rest/v1/supplier_gaps?resolved_at=is.null&order=gap_severity.desc,created_at.desc&select=*`;
  const severity = searchParams.get('severity');
  if (severity) path += `&gap_severity=eq.${severity}`;
  const category = searchParams.get('category');
  if (category) path += `&category=eq.${category}`;

  const gaps = await rest(env, path);
  return json({ ok: true, gaps });
}

export async function resolveSupplierGap(request, env, actor, id) {
  const body = await readJson(request);
  const result = await resolveGap({ env, gapId: id, resolvedBy: actor.userId, note: clean(body.note, 1000) });
  return json({ ok: true, gap: result });
}

export async function createDiscoveryJob(request, env, actor) {
  const body = await readJson(request);
  const job = {
    job_type: clean(body.job_type, 40),
    trigger_rfq_id: body.trigger_rfq_id || null,
    trigger_gap_id: body.trigger_gap_id || null,
    parameters: body.parameters || {}
  };

  const saved = await insert(env, 'supplier_discovery_jobs', { ...job, status: 'pending', created_at: new Date().toISOString() });
  return json({ ok: true, job: saved }, 201);
}

export async function getDiscoveryJobs(env, actor, searchParams) {
  let path = `/rest/v1/supplier_discovery_jobs?order=created_at.desc&select=*`;
  const status = searchParams.get('status');
  if (status) path += `&status=eq.${status}`;
  const type = searchParams.get('type');
  if (type) path += `&job_type=eq.${type}`;

  const jobs = await rest(env, path);
  return json({ ok: true, jobs });
}

export async function getSupplierPerformance(env, actor, vendorId) {
  const result = await getVendorPerformanceSummary({ env, vendorId });
  return json(result);
}

export async function getTopVendorsByCategory(env, actor, searchParams) {
  const category = searchParams.get('category');
  const emirate = searchParams.get('emirate');
  const limit = parseInt(searchParams.get('limit') || '10');
  const minScore = parseInt(searchParams.get('min_score') || '60');

  if (!category) return json({ ok: false, error: 'Category required' }, 400);

  const result = await getTopVendors({ env, category, emirate, limit, minScore });
  return json(result);
}

export async function recordQuotationPerformance(request, env, actor) {
  const body = await readJson(request);
  const { rfq_id, vendor_id, quotation_id, metrics } = body;

  const result = await recQuotationPerf({
    env, rfqId: rfq_id, vendorId: vendor_id, quotationId: quotation_id,
    metrics: { ...metrics, recorded_by: actor.userId }
  });

  return json({ ok: true, performance: result });
}

export async function recordProjectPerformance(request, env, actor) {
  const body = await readJson(request);
  const { rfq_id, vendor_id, award_id, metrics } = body;

  const result = await recProjectPerf({
    env, rfqId: rfq_id, vendorId: vendor_id, awardId: award_id,
    metrics: { ...metrics, recorded_by: actor.userId }
  });

  return json({ ok: true, performance: result });
}

// Negotiation handlers
export async function initiateNegotiation(request, env, actor) {
  const body = await readJson(request);
  const { rfq_id, quotation_id, terms, expires_in_days } = body;

  const result = await initNegotiation({ env, rfqId: rfq_id, quotationId: quotation_id, actor, terms, expiresInDays: expires_in_days });
  return json(result);
}

export async function respondToNegotiation(request, env, actor, negotiationId) {
  const body = await readJson(request);
  const { response, new_terms, note } = body;

  const result = await respNegotiation({ env, negotiationId, actor, response, newTerms: new_terms, note });
  return json(result);
}

export async function getNegotiationHistory(env, actor, searchParams) {
  const rfqId = searchParams.get('rfq_id');
  if (!rfqId) return json({ ok: false, error: 'rfq_id required' }, 400);

  const history = await getNegHistory({ env, rfqId });
  return json({ ok: true, history });
}

// Resilience handlers
export async function getScheduledJobs(env, actor, searchParams) {
  let path = `/rest/v1/scheduled_jobs?order=scheduled_at.asc&select=*`;
  const status = searchParams.get('status');
  if (status) path += `&status=eq.${status}`;
  const type = searchParams.get('type');
  if (type) path += `&job_type=eq.${type}`;

  const jobs = await rest(env, path);
  return json({ ok: true, jobs });
}

export async function processScheduledJobsNow(request, env, actor) {
  const body = await readJson(request);
  const { job_types } = body;

  // Mock processor for testing
  const mockProcessor = async (job) => {
    console.log('Processing job:', job.id, job.job_type);
  };

  const results = await processScheduledJobs({ env, jobTypes: job_types, processor: mockProcessor });
  return json({ ok: true, processed: results.length, results });
}

export async function getDeadLetters(env, actor, searchParams) {
  let path = `/rest/v1/dead_letters?order=failed_at.desc&select=*`;
  const type = searchParams.get('type');
  if (type) path += `&job_type=eq.${type}`;
  const limit = searchParams.get('limit') || '50';
  path += `&limit=${limit}`;

  const letters = await rest(env, path);
  return json({ ok: true, dead_letters: letters });
}

export async function requeueDeadLetterHandler(request, env, actor, id) {
  const body = await readJson(request);
  const { new_job_type } = body;

  const result = await requeueDL({ env, deadLetterId: id, newJobType: new_job_type });
  return json(result);
}

export async function getCircuitBreakerStatus(env, actor) {
  const status = getBreakerStatus();
  return json({ ok: true, circuit_breakers: status });
}

async function audit(env, actor, rfqId, eventType, details) {
  return insert(env, 'procurement_audit_events', { rfq_id: rfqId, actor_user_id: actor.userId, actor_role: actor.role, event_type: eventType, details });
}
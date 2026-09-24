import {
  createSupplierProspect,
  getSupplierProspects,
  getSupplierProspect,
  updateSupplierProspect,
  transitionSupplierStage,
  evaluateSupplierProspect,
  createSupplierOutreach,
  sendSupplierOutreach,
  scheduleSupplierFollowups,
  getSupplierOutreachHistory,
  triggerGapDiscovery,
  getSupplierGaps,
  getGapStats,
  resolveSupplierGap,
  createDiscoveryJob,
  getDiscoveryJobs,
  getSupplierPerformance,
  getTopVendorsByCategory,
  recordQuotationPerformance,
  recordProjectPerformance,
  initiateNegotiation,
  respondToNegotiation,
  getNegotiationHistory,
  getScheduledJobs,
  processScheduledJobsNow,
  getDeadLetters,
  requeueDeadLetterHandler as requeueDeadLetter,
  getCircuitBreakerStatus
} from './desk-supplier.js';

export async function handleSupplierApi(request, env = {}) {
  if (!env.SUPABASE_URL || !(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY)) {
    return json({ ok: false, error: 'Supplier API not configured' }, 503);
  }
  const actor = await requireIdentity(request, env);
  if (!actor.ok) return json({ ok: false, error: actor.error }, actor.status);

  const url = new URL(request.url);
  try {
    // Supplier Prospects
    if (request.method === 'POST' && url.pathname === '/api/supplier/prospects') {
      return actor.role === 'admin' ? await createSupplierProspect(request, env, actor) : denied();
    }
    if (request.method === 'GET' && url.pathname === '/api/supplier/prospects') {
      return actor.role === 'admin' ? await getSupplierProspects(env, actor, url.searchParams) : denied();
    }
    const prospectMatch = url.pathname.match(/^\/api\/supplier\/prospects\/([^/]+)$/);
    if (request.method === 'GET' && prospectMatch) {
      return actor.role === 'admin' ? await getSupplierProspect(env, actor, decodeURIComponent(prospectMatch[1])) : denied();
    }
    if (request.method === 'PATCH' && prospectMatch) {
      return actor.role === 'admin' ? await updateSupplierProspect(request, env, actor, decodeURIComponent(prospectMatch[1])) : denied();
    }
    const stageMatch = url.pathname.match(/^\/api\/supplier\/prospects\/([^/]+)\/stage$/);
    if (request.method === 'POST' && stageMatch) {
      return actor.role === 'admin' ? await transitionSupplierStage(request, env, actor, decodeURIComponent(stageMatch[1])) : denied();
    }
    const evalMatch = url.pathname.match(/^\/api\/supplier\/prospects\/([^/]+)\/evaluate$/);
    if (request.method === 'POST' && evalMatch) {
      return actor.role === 'admin' ? await evaluateSupplierProspect(env, actor, decodeURIComponent(evalMatch[1])) : denied();
    }

    // Supplier Outreach
    if (request.method === 'POST' && url.pathname === '/api/supplier/outreach') {
      return actor.role === 'admin' ? await createSupplierOutreach(request, env, actor) : denied();
    }
    const outreachSendMatch = url.pathname.match(/^\/api\/supplier\/outreach\/([^/]+)\/send$/);
    if (request.method === 'POST' && outreachSendMatch) {
      return actor.role === 'admin' ? await sendSupplierOutreach(env, actor, decodeURIComponent(outreachSendMatch[1])) : denied();
    }
    const outreachScheduleMatch = url.pathname.match(/^\/api\/supplier\/prospects\/([^/]+)\/followups$/);
    if (request.method === 'POST' && outreachScheduleMatch) {
      return actor.role === 'admin' ? await scheduleSupplierFollowups(request, env, actor, decodeURIComponent(outreachScheduleMatch[1])) : denied();
    }
    const outreachHistoryMatch = url.pathname.match(/^\/api\/supplier\/prospects\/([^/]+)\/outreach$/);
    if (request.method === 'GET' && outreachHistoryMatch) {
      return actor.role === 'admin' ? await getSupplierOutreachHistory(env, actor, decodeURIComponent(outreachHistoryMatch[1])) : denied();
    }

    // Supplier Gap Detection
    if (request.method === 'POST' && url.pathname === '/api/supplier/gaps/trigger') {
      return actor.role === 'admin' ? await triggerGapDiscovery(request, env, actor) : denied();
    }
    if (request.method === 'GET' && url.pathname === '/api/supplier/gaps') {
      return actor.role === 'admin' ? await getSupplierGaps(env, actor, url.searchParams) : denied();
    }
    if (request.method === 'GET' && url.pathname === '/api/supplier/gaps/stats') {
      return actor.role === 'admin' ? await getGapStats(env, actor) : denied();
    }
    const gapResolveMatch = url.pathname.match(/^\/api\/supplier\/gaps\/([^/]+)\/resolve$/);
    if (request.method === 'POST' && gapResolveMatch) {
      return actor.role === 'admin' ? await resolveSupplierGap(request, env, actor, decodeURIComponent(gapResolveMatch[1])) : denied();
    }

    // Discovery Jobs
    if (request.method === 'POST' && url.pathname === '/api/supplier/discovery-jobs') {
      return actor.role === 'admin' ? await createDiscoveryJob(request, env, actor) : denied();
    }
    if (request.method === 'GET' && url.pathname === '/api/supplier/discovery-jobs') {
      return actor.role === 'admin' ? await getDiscoveryJobs(env, actor, url.searchParams) : denied();
    }

    // Supplier Performance
    const perfMatch = url.pathname.match(/^\/api\/supplier\/performance\/([^/]+)$/);
    if (request.method === 'GET' && perfMatch) {
      return actor.role === 'admin' ? await getSupplierPerformance(env, actor, decodeURIComponent(perfMatch[1])) : denied();
    }
    if (request.method === 'GET' && url.pathname === '/api/supplier/performance/top') {
      return actor.role === 'admin' ? await getTopVendorsByCategory(env, actor, url.searchParams) : denied();
    }
    if (request.method === 'POST' && url.pathname === '/api/supplier/performance/quotation') {
      return actor.role === 'admin' ? await recordQuotationPerformance(request, env, actor) : denied();
    }
    if (request.method === 'POST' && url.pathname === '/api/supplier/performance/project') {
      return actor.role === 'admin' ? await recordProjectPerformance(request, env, actor) : denied();
    }

    // Negotiation
    if (request.method === 'POST' && url.pathname === '/api/supplier/negotiation') {
      return ['client', 'admin'].includes(actor.role) ? await initiateNegotiation(request, env, actor) : denied();
    }
    const negRespMatch = url.pathname.match(/^\/api\/supplier\/negotiation\/([^/]+)\/respond$/);
    if (request.method === 'POST' && negRespMatch) {
      return ['client', 'vendor', 'admin'].includes(actor.role) ? await respondToNegotiation(request, env, actor, decodeURIComponent(negRespMatch[1])) : denied();
    }
    if (request.method === 'GET' && url.pathname === '/api/supplier/negotiation/history') {
      return actor.role === 'admin' ? await getNegotiationHistory(env, actor, url.searchParams) : denied();
    }

    // Resilience / Scheduled Jobs
    if (request.method === 'GET' && url.pathname === '/api/supplier/scheduled-jobs') {
      return actor.role === 'admin' ? await getScheduledJobs(env, actor, url.searchParams) : denied();
    }
    if (request.method === 'POST' && url.pathname === '/api/supplier/scheduled-jobs/process') {
      return actor.role === 'admin' ? await processScheduledJobsNow(request, env, actor) : denied();
    }
    if (request.method === 'GET' && url.pathname === '/api/supplier/dead-letters') {
      return actor.role === 'admin' ? await getDeadLetters(env, actor, url.searchParams) : denied();
    }
    const dlRequeueMatch = url.pathname.match(/^\/api\/supplier\/dead-letters\/([^/]+)\/requeue$/);
    if (request.method === 'POST' && dlRequeueMatch) {
      return actor.role === 'admin' ? await requeueDeadLetterHandler(request, env, actor, decodeURIComponent(dlRequeueMatch[1])) : denied();
    }
    if (request.method === 'GET' && url.pathname === '/api/supplier/circuit-breakers') {
      return actor.role === 'admin' ? await getCircuitBreakerStatus(env, actor) : denied();
    }
  } catch (error) {
    return json({ ok: false, error: error?.message || 'Supplier API request failed' }, error?.status || 400);
  }
  return json({ ok: false, error: 'Not found' }, 404);
}

import { requireIdentity } from '../auth/identity.js';
import { denied, json } from './desk-shared.js';
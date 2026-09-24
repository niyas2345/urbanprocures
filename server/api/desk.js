import { requireIdentity } from '../auth/identity.js';
import {
  bootstrap,
  saveClientProfile,
  saveVendorProfile,
  createRfq,
  issueWorkPack,
  processRfq,
  updateRfqStatus,
  matchVendors,
  inviteVendor,
  saveStructuredQuote,
  declineInvitation,
  createClarification,
  answerClarification,
  awardQuotation,
  updateVendorStatus,
  downloadPrivateDocument,
  markNotificationsRead,
} from './desk-impl.js';
import { denied, json } from './desk-shared.js';

export async function handleDeskApi(request, env = {}) {
  if (!env.SUPABASE_URL || !(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY)) {
    return json({ ok: false, error: 'Persistent desk is not configured' }, 503);
  }
  const actor = await requireIdentity(request, env);
  if (!actor.ok) return json({ ok: false, error: actor.error }, actor.status);

  const url = new URL(request.url);
  try {
    if (request.method === 'GET' && url.pathname === '/api/desk/bootstrap') {
      return json(await bootstrap(env, actor));
    }
    if (request.method === 'POST' && url.pathname === '/api/desk/client-profile') {
      return actor.role === 'client' ? await saveClientProfile(request, env, actor) : denied();
    }
    if (request.method === 'POST' && url.pathname === '/api/desk/vendor-profile') {
      return actor.role === 'vendor' ? await saveVendorProfile(request, env, actor) : denied();
    }
    if (request.method === 'POST' && url.pathname === '/api/desk/rfqs') {
      return actor.role === 'client' ? await createRfq(request, env, actor) : denied();
    }

    const issueMatch = url.pathname.match(/^\/api\/desk\/rfqs\/([^/]+)\/issue$/);
    if (request.method === 'POST' && issueMatch) {
      return actor.role === 'admin' ? await issueWorkPack(env, actor, decodeURIComponent(issueMatch[1])) : denied();
    }

    const processMatch = url.pathname.match(/^\/api\/desk\/rfqs\/([^/]+)\/process$/);
    if (request.method === 'POST' && processMatch) {
      return await processRfq(env, actor, decodeURIComponent(processMatch[1]));
    }
    const statusMatch = url.pathname.match(/^\/api\/desk\/rfqs\/([^/]+)\/status$/);
    if (request.method === 'POST' && statusMatch) {
      return actor.role === 'admin' ? await updateRfqStatus(request, env, actor, decodeURIComponent(statusMatch[1])) : denied();
    }
    const matchingMatch = url.pathname.match(/^\/api\/desk\/rfqs\/([^/]+)\/match$/);
    if (request.method === 'POST' && matchingMatch) {
      return actor.role === 'admin' ? await matchVendors(env, actor, decodeURIComponent(matchingMatch[1])) : denied();
    }
    const inviteMatch = url.pathname.match(/^\/api\/desk\/rfqs\/([^/]+)\/invite$/);
    if (request.method === 'POST' && inviteMatch) {
      return actor.role === 'admin' ? await inviteVendor(request, env, actor, decodeURIComponent(inviteMatch[1])) : denied();
    }
    const quoteMatch = url.pathname.match(/^\/api\/desk\/rfqs\/([^/]+)\/quote$/);
    if (request.method === 'POST' && quoteMatch) {
      return actor.role === 'vendor' ? await saveStructuredQuote(request, env, actor, decodeURIComponent(quoteMatch[1])) : denied();
    }
    const declineMatch = url.pathname.match(/^\/api\/desk\/rfqs\/([^/]+)\/decline$/);
    if (request.method === 'POST' && declineMatch) {
      return actor.role === 'vendor' ? await declineInvitation(request, env, actor, decodeURIComponent(declineMatch[1])) : denied();
    }
    const clarificationMatch = url.pathname.match(/^\/api\/desk\/rfqs\/([^/]+)\/clarifications$/);
    if (request.method === 'POST' && clarificationMatch) {
      return actor.role === 'vendor' ? await createClarification(request, env, actor, decodeURIComponent(clarificationMatch[1])) : denied();
    }
    const answerMatch = url.pathname.match(/^\/api\/desk\/clarifications\/([^/]+)$/);
    if (request.method === 'PATCH' && answerMatch) {
      return ['client', 'admin'].includes(actor.role) ? await answerClarification(request, env, actor, decodeURIComponent(answerMatch[1])) : denied();
    }
    const awardMatch = url.pathname.match(/^\/api\/desk\/rfqs\/([^/]+)\/award$/);
    if (request.method === 'POST' && awardMatch) {
      return ['client', 'admin'].includes(actor.role) ? await awardQuotation(request, env, actor, decodeURIComponent(awardMatch[1])) : denied();
    }
    const verifyMatch = url.pathname.match(/^\/api\/desk\/vendors\/([^/]+)\/status$/);
    if (request.method === 'POST' && verifyMatch) {
      return actor.role === 'admin' ? await updateVendorStatus(request, env, actor, decodeURIComponent(verifyMatch[1])) : denied();
    }
    const documentMatch = url.pathname.match(/^\/api\/desk\/documents\/(rfq|quote)\/([^/]+)$/);
    if (request.method === 'GET' && documentMatch) {
      return await downloadPrivateDocument(env, actor, documentMatch[1], decodeURIComponent(documentMatch[2]));
    }
    if (request.method === 'POST' && url.pathname === '/api/desk/notifications/read') {
      return await markNotificationsRead(env, actor);
    }
  } catch (error) {
    return json({ ok: false, error: error?.message || 'Persistent desk request failed' }, error?.status || 400);
  }
  return json({ ok: false, error: 'Not found' }, 404);
}

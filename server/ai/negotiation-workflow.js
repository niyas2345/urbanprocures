/**
 * Negotiation Workflow with Audit Trail
 * Post-comparison, pre-award negotiation with full audit logging
 */

export const NEGOTIATION_STAGES = Object.freeze([
  'initiated',
  'vendor_responded',
  'client_countered',
  'vendor_accepted',
  'vendor_declined',
  'client_accepted',
  'client_declined',
  'expired',
  'withdrawn',
  'awarded'
]);

export const NEGOTIATION_TRANSITIONS = Object.freeze({
  initiated: new Set(['vendor_responded', 'expired', 'withdrawn']),
  vendor_responded: new Set(['client_countered', 'client_accepted', 'client_declined', 'expired']),
  client_countered: new Set(['vendor_accepted', 'vendor_declined', 'expired']),
  vendor_accepted: new Set(['awarded', 'client_declined']),
  vendor_declined: new Set(['client_countered', 'withdrawn']),
  client_accepted: new Set(['awarded']),
  client_declined: new Set(['withdrawn']),
  expired: new Set(),
  withdrawn: new Set(),
  awarded: new Set()
});

export async function initiateNegotiation({ env, rfqId, quotationId, actor, terms, expiresInDays = 7 }) {
  const rfq = await getRfq(env, rfqId);
  if (!rfq) return { ok: false, error: 'RFQ not found' };

  const quotation = await getQuotation(env, quotationId);
  if (!quotation) return { ok: false, error: 'Quotation not found' };
  if (quotation.rfq_id !== rfqId) return { ok: false, error: 'Quotation does not belong to RFQ' };

  // Check if negotiation already exists
  const existing = await getActiveNegotiation(env, rfqId);
  if (existing) return { ok: false, error: 'Negotiation already in progress', negotiation: existing };

  const negotiation = {
    rfq_id: rfqId,
    quotation_id: quotationId,
    vendor_user_id: quotation.vendor_user_id,
    client_user_id: rfq.client_id,
    stage: 'initiated',
    terms: JSON.stringify(terms),
    current_terms: JSON.stringify(terms),
    round: 1,
    initiated_by: actor.userId,
    initiated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString(),
    status: 'active'
  };

  const saved = await insertNegotiation(env, negotiation);

  await audit(env, actor, rfqId, 'negotiation_initiated', {
    negotiation_id: saved.id,
    quotation_id: quotationId,
    terms
  });

  await notify(env, {
    userId: quotation.vendor_user_id,
    role: 'vendor',
    rfqId,
    eventType: 'negotiation_initiated',
    message: `Negotiation started for RFQ ${rfqId}`
  });

  return { ok: true, negotiation: saved };
}

export async function respondToNegotiation({ env, negotiationId, actor, response, newTerms, note }) {
  const negotiation = await getNegotiation(env, negotiationId);
  if (!negotiation) return { ok: false, error: 'Negotiation not found' };
  if (negotiation.status !== 'active') return { ok: false, error: 'Negotiation not active' };
  if (new Date(negotiation.expires_at) < new Date()) {
    await expireNegotiation(env, negotiationId);
    return { ok: false, error: 'Negotiation expired' };
  }

  // Verify actor is participant
  const isVendor = actor.userId === negotiation.vendor_user_id;
  const isClient = actor.userId === negotiation.client_user_id;
  if (!isVendor && !isClient && actor.role !== 'admin') {
    return { ok: false, error: 'Not authorized' };
  }

  const validTransitions = NEGOTIATION_TRANSITIONS[negotiation.stage];
  if (!validTransitions?.has(response)) {
    return { ok: false, error: `Invalid response ${response} for stage ${negotiation.stage}` };
  }

  const updates = {
    stage: response,
    updated_at: new Date().toISOString()
  };

  if (newTerms) {
    updates.current_terms = JSON.stringify(newTerms);
    updates.round = Number(negotiation.round) + 1;
  }

  if (note) {
    updates.notes = (negotiation.notes || '') + `\n[${new Date().toISOString()}] ${actor.role}: ${note}`;
  }

  const updated = await updateNegotiation(env, negotiationId, updates);

  await audit(env, actor, negotiation.rfq_id, 'negotiation_updated', {
    negotiation_id: negotiationId,
    from_stage: negotiation.stage,
    to_stage: response,
    terms_changed: !!newTerms,
    round: updated.round
  });

  // Notify other party
  const otherPartyId = isVendor ? negotiation.client_user_id : negotiation.vendor_user_id;
  const otherRole = isVendor ? 'client' : 'vendor';
  await notify(env, {
    userId: otherPartyId,
    role: otherRole,
    rfqId: negotiation.rfq_id,
    eventType: 'negotiation_updated',
    message: `Negotiation updated for RFQ ${negotiation.rfq_id}`
  });

  // Check if negotiation concluded
  if (['vendor_accepted', 'client_accepted'].includes(response)) {
    await concludeNegotiation(env, negotiationId, actor);
  }

  return { ok: true, negotiation: updated };
}

export async function concludeNegotiation(env, negotiationId, actor) {
  const negotiation = await getNegotiation(env, negotiationId);
  if (!negotiation) return { ok: false, error: 'Not found' };

  const finalTerms = JSON.parse(negotiation.current_terms || negotiation.terms);

  // Update quotation with negotiated terms
  await updateQuotation(env, negotiation.quotation_id, {
    ...finalTerms,
    status: 'negotiated',
    negotiated_at: new Date().toISOString(),
    negotiated_by: actor.userId
  });

  // Mark negotiation as awarded
  await updateNegotiation(env, negotiationId, {
    stage: 'awarded',
    status: 'concluded',
    concluded_at: new Date().toISOString(),
    concluded_by: actor.userId
  });

  await audit(env, actor, negotiation.rfq_id, 'negotiation_concluded', {
    negotiation_id: negotiationId,
    final_terms: finalTerms
  });

  return { ok: true, negotiation: await getNegotiation(env, negotiationId) };
}

export async function expireNegotiation(env, negotiationId) {
  return updateNegotiation(env, negotiationId, {
    stage: 'expired',
    status: 'concluded',
    concluded_at: new Date().toISOString()
  });
}

export async function getNegotiationHistory({ env, rfqId }) {
  return rest(env, `/rest/v1/negotiations?rfq_id=eq.${encodeURIComponent(rfqId)}&order=created_at.desc&select=*`);
}

export async function getNegotiationAudit({ env, negotiationId }) {
  return rest(env, `/rest/v1/procurement_audit_events?rfq_id=eq.${encodeURIComponent(negotiationId)}&event_type=like.negotiation*&order=created_at.desc&select=*`);
}

// Database helpers
async function getRfq(env, id) {
  return one(env, `/rest/v1/rfqs?id=eq.${encodeURIComponent(id)}&select=*`);
}

async function getQuotation(env, id) {
  return one(env, `/rest/v1/quotations?id=eq.${encodeURIComponent(id)}&select=*`);
}

async function getActiveNegotiation(env, rfqId) {
  return one(env, `/rest/v1/negotiations?rfq_id=eq.${encodeURIComponent(rfqId)}&status=eq.active&select=*`);
}

async function getNegotiation(env, id) {
  return one(env, `/rest/v1/negotiations?id=eq.${encodeURIComponent(id)}&select=*`);
}

async function insertNegotiation(env, negotiation) {
  return insert(env, 'negotiations', negotiation);
}

async function updateNegotiation(env, id, changes) {
  return patch(env, 'negotiations', `id=eq.${encodeURIComponent(id)}`, changes);
}

async function updateQuotation(env, id, changes) {
  return patch(env, 'quotations', `id=eq.${encodeURIComponent(id)}`, changes);
}

async function notify(env, { userId, role, rfqId, eventType, message }) {
  return insert(env, 'procurement_notifications', { user_id: userId, role, rfq_id: rfqId, event_type: eventType, message });
}

async function audit(env, actor, rfqId, eventType, details) {
  return insert(env, 'procurement_audit_events', { rfq_id: rfqId, actor_user_id: actor.userId, actor_role: actor.role, event_type: eventType, details });
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
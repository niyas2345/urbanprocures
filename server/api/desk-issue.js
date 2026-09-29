import { buildSanitizedVendorRfq, assertVendorSafeArtifact } from '../ai/sanitized-rfq.js';
import { scanIdentityLeakage } from '../ai/identity-scan.js';
import { processPersistentDocumentJob } from '../jobs/supabase-job-processor.js';
import {
  mapQuotes, anonymousQuote, mapDocuments, vendorSafeRow, scoreVendor, mergeExtractions, documentStatus,
  assertRfqOwner, getRfq, redactIdentityTerms, guestIdentityTerms, collectClientIdentityTerms,
  notify, audit, rest, one, insert, upsert, patch, params, inFilter, encodePath,
  clean, list, nullableNumber, positiveInt, readJson, denied, forbidden, notFound, json,
  safeDisposition, adminHeaders
} from './desk-shared.js';

const RFQ_STATUSES = new Set(['Submitted', 'Under Review', 'Matching', 'Quoting', 'Comparing', 'Awarded', 'Closed', 'Withdrawn']);
const TRANSITIONS = {
  Submitted: new Set(['Under Review', 'Withdrawn']),
  'Under Review': new Set(['Matching', 'Withdrawn']),
  Matching: new Set(['Quoting', 'Under Review', 'Withdrawn']),
  Quoting: new Set(['Comparing', 'Closed']),
  Comparing: new Set(['Quoting', 'Closed']),
  Awarded: new Set(['Closed']),
  Closed: new Set(),
  Withdrawn: new Set(),
};

export async function issueWorkPack(env, actor, rfqId) {
  const rfq = await getRfq(env, rfqId);
  if (!rfq) throw notFound('RFQ not found');
  let artifact = rfq.sanitized_payload;
  if (!rfq.sanitized_ready || !artifact) {
    const identityTerms = [...await collectClientIdentityTerms(env, rfq), ...guestIdentityTerms(rfq)];
    const scopeText = redactIdentityTerms(clean(rfq.scope, 20000) || clean(rfq.title, 220), identityTerms);
    const safeTitle = redactIdentityTerms(clean(rfq.title, 220), identityTerms) || clean(rfq.category, 120);
    if (!scopeText && !safeTitle) {
      await patch(env, 'rfqs', `id=eq.${encodeURIComponent(rfqId)}`, { sanitized_ready: false, review_state: 'human_review_required' });
      return json({
        ok: false,
        error: 'review_required',
        message: 'This RFQ has no work description to issue. Add a scope on the desk first.',
        reasons: ['no_scope_text']
      }, 409);
    }
    const fallbackExtraction = { text: scopeText || safeTitle, items: [], fields: {}, requires_human_review: false, status: 'ready' };
    const built = buildSanitizedVendorRfq({
      rfqId,
      extraction: fallbackExtraction,
      input: { category: rfq.category, title: safeTitle, location: rfq.emirate, identity_terms: identityTerms },
      sourceDocumentId: null
    });
    if (!built.artifact) {
      await patch(env, 'rfqs', `id=eq.${encodeURIComponent(rfqId)}`, { sanitized_ready: false, review_state: 'human_review_required' });
      return json({
        ok: false,
        error: 'review_required',
        message: 'Identity is still in the work text after redaction. Edit the scope, then issue again.',
        reasons: built.reasons && built.reasons.length ? built.reasons : ['identity_leakage']
      }, 409);
    }
    assertVendorSafeArtifact(built.artifact);
    artifact = built.artifact;
  }
  await patch(env, 'rfqs', `id=eq.${encodeURIComponent(rfqId)}`, {
    sanitized_payload: artifact,
    sanitized_ready: true,
    published_at: new Date().toISOString(),
    status: 'Quoting',
    review_state: 'published'
  });
  const vendors = await rest(env, '/rest/v1/vendor_profiles?status=eq.verified&select=*');
  const matches = vendors
    .map((vendor) => scoreVendor(rfq, vendor))
    .filter((row) => row.score >= 40)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
  for (const match of matches) {
    await upsert(env, 'rfq_invitations', {
      rfq_id: rfqId,
      vendor_user_id: match.vendor.id,
      status: 'invited',
      match_score: match.score,
      match_reasons: match.reasons,
      invited_by: actor.userId,
      updated_at: new Date().toISOString()
    }, 'rfq_id,vendor_user_id');
    await notify(env, { userId: match.vendor.id, role: 'vendor', rfqId, eventType: 'rfq_invitation', message: `A matched ${rfq.category} RFQ is available` });
  }
  await Promise.all([
    notify(env, { userId: rfq.client_id, role: 'client', rfqId, eventType: 'rfq_published', message: `Work pack issued for ${rfqId}` }),
    audit(env, actor, rfqId, 'work_pack_issued', { invited: matches.length })
  ]);
  return json({ ok: true, rfq_id: rfqId, invited: matches.length, artifact });
}

export async function processRfq(env, actor, rfqId) {
  const rfq = await getRfq(env, rfqId);
  assertRfqOwner(rfq, actor);
  const jobs = await rest(env, `/rest/v1/document_processing_jobs?${params({ rfq_id: `eq.${rfqId}`, job_type: 'eq.extract', status: 'in.(pending,failed)', select: '*', order: 'created_at.asc' })}`);
  const results = [];
  for (const job of jobs) results.push(await processPersistentDocumentJob({ env, jobId: job.id }));
  const docs = await rest(env, `/rest/v1/rfq_documents?${params({ rfq_id: `eq.${rfqId}`, document_role: 'eq.source', select: '*' })}`);
  const blocked = docs.filter((row) => row.processing_status === 'blocked' || row.processing_status === 'failed' || row.requires_human_review);
  const ready = docs.filter((row) => row.processing_status === 'ready' && row.extraction);

  if (docs.length === 0) {
    const scopeText = clean(rfq.scope, 20000);
    const identityTerms = await collectClientIdentityTerms(env, rfq);
    const fallbackExtraction = { text: scopeText, items: [], fields: {}, requires_human_review: false, status: 'ready' };
    const built = buildSanitizedVendorRfq({ rfqId, extraction: fallbackExtraction, input: { category: rfq.category, title: rfq.title, location: rfq.emirate, identity_terms: identityTerms }, sourceDocumentId: null });
    const leaked = !built.ok || built.requires_human_review || scanIdentityLeakage(built.artifact, identityTerms).leaked;
    if (!scopeText || leaked) {
      await patch(env, 'rfqs', `id=eq.${encodeURIComponent(rfqId)}`, { sanitized_ready: false, review_state: 'human_review_required' });
      return json({ ok: false, error: 'review_required', reasons: scopeText ? (built.reasons && built.reasons.length ? built.reasons : ['identity_leakage']) : ['no_scope_text'], results }, 409);
    }
    assertVendorSafeArtifact(built.artifact);
    await patch(env, 'rfqs', `id=eq.${encodeURIComponent(rfqId)}`, { sanitized_payload: built.artifact, sanitized_ready: true, review_state: 'ready_for_review' });
    await audit(env, actor, rfqId, 'rfq_sanitized', { document_count: 0, source: 'description_only' });
    return json({ ok: true, sanitized: true, artifact: built.artifact });
  }

  if (blocked.length || ready.length !== docs.length) {
    await patch(env, 'rfqs', `id=eq.${encodeURIComponent(rfqId)}`, { sanitized_ready: false, review_state: blocked.length ? 'human_review_required' : 'processing' });
    return json({ ok: false, error: 'review_required', documents: docs.map(documentStatus), results }, 409);
  }
  const extraction = mergeExtractions(ready.map((row) => row.extraction));
  const built = buildSanitizedVendorRfq({ rfqId, extraction, input: { category: rfq.category, title: rfq.title, location: rfq.emirate }, sourceDocumentId: ready[0].id });
  if (!built.ok || built.requires_human_review) {
    await patch(env, 'rfqs', `id=eq.${encodeURIComponent(rfqId)}`, { sanitized_ready: false, review_state: 'human_review_required' });
    return json({ ok: false, error: 'review_required', reasons: built.reasons || [] }, 409);
  }
  assertVendorSafeArtifact(built.artifact);
  if (scanIdentityLeakage(built.artifact).leaked) throw new Error('Identity leakage blocked publication');
  await patch(env, 'rfqs', `id=eq.${encodeURIComponent(rfqId)}`, { sanitized_payload: built.artifact, sanitized_ready: true, review_state: 'ready_for_review' });
  await audit(env, actor, rfqId, 'rfq_sanitized', { document_count: docs.length });
  return json({ ok: true, sanitized: true, artifact: built.artifact });
}

export async function updateRfqStatus(request, env, actor, rfqId) {
  const body = await readJson(request); const next = clean(body.status, 40);
  if (!RFQ_STATUSES.has(next)) throw new Error('Invalid RFQ status');
  const rfq = await getRfq(env, rfqId);
  if (!rfq) throw notFound('RFQ not found');
  if (!TRANSITIONS[rfq.status]?.has(next)) throw new Error(`Invalid transition from ${rfq.status} to ${next}`);
  if (next === 'Quoting' && !rfq.sanitized_ready) throw new Error('Sanitized RFQ review must pass before publication');
  const updated = await patch(env, 'rfqs', `id=eq.${encodeURIComponent(rfqId)}`, { status: next, published_at: next === 'Quoting' ? new Date().toISOString() : rfq.published_at });
  await Promise.all([
    notify(env, { userId: rfq.client_id, role: 'client', rfqId, eventType: 'rfq_status', message: `RFQ ${rfqId} moved to ${next}` }),
    audit(env, actor, rfqId, 'rfq_status_changed', { from: rfq.status, to: next }),
  ]);
  return json({ ok: true, rfq: updated });
}

export async function matchVendors(env, actor, rfqId) {
  const rfq = await getRfq(env, rfqId); if (!rfq) throw notFound('RFQ not found');
  const vendors = await rest(env, '/rest/v1/vendor_profiles?status=eq.verified&available=eq.true&select=*');
  const matches = vendors.map((vendor) => scoreVendor(rfq, vendor)).filter((row) => row.score >= 40).sort((a, b) => b.score - a.score).slice(0, 20);
  for (const match of matches) {
    await upsert(env, 'rfq_invitations', { rfq_id: rfqId, vendor_user_id: match.vendor.id, status: 'invited', match_score: match.score, match_reasons: match.reasons, invited_by: actor.userId, updated_at: new Date().toISOString() }, 'rfq_id,vendor_user_id');
    await notify(env, { userId: match.vendor.id, role: 'vendor', rfqId, eventType: 'rfq_invitation', message: `A matched ${rfq.category} RFQ is available` });
  }
  if (rfq.status === 'Under Review') await patch(env, 'rfqs', `id=eq.${encodeURIComponent(rfqId)}`, { status: 'Matching' });
  await audit(env, actor, rfqId, 'vendors_matched', { count: matches.length });
  return json({ ok: true, matches: matches.map(({ vendor, ...rest }) => ({ vendor_id: vendor.id, company_name: vendor.company_name, ...rest })) });
}

export async function inviteVendor(request, env, actor, rfqId) {
  const body = await readJson(request); const vendorId = clean(body.vendor_id, 80);
  const [rfq, vendor] = await Promise.all([getRfq(env, rfqId), one(env, `/rest/v1/vendor_profiles?${params({ id: `eq.${vendorId}`, status: 'eq.verified', select: '*' })}`)]);
  if (!rfq) throw notFound('RFQ not found');
  if (!vendor) throw new Error('Only verified vendors can be invited');
  const scored = scoreVendor(rfq, vendor);
  const invitation = await upsert(env, 'rfq_invitations', { rfq_id: rfqId, vendor_user_id: vendorId, status: 'invited', match_score: scored.score, match_reasons: scored.reasons, invited_by: actor.userId, updated_at: new Date().toISOString() }, 'rfq_id,vendor_user_id');
  await Promise.all([notify(env, { userId: vendorId, role: 'vendor', rfqId, eventType: 'rfq_invitation', message: `A matched ${rfq.category} RFQ is available` }), audit(env, actor, rfqId, 'vendor_invited', { vendor_id: vendorId })]);
  return json({ ok: true, invitation });
}

export async function saveStructuredQuote(request, env, actor, rfqId) {
  const body = await readJson(request); await assertVendorCanQuote(env, actor.userId, rfqId);
  const subtotal = nullableNumber(body.subtotal ?? body.amount); const vat = nullableNumber(body.vat);
  const total = nullableNumber(body.total ?? (subtotal === null ? null : subtotal + (vat || 0)));
  if (total === null || total <= 0) throw new Error('Quotation total must be greater than zero');
  const arithmeticValid = subtotal === null ? null : Math.abs((subtotal + (vat || 0)) - total) < 0.01;
  const comparisonFlags = arithmeticValid === false ? ['arithmetic_mismatch'] : [];
  const row = {
    rfq_id: rfqId, vendor_user_id: actor.userId, vendor_reference: clean(body.vendor_reference, 160),
    subtotal, vat, total, currency: clean(body.currency || 'AED', 8), validity_days: positiveInt(body.validity_days),
    completion_period: clean(body.completion_period || body.duration, 160), mobilization: clean(body.mobilization || body.mob, 160),
    warranty: clean(body.warranty, 240), inclusions: list(body.inclusions), exclusions: list(body.exclusions),
    deviations: list(body.deviations), payment_terms: clean(body.payment_terms || body.pay, 1000), notes: clean(body.notes || body.note, 5000),
    vat_included: Boolean(body.vat_included || body.vatInc === 'included'), arithmetic_valid: arithmeticValid,
    comparison_flags: comparisonFlags, status: 'submitted', updated_at: new Date().toISOString(),
  };
  const quote = await upsert(env, 'quotations', row, 'rfq_id,vendor_user_id');
  await patch(env, 'rfq_invitations', `rfq_id=eq.${encodeURIComponent(rfqId)}&vendor_user_id=eq.${actor.userId}`, { status: 'quoted', updated_at: new Date().toISOString() });
  const rfq = await getRfq(env, rfqId);
  await Promise.all([
    notify(env, { userId: rfq.client_id, role: 'client', rfqId, eventType: 'quotation_received', message: `A new anonymous quotation was received for ${rfqId}` }),
    notify(env, { role: 'admin', rfqId, eventType: 'quotation_received', message: `Quotation received for ${rfqId}` }),
    audit(env, actor, rfqId, 'quotation_submitted', { quotation_id: quote.id }),
  ]);
  return json({ ok: true, quotation: anonymousQuote(quote, 0, actor.role === 'admin') });
}

async function assertVendorCanQuote(env, vendorId, rfqId) {
  const [rfq, profile, invite] = await Promise.all([
    getRfq(env, rfqId),
    one(env, `/rest/v1/vendor_profiles?${params({ id: `eq.${vendorId}`, select: '*' })}`),
    one(env, `/rest/v1/rfq_invitations?${params({ rfq_id: `eq.${rfqId}`, vendor_user_id: `eq.${vendorId}`, select: '*' })}`),
  ]);
  if (!rfq || !rfq.sanitized_ready || !['Quoting', 'Comparing'].includes(rfq.status)) throw forbidden('RFQ is not open for quotations');
  if (!profile || profile.status !== 'verified') throw forbidden('Verified vendor profile required');
  if (!invite || !['invited', 'viewed', 'quoted'].includes(invite.status)) throw forbidden('Vendor is not invited to this RFQ');
  return true;
}

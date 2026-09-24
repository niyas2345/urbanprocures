import {
  assertRfqOwner, getRfq,
  notify, audit, rest, one, insert, upsert, patch, params,
  clean, list, readJson, forbidden, notFound, json,
  safeDisposition, adminHeaders, encodePath
} from './desk-shared.js';
import { recordProjectPerformance } from '../ai/supplier-performance.js';

export async function declineInvitation(request, env, actor, rfqId) {
  const body = await readJson(request);
  const reason = clean(body.reason, 1000);
  const invitation = await one(env, `/rest/v1/rfq_invitations?${params({ rfq_id: `eq.${rfqId}`, vendor_user_id: `eq.${actor.userId}`, select: '*' })}`);
  if (!invitation || !['invited', 'viewed'].includes(invitation.status)) throw forbidden('Active RFQ invitation required');
  await patch(env, 'rfq_invitations', `rfq_id=eq.${encodeURIComponent(rfqId)}&vendor_user_id=eq.${actor.userId}`, { status: 'declined', updated_at: new Date().toISOString() });
  await Promise.all([
    notify(env, { role: 'admin', rfqId, eventType: 'invitation_declined', message: `A matched vendor declined ${rfqId}${reason ? `: ${reason}` : ''}` }),
    audit(env, actor, rfqId, 'invitation_declined', { reason }),
  ]);
  return json({ ok: true });
}

export async function createClarification(request, env, actor, rfqId) {
  const body = await readJson(request);
  const question = clean(body.question || body.q, 3000);
  if (!question) throw new Error('Clarification question is required');
  await assertVendorCanViewRfq(env, actor.userId, rfqId);
  const clarification = await insert(env, 'rfq_clarifications', { rfq_id: rfqId, vendor_user_id: actor.userId, question, status: 'open' });
  const rfq = await getRfq(env, rfqId);
  await Promise.all([
    notify(env, { userId: rfq.client_id, role: 'client', rfqId, eventType: 'clarification', message: `An anonymous vendor asked a clarification on ${rfqId}` }),
    notify(env, { role: 'admin', rfqId, eventType: 'clarification', message: `Clarification received on ${rfqId}` }),
    audit(env, actor, rfqId, 'clarification_created', { clarification_id: clarification.id }),
  ]);
  return json({ ok: true, clarification }, 201);
}

export async function answerClarification(request, env, actor, clarificationId) {
  const body = await readJson(request);
  const answer = clean(body.answer, 5000);
  if (!answer) throw new Error('Clarification answer is required');
  const clarification = await one(env, `/rest/v1/rfq_clarifications?${params({ id: `eq.${clarificationId}`, select: '*' })}`);
  if (!clarification) throw notFound('Clarification not found');
  const rfq = await getRfq(env, clarification.rfq_id);
  assertRfqOwner(rfq, actor);
  const updated = await patch(env, 'rfq_clarifications', `id=eq.${clarificationId}`, { answer, status: 'answered', answered_at: new Date().toISOString() });
  await Promise.all([
    notify(env, { userId: clarification.vendor_user_id, role: 'vendor', rfqId: clarification.rfq_id, eventType: 'clarification_answered', message: `A clarification was answered for ${clarification.rfq_id}` }),
    audit(env, actor, clarification.rfq_id, 'clarification_answered', { clarification_id: clarificationId }),
  ]);
  return json({ ok: true, clarification: updated });
}

export async function awardQuotation(request, env, actor, rfqId) {
  const body = await readJson(request); const quotationId = clean(body.quotation_id || body.quote_id, 80);
  const rfq = await getRfq(env, rfqId); assertRfqOwner(rfq, actor);
  if (!['Comparing', 'Quoting'].includes(rfq.status)) throw new Error('RFQ must be open for comparison before award');
  if (rfq.status === 'Quoting') {
    await patch(env, 'rfqs', `id=eq.${encodeURIComponent(rfqId)}`, { status: 'Comparing' });
    rfq.status = 'Comparing';
  }
  const quotation = await one(env, `/rest/v1/quotations?${params({ id: `eq.${quotationId}`, rfq_id: `eq.${rfqId}`, select: '*' })}`);
  if (!quotation) throw notFound('Quotation not found');
  const existing = await one(env, `/rest/v1/awards?${params({ rfq_id: `eq.${rfqId}`, select: '*' })}`);
  if (existing) return json({ ok: true, idempotent: true, award: existing });
  const legacyQuoteId = String(quotation.id);
  await upsert(env, 'quotes', { id: legacyQuoteId, rfq_id: rfqId, vendor_id: quotation.vendor_user_id, vendor_label: 'Winning vendor', amount: quotation.total, vat_pct: 0, vat_inc: 'included', duration: quotation.completion_period || '', inclusions: list(quotation.inclusions).join('\n'), exclusions: list(quotation.exclusions).join('\n'), status: 'Awarded', file_count: 0 }, 'id');
  const computedFee = Math.max(500, Number(quotation.total) * 0.025);
  const billingMode = String(env.PLATFORM_BILLING_MODE || 'free').toLowerCase() === 'paid' ? 'paid' : 'free';
  const feeAmount = billingMode === 'paid' ? computedFee : 0;
  const award = await insert(env, 'awards', { rfq_id: rfqId, quote_id: legacyQuoteId, winner_vendor_id: quotation.vendor_user_id, awarded_amount: quotation.total, fee_rate: 0.025, fee_floor: 500, fee_amount: feeAmount, confirmed_by: actor.userId, notes: clean(body.notes, 3000), disclosed_at: new Date().toISOString(), disclosure_details: { client_to_winner: true, winner_to_client: true, losing_vendors_disclosed: false, billing_mode: billingMode, fee_status: billingMode === 'paid' ? 'due' : 'waived_soft_launch', computed_fee_amount: computedFee } });
  
  // Record supplier performance for the award
  await recordProjectPerformance({
    env,
    rfqId: rfqId,
    vendorId: quotation.vendor_user_id,
    awardId: award.id,
    metrics: {
      project_completed_on_time: null, // Will be updated later
      project_quality_rating: null,
      client_satisfaction_rating: null,
      payment_disputes: 0,
      service_fee_paid_on_time: billingMode === 'free',
      notes: `Awarded via ${billingMode} mode`,
      recorded_by: actor.userId
    }
  });
  
  // Also record quotation performance
  await recordQuotationPerformance({
    env,
    rfqId: rfqId,
    vendorId: quotation.vendor_user_id,
    quotationId: quotation.id,
    metrics: {
      submitted_on_time: true, // Assuming on-time since it was awarded
      quote_competitiveness_score: 80, // Default, could be calculated from comparison
      technical_compliance_score: 85,
      commercial_compliance_score: 90,
      responsiveness_score: 85,
      awarded: true,
      recorded_by: actor.userId
    }
  });
  
  await Promise.all([
    patch(env, 'rfqs', `id=eq.${encodeURIComponent(rfqId)}`, { status: 'Awarded' }),
    patch(env, 'quotations', `id=eq.${encodeURIComponent(quotation.id)}`, { status: 'selected' }),
    notify(env, { userId: quotation.vendor_user_id, role: 'vendor', rfqId, eventType: 'award', message: `Your quotation was awarded for ${rfqId}` }),
    notify(env, { userId: rfq.client_id, role: 'client', rfqId, eventType: 'award', message: `Award confirmed for ${rfqId}` }),
    audit(env, actor, rfqId, 'award_disclosed', { quotation_id: quotation.id, winner_vendor_id: quotation.vendor_user_id }),
  ]);
  return json({ ok: true, award });
}

export async function updateVendorStatus(request, env, actor, vendorId) {
  const body = await readJson(request); const status = clean(body.status, 40);
  if (!['pending_verification', 'verified', 'suspended', 'rejected'].includes(status)) throw new Error('Invalid vendor status');
  const profile = await patch(env, 'vendor_profiles', `id=eq.${vendorId}`, { status, verified_at: status === 'verified' ? new Date().toISOString() : null, verification_note: clean(body.note, 1000), updated_at: new Date().toISOString() });
  await Promise.all([notify(env, { userId: vendorId, role: 'vendor', eventType: 'vendor_status', message: `Vendor verification status: ${status}` }), audit(env, actor, null, 'vendor_status_changed', { vendor_id: vendorId, status })]);
  return json({ ok: true, profile });
}

export async function downloadPrivateDocument(env, actor, kind, id) {
  const table = kind === 'rfq' ? 'rfq_documents' : 'quote_documents';
  const document = await one(env, `/rest/v1/${table}?${params({ id: `eq.${id}`, select: '*' })}`);
  if (!document) throw notFound('Document not found');
  if (actor.role !== 'admin') {
    if (kind === 'rfq') {
      const rfq = await getRfq(env, document.rfq_id);
      if (actor.role !== 'client' || rfq?.client_id !== actor.userId) throw forbidden('Original client documents are private');
    } else if (actor.role !== 'vendor' || document.vendor_user_id !== actor.userId) {
      throw forbidden('Original vendor quotations are private');
    }
  }
  const bucket = document.storage_bucket || (kind === 'rfq' ? 'rfq-documents' : 'quote-documents');
  const path = document.storage_path || document.storage_key;
  const object = await getPrivateObject(env, bucket, path);
  await audit(env, actor, document.rfq_id, 'private_document_downloaded', { kind, document_id: id });
  return new Response(object.body, { status: 200, headers: { 'Content-Type': document.mime_type || object.contentType || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${safeDisposition(document.original_filename || 'document')}"`, 'Cache-Control': 'private, no-store' } });
}

async function getPrivateObject(env, bucket, path) {
  const r2 = bucket === 'rfq-documents' ? env.URBAN_PROCURE_RFQ_DOCUMENTS : bucket === 'quote-documents' ? env.URBAN_PROCURE_QUOTE_DOCUMENTS : null;
  if (r2) {
    const object = await r2.get(path);
    if (!object) throw new Error('Private document download failed');
    return { body: object.body, contentType: object.httpMetadata?.contentType };
  }
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
  const response = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${encodeURIComponent(bucket)}/${encodePath(path)}`, { headers: adminHeaders(env, key) });
  if (!response.ok) throw new Error('Private document download failed');
  return { body: response.body, contentType: response.headers.get('Content-Type') || '' };
}

export async function markNotificationsRead(env, actor) {
  await patch(env, 'procurement_notifications', `user_id=eq.${actor.userId}&read_at=is.null`, { read_at: new Date().toISOString() });
  return json({ ok: true });
}

async function assertVendorCanViewRfq(env, vendorId, rfqId) {
  const [rfq, invitation] = await Promise.all([
    getRfq(env, rfqId),
    one(env, `/rest/v1/rfq_invitations?${params({ rfq_id: `eq.${rfqId}`, vendor_user_id: `eq.${vendorId}`, select: '*' })}`),
  ]);
  if (!rfq || !rfq.sanitized_ready || !['Quoting', 'Comparing'].includes(rfq.status)) throw forbidden('RFQ is not open to this vendor');
  if (!invitation || !['invited', 'viewed', 'quoted'].includes(invitation.status)) throw forbidden('Vendor is not invited to this RFQ');
  return true;
}

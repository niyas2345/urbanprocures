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

export async function bootstrap(env, actor) {
  const notes = await rest(env, `/rest/v1/procurement_notifications?${params({
    select: 'id,role,rfq_id,event_type,message,read_at,created_at',
    or: actor.role === 'admin' ? '(role.eq.admin,user_id.eq.' + actor.userId + ')' : '(user_id.eq.' + actor.userId + ')',
    order: 'created_at.desc', limit: '100',
  })}`);
  if (actor.role === 'admin') return adminBootstrap(env, actor, notes);
  if (actor.role === 'client') return clientBootstrap(env, actor, notes);
  return vendorBootstrap(env, actor, notes);
}

async function adminBootstrap(env, actor, notes) {
  const [rfqs, quotations, awards, vendors, clients, invitations, attachments, rfqDocuments, quoteDocuments, jobs, clarifications] = await Promise.all([
    rest(env, '/rest/v1/rfqs?select=*&order=created_at.desc'),
    rest(env, '/rest/v1/quotations?select=*&order=created_at.desc'),
    rest(env, '/rest/v1/awards?select=*&order=created_at.desc'),
    rest(env, '/rest/v1/vendor_profiles?select=*&order=updated_at.desc'),
    rest(env, '/rest/v1/client_profiles?select=*&order=updated_at.desc'),
    rest(env, '/rest/v1/rfq_invitations?select=*&order=created_at.desc'),
    rest(env, '/rest/v1/attachments?select=id,owner_type,owner_id,name,mime,size_bytes,created_by,created_at,processing_status,ai_status&order=created_at.desc'),
    rest(env, '/rest/v1/rfq_documents?select=id,rfq_id,original_filename,mime_type,file_size,processing_status,requires_human_review,created_at&order=created_at.desc'),
    rest(env, '/rest/v1/quote_documents?select=id,quotation_id,rfq_id,vendor_user_id,original_filename,mime_type,processing_status,requires_human_review,created_at&order=created_at.desc'),
    rest(env, '/rest/v1/document_processing_jobs?select=id,rfq_id,document_id,job_type,status,provider,model,error_message,attempts,created_at,completed_at&order=created_at.desc'),
    rest(env, '/rest/v1/rfq_clarifications?select=*&order=created_at.desc'),
  ]);
  return {
    ok: true, role: actor.role, profile: { id: actor.userId, email: actor.user?.email || '' },
    rfqs, quotations: mapQuotes(quotations, true), awards, vendors, clients, invitations,
    notifications: notes, documents: mapDocuments(attachments, rfqDocuments, quoteDocuments), jobs, clarifications,
  };
}

async function clientBootstrap(env, actor, notes) {
  const [profile] = await rest(env, `/rest/v1/client_profiles?${params({ id: `eq.${actor.userId}`, select: '*' })}`);
  const rfqs = await rest(env, `/rest/v1/rfqs?${params({ client_id: `eq.${actor.userId}`, select: '*', order: 'created_at.desc' })}`);
  const ids = rfqs.map((row) => row.id);
  const [quotations, awards, attachments, documents, clarifications] = ids.length ? await Promise.all([
    rest(env, `/rest/v1/quotations?${params({ rfq_id: inFilter(ids), select: '*', order: 'created_at.asc' })}`),
    rest(env, `/rest/v1/awards?${params({ rfq_id: inFilter(ids), select: '*', order: 'created_at.desc' })}`),
    rest(env, `/rest/v1/attachments?${params({ owner_id: inFilter(ids), owner_type: 'eq.rfq', select: 'id,owner_type,owner_id,name,mime,size_bytes,created_by,created_at,processing_status,ai_status', order: 'created_at.desc' })}`),
    rest(env, `/rest/v1/rfq_documents?${params({ rfq_id: inFilter(ids), select: 'id,rfq_id,original_filename,mime_type,file_size,processing_status,requires_human_review,created_at', order: 'created_at.desc' })}`),
    rest(env, `/rest/v1/rfq_clarifications?${params({ rfq_id: inFilter(ids), select: '*', order: 'created_at.desc' })}`),
  ]) : [[], [], [], [], []];
  const winnerIds = [...new Set(awards.map((row) => row.winner_vendor_id).filter(Boolean))];
  const winnerProfiles = winnerIds.length ? await rest(env, `/rest/v1/vendor_profiles?${params({ id: inFilter(winnerIds), select: 'id,company_name,trading_name,contact_name,contact_email,phone' })}`) : [];
  const winnerById = new Map(winnerProfiles.map((row) => [row.id, row]));
  const disclosures = awards.map((award) => ({
    rfq_id: award.rfq_id, quotation_id: award.quote_id, disclosed_at: award.disclosed_at,
    winner: winnerById.get(award.winner_vendor_id) || { id: award.winner_vendor_id },
  }));
  return {
    ok: true, role: actor.role, profile: profile || { id: actor.userId, email: actor.user?.email || '' },
    rfqs, quotations: mapQuotes(quotations, false), awards, vendors: [], clients: [], invitations: [],
    notifications: notes, documents: mapDocuments(attachments, documents, []), jobs: [], disclosures, clarifications,
  };
}

async function vendorBootstrap(env, actor, notes) {
  const [profile] = await rest(env, `/rest/v1/vendor_profiles?${params({ id: `eq.${actor.userId}`, select: '*' })}`);
  const invitations = await rest(env, `/rest/v1/rfq_invitations?${params({ vendor_user_id: `eq.${actor.userId}`, select: '*', order: 'created_at.desc' })}`);
  const invitedIds = invitations.filter((row) => row.status !== 'withdrawn').map((row) => row.rfq_id);
  const rfqs = invitedIds.length ? await rest(env, `/rest/v1/rfqs?${params({ id: inFilter(invitedIds), sanitized_ready: 'eq.true', status: 'in.(Quoting,Comparing,Awarded)', select: 'id,title,category,subcategory,emirate,deadline,status,sanitized_payload,project,start_date,duration,visit,published_at', order: 'published_at.desc' })}`) : [];
  const quotations = await rest(env, `/rest/v1/quotations?${params({ vendor_user_id: `eq.${actor.userId}`, select: '*', order: 'created_at.desc' })}`);
  const quoteIds = quotations.map((row) => row.id);
  const quoteDocuments = quoteIds.length ? await rest(env, `/rest/v1/quote_documents?${params({ quotation_id: inFilter(quoteIds), select: 'id,quotation_id,rfq_id,vendor_user_id,original_filename,mime_type,processing_status,requires_human_review,created_at', order: 'created_at.desc' })}`) : [];
  const awards = await rest(env, `/rest/v1/awards?${params({ winner_vendor_id: `eq.${actor.userId}`, select: '*', order: 'created_at.desc' })}`);
  const clarifications = await rest(env, `/rest/v1/rfq_clarifications?${params({ vendor_user_id: `eq.${actor.userId}`, select: '*', order: 'created_at.desc' })}`);
  const awardedRfqIds = awards.map((row) => row.rfq_id);
  const awardedRfqs = awardedRfqIds.length ? await rest(env, `/rest/v1/rfqs?${params({ id: inFilter(awardedRfqIds), select: 'id,client_id,location' })}`) : [];
  const clientIds = [...new Set(awardedRfqs.map((row) => row.client_id).filter(Boolean))];
  const clientProfiles = clientIds.length ? await rest(env, `/rest/v1/client_profiles?${params({ id: inFilter(clientIds), select: 'id,company_name,contact_name,phone,whatsapp' })}`) : [];
  const clientById = new Map(clientProfiles.map((row) => [row.id, row]));
  const awardedRfqById = new Map(awardedRfqs.map((row) => [row.id, row]));
  const disclosures = awards.map((award) => {
    const awardedRfq = awardedRfqById.get(award.rfq_id) || {};
    return { rfq_id: award.rfq_id, quotation_id: award.quote_id, disclosed_at: award.disclosed_at, client: clientById.get(awardedRfq.client_id) || { id: awardedRfq.client_id }, location: awardedRfq.location || '' };
  });
  return {
    ok: true, role: actor.role, profile: profile || { id: actor.userId, email: actor.user?.email || '' },
    rfqs: rfqs.map(vendorSafeRow), quotations: mapQuotes(quotations, true), awards, vendors: [], clients: [], invitations,
    notifications: notes, documents: mapDocuments([], [], quoteDocuments), jobs: [], disclosures, clarifications,
  };
}

export async function saveClientProfile(request, env, actor) {
  const body = await readJson(request);
  const company = clean(body.company_name || body.company, 180);
  if (!company) throw new Error('Company name is required');
  const row = {
    id: actor.userId, company_name: company, contact_name: clean(body.contact_name || body.name, 160),
    designation: clean(body.designation, 120), phone: clean(body.phone, 60), whatsapp: clean(body.whatsapp, 60),
    emirate: clean(body.emirate || 'Dubai', 80), company_type: clean(body.company_type || body.type, 120),
    updated_at: new Date().toISOString(),
  };
  const saved = await upsert(env, 'client_profiles', row, 'id');
  await audit(env, actor, null, 'client_profile_saved', {});
  return json({ ok: true, profile: saved });
}

export async function saveVendorProfile(request, env, actor) {
  const body = await readJson(request);
  await assertAcceptedTerms(env, actor.userId, ['vendor_tnc']);
  const company = clean(body.company_name || body.company, 180);
  const licence = clean(body.trade_license_no || body.license, 120);
  if (!company || !licence || !body.license_expiry) throw new Error('Company, trade licence and expiry are required');
  const existing = await one(env, `/rest/v1/vendor_profiles?${params({ id: `eq.${actor.userId}`, select: '*' })}`);
  const row = {
    id: actor.userId, company_name: company, trading_name: clean(body.trading_name || body.trading, 180),
    contact_name: clean(body.contact_name || body.sign_name, 160), contact_email: clean(actor.user?.email, 200), phone: clean(body.phone, 60),
    trade_license_no: licence, license_expiry: body.license_expiry, categories: list(body.categories || body.category),
    subcategories: list(body.subcategories || body.subs), emirate: clean(body.emirate, 80), capacity: positiveInt(body.capacity) || 0,
    available: body.available !== false,
    status: existing?.status || 'pending_verification',
    verified_at: existing?.verified_at || null,
    verification_note: existing?.verification_note || '',
    updated_at: new Date().toISOString(),
  };
  const saved = await upsert(env, 'vendor_profiles', row, 'id');
  await Promise.all([notify(env, { role: 'admin', eventType: 'vendor_registered', message: `Vendor registration received: ${company}` }), audit(env, actor, null, 'vendor_profile_saved', {})]);
  return json({ ok: true, profile: saved });
}

export async function createRfq(request, env, actor) {
  const body = await readJson(request);
  const id = clean(body.id, 80) || `RFQ-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const title = clean(body.title, 220); const category = clean(body.category, 120);
  if (!title || !category || !clean(body.scope, 20000)) throw new Error('Title, category and scope are required');
  const row = {
    id, client_id: actor.userId, project: clean(body.project, 220), title, category,
    subcategory: clean(body.subcategory || body.sub, 160), emirate: clean(body.emirate || 'Dubai', 80),
    location: clean(body.location, 500), scope: clean(body.scope, 20000), budget: nullableNumber(body.budget),
    start_date: body.start_date || body.start || null, duration: clean(body.duration, 120), deadline: body.deadline || null,
    visit: clean(body.visit || 'TBD', 40), special_requirements: clean(body.special_requirements || body.special, 10000),
    status: 'Submitted', review_state: 'awaiting_documents', file_count: 0, source: 'web',
  };
  const saved = await insert(env, 'rfqs', row);
  await Promise.all([
    notify(env, { userId: actor.userId, role: 'client', rfqId: id, eventType: 'rfq_created', message: `RFQ ${id} created` }),
    notify(env, { role: 'admin', rfqId: id, eventType: 'rfq_created', message: `New RFQ ${id} requires review` }),
    audit(env, actor, id, 'rfq_created', { category }),
  ]);
  return json({ ok: true, rfq: saved }, 201);
}

async function assertAcceptedTerms(env, userId, types) {
  const rows = await rest(env, `/rest/v1/terms_acceptances?${params({ user_id: `eq.${userId}`, doc_type: `in.(${types.join(',')})`, select: 'doc_type' })}`);
  const accepted = new Set(rows.map((row) => row.doc_type));
  if (types.some((type) => !accepted.has(type))) throw forbidden('Vendor Terms and Annex A acceptance are required');
}

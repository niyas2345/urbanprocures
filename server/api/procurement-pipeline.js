import { classifyFile } from '../ai/file-classifier.js';
import { extractDocument, EXTRACTION_STATUS } from '../ai/document-extractor.js';
import { scanIdentityLeakage } from '../ai/identity-scan.js';
import { assertVendorSafeArtifact, buildSanitizedVendorRfq } from '../ai/sanitized-rfq.js';
import { createMemoryStore, processDocumentJob } from '../jobs/job-processor.js';
import { uploadRFQDocuments } from './rfq-documents.js';
import { uploadVendorQuotation } from './quotation-documents.js';
import { processPersistentDocumentJob } from '../jobs/supabase-job-processor.js';

const DEFAULT_STORE = createMemoryStore();
const BUCKET = 'rfq-documents';
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'dwg', 'dxf', 'xls', 'xlsx', 'csv',
  'png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'heic', 'heif',
  'ppt', 'pptx', 'odt', 'ods', 'txt', 'rtf', 'zip', 'rar',
]);

export async function handleProcurementApi(request, env = {}, store = DEFAULT_STORE) {
  const url = new URL(request.url);

  if (request.method === 'POST' && url.pathname === '/api/rfq-documents/upload') {
    return uploadRFQDocuments(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/api/quotations/documents') {
    return uploadVendorQuotation(request, env);
  }

  const actor = await authenticate(request, env);
  if (!actor.ok) return json({ ok: false, error: actor.error }, actor.status);

  try {
    if (request.method === 'POST' && url.pathname === '/api/rfq/documents') {
      if (actor.role !== 'client' && actor.role !== 'admin') return json({ ok: false, error: 'Access denied' }, 403);
      return uploadRfqDocument(request, env, store, actor);
    }

    if (request.method === 'POST' && url.pathname === '/api/procurement/jobs/process') {
      if (actor.role !== 'client' && actor.role !== 'admin') return json({ ok: false, error: 'Access denied' }, 403);
      const body = await readJson(request);
      if (env.SUPABASE_URL && (env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY) && actor.role !== 'admin') {
        const job = await restOne(env, `/rest/v1/document_processing_jobs?id=eq.${encodeURIComponent(body.job_id || '')}&select=id,rfq_id`);
        const rfq = job?.rfq_id ? await restOne(env, `/rest/v1/rfqs?id=eq.${encodeURIComponent(job.rfq_id)}&select=id,client_id`) : null;
        const owner = rfq?.client_id;
        if (!job || !rfq || owner !== actor.userId) return json({ ok: false, error: 'Access denied' }, 403);
      }
      const result = env.SUPABASE_URL && (env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY)
        ? await processPersistentDocumentJob({ env, jobId: body.job_id })
        : await processDocumentJob({ jobId: body.job_id, store });
      return json(result, result.ok ? 200 : result.status === 'failed' ? 500 : 409);
    }

    const vendorView = url.pathname.match(/^\/api\/procurement\/rfq\/([^/]+)\/vendor-view$/);
    if (request.method === 'GET' && vendorView) {
      if (actor.role !== 'vendor' && actor.role !== 'admin') return json({ ok: false, error: 'Access denied' }, 403);
      return env.SUPABASE_URL && (env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY)
        ? persistentVendorSafeRfq(decodeURIComponent(vendorView[1]), env, actor)
        : vendorSafeRfq(decodeURIComponent(vendorView[1]), store);
    }

    const comparison = url.pathname.match(/^\/api\/procurement\/rfq\/([^/]+)\/comparison$/);
    if (request.method === 'GET' && comparison) {
      if (actor.role !== 'client' && actor.role !== 'admin') return json({ ok: false, error: 'Access denied' }, 403);
      return env.SUPABASE_URL && (env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY)
        ? persistentClientComparison(decodeURIComponent(comparison[1]), env, actor, url.searchParams.get('awarded') === '1')
        : json({ ok: true, rfq_id: decodeURIComponent(comparison[1]), comparisons: [], vendor_identities_visible: url.searchParams.get('awarded') === '1' });
    }
  } catch (error) {
    return json({ ok: false, error: error?.message || 'Procurement request failed' }, 500);
  }

  return json({ ok: false, error: 'Not found' }, 404);
}

export function validateFile(file) {
  const name = String(file?.name || file?.file_name || '').trim();
  const size = Number(file?.size ?? file?.size_bytes ?? 0);
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (!name) throw new Error('Filename is required');
  if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error(`${name}: unsupported file format`);
  if (!size) throw new Error(`${name}: file is empty`);
  if (size > MAX_FILE_SIZE) throw new Error(`${name}: file exceeds 25 MB limit`);
  return { extension, safeName: name.replace(/[^a-zA-Z0-9._-]/g, '_') };
}

async function uploadRfqDocument(request, env, store, actor) {
  const input = await readUpload(request);
  const rfqId = String(input.rfq_id || '').trim();
  if (!rfqId) return json({ ok: false, error: 'rfq_id is required' }, 400);

  const existing = await store.getRfq(rfqId);
  if (existing?.client_user_id && existing.client_user_id !== actor.userId && actor.role !== 'admin') return json({ ok: false, error: 'Access denied' }, 403);
  await store.putRfq({ id: rfqId, client_user_id: existing?.client_user_id || actor.userId, status: existing?.status || 'review' });

  const files = input.files.length ? input.files : input.file_name ? [{ name: input.file_name, type: input.mime_type || 'text/plain', bytes: Buffer.from(input.text || ''), size: Buffer.byteLength(input.text || '') }] : [];
  if (!files.length) return json({ ok: false, error: 'At least one file is required' }, 400);
  if (files.length > 10) return json({ ok: false, error: 'Maximum 10 files per RFQ' }, 400);

  const attachments = [];
  for (const file of files) {
    const validation = validateFile(file);
    const bytes = toBuffer(file.bytes);
    const classification = classifyFile({ fileName: file.name, mimeType: file.type, bytes });
    const storagePath = `${actor.userId}/${rfqId}/${crypto.randomUUID()}-${validation.safeName}`;
    await store.putObject(storagePath, bytes);

    const document = await store.putDocument({
      id: crypto.randomUUID(),
      rfq_id: rfqId,
      storage_bucket: BUCKET,
      storage_path: storagePath,
      storage_key: storagePath,
      document_role: 'source',
      original_filename: file.name,
      mime_type: file.type || classification.detected_mime,
      processing_status: classification.ok ? 'pending' : 'blocked',
      requires_human_review: !classification.ok,
      classification,
      rejection_reason: classification.ok ? null : classification.reason,
    });

    let job = null;
    if (classification.ok) {
      job = await store.putJob({
        id: crypto.randomUUID(),
        rfq_id: rfqId,
        document_id: document.id,
        job_type: 'extract',
        status: 'pending',
        classification,
      });
    }

    const attachment = await store.putAttachment({
      id: crypto.randomUUID(),
      owner_type: 'rfq',
      owner_id: rfqId,
      name: file.name,
      storage_bucket: BUCKET,
      storage_path: storagePath,
      ai_status: classification.ok ? 'queued' : 'rejected',
      ai_detected_format: classification.format,
      ai_rejection_reason: classification.ok ? null : classification.reason,
      document_id: document.id,
      job_id: job?.id || null,
    });
    attachments.push({ ...attachment, storage_path: undefined, storage_bucket: undefined });
  }

  return json({ ok: true, bucket: BUCKET, attachments });
}

async function vendorSafeRfq(rfqId, store) {
  const docs = [...store.state.documents.values()].filter((document) => document.rfq_id === rfqId && document.extraction);
  if (!docs.length) return json({ ok: false, error: 'review_required' }, 409);
  const extraction = docs[0].extraction;
  const built = buildSanitizedVendorRfq({ rfqId, extraction, sourceDocumentId: docs[0].id });
  if (!built.ok || built.requires_human_review) return json({ ok: false, error: 'review_required', reasons: built.reasons || [] }, 409);
  assertVendorSafeArtifact(built.artifact);
  if (scanIdentityLeakage(built.artifact).leaked) return json({ ok: false, error: 'identity_leakage' }, 409);
  return json({ ok: true, rfq: built.artifact });
}

async function persistentVendorSafeRfq(rfqId, env, actor) {
  const rfq = await restOne(env, `/rest/v1/rfqs?id=eq.${encodeURIComponent(rfqId)}&select=id,status,category,title,location,emirate`);
  if (!rfq || String(rfq.status).toLowerCase() !== 'published') return json({ ok: false, error: 'RFQ is not published' }, 404);
  const documents = await rest(env, `/rest/v1/rfq_documents?rfq_id=eq.${encodeURIComponent(rfqId)}&document_role=eq.source&processing_status=eq.ready&select=id,extraction,original_filename`);
  const source = documents.find((document) => document.extraction);
  if (!source) return json({ ok: false, error: 'review_required' }, 409);
  const built = buildSanitizedVendorRfq({ rfqId, extraction: source.extraction, input: { category: rfq.category, title: rfq.title, location: rfq.location || rfq.emirate }, sourceDocumentId: source.id });
  if (!built.ok || built.requires_human_review) return json({ ok: false, error: 'review_required', reasons: built.reasons || [] }, 409);
  assertVendorSafeArtifact(built.artifact);
  return json({ ok: true, rfq: built.artifact });
}

async function persistentClientComparison(rfqId, env, actor, awarded) {
  const rfq = await restOne(env, `/rest/v1/rfqs?id=eq.${encodeURIComponent(rfqId)}&select=id,status,client_id,client_user_id,created_by`);
  const owner = rfq?.client_id || rfq?.client_user_id || rfq?.created_by;
  if (!rfq || (owner && owner !== actor.userId && actor.role !== 'admin')) return json({ ok: false, error: 'Access denied' }, 403);
  const quotes = await rest(env, `/rest/v1/quotations?rfq_id=eq.${encodeURIComponent(rfqId)}&select=id,total,currency,completion_period,warranty,inclusions,exclusions,payment_terms,status&order=created_at.asc`);
  return json({ ok: true, rfq_id: rfqId, comparisons: quotes.map((quote, index) => ({ quotationId: quote.id, vendorReference: `Vendor ${String.fromCharCode(65 + index)}`, total: Number(quote.total), currency: quote.currency || 'AED', completionPeriod: quote.completion_period || null, warranty: quote.warranty || null, inclusions: quote.inclusions || [], exclusions: quote.exclusions || [], paymentTerms: quote.payment_terms || null, status: quote.status || 'submitted' })), vendor_identities_visible: Boolean(awarded && String(rfq.status).toLowerCase() === 'awarded') });
}

async function readUpload(request) {
  const type = request.headers.get('Content-Type') || '';
  if (type.includes('multipart/form-data')) {
    const form = await request.formData();
    return {
      rfq_id: form.get('rfq_id'),
      files: await Promise.all(form.getAll('files').filter((file) => file?.arrayBuffer).map(async (file) => ({
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size,
        bytes: new Uint8Array(await file.arrayBuffer()),
      }))),
    };
  }
  const body = await readJson(request);
  return { ...body, files: Array.isArray(body.files) ? body.files.map(normalizeBodyFile) : [] };
}

function normalizeBodyFile(file) {
  const text = file.text || file.content || '';
  return {
    name: file.name || file.file_name,
    type: file.type || file.mime_type || 'text/plain',
    size: Number(file.size ?? Buffer.byteLength(text)),
    bytes: file.bytes ? toBuffer(file.bytes) : Buffer.from(text),
  };
}

async function authenticate(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return { ok: false, status: 401, error: 'Missing bearer token' };
  if (env.PROCUREMENT_TEST_AUTH === '1' && token.startsWith('test:')) {
    const [, role, userId] = token.split(':');
    if (!role || !userId) return { ok: false, status: 401, error: 'Invalid test token' };
    return { ok: true, role, userId };
  }
  if (!env.SUPABASE_URL || !(env.SUPABASE_ANON_KEY || env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY)) return { ok: false, status: 401, error: 'Unsupported auth token' };
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY || env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` } });
  if (!response.ok) return { ok: false, status: 401, error: 'Invalid session' };
  const user = await response.json(); const role = user?.app_metadata?.role || user?.role;
  if (!user?.id || !['client', 'vendor', 'admin'].includes(role)) return { ok: false, status: 403, error: 'Account role is not configured' };
  return { ok: true, role, userId: user.id };
}

async function readJson(request) {
  return request.json().catch(() => ({}));
}

function toBuffer(bytes) {
  if (!bytes) return Buffer.alloc(0);
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (Array.isArray(bytes)) return Buffer.from(bytes);
  if (typeof bytes === 'string') return Buffer.from(bytes);
  return Buffer.alloc(0);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function rest(env, path, init = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
  const response = await fetch(`${env.SUPABASE_URL}${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const text = await response.text(); if (!response.ok) throw new Error(text || `Supabase request failed (${response.status})`); return text ? JSON.parse(text) : [];
}
async function restOne(env, path) { return (await rest(env, path))[0] || null; }

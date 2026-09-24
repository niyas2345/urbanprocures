import { extractDocument, EXTRACTION_STATUS } from '../ai/document-extractor.js';

export function createMemoryStore(seed = {}) {
  const state = {
    rfqs: new Map(Object.entries(seed.rfqs || {})),
    documents: new Map(Object.entries(seed.documents || {})),
    jobs: new Map(Object.entries(seed.jobs || {})),
    objects: new Map(Object.entries(seed.objects || {})),
    attachments: new Map(Object.entries(seed.attachments || {})),
  };

  return {
    state,
    async getRfq(id) { return state.rfqs.get(id) || null; },
    async putRfq(row) { state.rfqs.set(row.id, { ...(state.rfqs.get(row.id) || {}), ...row }); return state.rfqs.get(row.id); },
    async getDocument(id) { return state.documents.get(id) || null; },
    async putDocument(row) { state.documents.set(row.id, { ...(state.documents.get(row.id) || {}), ...row }); return state.documents.get(row.id); },
    async getJob(id) { return state.jobs.get(id) || null; },
    async putJob(row) { state.jobs.set(row.id, { ...(state.jobs.get(row.id) || {}), ...row }); return state.jobs.get(row.id); },
    async getObject(path) { return state.objects.get(path) || null; },
    async putObject(path, bytes) { state.objects.set(path, toBuffer(bytes)); return { path }; },
    async putAttachment(row) { state.attachments.set(row.id, { ...(state.attachments.get(row.id) || {}), ...row }); return state.attachments.get(row.id); },
  };
}

export async function processDocumentJob({ jobId, store }) {
  if (!store) throw new Error('store is required');
  const job = await store.getJob(jobId);
  if (!job) return { ok: false, status: 'failed', error: 'job_not_found' };
  if (job.status === 'completed' || job.status === 'blocked') {
    return { ok: true, idempotent: true, job, extraction: job.result || null };
  }
  if (job.status === 'processing' && job.locked_at) {
    return { ok: true, idempotent: true, job, extraction: job.result || null };
  }

  const processing = await store.putJob({ ...job, status: 'processing', locked_at: job.locked_at || new Date().toISOString(), attempts: Number(job.attempts || 0) + 1 });
  const document = await store.getDocument(processing.document_id);
  if (!document) return failJob({ store, job: processing, reason: 'document_not_found' });
  if (document.processing_status === 'blocked' || document.classification?.ok === false) {
    return blockJob({ store, job: processing, document, reason: document.rejection_reason || document.classification?.reason || 'document_blocked' });
  }

  const bytes = document.bytes || await store.getObject(document.storage_path || document.storage_key);
  if (!bytes) return failJob({ store, job: processing, document, reason: 'source_object_not_found' });

  const extraction = extractDocument({
    fileName: document.original_filename || document.file_name || document.storage_path || '',
    mimeType: document.mime_type || '',
    bytes,
    classification: document.classification || processing.classification || processing.result?.classification,
  });

  if (extraction.status === EXTRACTION_STATUS.BLOCKED) return blockJob({ store, job: processing, document, reason: extraction.reason || extraction.error || 'blocked', extraction });
  if (extraction.status === EXTRACTION_STATUS.FAILED) return failJob({ store, job: processing, document, reason: extraction.reason || extraction.error || 'failed', extraction });

  const completed = await store.putJob({
    ...processing,
    status: 'completed',
    result: extraction,
    error_message: null,
    completed_at: new Date().toISOString(),
  });
  await store.putDocument({ ...document, processing_status: extraction.status === EXTRACTION_STATUS.PENDING_EXTERNAL ? 'processing' : 'ready', extraction });
  return { ok: true, job: completed, extraction };
}

async function blockJob({ store, job, document, reason, extraction = null }) {
  const result = extraction || { status: EXTRACTION_STATUS.BLOCKED, reason, published: false };
  const blocked = await store.putJob({ ...job, status: 'blocked', result, error_message: reason, completed_at: new Date().toISOString() });
  if (document) await store.putDocument({ ...document, processing_status: 'blocked', requires_human_review: true, extraction: result });
  return { ok: false, job: blocked, extraction: result, error: reason };
}

async function failJob({ store, job, document = null, reason, extraction = null }) {
  const result = extraction || { status: EXTRACTION_STATUS.FAILED, reason, published: false };
  const failed = await store.putJob({ ...job, status: 'failed', result, error_message: reason, completed_at: new Date().toISOString() });
  if (document) await store.putDocument({ ...document, processing_status: 'failed', requires_human_review: true, extraction: result });
  return { ok: false, job: failed, extraction: result, error: reason };
}

function toBuffer(bytes) {
  if (!bytes) return Buffer.alloc(0);
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (typeof bytes === 'string') return Buffer.from(bytes);
  return Buffer.alloc(0);
}

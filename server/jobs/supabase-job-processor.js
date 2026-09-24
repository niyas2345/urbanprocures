import { extractDocumentAsync } from '../ai/document-extractor.js';

/** Persistent worker path. It is deliberately explicit: callers pass a job id,
 * the same job cannot be claimed twice while locked, and all results stay in
 * private database records. */
export async function processPersistentDocumentJob({ env, jobId, ocrVisionProvider } = {}) {
  if (!env?.SUPABASE_URL || !(env?.SUPABASE_SECRET_KEY || env?.SUPABASE_SERVICE_ROLE_KEY) || !jobId) return { ok: false, status: 'failed', error: 'persistent_job_configuration_missing' };
  const job = await one(env, `/rest/v1/document_processing_jobs?id=eq.${encodeURIComponent(jobId)}&select=*`);
  if (!job) return { ok: false, status: 'failed', error: 'job_not_found' };
  if (['completed', 'blocked'].includes(job.status)) return { ok: true, idempotent: true, job };
  const now = new Date().toISOString();
  if (job.status === 'processing' && job.locked_at && Date.parse(job.locked_at) > Date.now() - 15 * 60 * 1000) return { ok: true, idempotent: true, job };
  const claimed = await update(env, job.id, { status: 'processing', locked_at: now, attempts: Number(job.attempts || 0) + 1 });
  try {
    const documentTable = job.result?.document_table === 'quote_documents' ? 'quote_documents' : 'rfq_documents';
    const document = job.document_id ? await one(env, `/rest/v1/${documentTable}?id=eq.${encodeURIComponent(job.document_id)}&select=*`) : null;
    if (!document) return await finish(env, job.id, { status: 'failed', error_message: 'document_not_found' });
    const bytes = await download(env, document.storage_bucket || 'rfq-documents', document.storage_path || document.storage_key);
    const extraction = await extractDocumentAsync({ fileName: document.original_filename, mimeType: document.mime_type, bytes, classification: document.classification_result || document.classification, env, ocrVisionProvider });
    const status = extraction.status === 'blocked' ? 'blocked' : extraction.status === 'failed' ? 'failed' : extraction.status === 'pending_external' ? 'processing' : 'completed';
    await updateDocument(env, documentTable, document.id, { processing_status: status === 'completed' ? 'ready' : status, extraction, requires_human_review: Boolean(extraction.requires_human_review) });
    return await finish(env, job.id, { status, provider: extraction.adapter || extraction.metadata?.provider || null, model: extraction.metadata?.model || null, result: extraction, error_message: extraction.error || extraction.reason || null, warnings: extraction.metadata?.warnings || [] });
  } catch (error) {
    return await finish(env, job.id, { status: 'failed', error_message: error.message || 'job_failed', result: { status: 'failed', published: false } });
  }
}
async function finish(env, id, patch) { return { ok: patch.status === 'completed', job: await update(env, id, { ...patch, completed_at: patch.status === 'processing' ? null : new Date().toISOString(), locked_at: null }) }; }
async function one(env, path) { const rows = await api(env, path); return rows[0] || null; }
async function update(env, id, patch) { const rows = await api(env, `/rest/v1/document_processing_jobs?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) }); return rows[0] || { id, ...patch }; }
async function updateDocument(env, table, id, patch) { await api(env, `/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }); }
async function download(env, bucket, path) {
  const r2 = bucket === 'rfq-documents' ? env.URBAN_PROCURE_RFQ_DOCUMENTS : bucket === 'quote-documents' ? env.URBAN_PROCURE_QUOTE_DOCUMENTS : null;
  if (r2) {
    const object = await r2.get(path);
    if (!object) throw new Error('source_download_404');
    return object.arrayBuffer();
  }
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
  const response = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`source_download_${response.status}`);
  return response.arrayBuffer();
}
async function api(env, path, init = {}) { const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY; const response = await fetch(`${env.SUPABASE_URL}${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } }); const text = await response.text(); if (!response.ok) throw new Error(text || `supabase_${response.status}`); return text ? JSON.parse(text) : []; }

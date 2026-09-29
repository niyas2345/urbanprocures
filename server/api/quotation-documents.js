import { classifyFile } from '../ai/file-classifier.js';

const QUOTE_BUCKET = 'quote-documents';
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const ALLOWED = new Set(['pdf','doc','docx','xls','xlsx','csv','ods','ppt','pptx','png','jpg','jpeg','webp','tif','tiff','heic','heif','txt','rtf']);

export async function uploadVendorQuotation(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
  if (!env.SUPABASE_URL || !(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY)) return json({ ok: false, error: 'Supabase env vars missing' }, 503);
  const actor = await authenticate(request, env);
  if (!actor.ok) return json(actor, actor.status);
  const form = await request.formData(); const rfqId = String(form.get('rfq_id') || '').trim();
  const files = form.getAll('files').filter((file) => file?.arrayBuffer);
  if (!rfqId) return json({ ok: false, error: 'rfq_id is required' }, 400);
  const [rfq, profile, invitation] = await Promise.all([getRfq(env, rfqId), getVendorProfile(env, actor.userId), getInvitation(env, rfqId, actor.userId)]);
  if (!rfq || !rfq.sanitized_ready || !['quoting', 'comparing'].includes(String(rfq.status).toLowerCase())) return json({ ok: false, error: 'RFQ is not open for quotations' }, 403);
  if (!profile || profile.status !== 'verified') return json({ ok: false, error: 'Verified vendor profile required' }, 403);
  if (!invitation || !['invited', 'viewed', 'quoted'].includes(invitation.status)) return json({ ok: false, error: 'Vendor is not invited to this RFQ' }, 403);
  const uploaded = [];
  try {
    const quotation = await getOrCreateQuotation(env, rfqId, actor.userId);
    for (const file of files) {
      const name = String(file.name || '').trim(); const ext = name.split('.').pop().toLowerCase();
      if (!ALLOWED.has(ext) || !file.size || file.size > MAX_FILE_SIZE) throw new Error(`${name}: invalid quotation file`);
      const bytes = await file.arrayBuffer(); const classification = classifyFile({ fileName: name, mimeType: file.type, bytes });
      if (!classification.ok) throw new Error(`${name}: ${classification.reason}`);
      const path = `${actor.userId}/${rfqId}/${crypto.randomUUID()}-${safeName(name)}`;
      await putPrivateObject(env, QUOTE_BUCKET, path, bytes, file.type || 'application/octet-stream'); uploaded.push(path);
      const document = await insert(env, 'quote_documents', { quotation_id: quotation.id, rfq_id: rfqId, vendor_user_id: actor.userId, storage_bucket: QUOTE_BUCKET, storage_key: path, original_filename: name, mime_type: file.type || 'application/octet-stream', processing_status: 'pending', requires_human_review: false, extraction: { classification } });
      await insert(env, 'document_processing_jobs', { rfq_id: rfqId, document_id: document.id, job_type: 'normalize_quotation', status: 'pending', result: { quote_id: quotation.id, document_table: 'quote_documents', classification }, error_message: null });
    }
    await patch(env, 'rfq_invitations', `rfq_id=eq.${encodeURIComponent(rfqId)}&vendor_user_id=eq.${actor.userId}`, { status: 'quoted', updated_at: new Date().toISOString() });
    return json({ ok: true, bucket: QUOTE_BUCKET, count: uploaded.length, quotation: { id: quotation.id, status: quotation.status || 'submitted' }, documents: uploaded.map((_, index) => ({ index, status: 'processing' })) });
  } catch (error) { await Promise.all(uploaded.map((path) => deletePrivateObject(env, QUOTE_BUCKET, path).catch(() => null))); return json({ ok: false, error: error.message || 'Quotation upload failed' }, 400); }
}

async function authenticate(request, env) {
  const header = request.headers.get('Authorization') || ''; const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (env.PROCUREMENT_TEST_AUTH === '1' && token.startsWith('test:')) { const [, role, userId] = token.split(':'); return role === 'vendor' ? { ok: true, role, userId } : { ok: false, status: 403, error: 'Vendor access required' }; }
  if (!token) return { ok: false, status: 401, error: 'Authentication required' };
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY || env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` } });
  if (!response.ok) return { ok: false, status: 401, error: 'Invalid session' };
  const user = await response.json(); const role = user?.app_metadata?.role || user?.role;
  if (!user?.id || role !== 'vendor') return { ok: false, status: 403, error: 'Vendor access required' };
  return { ok: true, role, userId: user.id };
}
async function getRfq(env, id) { const rows = await supabaseFetch(env, `/rest/v1/rfqs?id=eq.${encodeURIComponent(id)}&select=id,status,sanitized_ready`); return rows[0] || null; }
async function getVendorProfile(env, id) { const rows = await supabaseFetch(env, `/rest/v1/vendor_profiles?id=eq.${encodeURIComponent(id)}&select=id,status`); return rows[0] || null; }
async function getInvitation(env, rfqId, vendorId) { const rows = await supabaseFetch(env, `/rest/v1/rfq_invitations?rfq_id=eq.${encodeURIComponent(rfqId)}&vendor_user_id=eq.${encodeURIComponent(vendorId)}&select=*`); return rows[0] || null; }
async function getOrCreateQuotation(env, rfqId, vendorId) {
  const rows = await supabaseFetch(env, `/rest/v1/quotations?rfq_id=eq.${encodeURIComponent(rfqId)}&vendor_user_id=eq.${encodeURIComponent(vendorId)}&select=*`);
  if (rows[0]) return rows[0];
  return insert(env, 'quotations', { rfq_id: rfqId, vendor_user_id: vendorId, status: 'processing', currency: 'AED', total: 0 });
}
async function insert(env, table, row) { const rows = await supabaseFetch(env, `/rest/v1/${table}`, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) }); return rows[0] || row; }
async function patch(env, table, filter, row) { const rows = await supabaseFetch(env, `/rest/v1/${table}?${filter}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) }); return rows[0] || row; }
async function supabaseFetch(env, path, init = {}) { const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY; const response = await fetch(`${env.SUPABASE_URL}${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } }); const text = await response.text(); if (!response.ok) throw new Error(text || `Supabase request failed (${response.status})`); return text ? JSON.parse(text) : []; }
async function putPrivateObject(env, bucket, path, bytes, contentType) {
  const r2 = bucket === QUOTE_BUCKET ? env.URBAN_PROCURE_QUOTE_DOCUMENTS : null;
  if (r2) {
    await assertStorageCapacity(r2, bytes.byteLength);
    await r2.put(path, bytes, { httpMetadata: { contentType } });
    return;
  }
  await storageFetch(env, `/storage/v1/object/${bucket}/${encodePath(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, 'x-upsert': 'false' },
    body: bytes
  });
}
async function deletePrivateObject(env, bucket, path) {
  const r2 = bucket === QUOTE_BUCKET ? env.URBAN_PROCURE_QUOTE_DOCUMENTS : null;
  if (r2) {
    await r2.delete(path);
    return;
  }
  await storageFetch(env, `/storage/v1/object/${bucket}/${encodePath(path)}`, { method: 'DELETE' });
}
async function assertStorageCapacity(bucket, incomingBytes) {
  const hardLimit = 6 * 1024 * 1024 * 1024;
  let total = incomingBytes;
  let cursor;
  do {
    const page = await bucket.list({ limit: 1000, cursor });
    total += page.objects.reduce((sum, object) => sum + (object.size || 0), 0);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (total > hardLimit) throw new Error('Document storage capacity reached; owner review required');
}
async function storageFetch(env, path, init = {}) { const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY; const response = await fetch(`${env.SUPABASE_URL}${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, ...(init.headers || {}) } }); if (!response.ok) throw new Error(`Storage request failed (${response.status})`); return response; }
function safeName(name) { return name.normalize('NFKD').replace(/[^\w.-]+/g, '_').slice(0, 140) || 'quotation'; }
function encodePath(path) { return path.split('/').map(encodeURIComponent).join('/'); }
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }); }
export { QUOTE_BUCKET };

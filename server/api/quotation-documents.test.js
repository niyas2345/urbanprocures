import { strict as assert } from 'node:assert';
import test from 'node:test';
import { uploadVendorQuotation } from './quotation-documents.js';

test('vendor quotation upload stores privately and queues persistent normalization', async () => {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes('/rest/v1/rfqs?')) return json([{ id: 'RFQ-1', status: 'Quoting', sanitized_ready: true }]);
    if (url.includes('/rest/v1/vendor_profiles?')) return json([{ id: 'v1', status: 'verified' }]);
    if (url.includes('/rest/v1/rfq_invitations?') && init.method !== 'PATCH') return json([{ rfq_id: 'RFQ-1', vendor_user_id: 'v1', status: 'invited' }]);
    if (url.includes('/rest/v1/rfq_invitations?') && init.method === 'PATCH') return json([{ rfq_id: 'RFQ-1', vendor_user_id: 'v1', status: 'quoted' }]);
    if (url.includes('/storage/v1/object/quote-documents/') && init.method === 'POST') return json({});
    if (url.includes('/rest/v1/quotations')) return json([{ id: 'quote-1' }]);
    if (url.includes('/rest/v1/quote_documents')) return json([{ id: 'doc-1' }]);
    if (url.includes('/rest/v1/document_processing_jobs')) return json([{ id: 'job-1' }]);
    throw new Error(`unexpected ${url}`);
  };
  try {
    const form = new FormData(); form.set('rfq_id', 'RFQ-1'); form.append('files', new Blob(['%PDF-1.4\n%%EOF'], { type: 'application/pdf' }), 'quote.pdf');
    const response = await uploadVendorQuotation(new Request('https://app.test/api/quotations/documents', { method: 'POST', headers: { Authorization: 'Bearer test:vendor:v1' }, body: form }), { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'service-role', PROCUREMENT_TEST_AUTH: '1' });
    const body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.bucket, 'quote-documents');
    assert.ok(calls.some(({ url, init }) => url.includes('/storage/v1/object/quote-documents/') && init.method === 'POST'));
    assert.ok(calls.some(({ url }) => url.includes('/rest/v1/document_processing_jobs')));
    assert.equal(JSON.stringify(body).includes('storage_path'), false);
  } finally { globalThis.fetch = previous; }
});

test('quotation upload rejects non-vendor test actor before storage', async () => {
  const form = new FormData(); form.set('rfq_id', 'RFQ-1'); form.append('files', new Blob(['%PDF-1.4\n%%EOF'], { type: 'application/pdf' }), 'quote.pdf');
  const response = await uploadVendorQuotation(new Request('https://app.test/api/quotations/documents', { method: 'POST', headers: { Authorization: 'Bearer test:client:c1' }, body: form }), { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'service-role', PROCUREMENT_TEST_AUTH: '1' });
  assert.equal(response.status, 403);
});

function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { processPersistentDocumentJob } from './supabase-job-processor.js';

test('persistent job processor claims, downloads, extracts and persists result', async () => {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes('/document_processing_jobs?id=eq.job-1') && !init.method) return response([{ id: 'job-1', status: 'pending', document_id: 'doc-1', attempts: 0 }]);
    if (url.includes('/rfq_documents?id=eq.doc-1')) return response([{ id: 'doc-1', original_filename: 'boq.csv', mime_type: 'text/csv', storage_bucket: 'rfq-documents', storage_key: 'c/r/boq.csv', classification: { ok: true, format: 'csv', route: 'extract_spreadsheet' } }]);
    if (url.includes('/storage/v1/object/')) return new Response('description,quantity,unit\nPainting,10,m2\n');
    if (url.includes('/rest/v1/document_processing_jobs?id=eq.job-1') && init.method === 'PATCH') return response([{ id: 'job-1', ...JSON.parse(init.body) }]);
    if (url.includes('/rest/v1/rfq_documents?id=eq.doc-1') && init.method === 'PATCH') return response([]);
    throw new Error(`unexpected ${url}`);
  };
  try {
    const result = await processPersistentDocumentJob({ env: { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'service-role' }, jobId: 'job-1' });
    assert.equal(result.ok, true); assert.equal(result.job.status, 'completed'); assert.ok(calls.some((call) => call.url.includes('/storage/v1/object/rfq-documents/')));
  } finally { globalThis.fetch = previous; }
});

test('persistent job processor downloads source documents from private R2 binding', async () => {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes('/document_processing_jobs?id=eq.job-r2') && !init.method) return response([{ id: 'job-r2', status: 'pending', document_id: 'doc-r2', attempts: 0 }]);
    if (url.includes('/rfq_documents?id=eq.doc-r2')) return response([{ id: 'doc-r2', original_filename: 'boq.csv', mime_type: 'text/csv', storage_bucket: 'rfq-documents', storage_key: 'c/r/boq.csv', classification: { ok: true, format: 'csv', route: 'extract_spreadsheet' } }]);
    if (url.includes('/rest/v1/document_processing_jobs?id=eq.job-r2') && init.method === 'PATCH') return response([{ id: 'job-r2', ...JSON.parse(init.body) }]);
    if (url.includes('/rest/v1/rfq_documents?id=eq.doc-r2') && init.method === 'PATCH') return response([]);
    throw new Error(`unexpected ${url}`);
  };
  try {
    const result = await processPersistentDocumentJob({
      env: {
        SUPABASE_URL: 'https://supabase.test',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role',
        URBAN_PROCURE_RFQ_DOCUMENTS: {
          async get(path) {
            assert.equal(path, 'c/r/boq.csv');
            return new Response('description,quantity,unit\nPainting,10,m2\n');
          }
        }
      },
      jobId: 'job-r2'
    });
    assert.equal(result.ok, true);
    assert.equal(result.job.status, 'completed');
    assert.equal(calls.some((call) => call.url.includes('/storage/v1/object/')), false);
  } finally { globalThis.fetch = previous; }
});

function response(body) { return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }); }

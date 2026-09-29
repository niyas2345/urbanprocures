import test from 'node:test';
import assert from 'node:assert/strict';
import { handleProcurementApi } from './procurement-pipeline.js';
import { createMemoryStore } from '../jobs/job-processor.js';

function request(method, path, { actor, body } = {}) {
  const headers = new Headers({
    Authorization: `Bearer test:${actor.role}:${actor.userId}`,
    'Content-Type': 'application/json',
  });
  return new Request(`https://urbanprocure.local${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

test('unauthorized RFQ upload is denied', async () => {
  const store = createMemoryStore();
  const res = await handleProcurementApi(
    request('POST', '/api/rfq/documents', {
      actor: { role: 'vendor', userId: 'v1' },
      body: { rfq_id: 'RFQ-1', file_name: 'a.csv', text: 'description,quantity,unit\nx,1,m\n' },
    }),
    { PROCUREMENT_TEST_AUTH: '1' },
    store
  );
  assert.equal(res.status, 403);
});

test('missing bearer is denied', async () => {
  const res = await handleProcurementApi(
    new Request('https://urbanprocure.local/api/rfq/documents', { method: 'POST', body: '{}' }),
    { PROCUREMENT_TEST_AUTH: '1' },
    createMemoryStore()
  );
  assert.equal(res.status, 401);
});

test('client upload queues extract job and processing persists result', async () => {
  const store = createMemoryStore();
  const env = { PROCUREMENT_TEST_AUTH: '1' };
  const uploaded = await handleProcurementApi(
    request('POST', '/api/rfq/documents', {
      actor: { role: 'client', userId: 'c1' },
      body: { rfq_id: 'RFQ-9', file_name: 'boq.csv', text: 'description,quantity,unit\nChiller,1,nr\n' },
    }),
    env,
    store
  );
  assert.equal(uploaded.status, 200);
  const payload = await uploaded.json();
  const processed = await handleProcurementApi(
    request('POST', '/api/procurement/jobs/process', {
      actor: { role: 'client', userId: 'c1' },
      body: { job_id: payload.attachments[0].job_id },
    }),
    env,
    store
  );
  const job = await processed.json();
  assert.equal(job.ok, true);
  assert.equal(job.job.status, 'completed');
  assert.equal(job.extraction.published, false);
  assert.equal(job.extraction.items[0].description, 'Chiller');
});

test('client upload returns safe metadata without private storage path', async () => {
  const store = createMemoryStore();
  const res = await handleProcurementApi(
    request('POST', '/api/rfq/documents', {
      actor: { role: 'client', userId: 'c1' },
      body: { rfq_id: 'RFQ-10', file_name: 'scope.pdf', text: '%PDF-1.4\n/Type /Font\n/ToUnicode\nBT (Scope) Tj ET\n%%EOF' },
    }),
    { PROCUREMENT_TEST_AUTH: '1' },
    store
  );
  const payload = await res.json();
  assert.equal(res.status, 200);
  assert.equal(JSON.stringify(payload).includes('storage_path'), false);
  assert.equal(JSON.stringify(payload).includes('publicUrl'), false);
  assert.equal(store.state.documents.size, 1);
  assert.equal(store.state.jobs.size, 1);
});

test('blocked upload stores rejected metadata but creates no extraction job', async () => {
  const store = createMemoryStore();
  const res = await handleProcurementApi(
    request('POST', '/api/rfq/documents', {
      actor: { role: 'client', userId: 'c1' },
      body: { rfq_id: 'RFQ-11', file_name: 'fake.pdf', text: 'not-a-pdf' },
    }),
    { PROCUREMENT_TEST_AUTH: '1' },
    store
  );
  const document = [...store.state.documents.values()][0];
  assert.equal(res.status, 200);
  assert.equal(document.processing_status, 'blocked');
  assert.equal(document.requires_human_review, true);
  assert.equal(store.state.jobs.size, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFile } from '../ai/file-classifier.js';
import { createMemoryStore, processDocumentJob } from './job-processor.js';

test('job processor completes extract jobs and persists document extraction', async () => {
  const bytes = Buffer.from('description,quantity,unit\nPump,2,nr\n');
  const store = seededStore({ bytes, fileName: 'boq.csv' });
  const result = await processDocumentJob({ jobId: 'job-1', store });
  const document = await store.getDocument('doc-1');

  assert.equal(result.ok, true);
  assert.equal(result.job.status, 'completed');
  assert.equal(document.processing_status, 'ready');
  assert.equal(document.extraction.items[0].description, 'Pump');
});

test('job processor is idempotent for completed jobs', async () => {
  const store = createMemoryStore({
    jobs: { 'job-1': { id: 'job-1', status: 'completed', result: { text: 'done', published: false } } },
  });
  const result = await processDocumentJob({ jobId: 'job-1', store });

  assert.equal(result.ok, true);
  assert.equal(result.idempotent, true);
  assert.equal(result.extraction.text, 'done');
});

test('job processor blocks rejected documents without extraction', async () => {
  const store = createMemoryStore({
    documents: { 'doc-1': { id: 'doc-1', processing_status: 'blocked', rejection_reason: 'spoofed_or_corrupt' } },
    jobs: { 'job-1': { id: 'job-1', document_id: 'doc-1', status: 'pending' } },
  });
  const result = await processDocumentJob({ jobId: 'job-1', store });

  assert.equal(result.ok, false);
  assert.equal(result.job.status, 'blocked');
  assert.equal(result.error, 'spoofed_or_corrupt');
});

test('job processor records failed extraction and can retry a failed job', async () => {
  const store = createMemoryStore({
    documents: { 'doc-1': { id: 'doc-1', original_filename: 'missing.csv', mime_type: 'text/csv', storage_path: 'missing', processing_status: 'pending' } },
    jobs: { 'job-1': { id: 'job-1', document_id: 'doc-1', status: 'pending' } },
  });
  const failed = await processDocumentJob({ jobId: 'job-1', store });
  assert.equal(failed.job.status, 'failed');

  await store.putObject('missing', Buffer.from('description,quantity,unit\nValve,1,nr\n'));
  await store.putDocument({ id: 'doc-1', original_filename: 'missing.csv', mime_type: 'text/csv', storage_path: 'missing', processing_status: 'pending' });
  await store.putJob({ id: 'job-1', document_id: 'doc-1', status: 'pending' });
  const retried = await processDocumentJob({ jobId: 'job-1', store });
  assert.equal(retried.ok, true);
  assert.equal(retried.job.status, 'completed');
});

function seededStore({ bytes, fileName }) {
  const classification = classifyFile({ fileName, mimeType: 'text/csv', bytes });
  return createMemoryStore({
    documents: {
      'doc-1': { id: 'doc-1', original_filename: fileName, mime_type: 'text/csv', storage_path: 'obj-1', processing_status: 'pending', classification },
    },
    jobs: { 'job-1': { id: 'job-1', document_id: 'doc-1', status: 'pending', classification } },
    objects: { 'obj-1': bytes },
  });
}

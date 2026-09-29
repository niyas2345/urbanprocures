import test from 'node:test';
import assert from 'node:assert/strict';
import { approveExternalDocument, createRfqProcessingPlan } from '../server/ai/pipeline.js';
import { sanitizeTextForExternalUse } from '../server/ai/document-firewall.js';

test('RFQ processing plan always targets a sanitized vendor document', () => {
  const plan = createRfqProcessingPlan({ rfqId: 'UP-TEST-001', documentId: 'DOC-001', sourceType: 'pdf' });
  assert.equal(plan.target_audience, 'vendor');
  assert.equal(plan.source_visibility, 'original_internal');
  assert.equal(plan.output_visibility, 'sanitized_vendor');
  assert.deepEqual(plan.steps, ['extract', 'normalize', 'identity_check', 'render_sanitized', 'human_review', 'publish']);
});

test('identity/contact information is sanitized before external use', () => {
  const text = 'ABC Development LLC | Contact: +971 50 123 4567 | procurement@abc.example';
  const sanitized = sanitizeTextForExternalUse(text);
  assert.equal(sanitized.includes('+971 50 123 4567'), false);
  assert.equal(sanitized.includes('procurement@abc.example'), false);
});

test('original and sanitized document references cannot be the same', () => {
  assert.throws(() => approveExternalDocument({ originalDocument: 'same', sanitizedDocument: 'same' }), /never reuse/);
});

test('sanitized document can be approved when references are distinct', () => {
  const result = approveExternalDocument({ originalDocument: 'original://DOC-1', sanitizedDocument: 'sanitized://DOC-1' });
  assert.equal(result.state, 'approved');
  assert.equal(result.external_document, 'sanitized://DOC-1');
});

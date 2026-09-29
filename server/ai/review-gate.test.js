import { strict as assert } from 'node:assert';
import test from 'node:test';
import { evaluateReviewGate } from './review-gate.js';

test('review gate blocks low confidence and external processing', () => {
  const result = evaluateReviewGate({ extraction: { status: 'pending_external', confidence: 0.5 } });
  assert.equal(result.allowed, false); assert.ok(result.reasons.includes('external_processing_required')); assert.ok(result.reasons.includes('low_extraction_confidence'));
});

test('review gate allows complete high-confidence BOQ', () => {
  assert.equal(evaluateReviewGate({ extraction: { status: 'extracted', confidence: 0.9 }, boq: { review_required: false } }).allowed, true);
});

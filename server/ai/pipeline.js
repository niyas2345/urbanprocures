import { assertExternalDocumentSafe, buildDocumentProcessingRecord } from './document-firewall.js';
import { createNormalizedRfq } from './rfq-normalizer.js';
import { createNormalizedQuotation } from './quotation-normalizer.js';

export const PROCESSING_STATES = Object.freeze({
  PENDING: 'pending', EXTRACTING: 'extracting', NORMALIZED: 'normalized',
  REVIEW_REQUIRED: 'review_required', APPROVED: 'approved', BLOCKED: 'blocked', FAILED: 'failed'
});

export function createRfqProcessingPlan({ rfqId, documentId, sourceType = 'upload' }) {
  const record = buildDocumentProcessingRecord({ rfqId, documentId, sourceType, targetAudience: 'vendor' });
  return { kind: 'rfq_processing', state: PROCESSING_STATES.PENDING, ...record,
    steps: ['extract', 'normalize', 'identity_check', 'render_sanitized', 'human_review', 'publish'] };
}

export function normalizeRfqInput(input) {
  return { ...createNormalizedRfq(input), processing_state: PROCESSING_STATES.REVIEW_REQUIRED };
}

export function normalizeQuotationInput(input) { return createNormalizedQuotation(input); }

export function approveExternalDocument({ originalDocument, sanitizedDocument }) {
  assertExternalDocumentSafe({ originalDocument, sanitizedDocument });
  return { state: PROCESSING_STATES.APPROVED, external_document: sanitizedDocument };
}

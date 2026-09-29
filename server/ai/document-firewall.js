/**
 * Urban Procure document firewall.
 *
 * This module deliberately does NOT edit the uploaded source file in place.
 * It provides deterministic, provider-agnostic document policies and text
 * sanitisation primitives for the API/AI pipeline.
 */

const IDENTITY_PATTERNS = [
  /\b(?:company|client|customer|owner|developer|contractor)\s*[:\-]\s*[^\n]{2,120}/gi,
  /\b(?:contact|tel|telephone|mobile|phone|fax)\s*[:\-]?\s*\+?[0-9 ()\-]{7,}/gi,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /https?:\/\/[^\s)]+/gi,
];

export const DOCUMENT_VISIBILITY = Object.freeze({
  ORIGINAL_INTERNAL: 'original_internal',
  SANITIZED_VENDOR: 'sanitized_vendor',
  SANITIZED_CLIENT: 'sanitized_client',
});

export function sanitizeTextForExternalUse(input = '') {
  let output = String(input);
  for (const pattern of IDENTITY_PATTERNS) {
    output = output.replace(pattern, '[PROTECTED CONTACT/IDENTITY INFORMATION]');
  }
  return output.replace(/\s{3,}/g, '\n\n').trim();
}

export function buildDocumentProcessingRecord({
  rfqId,
  documentId,
  sourceType,
  targetAudience,
}) {
  if (!rfqId || !documentId) throw new Error('rfqId and documentId are required');
  if (!['client', 'vendor'].includes(targetAudience)) {
    throw new Error('targetAudience must be client or vendor');
  }

  return {
    rfq_id: rfqId,
    document_id: documentId,
    source_type: sourceType || 'unknown',
    target_audience: targetAudience,
    source_visibility: DOCUMENT_VISIBILITY.ORIGINAL_INTERNAL,
    output_visibility:
      targetAudience === 'vendor'
        ? DOCUMENT_VISIBILITY.SANITIZED_VENDOR
        : DOCUMENT_VISIBILITY.SANITIZED_CLIENT,
    requires_human_review: false,
    status: 'pending',
  };
}

export function assertExternalDocumentSafe({ originalDocument, sanitizedDocument }) {
  if (!originalDocument || !sanitizedDocument) {
    throw new Error('Both original and sanitized document references are required');
  }
  if (originalDocument === sanitizedDocument) {
    throw new Error('External document must never reuse the original document reference');
  }
  return true;
}

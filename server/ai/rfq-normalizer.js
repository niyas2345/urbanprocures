/**
 * Canonical RFQ normalization boundary.
 * AI providers should map extracted information into this shape; business
 * rules and access control remain deterministic and server-side.
 */

export const RFQ_MODES = Object.freeze({
  READY_TO_QUOTE: 'ready_to_quote',
  TECHNICAL_ASSISTANCE: 'technical_assistance',
});

export function createNormalizedRfq(input = {}) {
  const mode = input.mode || RFQ_MODES.READY_TO_QUOTE;
  if (!Object.values(RFQ_MODES).includes(mode)) throw new Error('Invalid RFQ mode');

  return {
    rfq_number: input.rfq_number || null,
    mode,
    category: input.category || null,
    title: input.title || null,
    location: input.location || null,
    scope_summary: input.scope_summary || null,
    items: Array.isArray(input.items) ? input.items.map(normalizeItem) : [],
    specifications: Array.isArray(input.specifications) ? input.specifications : [],
    documents: Array.isArray(input.documents) ? input.documents : [],
    source_document_ids: Array.isArray(input.source_document_ids) ? input.source_document_ids : [],
    status: input.status || 'draft',
  };
}

function normalizeItem(item = {}) {
  const quantity = item.quantity == null ? null : Number(item.quantity);
  if (quantity != null && !Number.isFinite(quantity)) throw new Error('Invalid RFQ quantity');

  return {
    description: item.description || '',
    specification: item.specification || null,
    quantity,
    unit: item.unit || null,
  };
}

export function validateRfqForVendorPublication(rfq) {
  if (!rfq?.rfq_number) return { ok: false, reasons: ['RFQ number missing'] };
  if (!rfq.category) return { ok: false, reasons: ['Category missing'] };
  if (!rfq.title && !rfq.scope_summary) return { ok: false, reasons: ['Scope missing'] };

  const originalDocuments = (rfq.documents || []).filter(
    (document) => document.visibility === 'original_internal'
  );
  if (originalDocuments.length) {
    return { ok: false, reasons: ['Original internal documents cannot be published to vendors'] };
  }

  return { ok: true, reasons: [] };
}

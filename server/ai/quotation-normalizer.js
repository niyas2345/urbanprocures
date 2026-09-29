/**
 * Canonical vendor quotation shape.
 * Contact/identity information is retained only in the internal record.
 */

export function createNormalizedQuotation(input = {}) {
  const items = Array.isArray(input.items) ? input.items.map(normalizeItem) : [];
  const total = input.total == null ? calculateTotal(items) : Number(input.total);
  if (!Number.isFinite(total)) throw new Error('Invalid quotation total');

  return {
    quotation_id: input.quotation_id || null,
    rfq_number: input.rfq_number || null,
    vendor_reference: input.vendor_reference || null,
    items,
    subtotal: numberOrNull(input.subtotal),
    vat: numberOrNull(input.vat),
    total,
    currency: input.currency || 'AED',
    validity_days: numberOrNull(input.validity_days),
    completion_period: input.completion_period || null,
    warranty: input.warranty || null,
    inclusions: arrayOrEmpty(input.inclusions),
    exclusions: arrayOrEmpty(input.exclusions),
    payment_terms: input.payment_terms || null,
    document_ids: arrayOrEmpty(input.document_ids),
    visibility: 'sanitized_client',
    status: input.status || 'submitted',
  };
}

function normalizeItem(item = {}) {
  const quantity = numberOrNull(item.quantity);
  const unitRate = numberOrNull(item.unit_rate);
  const amount = item.amount == null && quantity != null && unitRate != null
    ? quantity * unitRate
    : numberOrNull(item.amount);

  return {
    description: item.description || '',
    specification: item.specification || null,
    quantity,
    unit: item.unit || null,
    unit_rate: unitRate,
    amount,
  };
}

function calculateTotal(items) {
  return items.reduce((sum, item) => sum + (item.amount || 0), 0);
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('Expected a numeric value');
  return n;
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

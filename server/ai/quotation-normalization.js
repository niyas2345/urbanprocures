/**
 * Vendor quotation normalization and comparison primitives.
 * Provider-agnostic: AI/OCR extraction can feed this module later.
 */

export function normalizeQuotation(input) {
  const items = Array.isArray(input?.items) ? input.items : [];
  const normalizedItems = items.map((item, index) => ({
    lineNumber: item.lineNumber ?? index + 1,
    description: String(item.description ?? '').trim(),
    quantity: numberOrNull(item.quantity),
    unit: String(item.unit ?? '').trim() || null,
    unitRate: numberOrNull(item.unitRate),
    amount: item.amount != null ? numberOrNull(item.amount) : (item.quantity != null && item.unitRate != null ? Number(item.quantity) * Number(item.unitRate) : null),
    specification: item.specification ?? null,
    discrepancy: item.amount != null && item.quantity != null && item.unitRate != null && Math.abs(Number(item.amount) - Number(item.quantity) * Number(item.unitRate)) > 0.02
  }));

  const calculatedSubtotal = normalizedItems.every((item) => item.amount != null) ? normalizedItems.reduce((sum, item) => sum + item.amount, 0) : null;
  const subtotal = input?.subtotal != null ? numberOrNull(input.subtotal) : calculatedSubtotal;
  const vat = input?.vat != null ? numberOrNull(input.vat) : null;
  const total = input?.total != null ? numberOrNull(input.total) : (subtotal != null && vat != null ? subtotal + vat : subtotal);

  return {
    rfqId: input?.rfqId ?? null,
    vendorId: input?.vendorId ?? null,
    currency: input?.currency ?? 'AED',
    items: normalizedItems,
    subtotal,
    vat,
    total,
    validityDays: input?.validityDays ?? null,
    completionDays: input?.completionDays ?? null,
    warranty: input?.warranty ?? null,
    inclusions: Array.isArray(input?.inclusions) ? input.inclusions : [],
    exclusions: Array.isArray(input?.exclusions) ? input.exclusions : [],
    paymentTerms: input?.paymentTerms ?? null,
    status: 'normalized',
    validation: validateCommercialArithmetic({ normalizedItems, subtotal, vat, total })
  };
}

function numberOrNull(value) { if (value == null || value === '') return null; const n = Number(String(value).replace(/,/g, '')); return Number.isFinite(n) ? n : null; }
function validateCommercialArithmetic({ normalizedItems, subtotal, vat, total }) {
  const discrepancies = normalizedItems.filter((item) => item.discrepancy).map((item) => `line_${item.lineNumber}_amount_mismatch`);
  if (subtotal != null && normalizedItems.every((item) => item.amount != null) && Math.abs(subtotal - normalizedItems.reduce((sum, item) => sum + item.amount, 0)) > 0.02) discrepancies.push('subtotal_mismatch');
  if (total != null && subtotal != null && vat != null && Math.abs(total - subtotal - vat) > 0.02) discrepancies.push('total_mismatch');
  return { valid: discrepancies.length === 0, discrepancies };
}

export function compareQuotations(quotations) {
  const normalized = (quotations ?? []).map(normalizeQuotation).filter(q => Number.isFinite(q.total));
  const ranked = [...normalized].sort((a, b) => a.total - b.total);
  const lowest = ranked[0]?.total ?? null;

  return ranked.map((quotation, index) => ({
    ...quotation,
    rank: index + 1,
    varianceFromLowest: lowest == null ? null : Number((quotation.total - lowest).toFixed(2)),
    variancePercent: lowest && lowest !== 0
      ? Number((((quotation.total - lowest) / lowest) * 100).toFixed(2))
      : 0
  }));
}

export function validateQuotationForClient(quotation) {
  const errors = [];
  if (!quotation?.rfqId) errors.push('RFQ reference is required');
  if (!quotation?.vendorId) errors.push('Internal vendor reference is required');
  if (!quotation?.items?.length) errors.push('At least one quotation line is required');
  if (!Number.isFinite(quotation?.total) || quotation.total < 0) errors.push('Valid quotation total is required');
  return { valid: errors.length === 0, errors };
}

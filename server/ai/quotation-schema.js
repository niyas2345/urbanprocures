// Canonical quotation contract. Vendor originals remain private; this is the
// normalized representation used for comparison and client presentation.

export function normalizeQuotation(input = {}) {
  return {
    id: input.id || null,
    rfq_id: input.rfq_id || null,
    vendor_label: input.vendor_label || "Vendor",
    amount: numberOrNull(input.amount),
    vat_pct: numberOrNull(input.vat_pct),
    vat_included: input.vat_included ?? null,
    duration: String(input.duration || "").trim(),
    validity: String(input.validity || "").trim(),
    warranty: String(input.warranty || "").trim(),
    inclusions: String(input.inclusions || "").trim(),
    exclusions: String(input.exclusions || "").trim(),
    payment_terms: String(input.payment_terms || "").trim(),
    line_items: Array.isArray(input.line_items) ? input.line_items.map((item, i) => ({
      line_no: item.line_no ?? i + 1,
      description: String(item.description || "").trim(),
      quantity: numberOrNull(item.quantity),
      unit: String(item.unit || "").trim(),
      rate: numberOrNull(item.rate),
      amount: numberOrNull(item.amount),
      notes: String(item.notes || "").trim()
    })) : []
  };
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

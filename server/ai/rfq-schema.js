// Canonical Urban Procure RFQ contract used by the intake/normalization layer.
// Keep this schema independent of any specific AI provider.

export const RFQ_CATEGORIES = Object.freeze([
  "Civil",
  "MEP",
  "HVAC",
  "Manpower Supply"
]);

export function createEmptyRFQ(overrides = {}) {
  return {
    id: null,
    source: "web",
    mode: "ready_to_quote",
    title: "",
    category: "",
    emirate: "Dubai",
    scope: "",
    items: [],
    specifications: [],
    attachments: [],
    technical_assistance: false,
    status: "Submitted",
    ...overrides
  };
}

export function validateRFQ(rfq) {
  const errors = [];
  if (!rfq || typeof rfq !== "object") return ["RFQ payload is required"];
  if (!rfq.title?.trim()) errors.push("title is required");
  if (!RFQ_CATEGORIES.includes(rfq.category)) errors.push("valid category is required");
  if (!rfq.scope?.trim() && !rfq.technical_assistance) errors.push("scope is required unless technical assistance is requested");
  if (!['ready_to_quote', 'technical_assistance'].includes(rfq.mode)) errors.push("invalid RFQ mode");
  if (rfq.technical_assistance !== (rfq.mode === 'technical_assistance')) errors.push("technical assistance flag must match RFQ mode");
  return errors;
}

export function normalizeRFQItems(items = []) {
  return items.map((item, index) => ({
    line_no: item.line_no ?? index + 1,
    description: String(item.description || "").trim(),
    quantity: item.quantity ?? null,
    unit: String(item.unit || "").trim(),
    specification: String(item.specification || "").trim(),
    notes: String(item.notes || "").trim()
  }));
}

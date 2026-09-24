const UNITS = new Set(['m²', 'm2', 'm³', 'm3', 'lm', 'm', 'nos', 'no', 'pcs', 'pc', 'kg', 'ton', 't', 'ls', 'item', 'day', 'hour', 'hr']);

export function reconstructBoq(extraction = {}) {
  const candidates = [];
  for (const item of extraction.items || []) candidates.push({ ...item, source: item.source || extraction.source_reference || null });
  for (const table of extraction.tables || []) {
    const headers = table.headers || [];
    for (let index = 0; index < (table.rows || []).length; index++) {
      const row = table.rows[index];
      const cells = Array.isArray(row) ? row : Object.values(row || {});
      const item = rowToItem(headers, cells, table, index);
      if (item.description || item.quantity != null || item.unit) candidates.push(item);
    }
  }
  const items = mergeContinuationRows(candidates).map((item, index) => ({
    section: item.section || null, item_number: item.item_number || String(index + 1),
    description: textOrNull(item.description), specification: textOrNull(item.specification),
    quantity: numberOrNull(item.quantity), unit: normalizeUnit(item.unit), unit_rate: numberOrNull(item.unit_rate),
    amount: numberOrNull(item.amount), currency: item.currency || null, remarks: textOrNull(item.remarks),
    source_document: item.source_document || extraction.metadata?.file_name || null,
    source_page: item.source_page ?? item.source?.page ?? null, source_sheet: item.source_sheet ?? item.source?.sheet ?? null,
    source_row: item.source_row ?? item.source?.row ?? null, source_cell: item.source_cell ?? item.source?.cell ?? null,
    extraction_confidence: confidenceFor(item, extraction),
  }));
  const review = reviewReasons(items, extraction);
  return { items, sections: [...new Set(items.map((item) => item.section).filter(Boolean))], review_required: review.length > 0, review_reasons: review };
}

export function reviewReasons(items, extraction = {}) {
  const reasons = [];
  if (!items.length) reasons.push('boq_table_not_reconstructed');
  if (Number(extraction.confidence || 0) < 0.7) reasons.push('low_extraction_confidence');
  if (items.some((item) => item.quantity == null && item.unit == null && item.description)) reasons.push('ambiguous_quantity_or_unit');
  if (items.some((item) => item.amount != null && item.quantity != null && item.unit_rate != null && Math.abs(item.amount - item.quantity * item.unit_rate) > 0.02)) reasons.push('line_total_mismatch');
  return [...new Set(reasons)];
}

function rowToItem(headers, row, table, rowIndex) {
  const get = (patterns) => { const index = headers.findIndex((header) => patterns.some((pattern) => pattern.test(String(header)))); return index >= 0 ? row[index] : null; };
  const description = get([/description|scope|work|item/i]);
  return { item_number: get([/^no\.?$|item\s*(no|number)|^#$/i]), description, specification: get([/spec|detail/i]),
    quantity: numeric(get([/^qty$|quantity/i])), unit: get([/^uom$|^unit$/i]), unit_rate: numeric(get([/unit\s*rate|rate|price/i])),
    amount: numeric(get([/amount|total|value/i])), section: table.section || null,
    source_sheet: table.name || null, source_row: rowIndex + 2, source_cell: `A${rowIndex + 2}` };
}
function mergeContinuationRows(items) { const out = []; for (const item of items) { if (!item.description && out.length) { out[out.length - 1].description = `${out[out.length - 1].description || ''} ${item.specification || item.remarks || ''}`.trim(); } else out.push(item); } return out; }
function numeric(value) { if (value == null || value === '') return null; const n = Number(String(value).replace(/[, ]/g, '')); return Number.isFinite(n) ? n : null; }
function numberOrNull(value) { return value == null || value === '' ? null : Number(value); }
function textOrNull(value) { return value == null || String(value).trim() === '' ? null : String(value).trim(); }
function normalizeUnit(value) { const unit = textOrNull(value); if (!unit) return null; const lower = unit.toLowerCase(); return UNITS.has(lower) ? lower : unit; }
function confidenceFor(item, extraction) { let score = Number(item.extraction_confidence ?? extraction.confidence ?? 0); if (item.quantity == null || item.unit == null) score -= 0.15; return Math.max(0, Math.min(1, Number(score.toFixed(2)))); }

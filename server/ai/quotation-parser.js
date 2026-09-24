/**
 * Vendor Quotation Parser
 * Extracts structured quotation data from vendor PDF/Excel/Word submissions
 */

import { extractDocumentAsync } from './document-extractor.js';
import { normalizeQuotation } from './quotation-normalizer.js';
import { validateQuotationForClient } from './quotation-normalization.js';
import { classifyFile } from './file-classifier.js';

export async function parseVendorQuotation({ fileName, mimeType, bytes, classification, env, ocrVisionProvider, aiProvider }) {
  // Step 1: Extract text/tables from document
  const extraction = await extractDocumentAsync({
    fileName, mimeType, bytes, classification, env, ocrVisionProvider
  });

  if (extraction.status !== 'extracted') {
    return { ok: false, error: 'Document extraction failed', extraction };
  }

  // Step 2: Use AI to structure the quotation
  const structured = await structureQuotationWithAI({ extraction, aiProvider });

  if (!structured.ok) {
    return { ok: false, error: structured.error, extraction };
  }

  // Step 3: Normalize and validate
  const normalized = normalizeQuotation(structured.quotation);
  const validation = validateQuotationForClient(normalized);

  // Step 4: Detect arithmetic discrepancies
  const arithmeticCheck = validateCommercialArithmetic(normalized);

  return {
    ok: true,
    extraction,
    structured: structured.quotation,
    normalized,
    validation,
    arithmetic: arithmeticCheck,
    confidence: structured.confidence || extraction.confidence || 0.7
  };
}

async function structureQuotationWithAI({ extraction, aiProvider }) {
  if (!aiProvider) {
    return fallbackQuotationStructure(extraction);
  }

  const prompt = buildQuotationPrompt(extraction);

  try {
    const response = await aiProvider.complete({ prompt, temperature: 0.1, maxTokens: 4000 });
    const parsed = parseAIQuotationResponse(response);
    return { ok: true, quotation: parsed, confidence: 0.85 };
  } catch (error) {
    return fallbackQuotationStructure(extraction, error.message);
  }
}

function buildQuotationPrompt(extraction) {
  return `
You are an expert quantity surveyor parsing a vendor's construction quotation.

Extract structured data and return ONLY valid JSON:
{
  "rfq_number": "string|null",
  "vendor_reference": "string|null",
  "vendor_name": "string|null",
  "items": [
    {
      "line_number": "number",
      "description": "string",
      "specification": "string|null",
      "quantity": "number|null",
      "unit": "string|null",
      "unit_rate": "number|null",
      "amount": "number|null"
    }
  ],
  "subtotal": "number|null",
  "vat": "number|null",
  "total": "number|null",
  "currency": "string",
  "validity_days": "number|null",
  "completion_period": "string|null",
  "warranty": "string|null",
  "inclusions": ["string"],
  "exclusions": ["string"],
  "payment_terms": "string|null",
  "notes": "string|null"
}

Rules:
1. Identify the vendor's company name if present
2. Extract ALL line items with description, qty, unit, rate, amount
3. Find subtotal, VAT, total - verify arithmetic
4. Extract commercial terms: validity, completion, warranty, payment terms
5. List inclusions and exclusions explicitly stated
6. Currency: default AED if not specified
7. Confidence 0-1 based on clarity

DOCUMENT TEXT:
${extraction.text?.slice(0, 12000) || 'NO TEXT'}

TABLES:
${(extraction.tables || []).slice(0, 5).map((t, i) => `Table ${i+1} (${t.name}): Headers: ${t.headers?.join(' | ')} | Rows: ${(t.rows || []).slice(0, 20).map(r => r.join(' | ')).join(' \\n ')}`).join('\n\n')}

PAGES:
${(extraction.pages || []).slice(0, 10).map(p => `Page ${p.page_number}: ${p.text?.slice(0, 500)}`).join('\n')}
`.trim();
}

function parseAIQuotationResponse(response) {
  let jsonStr = response.text || response.content || response;
  jsonStr = jsonStr.trim();

  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) jsonStr = codeBlockMatch[1];

  try {
    return JSON.parse(jsonStr);
  } catch (error) {
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[0]); } catch {}
    }
    throw new Error(`Failed to parse AI quotation response: ${error.message}`);
  }
}

function fallbackQuotationStructure(extraction, error) {
  // Use reconstructed BOQ items as quotation line items
  const items = (extraction.boq || extraction.items || []).map((item, idx) => ({
    line_number: idx + 1,
    description: item.description || `Item ${idx + 1}`,
    specification: item.specification || null,
    quantity: item.quantity,
    unit: item.unit,
    unit_rate: item.unit_rate,
    amount: item.amount
  }));

  // Try to find totals in text
  const totals = extractTotalsFromText(extraction.text || '');

  return {
    ok: true,
    quotation: {
      rfq_number: null,
      vendor_reference: null,
      vendor_name: extractVendorName(extraction.text || ''),
      items,
      subtotal: totals.subtotal,
      vat: totals.vat,
      total: totals.total,
      currency: 'AED',
      validity_days: null,
      completion_period: null,
      warranty: null,
      inclusions: [],
      exclusions: [],
      payment_terms: null,
      notes: error ? `AI parsing failed: ${error}. Used fallback.` : 'Used fallback parsing (no AI provider).'
    },
    confidence: 0.45
  };
}

function extractTotalsFromText(text) {
  const result = { subtotal: null, vat: null, total: null };

  // Look for patterns like "Total: AED 123,456.78" or "Subtotal: 100,000"
  const patterns = {
    subtotal: /(?:sub[\s-]?total|subtotal)[:\s]*([AED\s\$\d,]+\.?\d*)/gi,
    vat: /(?:vat|tax)[:\s]*([AED\s\$\d,]+\.?\d*)/gi,
    total: /(?:grand\s+)?total[:\s]*([AED\s\$\d,]+\.?\d*)/gi
  };

  for (const [key, pattern] of Object.entries(patterns)) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length) {
      const value = parseAmount(matches[matches.length - 1][1]);
      if (value != null) result[key] = value;
    }
  }

  // If only total found, estimate subtotal (assume 5% VAT)
  if (result.total != null && result.subtotal == null && result.vat == null) {
    result.vat = Math.round(result.total * 0.05 * 100) / 100;
    result.subtotal = Math.round((result.total - result.vat) * 100) / 100;
  }

  return result;
}

function parseAmount(str) {
  const cleaned = String(str).replace(/[AED\s\$,]/gi, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function extractVendorName(text) {
  // Look for company names - patterns like "LLC", "L.L.C", "Ltd", "Inc", "Est."
  const patterns = [
    /\b([A-Z][A-Za-z0-9\s&.'-]{2,60}?\s+(?:LLC|L\.L\.C\.|Ltd|Limited|Inc|Establishment|Est\.|Corp|Corporation))\b/gi,
    /\b([A-Z][A-Za-z0-9\s&.'-]{5,60})\b(?=\s*(?:Quotation|Quote|Proposal|Tender))/gi
  ];

  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length) return matches[0][1].trim();
  }
  return null;
}

function validateCommercialArithmetic(normalized) {
  const discrepancies = [];

  if (normalized.items) {
    for (const item of normalized.items) {
      if (item.discrepancy) discrepancies.push(`line_${item.lineNumber}_amount_mismatch`);
    }
  }

  if (normalized.subtotal != null && normalized.items?.every(i => i.amount != null)) {
    const calcSubtotal = normalized.items.reduce((sum, i) => sum + (i.amount || 0), 0);
    if (Math.abs(normalized.subtotal - calcSubtotal) > 0.02) discrepancies.push('subtotal_mismatch');
  }

  if (normalized.total != null && normalized.subtotal != null && normalized.vat != null) {
    if (Math.abs(normalized.total - normalized.subtotal - normalized.vat) > 0.02) discrepancies.push('total_mismatch');
  }

  return { valid: discrepancies.length === 0, discrepancies };
}

export async function batchParseQuotations({ files, env, ocrVisionProvider, aiProvider }) {
  const results = [];
  for (const file of files) {
    const classification = classifyFile({ fileName: file.name, mimeType: file.type, bytes: file.bytes });
    const result = await parseVendorQuotation({
      fileName: file.name,
      mimeType: file.type,
      bytes: file.bytes,
      classification,
      env,
      ocrVisionProvider,
      aiProvider
    });
    results.push({ file: file.name, ...result });
  }
  return results;
}
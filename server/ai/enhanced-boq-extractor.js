/**
 * Enhanced BOQ Extractor with AI/LLM integration
 * Extracts structured Bill of Quantities from complex construction documents
 */

import { reconstructBoq } from './boq-reconstructor.js';

export const BOQ_EXTRACTION_PROMPT = `
You are an expert construction quantity surveyor. Extract a structured Bill of Quantities (BOQ) from the provided document text.

Return ONLY valid JSON matching this schema:
{
  "items": [
    {
      "item_number": "string",
      "description": "string",
      "specification": "string|null",
      "quantity": "number|null",
      "unit": "string|null",
      "unit_rate": "number|null",
      "amount": "number|null",
      "section": "string|null",
      "source_reference": {"page": "number|null", "sheet": "string|null", "row": "number|null"}
    }
  ],
  "sections": ["string"],
  "project_info": {
    "project_name": "string|null",
    "client_name": "string|null",
    "location": "string|null",
    "currency": "string"
  },
  "confidence": "number",
  "extraction_notes": "string"
}

Rules:
1. Extract ALL line items with descriptions, quantities, units, rates, amounts
2. Preserve section/hierarchy structure (e.g., "1. Earthworks", "1.1 Excavation")
3. Identify units from standard construction units (m2, m3, m, nr, item, kg, t, hr, day, ls)
4. If unit_rate and quantity exist but amount missing, calculate amount
5. If amount and quantity exist but rate missing, calculate rate
6. Flag items with missing critical data (quantity OR unit)
7. Confidence: 0.0-1.0 based on completeness and clarity
8. Notes: any ambiguities, merged cells, continued rows, assumptions
`;

export async function extractBoqWithAI({ text, tables, pages, provider, model, documentType = 'boq' }) {
  if (!provider) {
    return fallbackBoqExtraction({ text, tables, pages });
  }

  const input = buildExtractionInput({ text, tables, pages, documentType });
  const prompt = BOQ_EXTRACTION_PROMPT + '\n\nDOCUMENT:\n' + input;

  try {
    const response = await provider.complete({ prompt, model, temperature: 0.1, maxTokens: 8000 });
    const parsed = parseAIResponse(response);
    return enhanceWithReconstruction(parsed, { text, tables, pages });
  } catch (error) {
    return fallbackBoqExtraction({ text, tables, pages, error: error.message });
  }
}

function buildExtractionInput({ text, tables, pages, documentType }) {
  let input = `Document Type: ${documentType}\n\n`;

  if (pages?.length) {
    input += `PAGES (${pages.length}):\n`;
    for (const page of pages.slice(0, 20)) {
      input += `--- Page ${page.page_number} ---\n${page.text?.slice(0, 2000)}\n\n`;
    }
  } else if (text) {
    input += `FULL TEXT:\n${text.slice(0, 15000)}\n\n`;
  }

  if (tables?.length) {
    input += `TABLES (${tables.length}):\n`;
    for (const table of tables.slice(0, 10)) {
      input += `Table: ${table.name || 'unnamed'}\nHeaders: ${table.headers?.join(' | ')}\n`;
      for (const row of (table.rows || []).slice(0, 30)) {
        input += row.join(' | ') + '\n';
      }
      input += '\n';
    }
  }

  return input;
}

function parseAIResponse(response) {
  let jsonStr = response.text || response.content || response;
  jsonStr = jsonStr.trim();

  // Extract JSON from markdown code blocks
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) jsonStr = codeBlockMatch[1];

  try {
    return JSON.parse(jsonStr);
  } catch (error) {
    // Try to find JSON object in text
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[0]); } catch {}
    }
    throw new Error(`Failed to parse AI response: ${error.message}`);
  }
}

function enhanceWithReconstruction(aiResult, original) {
  if (!aiResult?.items?.length) {
    return fallbackBoqExtraction(original);
  }

  // Validate and enrich each item
  const validatedItems = aiResult.items.map((item, idx) => {
    const validated = { ...item };
    validated.item_number = item.item_number || String(idx + 1);
    validated.description = item.description || `Item ${idx + 1}`;
    validated.quantity = validateNumber(item.quantity);
    validated.unit = validateUnit(item.unit);
    validated.unit_rate = validateNumber(item.unit_rate);
    validated.amount = validateNumber(item.amount);
    validated.section = item.section || null;
    validated.specification = item.specification || null;
    validated.source_reference = item.source_reference || {};

    // Calculate missing values
    if (validated.amount == null && validated.quantity != null && validated.unit_rate != null) {
      validated.amount = validated.quantity * validated.unit_rate;
    }
    if (validated.unit_rate == null && validated.amount != null && validated.quantity != null && validated.quantity !== 0) {
      validated.unit_rate = validated.amount / validated.quantity;
    }

    return validated;
  });

  // Run reconstruction for additional validation
  const reconstruction = reconstructBoq({ items: validatedItems, tables: original.tables, confidence: aiResult.confidence || 0.8 });

  return {
    items: validatedItems,
    sections: aiResult.sections || reconstruction.sections,
    project_info: aiResult.project_info || { currency: 'AED' },
    confidence: Math.min(aiResult.confidence || 0.8, 0.95),
    extraction_notes: aiResult.extraction_notes || '',
    review_required: reconstruction.review_required,
    review_reasons: reconstruction.review_reasons,
    source_extraction: 'ai_enhanced'
  };
}

function fallbackBoqExtraction({ text, tables, pages, error }) {
  const reconstruction = reconstructBoq({ text, tables, pages, items: [], confidence: 0.5 });
  return {
    items: reconstruction.items,
    sections: reconstruction.sections,
    project_info: { currency: 'AED' },
    confidence: 0.4,
    extraction_notes: error ? `AI extraction failed: ${error}. Used fallback reconstruction.` : 'Used fallback reconstruction (no AI provider).',
    review_required: reconstruction.review_required,
    review_reasons: reconstruction.review_reasons,
    source_extraction: 'fallback'
  };
}

function validateNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function validateUnit(value) {
  if (!value) return null;
  const standardUnits = ['m2', 'm²', 'm3', 'm³', 'm', 'lm', 'nr', 'no', 'nos', 'pcs', 'pc', 'kg', 'ton', 't', 'ls', 'item', 'day', 'hr', 'hour', 'week', 'month'];
  const normalized = String(value).toLowerCase().replace(/[²³]/g, m => m === '²' ? '2' : '3');
  return standardUnits.includes(normalized) ? normalized : value;
}

export function validateBoqCompleteness(boq) {
  const issues = [];
  if (!boq.items?.length) issues.push('no_items_extracted');
  const missingQty = boq.items?.filter(i => i.quantity == null).length || 0;
  const missingUnit = boq.items?.filter(i => !i.unit).length || 0;
  const missingRate = boq.items?.filter(i => i.unit_rate == null).length || 0;
  if (missingQty > 0) issues.push(`${missingQty}_items_missing_quantity`);
  if (missingUnit > 0) issues.push(`${missingUnit}_items_missing_unit`);
  if (missingRate > 0) issues.push(`${missingRate}_items_missing_rate`);
  if (boq.confidence < 0.6) issues.push('low_confidence');
  return { complete: issues.length === 0, issues, completeness_score: boq.items?.length ? 1 - (missingQty + missingUnit) / (boq.items.length * 2) : 0 };
}

export function mergeBoqExtractions(extractions) {
  if (!extractions?.length) return { items: [], sections: [], confidence: 0 };
  if (extractions.length === 1) return extractions[0];

  const allItems = extractions.flatMap(e => e.items || []);
  const allSections = [...new Set(extractions.flatMap(e => e.sections || []))];
  const avgConfidence = extractions.reduce((sum, e) => sum + (e.confidence || 0), 0) / extractions.length;

  return {
    items: allItems,
    sections: allSections,
    project_info: extractions[0]?.project_info || { currency: 'AED' },
    confidence: Math.min(avgConfidence, 0.9),
    extraction_notes: `Merged from ${extractions.length} extractions`,
    review_required: extractions.some(e => e.review_required),
    review_reasons: [...new Set(extractions.flatMap(e => e.review_reasons || []))],
    source_extraction: 'merged'
  };
}
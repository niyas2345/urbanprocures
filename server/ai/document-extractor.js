import { CLASSIFICATION, classifyFile } from './file-classifier.js';
import { reconstructBoq } from './boq-reconstructor.js';
import { runOcrVision } from './ocr-vision.js';
import { inspectZipArchive } from './archive-inspector.js';

export const EXTRACTION_STATUS = Object.freeze({
  EXTRACTED: 'extracted',
  PENDING_EXTERNAL: 'pending_external',
  BLOCKED: 'blocked',
  FAILED: 'failed',
});

export function extractDocument({ fileName = '', mimeType = '', bytes, classification } = {}) {
  const cls = classification || classifyFile({ fileName, mimeType, bytes });
  const base = canonicalBase({ fileName, mimeType, bytes, classification: cls });
  if (!cls.ok) return blocked(base, cls.reason || 'blocked_by_classifier');

  try {
    if (cls.route === CLASSIFICATION.OCR_PENDING) return pending(base, 'ocr', 'ocr_required');
    if (cls.route === CLASSIFICATION.VISION_PENDING) return pending(base, 'vision', 'vision_required');
    if (cls.route === CLASSIFICATION.CAD_PENDING) return pending(base, 'cad', 'cad_requires_external_processor');
    if (cls.route === CLASSIFICATION.ARCHIVE_HOLD) return pending(base, 'archive', 'archive_requires_controlled_inspection');

    if (cls.format === 'pdf') return extractPdf(base);
    if (cls.format === 'csv') return withBoq(extractCsv(base));
    if (cls.format === 'txt') return extractText(base, 'text');
    if (cls.format === 'rtf') return extractRtf(base);

    if (['doc', 'docx', 'odt'].includes(cls.format)) return pending(base, 'office', `${cls.format}_requires_async_office_parser`);
    if (['xls', 'xlsx', 'ods'].includes(cls.format)) return pending(base, 'spreadsheet', `${cls.format}_requires_async_spreadsheet_parser`);
    if (['ppt', 'pptx'].includes(cls.format)) return pending(base, 'presentation', `${cls.format}_requires_async_presentation_parser`);
  } catch (error) {
    return failed(base, error?.message || 'extraction_failed');
  }

  return failed(base, `no_extractor_for_${cls.format || 'unknown'}`);
}

/** Async runtime entry point used by jobs. ZIP-based Office formats are parsed
 * with the platform DecompressionStream API; old OLE formats stay pending. */
export async function extractDocumentAsync({ fileName = '', mimeType = '', bytes, classification, env = {}, ocrVisionProvider } = {}) {
  const cls = classification || classifyFile({ fileName, mimeType, bytes });
  const base = canonicalBase({ fileName, mimeType, bytes, classification: cls });
  if (!cls.ok) return blocked(base, cls.reason || 'blocked_by_classifier');
  if ([CLASSIFICATION.OCR_PENDING, CLASSIFICATION.VISION_PENDING].includes(cls.route)) {
    const vision = await runOcrVision({ bytes, fileName, mimeType, provider: ocrVisionProvider, env });
    const detail = { ...base, adapter: vision.provider, confidence: vision.confidence, metadata: { ...base.metadata, provider: vision.provider, model: vision.model, warnings: vision.warnings, failure_reason: vision.failure_reason } };
    if (vision.status === 'failed') return failed(detail, vision.failure_reason || 'ocr_vision_failed');
    if (vision.status !== 'extracted') return pending(detail, cls.route === CLASSIFICATION.OCR_PENDING ? 'ocr' : 'vision', vision.failure_reason || 'external_processing_required');
    return withBoq({ ...base, status: EXTRACTION_STATUS.EXTRACTED, extraction_method: vision.provider || 'ocr_vision', adapter: vision.provider, text: vision.text, pages: vision.pages, tables: vision.tables, confidence: vision.confidence, metadata: { ...base.metadata, provider: vision.provider, model: vision.model, warnings: vision.warnings } });
  }
  if (['docx', 'xlsx', 'pptx', 'odt', 'ods'].includes(cls.format)) {
    const entries = await readZipEntries(toBuffer(bytes));
    if (!entries) return pending(base, cls.route === CLASSIFICATION.EXTRACT_SPREADSHEET ? 'spreadsheet' : cls.route === CLASSIFICATION.EXTRACT_PRESENTATION ? 'presentation' : 'office', 'zip_parser_unavailable_or_invalid');
    if (['xlsx', 'ods'].includes(cls.format)) return withBoq(parseSpreadsheet(entries, cls.format, base));
    if (cls.format === 'pptx') return parsePresentation(entries, base);
    return parseWord(entries, base);
  }
  if (cls.format === 'zip') return { ...pending(base, 'archive', 'archive_requires_controlled_inspection'), archive: inspectZipArchive(bytes) };
  if (cls.format === 'rar') return pending(base, 'archive', 'rar_requires_manual_inspection');
  return withBoq(extractDocument({ fileName, mimeType, bytes, classification: cls }));
}

function extractPdf(base) {
  const sample = text(base.bytes, 'latin1');
  if (!sample.startsWith('%PDF') || !sample.includes('%%EOF')) return failed(base, 'corrupt_pdf');
  if (base.classification.route === CLASSIFICATION.OCR_PENDING) return pending(base, 'ocr', 'ocr_required');

  const pieces = [];
  for (const match of sample.matchAll(/\(([^()]*)\)\s*Tj/g)) pieces.push(decodePdfString(match[1]));
  for (const match of sample.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
    const value = [...match[1].matchAll(/\(([^()]*)\)/g)].map((part) => decodePdfString(part[1])).join('');
    if (value) pieces.push(value);
  }
  const cleaned = pieces.map((value) => value.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!cleaned.length) return pending(base, 'ocr', 'no_native_pdf_text_extracted');

  return withBoq({
    ...base,
    status: EXTRACTION_STATUS.EXTRACTED,
    extraction_method: 'native_pdf_text',
    text: cleaned.join('\n'),
    pages: pdfPages(sample, cleaned),
    blocks: cleaned.map((value, index) => ({ type: 'text', text: value, page: Math.min(index + 1, Math.max(1, pageCount(sample))) })),
    confidence: 0.82,
  });
}

function parseSpreadsheet(entries, format, base) {
  const workbook = entries.get('xl/workbook.xml') || entries.get('content.xml');
  const shared = [...String(entries.get('xl/sharedStrings.xml') || '').matchAll(/<si\b[\s\S]*?<\/si>/gi)].map((match) => xmlTexts(match[0]));
  const sheetEntries = [...entries.entries()].filter(([name]) => /(?:xl\/worksheets\/sheet\d+\.xml|content\.xml)$/.test(name));
  const tables = sheetEntries.map(([name, xml]) => {
    const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)].map((rowMatch) => [...rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)].map((cell) => { const type = cell[1].match(/\bt="([^"]+)"/i)?.[1]; const value = xmlTexts(cell[2]); return type === 's' ? (shared[Number(value)] || '') : value; }));
    return { name: name.split('/').pop().replace(/\.xml$/, '') || format, headers: rows[0] || [], rows: rows.slice(1), likely_boq: likelyBoq((rows[0] || []).join(' ')) };
  });
  const textValue = tables.flatMap((table) => [table.headers, ...table.rows]).flat().join(' ').trim();
  return withBoq({ ...base, status: EXTRACTION_STATUS.EXTRACTED, extraction_method: `${format}_xml`, text: textValue, sheets: tables, tables, confidence: tables.length ? 0.84 : 0.35 });
}

function parseWord(entries, base) {
  const xml = entries.get('word/document.xml') || entries.get('content.xml') || '';
  const textValue = xmlTexts(xml);
  const blocks = [...xml.matchAll(/<w:(?:p|tr)\b[\s\S]*?<\/w:(?:p|tr)>/gi)].map((match, index) => ({ type: match[0].includes('<w:tr') ? 'table_row' : 'paragraph', text: xmlTexts(match[0]), index })).filter((item) => item.text);
  if (!textValue) return failed(base, 'empty_word_document');
  return withBoq({ ...base, status: EXTRACTION_STATUS.EXTRACTED, extraction_method: 'office_xml', text: textValue, blocks, confidence: 0.82 });
}

function parsePresentation(entries, base) {
  const slides = [...entries.entries()].filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map(([name, xml], index) => ({ slide_number: index + 1, text: xmlTexts(xml), source_reference: { slide: index + 1 } }));
  return { ...base, status: EXTRACTION_STATUS.EXTRACTED, extraction_method: 'presentation_xml', text: slides.map((slide) => slide.text).filter(Boolean).join('\n'), slides, confidence: slides.length ? 0.8 : 0.35 };
}

async function readZipEntries(bytes) {
  const buf = toBuffer(bytes); const entries = new Map(); let offset = 0; let count = 0;
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) return null;
  while (offset + 30 < buf.length && count++ < 500) {
    const signature = buf.readUInt32LE(offset); if (signature !== 0x04034b50) break;
    const method = buf.readUInt16LE(offset + 8); const compressedSize = buf.readUInt32LE(offset + 18); const nameLength = buf.readUInt16LE(offset + 26); const extraLength = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + nameLength).toString(); const start = offset + 30 + nameLength + extraLength; const compressed = buf.subarray(start, start + compressedSize);
    if (name.includes('..') || name.startsWith('/')) return null;
    if (method === 0) entries.set(name, compressed.toString('utf8'));
    else if (method === 8 && typeof DecompressionStream !== 'undefined') entries.set(name, new TextDecoder().decode(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()));
    offset = start + compressedSize;
  }
  return entries;
}

function xmlTexts(xml) { return String(xml || '').replace(/<w:tab\s*\/?>/gi, '\t').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim(); }
function withBoq(extraction) { return extraction?.status === EXTRACTION_STATUS.EXTRACTED ? { ...extraction, boq: reconstructBoq(extraction) } : extraction; }

function extractCsv(base) {
  const body = text(base.bytes).trim();
  if (!body) return failed(base, 'empty_csv');
  const rows = body.split(/\r?\n/).filter(Boolean).map(splitCsv);
  const [headers = [], ...dataRows] = rows;
  const items = dataRows.map((row) => rowToItem(headers, row)).filter((item) => item.description || item.quantity != null || item.unit);

  return {
    ...base,
    status: EXTRACTION_STATUS.EXTRACTED,
    extraction_method: 'csv',
    text: body,
    sheets: [{ name: 'CSV', rows, likely_boq: likelyBoq(headers.join(' ')) }],
    tables: [{ name: 'CSV', headers, rows: dataRows, likely_boq: likelyBoq(headers.join(' ')) }],
    items,
    confidence: 0.86,
  };
}

function extractText(base, method) {
  const body = text(base.bytes).trim();
  if (!body) return failed(base, 'empty_text');
  return {
    ...base,
    status: EXTRACTION_STATUS.EXTRACTED,
    extraction_method: method,
    text: body,
    blocks: body.split(/\n{2,}/).map((value, index) => ({ type: 'paragraph', text: value.trim(), index })).filter((block) => block.text),
    confidence: 0.9,
  };
}

function extractRtf(base) {
  const body = text(base.bytes)
    .replace(/\\'[0-9a-f]{2}/gi, ' ')
    .replace(/[{}]|\\[a-z]+\d* ?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!body) return failed(base, 'empty_rtf');
  return {
    ...base,
    status: EXTRACTION_STATUS.EXTRACTED,
    extraction_method: 'rtf_text',
    text: body,
    blocks: [{ type: 'paragraph', text: body, index: 0 }],
    confidence: 0.74,
  };
}

function canonicalBase({ fileName, mimeType, bytes, classification }) {
  const buf = toBuffer(bytes);
  return {
    status: 'pending',
    format: classification.format || 'unknown',
    route: classification.route,
    adapter: null,
    text: '',
    content: null,
    metadata: {
      file_name: fileName,
      mime_type: mimeType || classification.detected_mime || 'application/octet-stream',
      size_bytes: buf.length,
      detected_mime: classification.detected_mime,
      reason: classification.reason,
    },
    pages: [],
    sheets: [],
    slides: [],
    blocks: [],
    tables: [],
    items: [],
    source_reference: null,
    extraction_method: null,
    requires_external_processing: false,
    external_processor_type: null,
    requires_human_review: false,
    confidence: 0,
    error: null,
    reason: null,
    published: false,
    classification,
    bytes: buf,
  };
}

function pending(base, adapter, reason) {
  return {
    ...withoutBytes(base),
    status: EXTRACTION_STATUS.PENDING_EXTERNAL,
    adapter,
    requires_external_processing: true,
    external_processor_type: adapter,
    requires_human_review: true,
    reason,
    confidence: 0.5,
  };
}

function blocked(base, reason) {
  return {
    ...withoutBytes(base),
    status: EXTRACTION_STATUS.BLOCKED,
    requires_human_review: true,
    error: reason,
    reason,
    confidence: 0,
  };
}

function failed(base, reason) {
  return {
    ...withoutBytes(base),
    status: EXTRACTION_STATUS.FAILED,
    requires_human_review: true,
    error: reason,
    reason,
    confidence: 0,
  };
}

function withoutBytes(result) {
  const { bytes, ...safe } = result;
  return safe;
}

function text(bytes, encoding = 'utf8') {
  return toBuffer(bytes).toString(encoding);
}

function pdfPages(sample, pieces) {
  const count = pageCount(sample);
  return Array.from({ length: count }, (_, index) => ({
    page_number: index + 1,
    text: pieces[index] || '',
    source_reference: { page: index + 1 },
  }));
}

function pageCount(sample) {
  return Math.max(1, (sample.match(/\/Type\s*\/Page[^s]/g) || []).length || Number(sample.match(/\/Count\s+(\d+)/)?.[1] || 1));
}

function decodePdfString(value) {
  return value.replace(/\\([nrtbf()\\])/g, (_, char) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' })[char] || char);
}

function rowToItem(headers, row) {
  const get = (patterns) => {
    const index = headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
    return index >= 0 ? row[index] : '';
  };
  const quantity = Number(get([/\bqty\b/i, /quantity/i]));
  return {
    description: get([/description/i, /item/i, /scope/i]),
    quantity: Number.isFinite(quantity) ? quantity : null,
    unit: get([/\bunit\b/i, /\buom\b/i]),
  };
}

function likelyBoq(value) {
  return /\b(boq|bill of quantities|qty|quantity|unit|rate|amount|description)\b/i.test(value || '');
}

function splitCsv(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      current += '"';
      index++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function toBuffer(bytes) {
  if (!bytes) return Buffer.alloc(0);
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (typeof bytes === 'string') return Buffer.from(bytes);
  return Buffer.alloc(0);
}

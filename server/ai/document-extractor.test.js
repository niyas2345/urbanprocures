import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDocument, extractDocumentAsync, EXTRACTION_STATUS } from './document-extractor.js';

test('extracts csv structured items without inventing values', () => {
  const bytes = Buffer.from('description,quantity,unit\nWaterproofing,100,m2\nScreed,20,m3\n');
  const result = extractDocument({ fileName: 'boq.csv', mimeType: 'text/csv', bytes });
  assert.equal(result.status, EXTRACTION_STATUS.EXTRACTED);
  assert.equal(result.published, false);
  assert.equal(result.items[0].description, 'Waterproofing');
  assert.equal(result.items[0].quantity, 100);
  assert.equal(result.items[0].unit, 'm2');
});

test('does not fake OCR for scanned pdf', () => {
  const bytes = Buffer.from('%PDF-1.4\n/Type /Page\n/XObject /Image\n%%EOF');
  const result = extractDocument({ fileName: 'scan.pdf', bytes });
  assert.equal(result.status, EXTRACTION_STATUS.PENDING_EXTERNAL);
  assert.equal(result.adapter, 'ocr');
  assert.equal(result.text, '');
});

test('does not fake vision for images', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const result = extractDocument({ fileName: 'site.png', bytes: png });
  assert.equal(result.status, EXTRACTION_STATUS.PENDING_EXTERNAL);
  assert.equal(result.adapter, 'vision');
});

test('blocks spoofed files', () => {
  const result = extractDocument({ fileName: 'scope.pdf', bytes: Buffer.from('not-a-pdf') });
  assert.equal(result.status, EXTRACTION_STATUS.BLOCKED);
});

test('extracts text-native pdf strings', () => {
  const bytes = Buffer.from('%PDF-1.4\n/Type /Font\n/ToUnicode\nBT (Replace AHU at roof plant) Tj ET\n%%EOF');
  const result = extractDocument({ fileName: 'scope.pdf', bytes });
  assert.equal(result.status, EXTRACTION_STATUS.EXTRACTED);
  assert.match(result.text, /Replace AHU/);
});

test('archives stay unpublished and unextracted', () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  const result = extractDocument({ fileName: 'docs.zip', bytes: zip });
  assert.equal(result.status, EXTRACTION_STATUS.PENDING_EXTERNAL);
  assert.equal(result.published, false);
  assert.equal(result.text, '');
});

test('async XLSX extraction reconstructs a traceable BOQ without invented values', async () => {
  const xml = '<?xml version="1.0"?><worksheet><sheetData><row><c><v>Description</v></c><c><v>Qty</v></c><c><v>Unit</v></c></row><row><c><v>Painting</v></c><c><v>50</v></c><c><v>m2</v></c></row></sheetData></worksheet>';
  const bytes = storedZip({ 'xl/worksheets/sheet1.xml': xml });
  const result = await extractDocumentAsync({ fileName: 'boq.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes });
  assert.equal(result.status, EXTRACTION_STATUS.EXTRACTED);
  assert.equal(result.boq.items[0].quantity, 50);
  assert.equal(result.boq.items[0].source_sheet, 'sheet1');
});

test('OCR failure is recorded as failed instead of left processing', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const result = await extractDocumentAsync({ fileName: 'scan.png', mimeType: 'image/png', bytes: png, ocrVisionProvider: { name: 'ocr.space', extract: async () => ({ status: 'failed', failure_reason: 'ocr_space_file_over_1mb', provider: 'ocr.space' }) } });
  assert.equal(result.status, EXTRACTION_STATUS.FAILED);
  assert.equal(result.error, 'ocr_space_file_over_1mb');
});
test('OCR/Vision adapter remains pending when no provider is configured', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const result = await extractDocumentAsync({ fileName: 'scan.png', mimeType: 'image/png', bytes: png });
  assert.equal(result.status, EXTRACTION_STATUS.PENDING_EXTERNAL);
  assert.equal(result.adapter, 'vision');
  assert.equal(result.requires_human_review, true);
});

function storedZip(entries) {
  const chunks = [];
  for (const [name, value] of Object.entries(entries)) {
    const data = Buffer.from(value); const nameBytes = Buffer.from(name); const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0, 6); header.writeUInt16LE(0, 8); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(nameBytes.length, 26); header.writeUInt16LE(0, 28);
    chunks.push(header, nameBytes, data);
  }
  return Buffer.concat(chunks);
}

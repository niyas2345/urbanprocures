import test from 'node:test';
import assert from 'node:assert/strict';
import { CLASSIFICATION, classifyFile } from './file-classifier.js';

test('classifies text-native pdf for extraction', () => {
  const bytes = Buffer.from('%PDF-1.4\n1 0 obj\n/Type /Font\n/ToUnicode\nBT (Waterproofing to roof slab) Tj ET\n%%EOF');
  const result = classifyFile({ fileName: 'scope.pdf', mimeType: 'application/pdf', bytes });
  assert.equal(result.ok, true);
  assert.equal(result.route, CLASSIFICATION.EXTRACT_TEXT);
});

test('routes scanned pdf to OCR pending', () => {
  const bytes = Buffer.from('%PDF-1.4\n/Type /Page\n/XObject /Image\n%%EOF');
  const result = classifyFile({ fileName: 'scan.pdf', bytes });
  assert.equal(result.route, CLASSIFICATION.OCR_PENDING);
  assert.equal(result.processing_state, 'ocr_pending');
});

test('routes images to vision pending', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const result = classifyFile({ fileName: 'drawing.png', mimeType: 'image/png', bytes: png });
  assert.equal(result.route, CLASSIFICATION.VISION_PENDING);
});

test('rejects spoofed pdf bytes named as pdf', () => {
  const result = classifyFile({ fileName: 'fake.pdf', bytes: Buffer.from('\x89PNG\r\n') });
  assert.equal(result.ok, false);
  assert.equal(result.route, CLASSIFICATION.BLOCKED);
});

test('holds zip/rar without extraction', () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  const result = classifyFile({ fileName: 'pack.zip', bytes: zip });
  assert.equal(result.route, CLASSIFICATION.ARCHIVE_HOLD);
});

test('rejects unsupported executables', () => {
  const result = classifyFile({ fileName: 'malware.exe', bytes: Buffer.from('MZ') });
  assert.equal(result.ok, false);
});

test('routes dwg/dxf to cad pending', () => {
  const result = classifyFile({ fileName: 'plan.dxf', bytes: Buffer.from('AC1027....section') });
  assert.equal(result.route, CLASSIFICATION.CAD_PENDING);
});

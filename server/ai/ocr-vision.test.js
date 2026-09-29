import { strict as assert } from 'node:assert';
import test from 'node:test';
import { runOcrVision, ocrSpaceResult } from './ocr-vision.js';

test('OCR/Vision adapter normalizes provider output and metadata', async () => {
  const result = await runOcrVision({ fileName: 'scan.png', provider: { name: 'fixture', extract: async () => ({ status: 'extracted', text: 'Painting', pages: [{ page_number: 1, text: 'Painting' }], tables: [], confidence: 0.91, model: 'fixture-v1', warnings: [] }) } });
  assert.equal(result.status, 'extracted'); assert.equal(result.provider, 'fixture'); assert.equal(result.confidence, 0.91); assert.equal(result.pages[0].page_number, 1);
});

test('OCR.space reports an invalid key instead of empty text', () => {
  const result = ocrSpaceResult({ IsErroredOnProcessing: true, OCRExitCode: 3, ErrorMessage: ['Invalid API key'] });
  assert.equal(result.status, 'failed');
  assert.equal(result.failure_reason, 'ocr_space_invalid_key');
});
test('OCR.space payload becomes extracted text', () => {
  const result = ocrSpaceResult({ ParsedResults: [{ ParsedText: 'Civil works\nAED 1200' }], IsErroredOnProcessing: false, OCRExitCode: 1 });
  assert.equal(result.status, 'extracted');
  assert.equal(result.pages[0].text, 'Civil works\nAED 1200');
});
test('OCR/Vision adapter fails closed on provider errors', async () => {
  const result = await runOcrVision({ provider: { name: 'broken', extract: async () => { throw new Error('timeout'); } } });
  assert.equal(result.status, 'failed'); assert.equal(result.confidence, 0); assert.match(result.failure_reason, /timeout/);
});

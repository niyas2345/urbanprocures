import { strict as assert } from 'node:assert';
import test from 'node:test';
import { normalizeQuotation, compareQuotations, validateQuotationForClient } from './quotation-normalization.js';

test('normalizes quotation line totals', () => {
  const q = normalizeQuotation({ rfqId: 'rfq-1', vendorId: 'vendor-1', items: [{ description: 'Waterproofing', quantity: 100, unit: 'm2', unitRate: 25 }] });
  assert.equal(q.items[0].amount, 2500);
  assert.equal(q.subtotal, 2500);
  assert.equal(q.total, 2500);
});

test('ranks quotations and calculates variance', () => {
  const result = compareQuotations([
    { rfqId: 'r', vendorId: 'v2', total: 1100, items: [{ description: 'x', quantity: 1, unitRate: 1100 }] },
    { rfqId: 'r', vendorId: 'v1', total: 1000, items: [{ description: 'x', quantity: 1, unitRate: 1000 }] }
  ]);
  assert.equal(result[0].vendorId, 'v1');
  assert.equal(result[1].varianceFromLowest, 100);
  assert.equal(result[1].variancePercent, 10);
});

test('rejects incomplete client quotation', () => {
  const result = validateQuotationForClient({ rfqId: 'r', vendorId: 'v', total: 0, items: [] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('At least one quotation line is required'));
});

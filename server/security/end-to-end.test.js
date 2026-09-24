import { strict as assert } from 'node:assert';
import test from 'node:test';
import { canViewRfq, canViewQuotation, canDiscloseIdentity } from './party-access.js';
import { normalizeQuotation, compareQuotations, validateQuotationForClient } from '../ai/quotation-normalization.js';
import { calculateServiceFee, validateOrderForFeeTrigger } from '../commercial/service-fee.js';

const rfq = { status: 'published', clientAccess: true, vendorAccess: true };

test('end-to-end: published RFQ is visible to both parties but identity is not disclosed', () => {
  assert.equal(canViewRfq('client', rfq), true);
  assert.equal(canViewRfq('vendor', rfq), true);
  assert.equal(canDiscloseIdentity({ role: 'vendor', stage: 'quotation', awarded: false }), false);
});

test('end-to-end: vendor quote normalizes and becomes client-safe comparison data', () => {
  const quotes = [
    normalizeQuotation({ rfqId: 'rfq-1', vendorId: 'internal-v1', items: [{ description: 'Waterproofing', quantity: 100, unit: 'm2', unitRate: 25 }] }),
    normalizeQuotation({ rfqId: 'rfq-1', vendorId: 'internal-v2', items: [{ description: 'Waterproofing', quantity: 100, unit: 'm2', unitRate: 27 }] }),
  ];
  assert.equal(validateQuotationForClient(quotes[0]).valid, true);
  const ranked = compareQuotations(quotes);
  assert.equal(ranked[0].total, 2500);
  assert.equal(ranked[1].variancePercent, 8);
  assert.equal(canViewQuotation('client', { clientVisible: true }), true);
});

test('end-to-end: award unlocks controlled identity disclosure and fee calculation', () => {
  assert.equal(canDiscloseIdentity({ role: 'client', stage: 'award', awarded: true }), true);
  assert.equal(validateOrderForFeeTrigger({ type: 'lpo', rfqId: 'rfq-1', totalValue: 400000 }), true);
  assert.equal(calculateServiceFee(400000).serviceFee, 10000);
});

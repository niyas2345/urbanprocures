import { strict as assert } from 'node:assert';
import test from 'node:test';
import { calculateServiceFee, validateOrderForFeeTrigger } from './service-fee.js';

test('enforces AED 500 minimum', () => {
  assert.equal(calculateServiceFee(10000).serviceFee, 500);
});

test('calculates 2.5 percent when above minimum', () => {
  assert.equal(calculateServiceFee(400000).serviceFee, 10000);
});

test('fee basis is total LPO/work order value', () => {
  const result = calculateServiceFee(400000);
  assert.equal(result.calculationBasis, 'total_lpo_work_order_value');
  assert.equal(result.paymentTrigger, 'first_payment_stage');
});

test('accepts LPO/work order trigger records', () => {
  assert.equal(validateOrderForFeeTrigger({ type: 'lpo', rfqId: 'r', totalValue: 50000 }), true);
});

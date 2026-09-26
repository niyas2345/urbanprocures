import { strict as assert } from 'node:assert';
import test from 'node:test';
import { calculateServiceFee, calculateVendorServiceCharge, validateOrderForFeeTrigger } from './service-fee.js';

test('enforces AED 500 minimum', () => {
  assert.equal(calculateServiceFee(10000).serviceFee, 500);
});

test('calculates 2.5 percent when above minimum', () => {
  assert.equal(calculateServiceFee(400000).serviceFee, 10000);
});

test('fee basis is total LPO/work order value', () => {
  const result = calculateServiceFee(400000);
  assert.equal(result.calculationBasis, 'total_lpo_work_order_value');
  assert.equal(result.paymentTrigger, 'upon_award_due_within_7_working_days');
});

test('accepts LPO/work order trigger records', () => {
  assert.equal(validateOrderForFeeTrigger({ type: 'lpo', rfqId: 'r', totalValue: 50000 }), true);
});

test('manpower uses AED 1 for each labourer-hour without the general-project minimum', () => {
  const result = calculateVendorServiceCharge({ category: 'Manpower Supply', awardedValue: 50000, labourers: 3, hoursPerLabourer: 120 });
  assert.equal(result.serviceFee, 360);
  assert.equal(result.calculationBasis, 'manpower_labourer_hours');
  assert.equal(result.paymentTrigger, 'manpower_pdc_before_award_execution');
  assert.throws(() => calculateVendorServiceCharge({ category: 'manpower', awardedValue: 50000, labourers: 0, hoursPerLabourer: 120 }));
});

test('general projects retain 2.5 percent with AED 500 minimum', () => {
  assert.equal(calculateVendorServiceCharge({ category: 'Civil', awardedValue: 10000 }).serviceFee, 500);
  assert.equal(calculateVendorServiceCharge({ category: 'MEP', awardedValue: 50000 }).serviceFee, 1250);
});

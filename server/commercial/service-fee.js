/**
 * Urban Procure commercial fee calculation.
 * This module calculates the platform service fee; invoicing remains a separate concern.
 */

export const DEFAULT_SERVICE_FEE = Object.freeze({
  minimumAed: 500,
  percentage: 0.025,
  currency: 'AED',
});

/** Vendor Terms, section 7: manpower supply is charged per labourer-hour. */
export function calculateManpowerServiceCharge(labourers, hoursPerLabourer) {
  const count = Number(labourers);
  const hours = Number(hoursPerLabourer);
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(hours) || hours <= 0 || hours > 100000) {
    throw new Error('Valid labourer count and hours per labourer are required');
  }
  return {
    currency: 'AED',
    serviceFee: Number((count * hours).toFixed(2)),
    ratePerLabourerHour: 1,
    labourers: count,
    hoursPerLabourer: hours,
    calculationBasis: 'manpower_labourer_hours',
    paymentTrigger: 'manpower_pdc_before_award_execution'
  };
}

export function calculateVendorServiceCharge({ category, awardedValue, labourers, hoursPerLabourer }) {
  return /manpower|labou?r supply/i.test(String(category || ''))
    ? calculateManpowerServiceCharge(labourers, hoursPerLabourer)
    : calculateServiceFee(awardedValue);
}

export function calculateServiceFee(orderValue, rules = DEFAULT_SERVICE_FEE) {
  const value = Number(orderValue);
  if (!Number.isFinite(value) || value < 0) throw new Error('A valid non-negative order value is required');

  const percentageFee = value * Number(rules.percentage);
  const fee = Math.max(Number(rules.minimumAed), percentageFee);

  return {
    currency: rules.currency ?? 'AED',
    orderValue: value,
    minimumFee: Number(rules.minimumAed),
    percentage: Number(rules.percentage),
    percentageFee: Number(percentageFee.toFixed(2)),
    serviceFee: Number(fee.toFixed(2)),
    vatApplicable: true,
    calculationBasis: 'total_lpo_work_order_value',
    paymentTrigger: 'upon_award_due_within_7_working_days',
  };
}

export function validateOrderForFeeTrigger(order) {
  const acceptedTypes = ['lpo', 'purchase_order', 'work_order', 'equivalent_written_order'];
  if (!acceptedTypes.includes(order?.type)) throw new Error('Unsupported order type for service fee trigger');
  if (!order?.rfqId) throw new Error('RFQ reference is required');
  if (!Number.isFinite(Number(order?.totalValue)) || Number(order.totalValue) < 0) {
    throw new Error('A valid total order value is required');
  }
  return true;
}

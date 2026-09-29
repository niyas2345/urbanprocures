import { strict as assert } from 'node:assert';
import test from 'node:test';
import { reconstructBoq } from './boq-reconstructor.js';

test('reconstructs BOQ rows with sheet and row traceability', () => {
  const result = reconstructBoq({ confidence: 0.9, metadata: { file_name: 'boq.xlsx' }, tables: [{ name: 'BOQ', headers: ['Item No', 'Description', 'Qty', 'Unit', 'Rate', 'Amount'], rows: [['1', 'Painting works', '100', 'm2', '25', '2500']] }] });
  assert.equal(result.items[0].quantity, 100); assert.equal(result.items[0].unit, 'm2'); assert.equal(result.items[0].source_sheet, 'BOQ'); assert.equal(result.items[0].source_row, 2); assert.equal(result.review_required, false);
});

test('does not invent missing commercial values and requires review', () => {
  const result = reconstructBoq({ confidence: 0.4, items: [{ description: 'Waterproofing' }] });
  assert.equal(result.items[0].quantity, null); assert.equal(result.items[0].unit_rate, null); assert.equal(result.review_required, true);
});

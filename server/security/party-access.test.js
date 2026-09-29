import { strict as assert } from 'node:assert';
import test from 'node:test';
import { canViewRfq, canViewQuotation, canDiscloseIdentity } from './party-access.js';

test('vendor cannot view unpublished RFQ', () => {
  assert.equal(canViewRfq('vendor', { status: 'draft', vendorAccess: true }), false);
});

test('vendor can view published vendor-safe RFQ', () => {
  assert.equal(canViewRfq('vendor', { status: 'published', vendorAccess: true }), true);
});

test('client and vendor identity stays hidden before award', () => {
  assert.equal(canDiscloseIdentity({ role: 'client', stage: 'quotation', awarded: false }), false);
  assert.equal(canDiscloseIdentity({ role: 'vendor', stage: 'quotation', awarded: false }), false);
});

test('identity can be disclosed at award stage', () => {
  assert.equal(canDiscloseIdentity({ role: 'client', stage: 'award', awarded: true }), true);
});

test('quotation visibility is independently controlled', () => {
  assert.equal(canViewQuotation('client', { clientVisible: false }), false);
  assert.equal(canViewQuotation('client', { clientVisible: true }), true);
  assert.equal(canViewQuotation('vendor', { vendorVisible: false }), false);
});

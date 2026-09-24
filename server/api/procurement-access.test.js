import { strict as assert } from 'node:assert';
import test from 'node:test';
import { authorizeRfqRead, authorizeQuotationRead, authorizeIdentityDisclosure, sanitizeExternalPayload } from './procurement-access.js';

test('API denies vendor access to draft RFQ', () => {
  assert.throws(() => authorizeRfqRead({ actorRole: 'vendor', rfq: { status: 'draft', vendorAccess: true } }), /Access denied/);
});

test('API permits vendor access to published RFQ', () => {
  assert.equal(authorizeRfqRead({ actorRole: 'vendor', rfq: { status: 'published', vendorAccess: true } }), true);
});

test('API denies premature identity disclosure', () => {
  assert.throws(() => authorizeIdentityDisclosure({ actorRole: 'vendor', stage: 'quotation', awarded: false }), /not permitted/);
});

test('API permits award-stage identity disclosure', () => {
  assert.equal(authorizeIdentityDisclosure({ actorRole: 'client', stage: 'award', awarded: true }), true);
});

test('external payload strips direct identity fields', () => {
  const safe = sanitizeExternalPayload({ clientName: 'Secret Client', vendorName: 'Secret Vendor', total: 100 });
  assert.deepEqual(safe, { total: 100 });
});

test('client quotation visibility is enforced at API boundary', () => {
  assert.throws(() => authorizeQuotationRead({ actorRole: 'client', quotation: { clientVisible: false } }), /Access denied/);
  assert.equal(authorizeQuotationRead({ actorRole: 'client', quotation: { clientVisible: true } }), true);
});

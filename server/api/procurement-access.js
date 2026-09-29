/**
 * API-facing authorization helpers. Route handlers should call these before
 * returning RFQ, quotation, document, or identity data.
 */

import { assertPartyAccess, canDiscloseIdentity } from '../security/party-access.js';

export function authorizeRfqRead({ actorRole, rfq }) {
  return assertPartyAccess({ role: actorRole, resource: { ...rfq, type: 'rfq' }, action: 'view' });
}

export function authorizeQuotationRead({ actorRole, quotation }) {
  return assertPartyAccess({ role: actorRole, resource: { ...quotation, type: 'quotation' }, action: 'view' });
}

export function authorizeIdentityDisclosure({ actorRole, stage, awarded }) {
  if (!canDiscloseIdentity({ role: actorRole, stage, awarded })) throw new Error('Identity disclosure is not permitted at this stage');
  return true;
}

export function sanitizeExternalPayload(payload, fields = ['clientName', 'clientEmail', 'clientPhone', 'vendorName', 'vendorEmail', 'vendorPhone']) {
  const output = { ...payload };
  for (const field of fields) delete output[field];
  return output;
}

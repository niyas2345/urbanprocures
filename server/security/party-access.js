const ROLES = Object.freeze({ CLIENT: 'client', VENDOR: 'vendor', ADMIN: 'admin' });

export function canViewRfq(role, rfq) {
  if (role === ROLES.ADMIN) return true;
  if (!rfq) return false;
  if (role === ROLES.CLIENT) return rfq.clientAccess === true;
  if (role === ROLES.VENDOR) return rfq.vendorAccess === true && rfq.status === 'published';
  return false;
}

export function canViewQuotation(role, quotation, { awarded = false } = {}) {
  if (role === ROLES.ADMIN) return true;
  if (!quotation) return false;
  if (role === ROLES.CLIENT) return quotation.clientVisible === true;
  if (role === ROLES.VENDOR) return quotation.vendorVisible === true;
  return awarded && false;
}

export function canDiscloseIdentity({ role, stage, awarded = false }) {
  if (role === ROLES.ADMIN) return true;
  if (awarded || stage === 'award') return true;
  return false;
}

export function assertPartyAccess({ role, resource, action = 'view' }) {
  if (role === ROLES.ADMIN) return true;
  let allowed = false;
  if (action === 'view' && resource?.type === 'rfq') allowed = canViewRfq(role, resource);
  else if (action === 'view' && resource?.type === 'quotation') allowed = canViewQuotation(role, resource, resource);
  else if (action === 'identity') allowed = canDiscloseIdentity(resource);
  if (!allowed) throw new Error('Access denied');
  return true;
}

import { createNormalizedRfq, validateRfqForVendorPublication } from './rfq-normalizer.js';
import { assertOutboundDocument, DOCUMENT_AUDIENCES } from './document-policy.js';
import { assertExternalDocumentSafe } from './document-firewall.js';
import { assertNoIdentityLeak, sanitizeIdentity, scanIdentityLeakage } from './identity-scan.js';

export function buildSanitizedVendorRfq({ rfqId, extraction, input = {}, sourceDocumentId }) {
  const fields = { ...(extraction?.fields || {}), ...input };
  const items = Array.isArray(input.items) && input.items.length
    ? input.items
    : extraction?.items || [];

  const normalized = createNormalizedRfq({
    rfq_number: fields.rfq_number || rfqId || null,
    mode: fields.mode,
    category: fields.category || null,
    title: fields.title || null,
    location: stripStreet(fields.location),
    scope_summary: fields.scope_summary || extraction?.text?.slice(0, 800) || null,
    items,
    specifications: fields.specifications || [],
    documents: [{
      id: `${sourceDocumentId || 'src'}:sanitized`,
      visibility: 'sanitized_vendor',
      is_original: false,
      source: 'derived',
    }],
    source_document_ids: sourceDocumentId ? [sourceDocumentId] : [],
    status: 'review',
  });

  const artifact = sanitizeIdentity({
    kind: 'sanitized_vendor_rfq',
    rfq_id: rfqId,
    is_original: false,
    source: 'derived',
    audience: DOCUMENT_AUDIENCES.VENDOR,
    title: normalized.title,
    category: normalized.category,
    location: normalized.location,
    scope: normalized.scope_summary,
    items: normalized.items,
    specifications: normalized.specifications,
    deadline: fields.deadline || null,
    budget_band: band(fields.budget),
    payment_terms: fields.payment_terms || null,
    commercial_requirements: fields.commercial_requirements || null,
    drawing_references: fields.drawing_references || [],
    extraction_status: extraction?.status || null,
    requires_human_review: Boolean(extraction?.requires_human_review),
  });

  const leak = scanIdentityLeakage(artifact, fields.identity_terms || input.identity_terms || []);
  if (leak.leaked) {
    return {
      ok: false,
      published: false,
      requires_human_review: true,
      reasons: ['identity_leakage'],
      leak,
      artifact: null,
      normalized,
    };
  }

  assertOutboundDocument({ is_original: false, source: 'derived' }, DOCUMENT_AUDIENCES.VENDOR);
  assertExternalDocumentSafe({
    originalDocument: sourceDocumentId || `${rfqId}:source`,
    sanitizedDocument: `${rfqId}:sanitized`,
  });

  const publication = validateRfqForVendorPublication({
    ...normalized,
    documents: normalized.documents,
  });

  return {
    ok: publication.ok && !artifact.requires_human_review,
    published: false,
    requires_human_review: artifact.requires_human_review || !publication.ok,
    reasons: publication.reasons,
    artifact,
    normalized,
  };
}

export function assertVendorSafeArtifact(artifact) {
  if (!artifact || artifact.is_original) throw new Error('Original artifacts cannot be vendor-visible');
  if (artifact.audience && artifact.audience !== DOCUMENT_AUDIENCES.VENDOR && artifact.audience !== 'vendor') {
    throw new Error('Artifact audience is not vendor');
  }
  assertNoIdentityLeak(artifact);
  return true;
}

function stripStreet(location) {
  if (!location) return null;
  const value = String(location);
  if (/\d+\s+\w+/.test(value) && /street|road|villa|plot/i.test(value)) {
    const emirate = value.match(/Dubai|Abu Dhabi|Sharjah|Ajman|Ras Al Khaimah|Fujairah|Umm Al Quwain/i);
    return emirate ? emirate[0] : null;
  }
  return value;
}

function band(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  if (amount >= 250000) return 'AED 250k+';
  if (amount >= 100000) return 'AED 100k–250k';
  if (amount >= 50000) return 'AED 50k–100k';
  return 'Below AED 50k';
}

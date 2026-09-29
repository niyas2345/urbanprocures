const DEFAULT_THRESHOLD = 0.7;

export function evaluateReviewGate({ extraction = {}, boq = extraction.boq, identityScan = null, malformed = false, missingPages = false } = {}) {
  const reasons = new Set();
  if (malformed || extraction.status === 'failed' || extraction.status === 'blocked') reasons.add('malformed_or_blocked_document');
  if (extraction.status === 'pending_external') reasons.add('external_processing_required');
  if (Number(extraction.confidence || 0) < DEFAULT_THRESHOLD) reasons.add('low_extraction_confidence');
  if (boq?.review_required) for (const reason of boq.review_reasons || []) reasons.add(reason);
  if (missingPages) reasons.add('missing_critical_pages');
  if (identityScan?.leaked || identityScan?.requires_human_review) reasons.add('identity_removal_uncertain');
  return { allowed: reasons.size === 0, requires_human_review: reasons.size > 0, reasons: [...reasons], threshold: DEFAULT_THRESHOLD };
}

export function assertReviewPassed(result) { if (!result?.allowed) { const error = new Error('Human review required'); error.review = result; throw error; } return true; }

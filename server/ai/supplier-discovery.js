/**
 * Supplier Discovery & Growth Engine
 * Autonomous supplier network: PROSPECT → IDENTIFIED → QUALIFIED → PRIORITIZED → CONTACTED → RESPONDED → INVITED → REGISTERED → DOCUMENTS_SUBMITTED → VERIFIED → ACTIVE → QUOTING → PERFORMING
 */

export const SUPPLIER_STAGES = Object.freeze([
  'prospect',
  'identified',
  'qualified',
  'prioritized',
  'contacted',
  'responded',
  'invited',
  'registered',
  'documents_submitted',
  'verified',
  'active',
  'quoting',
  'performing',
  'suspended',
  'rejected',
  'archived'
]);

export const STAGE_TRANSITIONS = Object.freeze({
  prospect: new Set(['identified', 'rejected', 'archived']),
  identified: new Set(['qualified', 'rejected', 'archived']),
  qualified: new Set(['prioritized', 'rejected', 'archived']),
  prioritized: new Set(['contacted', 'rejected', 'archived']),
  contacted: new Set(['responded', 'contacted', 'rejected', 'archived']), // can re-contact
  responded: new Set(['invited', 'contacted', 'rejected', 'archived']),
  invited: new Set(['registered', 'contacted', 'rejected', 'archived']),
  registered: new Set(['documents_submitted', 'rejected', 'archived']),
  documents_submitted: new Set(['verified', 'rejected', 'archived']),
  verified: new Set(['active', 'suspended', 'archived']),
  active: new Set(['quoting', 'suspended', 'archived']),
  quoting: new Set(['performing', 'active', 'suspended', 'archived']),
  performing: new Set(['active', 'suspended', 'archived']),
  suspended: new Set(['active', 'archived']),
  rejected: new Set(['archived']),
  archived: new Set()
});

export const OUTREACH_STAGES = Object.freeze([
  'initial_contact',
  'followup_1',
  'followup_2',
  'followup_3',
  'final_notice',
  'registration_invite',
  'document_request',
  'verification_complete',
  'rfq_invitation',
  'rfq_reminder',
  'rfq_deadline'
]);

export const AUTOMATION_LEVELS = Object.freeze({
  HUMAN: 0,
  ASSISTED: 1,
  APPROVAL_BASED: 2,
  AUTONOMOUS_POLICY: 3,
  AUTONOMOUS_DEFAULT: 4
});

const QUALIFICATION_WEIGHTS = Object.freeze({
  has_trade_license: 25,
  license_valid: 20,
  category_match: 20,
  emirate_match: 15,
  has_contact: 10,
  has_website: 5,
  has_certifications: 5
});

const PRIORITY_WEIGHTS = Object.freeze({
  category_demand: 30,
  emirate_demand: 20,
  gap_severity: 25,
  qualification_score: 15,
  responsiveness: 10
});

function scoreQualification(prospect) {
  let score = 0;
  if (prospect.trade_license_no) score += QUALIFICATION_WEIGHTS.has_trade_license;
  if (prospect.license_expiry && new Date(prospect.license_expiry) > new Date()) score += QUALIFICATION_WEIGHTS.license_valid;
  if (prospect.categories?.length) score += QUALIFICATION_WEIGHTS.category_match;
  if (prospect.emirate) score += QUALIFICATION_WEIGHTS.emirate_match;
  if (prospect.contact_email || prospect.contact_phone) score += QUALIFICATION_WEIGHTS.has_contact;
  if (prospect.website) score += QUALIFICATION_WEIGHTS.has_website;
  if (prospect.certifications?.length) score += QUALIFICATION_WEIGHTS.has_certifications;
  return Math.min(100, score);
}

function scorePriority(prospect, context = {}) {
  let score = 0;
  const categoryDemand = context.categoryDemand || 0;
  const emirateDemand = context.emirateDemand || 0;
  const gapSeverity = context.gapSeverity || 0;
  score += Math.min(30, categoryDemand * 10);
  score += Math.min(20, emirateDemand * 10);
  score += Math.min(25, gapSeverity * 8);
  score += Math.min(15, (prospect.qualification_score || 0) * 0.15);
  score += Math.min(10, (prospect.responsiveness_score || 0) * 0.1);
  return Math.min(100, Math.round(score));
}

export function canTransition(fromStage, toStage) {
  return STAGE_TRANSITIONS[fromStage]?.has(toStage) || false;
}

export function transitionStage(prospect, newStage, { reason, actor } = {}) {
  if (!canTransition(prospect.status, newStage)) {
    throw new Error(`Invalid stage transition: ${prospect.status} → ${newStage}`);
  }
  return {
    ...prospect,
    status: newStage,
    updated_at: new Date().toISOString(),
    ...(reason && { verification_note: reason }),
    ...(actor && { verification_by: actor })
  };
}

export function evaluateProspect(prospect, context = {}) {
  const qualificationScore = scoreQualification(prospect);
  const priorityScore = scorePriority({ ...prospect, qualification_score: qualificationScore }, context);

  let newStage = prospect.status;
  if (prospect.status === 'prospect' && qualificationScore >= 40) newStage = 'identified';
  if (prospect.status === 'identified' && qualificationScore >= 60) newStage = 'qualified';
  if (prospect.status === 'qualified' && priorityScore >= 50) newStage = 'prioritized';

  return {
    qualification_score: qualificationScore,
    priority_score: priorityScore,
    suggested_stage: newStage,
    reasons: buildQualificationReasons(prospect, qualificationScore)
  };
}

function buildQualificationReasons(prospect, score) {
  const reasons = [];
  if (prospect.trade_license_no) reasons.push('has_trade_license');
  if (prospect.license_expiry && new Date(prospect.license_expiry) > new Date()) reasons.push('license_valid');
  if (prospect.categories?.length) reasons.push('category_match');
  if (prospect.emirate) reasons.push('emirate_match');
  if (prospect.contact_email || prospect.contact_phone) reasons.push('has_contact');
  if (prospect.website) reasons.push('has_website');
  if (prospect.certifications?.length) reasons.push('has_certifications');
  if (score < 40) reasons.push('below_qualification_threshold');
  return reasons;
}

export function selectOutreachTemplate(stage, channel, templates) {
  return templates.find(t =>
    t.stage === stage &&
    t.channel === channel &&
    t.active
  );
}

export function renderTemplate(template, variables) {
  let subject = template.subject_template || '';
  let body = template.body_template || '';
  for (const [key, value] of Object.entries(variables || {})) {
    const placeholder = `{{${key}}}`;
    subject = subject.replaceAll(placeholder, String(value ?? ''));
    body = body.replaceAll(placeholder, String(value ?? ''));
  }
  return { subject, body };
}

export function buildRegistrationLink(_prospectId, baseUrl = '', kind = 'vendor') {
  const base = String(baseUrl || 'https://www.urbanprocures.com').replace(/\/$/, '');
  return `${base}/signup.html#${kind === 'client' ? 'client' : 'vendor'}`;
}

export function growthInvite({ kind = 'vendor', company = '', link = '' } = {}) {
  const name = company ? `${company} ` : '';
  if (kind === 'client') {
    return {
      subject: 'Post construction work and collect quotations — free',
      body: `Hello,\n\nUrban Procures is a new UAE platform for construction work. Post the job, receive quotations from contractors, and compare them in one place. Joining is free for clients.\n\nRegister ${name}here:\n${link}\n\nUrban Procures\ndesk@urbanprocures.com`
    };
  }
  return {
    subject: 'Receive construction RFQs in the UAE',
    body: `Hello,\n\nUrban Procures is a new platform where clients post construction work and contractors send quotations. Register ${name}to be invited to matching requests.\n\nJoining is free. A platform fee is recorded only if the work is awarded to you (2.5%, minimum AED 500).\n\nRegister here:\n${link}\n\nUrban Procures\ndesk@urbanprocures.com`
  };
}

export function buildVendorDashboardLink(rfqId, baseUrl = '') {
  return `${baseUrl}/dashboard-vendor.html?rfq=${rfqId}`;
}

export function calculateGapSeverity({ matchedCount, invitedCount, respondedCount, requiredCapacity }) {
  if (matchedCount === 0) return 'critical';
  if (invitedCount === 0) return 'high';
  if (respondedCount === 0) return 'moderate';
  if (requiredCapacity && invitedCount < requiredCapacity) return 'moderate';
  return 'low';
}

export function detectSupplierGap(rfq, matchedVendors, invitedVendors, respondedVendors) {
  const matchedCount = matchedVendors?.length || 0;
  const invitedCount = invitedVendors?.length || 0;
  const respondedCount = respondedVendors?.length || 0;
  const requiredCapacity = rfq.required_vendor_count || 3;

  return {
    category: rfq.category,
    subcategory: rfq.subcategory,
    emirate: rfq.emirate,
    required_capacity: requiredCapacity,
    matched_vendor_count: matchedCount,
    invited_vendor_count: invitedCount,
    responded_vendor_count: respondedCount,
    gap_severity: calculateGapSeverity({ matchedCount, invitedCount, respondedCount, requiredCapacity })
  };
}

export function shouldTriggerDiscovery(gap) {
  const short = Number(gap.matched_vendor_count || 0) < Number(gap.required_capacity || 3);
  return short && ['critical', 'high', 'moderate'].includes(gap.gap_severity);
}
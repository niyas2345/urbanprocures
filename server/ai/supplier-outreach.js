/**
 * Supplier Outreach Automation
 * Handles automated communication with supplier prospects through the pipeline
 */

import { selectOutreachTemplate, renderTemplate, buildRegistrationLink, buildVendorDashboardLink, OUTREACH_STAGES, AUTOMATION_LEVELS } from './supplier-discovery.js';
import { createOutreachProvider, OUTREACH_STATUS } from './outreach-provider.js';

const FOLLOWUP_SCHEDULE = Object.freeze({
  initial_contact: 0,
  followup_1: 3,      // days after initial
  followup_2: 7,      // days after followup_1
  followup_3: 14,     // days after followup_2
  final_notice: 21    // days after followup_3
});

const RFQ_FOLLOWUP_SCHEDULE = Object.freeze({
  rfq_invitation: 0,
  rfq_reminder: 2,    // days before deadline
  rfq_deadline: 0     // day of deadline
});

export async function createOutreachJob({ env, prospectId, stage, channel, automationLevel = AUTOMATION_LEVELS.APPROVAL_BASED, triggeredBy, variables = {} }) {
  const template = variables.subject_override ? null : await getTemplate(env, stage, channel);
  if (!template && !variables.subject_override) {
    return { ok: false, error: `No active template for stage ${stage} channel ${channel}` };
  }

  const rendered = variables.subject_override
    ? { subject: variables.subject_override, body: variables.body_override || '' }
    : renderTemplate(template, variables);
  const outreach = {
    prospect_id: prospectId,
    channel,
    direction: 'outbound',
    template_id: template?.id || null,
    subject: rendered.subject,
    body: rendered.body,
    sent_at: new Date().toISOString(),
    automation_level: automationLevel,
    triggered_by: triggeredBy,
    metadata: { stage, source: variables.source || null, audience: variables.audience || null, variables }
  };

  const saved = await insertOutreach(env, outreach);
  return { ok: true, outreach: saved };
}

export async function sendOutreach({ env, outreachId, provider }) {
  const outreach = await getOutreach(env, outreachId);
  if (!outreach) return { ok: false, error: 'Outreach not found' };
  if (outreach.delivered_at) return { ok: true, idempotent: true, outreach };

  const outreachProvider = provider || createOutreachProvider(env);
  const channel = outreach.channel;

  try {
    const variables = outreach.metadata?.variables || {};
    const result = await outreachProvider.send({
      channel,
      to: channel === 'whatsapp' ? variables.contact_phone : variables.contact_email,
      subject: outreach.subject,
      body: outreach.body,
      templateId: outreach.template_id,
      variables
    });

    const updated = await updateOutreach(env, outreachId, {
      delivered_at: result.sent ? new Date().toISOString() : null,
      metadata: { ...outreach.metadata, provider_response: result.providerResponse, send_status: result.status, error: result.sent ? null : (result.reason || null) }
    });

    if (!result.sent) {
      return { ok: false, error: result.reason || `Failed to send via ${channel}`, outreach: updated, status: result.status };
    }

    return { ok: true, outreach: updated, status: result.status, messageId: result.messageId };
  } catch (error) {
    return { ok: false, error: error.message, outreach: await updateOutreach(env, outreachId, { metadata: { ...outreach.metadata, error: error.message } }) };
  }
}

export async function processInboundResponse({ env, prospectId, channel, responseText, metadata = {} }) {
  const outreach = {
    prospect_id: prospectId,
    channel,
    direction: 'inbound',
    body: responseText,
    sent_at: new Date().toISOString(),
    automation_level: AUTOMATION_LEVELS.HUMAN,
    metadata: { ...metadata, response_sentiment: analyzeSentiment(responseText) }
  };

  const saved = await insertOutreach(env, outreach);

  // Update prospect stage based on response
  const prospect = await getProspect(env, prospectId);
  if (prospect) {
    const sentiment = analyzeSentiment(responseText);
    if (sentiment === 'positive' && ['contacted', 'prioritized'].includes(prospect.status)) {
      await updateProspect(env, prospectId, { status: 'responded', response_received_at: new Date().toISOString() });
    } else if (sentiment === 'negative') {
      await updateProspect(env, prospectId, { status: 'rejected', verification_note: 'Unsubscribed or declined' });
    }
  }

  return { ok: true, outreach: saved };
}

function analyzeSentiment(text) {
  const lower = text.toLowerCase();
  const positive = ['interested', 'yes', 'please', 'register', 'sign up', 'join', 'info', 'details', 'send', 'contact'];
  const negative = ['unsubscribe', 'not interested', 'no thanks', 'remove', 'stop', 'spam', 'delete'];

  if (positive.some(w => lower.includes(w))) return 'positive';
  if (negative.some(w => lower.includes(w))) return 'negative';
  return 'neutral';
}

export function getNextFollowupStage(currentStage) {
  const stages = OUTREACH_STAGES;
  const idx = stages.indexOf(currentStage);
  if (idx >= 0 && idx < stages.length - 1) return stages[idx + 1];
  return null;
}

export function calculateNextFollowupDate(currentStage, lastContactAt) {
  const days = FOLLOWUP_SCHEDULE[currentStage] || 0;
  const date = new Date(lastContactAt);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

export function calculateRfqFollowupDate(stage, deadline) {
  const days = RFQ_FOLLOWUP_SCHEDULE[stage] || 0;
  const date = new Date(deadline);
  if (stage === 'rfq_reminder') date.setDate(date.getDate() - days);
  else if (stage === 'rfq_deadline') date.setDate(date.getDate() - 0);
  else date.setDate(date.getDate() + days);
  return date.toISOString();
}

export async function scheduleFollowups({ env, prospectId, startStage = 'initial_contact', channel = 'email', automationLevel = AUTOMATION_LEVELS.APPROVAL_BASED, variables = {} }) {
  const stages = ['initial_contact', 'followup_1', 'followup_2', 'followup_3', 'final_notice'];
  const startIdx = stages.indexOf(startStage);
  if (startIdx === -1) return { ok: false, error: 'Invalid start stage' };

  const prospect = await getProspect(env, prospectId);
  if (!prospect) return { ok: false, error: 'Prospect not found' };

  const results = [];
  let lastDate = new Date();

  for (let i = startIdx; i < stages.length; i++) {
    const stage = stages[i];
    const days = FOLLOWUP_SCHEDULE[stage];
    const scheduledAt = new Date(lastDate);
    scheduledAt.setDate(scheduledAt.getDate() + days);

    const job = await createScheduledJob(env, {
      type: 'send_outreach',
      prospect_id: prospectId,
      stage,
      channel,
      automation_level: automationLevel,
      variables,
      scheduled_at: scheduledAt.toISOString()
    });
    results.push({ stage, scheduled_at: scheduledAt.toISOString(), job_id: job?.id });
    lastDate = scheduledAt;
  }

  return { ok: true, scheduled: results };
}

export async function scheduleRfqFollowups({ env, prospectId, rfqId, rfqTitle, deadline, channel = 'email', automationLevel = AUTOMATION_LEVELS.AUTONOMOUS_POLICY, variables = {} }) {
  const stages = ['rfq_invitation', 'rfq_reminder', 'rfq_deadline'];
  const results = [];

  for (const stage of stages) {
    const scheduledAt = calculateRfqFollowupDate(stage, deadline);
    const job = await createScheduledJob(env, {
      type: 'send_outreach',
      prospect_id: prospectId,
      stage,
      channel,
      automation_level: automationLevel,
      variables: { ...variables, rfq_title: rfqTitle, deadline, rfq_id: rfqId },
      scheduled_at: scheduledAt
    });
    results.push({ stage, scheduled_at: scheduledAt, job_id: job?.id });
  }

  return { ok: true, scheduled: results };
}

// Database helpers
async function getTemplate(env, stage, channel) {
  return one(env, `/rest/v1/outreach_templates?stage=eq.${stage}&channel=eq.${channel}&active=eq.true&select=*`);
}

async function insertOutreach(env, outreach) {
  return insert(env, 'supplier_outreach', outreach);
}

async function getOutreach(env, id) {
  return one(env, `/rest/v1/supplier_outreach?id=eq.${encodeURIComponent(id)}&select=*`);
}

async function updateOutreach(env, id, changes) {
  return patch(env, 'supplier_outreach', `id=eq.${encodeURIComponent(id)}`, changes);
}

async function getProspect(env, id) {
  return one(env, `/rest/v1/supplier_prospects?id=eq.${encodeURIComponent(id)}&select=*`);
}

async function updateProspect(env, id, changes) {
  return patch(env, 'supplier_prospects', `id=eq.${encodeURIComponent(id)}`, changes);
}

async function createScheduledJob(env, job) {
  return insert(env, 'scheduled_jobs', job);
}

async function one(env, path) {
  const rows = await rest(env, path);
  return rows[0] || null;
}

async function rest(env, path, init = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
  const response = await fetch(`${env.SUPABASE_URL}${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `Supabase request failed (${response.status})`);
  return text ? JSON.parse(text) : [];
}

async function insert(env, table, row) {
  const rows = await rest(env, `/rest/v1/${table}`, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
  return rows[0] || row;
}

async function patch(env, table, filter, body) {
  const rows = await rest(env, `/rest/v1/${table}?${filter}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) });
  return rows[0] || body;
}
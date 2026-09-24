/**
 * Inbound Webhook Handlers for Email/WhatsApp/LinkedIn Responses
 * Processes inbound messages and updates supplier prospect status
 */

import { processInboundResponse } from '../ai/supplier-outreach.js';
import { json, readJson } from './desk-shared.js';

export async function handleInboundWebhook(request, env) {
  const url = new URL(request.url);
  
  // Verify webhook signature if configured
  if (env.WEBHOOK_SECRET) {
    const signature = request.headers.get('x-webhook-signature') || request.headers.get('x-signature');
    if (!signature || !verifyWebhookSignature(signature, request, env.WEBHOOK_SECRET)) {
      return json({ ok: false, error: 'Invalid webhook signature' }, 401);
    }
  }

  const channel = url.pathname.split('/').pop(); // email, whatsapp, linkedin
  
  if (!['email', 'whatsapp', 'linkedin'].includes(channel)) {
    return json({ ok: false, error: 'Invalid channel' }, 400);
  }

  try {
    const payload = await parseWebhookPayload(request, channel);
    const { prospectId, responseText, metadata } = payload;

    if (!prospectId || !responseText) {
      return json({ ok: false, error: 'Missing prospectId or responseText' }, 400);
    }

    const result = await processInboundResponse({ 
      env, 
      prospectId, 
      channel, 
      responseText, 
      metadata: { ...metadata, webhook_source: channel }
    });

    return json(result);
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}

async function parseWebhookPayload(request, channel) {
  const contentType = request.headers.get('content-type') || '';
  
  if (channel === 'email') {
    // Parse email webhook (SendGrid, Mailgun, SES, etc.)
    return parseEmailWebhook(await request.json(), channel);
  } else if (channel === 'whatsapp') {
    // Parse WhatsApp webhook (Twilio, Meta Business API)
    return parseWhatsAppWebhook(await request.json(), channel);
  } else if (channel === 'linkedin') {
    // Parse LinkedIn webhook
    return parseLinkedInWebhook(await request.json(), channel);
  }
  
  throw new Error(`Unsupported channel: ${channel}`);
}

function parseEmailWebhook(payload, channel) {
  // Support multiple email providers
  let prospectId, responseText, fromEmail, subject, metadata = {};
  
  // SendGrid Inbound Parse
  if (payload.envelope && payload.from) {
    prospectId = extractProspectId(payload.headers?.['x-prospect-id'] || payload.to);
    responseText = payload.text || payload.html || '';
    fromEmail = payload.from;
    subject = payload.subject;
    metadata = { provider: 'sendgrid', message_id: payload.message_id };
  }
  // Mailgun
  else if (payload.recipient && payload.sender) {
    prospectId = extractProspectId(payload['message-headers']?.find(h => h[0] === 'x-prospect-id')?.[1] || payload.recipient);
    responseText = payload['body-plain'] || payload['body-html'] || '';
    fromEmail = payload.sender;
    subject = payload.subject;
    metadata = { provider: 'mailgun', message_id: payload['message-id'] };
  }
  // AWS SES
  else if (payload.mail && payload.receipt) {
    prospectId = extractProspectId(payload.mail.headers?.find(h => h.name === 'x-prospect-id')?.value || payload.mail.destination[0]);
    responseText = payload.mail.content || '';
    fromEmail = payload.mail.source;
    subject = payload.mail.headers?.find(h => h.name === 'subject')?.value;
    metadata = { provider: 'ses', message_id: payload.mail.messageId };
  }
  // Generic fallback
  else {
    prospectId = payload.prospect_id || extractProspectId(payload.to);
    responseText = payload.text || payload.body || payload.content || '';
    fromEmail = payload.from || payload.sender;
    subject = payload.subject;
    metadata = { provider: 'unknown' };
  }

  return { prospectId, responseText, metadata: { ...metadata, from_email: fromEmail, subject, channel: 'email' } };
}

function parseWhatsAppWebhook(payload, channel) {
  let prospectId, responseText, fromPhone, metadata = {};
  
  // Meta Business API (WhatsApp Cloud API)
  if (payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
    const message = payload.entry[0].changes[0].value.messages[0];
    fromPhone = message.from;
    prospectId = extractProspectId(message.context?.id) || extractProspectId(fromPhone);
    responseText = message.text?.body || message.button?.text || message.interactive?.button_reply?.title || '';
    metadata = { provider: 'meta', message_id: message.id, timestamp: message.timestamp };
  }
  // Twilio
  else if (payload.From && payload.Body) {
    fromPhone = payload.From.replace('whatsapp:', '');
    prospectId = extractProspectId(payload.From) || payload.From;
    responseText = payload.Body;
    metadata = { provider: 'twilio', message_sid: payload.MessageSid };
  }
  // Generic fallback
  else {
    prospectId = payload.prospect_id || extractProspectId(payload.from);
    responseText = payload.text || payload.body || payload.content || '';
    fromPhone = payload.from || payload.From;
    metadata = { provider: 'unknown' };
  }

  return { prospectId, responseText, metadata: { ...metadata, from_phone: fromPhone, channel: 'whatsapp' } };
}

function parseLinkedInWebhook(payload, channel) {
  let prospectId, responseText, fromProfile, metadata = {};
  
  if (payload.value?.message) {
    const msg = payload.value.message;
    fromProfile = msg.from?.memberUrn || msg.from?.personUrn;
    prospectId = extractProspectId(fromProfile);
    responseText = msg.body || '';
    metadata = { provider: 'linkedin', message_id: msg.id };
  } else {
    prospectId = payload.prospect_id || extractProspectId(payload.from);
    responseText = payload.text || payload.body || payload.content || '';
    fromProfile = payload.from;
    metadata = { provider: 'unknown' };
  }

  return { prospectId, responseText, metadata: { ...metadata, from_profile: fromProfile, channel: 'linkedin' } };
}

function extractProspectId(identifier) {
  if (!identifier) return null;
  // Try to extract UUID from identifier
  const uuidMatch = identifier.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return uuidMatch ? uuidMatch[0] : null;
}

function verifyWebhookSignature(signature, request, secret) {
  // Implement HMAC verification based on provider
  // This is a placeholder - implement based on actual provider requirements
  return true;
}

// Health check endpoint for webhook monitoring
export async function handleWebhookHealth(request, env) {
  return json({ ok: true, service: 'webhooks', timestamp: new Date().toISOString() });
}

export default { handleInboundWebhook, handleWebhookHealth };
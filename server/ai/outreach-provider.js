/**
 * Outreach Provider Abstraction
 * Supports Email, WhatsApp, LinkedIn, SMS, and in-app portal messages
 * Returns explicit PENDING state when not configured - never fakes delivery
 */

export const OUTREACH_CHANNELS = Object.freeze({
  EMAIL: 'email',
  WHATSAPP: 'whatsapp',
  LINKEDIN: 'linkedin',
  SMS: 'sms',
  PORTAL: 'portal'
});

export const OUTREACH_STATUS = Object.freeze({
  QUEUED: 'queued',
  SENT: 'sent',
  DELIVERED: 'delivered',
  OPENED: 'opened',
  CLICKED: 'clicked',
  REPLIED: 'replied',
  FAILED: 'failed',
  BOUNCED: 'bounced',
  OPTED_OUT: 'opted_out',
  PENDING_PROVIDER: 'pending_provider',
  PROVIDER_ERROR: 'provider_error',
  NOT_CONFIGURED: 'not_configured'
});

export class OutreachProvider {
  constructor(config = {}) {
    this.config = {
      timeoutMs: config.timeoutMs || 10000,
      retryAttempts: config.retryAttempts || 3,
      retryDelayMs: config.retryDelayMs || 1000,
      ...config
    };
    this.providers = new Map();
    this.templates = new Map();
  }

  registerProvider(channel, provider) {
    this.providers.set(channel, provider);
  }

  getProvider(channel) {
    return this.providers.get(channel);
  }

  registerTemplate(template) {
    this.templates.set(`${template.channel}:${template.stage}`, template);
  }

  getTemplate(channel, stage) {
    return this.templates.get(`${channel}:${stage}`);
  }

  async send({ channel, to, subject, body, templateId, variables, metadata = {} }) {
    const provider = this.getProvider(channel);
    if (!provider) {
      return {
        status: OUTREACH_STATUS.NOT_CONFIGURED,
        sent: false,
        reason: `No outreach provider configured for channel: ${channel}`,
        channel,
        sent_at: new Date().toISOString()
      };
    }

    try {
      let result;
      switch (channel) {
        case OUTREACH_CHANNELS.EMAIL:
          result = await provider.sendEmail({ to, subject, body, templateId, variables });
          break;
        case OUTREACH_CHANNELS.WHATSAPP:
          result = await provider.sendWhatsApp({ to, body, templateId, variables });
          break;
        case OUTREACH_CHANNELS.LINKEDIN:
          result = await provider.sendLinkedIn({ to, subject, body, templateId, variables });
          break;
        case OUTREACH_CHANNELS.SMS:
          result = await provider.sendSms({ to, body });
          break;
        case OUTREACH_CHANNELS.PORTAL:
          result = await provider.sendPortal({ to, subject, body });
          break;
        default:
          return {
            status: OUTREACH_STATUS.PROVIDER_ERROR,
            sent: false,
            reason: `Unsupported channel: ${channel}`,
            channel
          };
      }

      return {
        status: result.success ? OUTREACH_STATUS.SENT : OUTREACH_STATUS.FAILED,
        sent: result.success,
        messageId: result.messageId || null,
        providerResponse: result.rawResponse || null,
        reason: result.success ? null : result.reason,
        channel,
        sent_at: new Date().toISOString()
      };
    } catch (error) {
      return {
        status: OUTREACH_STATUS.PROVIDER_ERROR,
        sent: false,
        reason: `Outreach provider error: ${error.message}`,
        channel,
        sent_at: new Date().toISOString()
      };
    }
  }

  async sendBulk({ channel, recipients, subject, body, templateId, variables, batchSize = 10, delayMs = 1000 }) {
    const results = [];
    for (let i = 0; i < recipients.length; i += batchSize) {
      const batch = recipients.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(r => this.send({ channel, to: r.to, subject, body, templateId, variables: { ...variables, ...r.variables } }))
      );
      results.push(...batchResults);
      if (i + batchSize < recipients.length) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    return results;
  }
}

// HTTP-based email provider (SendGrid, Mailgun, AWS SES, etc.)
export class HttpEmailProvider {
  constructor(config = {}) {
    this.apiBase = config.apiBase;
    this.apiKey = config.apiKey;
    this.fromEmail = config.fromEmail || 'noreply@urbanprocure.com';
    this.fromName = config.fromName || 'Urban Procure';
    this.timeoutMs = config.timeoutMs || 10000;
  }

  async sendEmail({ to, subject, body, templateId, variables }) {
    if (!this.apiBase || !this.apiKey) {
      return { success: false, reason: 'Email provider not fully configured' };
    }

    try {
      const response = await fetch(`${this.apiBase}/email/send`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: { email: this.fromEmail, name: this.fromName },
          to: Array.isArray(to) ? to : [{ email: to }],
          subject,
          html: body,
          text: body.replace(/<[^>]+>/g, ''),
          template_id: templateId,
          template_data: variables,
          tracking_settings: { click_tracking: { enable: true }, open_tracking: { enable: true } }
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Email API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      return { success: true, messageId: data.message_id || data.id, rawResponse: data };
    } catch (error) {
      return { success: false, reason: error.message, rawResponse: null };
    }
  }
}

// HTTP-based WhatsApp provider (Twilio, Meta Business API, etc.)
export class HttpWhatsAppProvider {
  constructor(config = {}) {
    this.apiBase = config.apiBase;
    this.apiKey = config.apiKey;
    this.phoneNumberId = config.phoneNumberId;
    this.timeoutMs = config.timeoutMs || 10000;
  }

  async sendWhatsApp({ to, body, templateId, variables }) {
    if (!this.apiBase || !this.apiKey || !this.phoneNumberId) {
      return { success: false, reason: 'WhatsApp provider not fully configured' };
    }

    try {
      const response = await fetch(`${this.apiBase}/${this.phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: to.replace(/\D/g, ''),
          type: templateId ? 'template' : 'text',
          template: templateId ? { name: templateId, language: { code: 'en' }, components: [{ type: 'body', parameters: Object.entries(variables || {}).map(([k, v]) => ({ type: 'text', text: String(v) })) }] } : null,
          text: templateId ? undefined : { preview_url: false, body }
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`WhatsApp API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      return { success: true, messageId: data.messages?.[0]?.id, rawResponse: data };
    } catch (error) {
      return { success: false, reason: error.message, rawResponse: null };
    }
  }
}

// HTTP-based LinkedIn provider
export class HttpLinkedInProvider {
  constructor(config = {}) {
    this.apiBase = config.apiBase || 'https://api.linkedin.com/v2';
    this.accessToken = config.accessToken;
    this.timeoutMs = config.timeoutMs || 10000;
  }

  async sendLinkedIn({ to, subject, body, templateId, variables }) {
    if (!this.accessToken) {
      return { success: false, reason: 'LinkedIn provider not configured (missing access token)' };
    }

    try {
      // LinkedIn messaging API requires specific permissions and setup
      // This is a placeholder for the actual implementation
      const response = await fetch(`${this.apiBase}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0'
        },
        body: JSON.stringify({
          recipients: { values: [{ person: { _path: `/people/${to}` } }] },
          subject,
          body: { text: body }
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LinkedIn API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      return { success: true, messageId: data.messageId, rawResponse: data };
    } catch (error) {
      return { success: false, reason: error.message, rawResponse: null };
    }
  }
}

// Mock provider for testing - NEVER returns fake success in production
export class MockOutreachProvider {
  constructor(config = {}) {
    this.shouldSucceed = config.shouldSucceed ?? true;
    this.delayMs = config.delayMs || 50;
    this.mockResponses = config.mockResponses || {};
  }

  async sendEmail({ to, subject, body, templateId, variables }) {
    await new Promise(resolve => setTimeout(resolve, this.delayMs));

    if (process.env.NODE_ENV === 'test' || process.env.ALLOW_MOCK_OUTREACH === 'true') {
      return { success: this.shouldSucceed, messageId: `mock-email-${Date.now()}`, rawResponse: { mock: true } };
    }
    return { success: false, reason: 'Mock provider disabled in production' };
  }

  async sendWhatsApp({ to, body, templateId, variables }) {
    await new Promise(resolve => setTimeout(resolve, this.delayMs));

    if (process.env.NODE_ENV === 'test' || process.env.ALLOW_MOCK_OUTREACH === 'true') {
      return { success: this.shouldSucceed, messageId: `mock-whatsapp-${Date.now()}`, rawResponse: { mock: true } };
    }
    return { success: false, reason: 'Mock provider disabled in production' };
  }

  async sendLinkedIn({ to, subject, body, templateId, variables }) {
    await new Promise(resolve => setTimeout(resolve, this.delayMs));

    if (process.env.NODE_ENV === 'test' || process.env.ALLOW_MOCK_OUTREACH === 'true') {
      return { success: this.shouldSucceed, messageId: `mock-linkedin-${Date.now()}`, rawResponse: { mock: true } };
    }
    return { success: false, reason: 'Mock provider disabled in production' };
  }
}

const ZOHO_HOSTS = {
  com: ['https://accounts.zoho.com', 'https://mail.zoho.com'],
  eu: ['https://accounts.zoho.eu', 'https://mail.zoho.eu'],
  in: ['https://accounts.zoho.in', 'https://mail.zoho.in'],
  'com.au': ['https://accounts.zoho.com.au', 'https://mail.zoho.com.au'],
  jp: ['https://accounts.zoho.jp', 'https://mail.zoho.jp'],
  ca: ['https://accounts.zohocloud.ca', 'https://mail.zohocloud.ca'],
  sa: ['https://accounts.zoho.sa', 'https://mail.zoho.sa']
};

export class ZohoEmailProvider {
  constructor(config = {}) {
    this.env = config.env || {};
    this.timeoutMs = config.timeoutMs || 10000;
    this.cached = null;
    this.accessToken = '';
    this.accessTokenExp = 0;
  }

  async config() {
    if (this.cached) return this.cached;
    const env = this.env;
    const fromEnv = {
      ZOHO_CLIENT_ID: env.ZOHO_CLIENT_ID,
      ZOHO_CLIENT_SECRET: env.ZOHO_CLIENT_SECRET,
      ZOHO_REFRESH_TOKEN: env.ZOHO_REFRESH_TOKEN,
      ZOHO_ACCOUNT_ID: env.ZOHO_ACCOUNT_ID,
      ZOHO_DC: env.ZOHO_DC,
      ZOHO_FROM_EMAIL: env.ZOHO_FROM_EMAIL
    };
    if (!fromEnv.ZOHO_REFRESH_TOKEN) Object.assign(fromEnv, await loadIntegrationSecrets(env));
    const dc = fromEnv.ZOHO_DC || 'com';
    const [accountsBase, mailBase] = ZOHO_HOSTS[dc] || ZOHO_HOSTS.com;
    this.cached = {
      clientId: fromEnv.ZOHO_CLIENT_ID,
      clientSecret: fromEnv.ZOHO_CLIENT_SECRET,
      refreshToken: fromEnv.ZOHO_REFRESH_TOKEN,
      accountId: fromEnv.ZOHO_ACCOUNT_ID,
      fromEmail: fromEnv.ZOHO_FROM_EMAIL || 'desk@urbanprocures.com',
      accountsBase,
      mailBase
    };
    return this.cached;
  }

  async ready() {
    const config = await this.config();
    return Boolean(config.clientId && config.clientSecret && config.refreshToken && config.accountId);
  }

  async token(config) {
    if (this.accessToken && Date.now() < this.accessTokenExp - 60000) return this.accessToken;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken
    });
    const response = await fetch(`${config.accountsBase}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) throw new Error(data.error || 'Zoho token refresh failed');
    this.accessToken = data.access_token;
    this.accessTokenExp = Date.now() + (Number(data.expires_in) || 3600) * 1000;
    return this.accessToken;
  }

  async sendEmail({ to, subject, body }) {
    const config = await this.config();
    if (!config.clientId || !config.clientSecret || !config.refreshToken || !config.accountId) {
      return { success: false, reason: 'Zoho mail is not configured' };
    }
    const address = recipientEmail(to);
    if (!address) return { success: false, reason: 'Missing recipient email' };
    try {
      const access = await this.token(config);
      const response = await fetch(`${config.mailBase}/api/accounts/${config.accountId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Zoho-oauthtoken ${access}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fromAddress: config.fromEmail,
          toAddress: address,
          subject: subject || 'Urban Procure',
          content: body || '',
          mailFormat: /<[a-z][\s\S]*>/i.test(body || '') ? 'html' : 'plaintext'
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      const data = await response.json().catch(() => ({}));
      const statusCode = data.status?.code;
      if (!response.ok || (statusCode && statusCode !== 200)) {
        return { success: false, reason: data.status?.description || `Zoho mail ${response.status}`, rawResponse: data };
      }
      return { success: true, messageId: data.data?.messageId || data.data?.mailId || null, rawResponse: data };
    } catch (error) {
      return { success: false, reason: error.message, rawResponse: null };
    }
  }
}

function recipientEmail(to) {
  if (!to) return '';
  if (typeof to === 'string') return to.trim();
  if (Array.isArray(to)) return recipientEmail(to[0]);
  return String(to.email || to.mailId || '').trim();
}

async function loadIntegrationSecrets(env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || env.Supabase_Secret_Key || '';
  if (!env.SUPABASE_URL || !key) return {};
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/integration_secrets?select=id,value`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  if (!response.ok) return {};
  const rows = await response.json();
  return Object.fromEntries((Array.isArray(rows) ? rows : []).map((row) => [row.id, row.value]));
}

// Factory to create outreach provider with configured channels
export function createOutreachProvider(env = {}) {
  const provider = new OutreachProvider({
    timeoutMs: parseInt(env.OUTREACH_TIMEOUT_MS || '10000'),
    retryAttempts: parseInt(env.OUTREACH_RETRY_ATTEMPTS || '3'),
    retryDelayMs: parseInt(env.OUTREACH_RETRY_DELAY_MS || '1000')
  });

  const zoho = new ZohoEmailProvider({ env, timeoutMs: parseInt(env.OUTREACH_TIMEOUT_MS || '10000', 10) });
  if (env.ZOHO_REFRESH_TOKEN || env.SUPABASE_URL) {
    provider.registerProvider('email', zoho);
  } else if (env.EMAIL_API_BASE && env.EMAIL_API_KEY) {
    provider.registerProvider('email', new HttpEmailProvider({
      apiBase: env.EMAIL_API_BASE,
      apiKey: env.EMAIL_API_KEY,
      fromEmail: env.EMAIL_FROM_EMAIL || 'noreply@urbanprocure.com',
      fromName: env.EMAIL_FROM_NAME || 'Urban Procure'
    }));
  }

  // WhatsApp provider (Twilio, Meta Business API)
  if (env.WHATSAPP_API_BASE && env.WHATSAPP_API_KEY && env.WHATSAPP_PHONE_NUMBER_ID) {
    provider.registerProvider('whatsapp', new HttpWhatsAppProvider({
      apiBase: env.WHATSAPP_API_BASE,
      apiKey: env.WHATSAPP_API_KEY,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID
    }));
  }

  // LinkedIn provider
  if (env.LINKEDIN_ACCESS_TOKEN) {
    provider.registerProvider('linkedin', new HttpLinkedInProvider({
      accessToken: env.LINKEDIN_ACCESS_TOKEN
    }));
  }

  // Register mock provider only for testing
  if (env.NODE_ENV === 'test' || env.ALLOW_MOCK_OUTREACH === 'true') {
    const mockProvider = new MockOutreachProvider({
      shouldSucceed: env.MOCK_OUTREACH_SUCCESS !== 'false'
    });
    provider.registerProvider('email', mockProvider);
    provider.registerProvider('whatsapp', mockProvider);
    provider.registerProvider('linkedin', mockProvider);
  }

  return provider;
}

export default OutreachProvider;
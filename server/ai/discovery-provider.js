/**
 * Supplier Discovery Provider Abstraction
 * Supports multiple discovery sources: directories, web search, municipality lists, etc.
 * Returns explicit PENDING state when not configured - never fakes supplier data
 */

export const DISCOVERY_SOURCES = Object.freeze({
  MUNICIPALITY_LIST: 'municipality_list',
  FREE_ZONE_LIST: 'free_zone_list',
  CHAMBER_OF_COMMERCE: 'chamber_of_commerce',
  TRADE_SHOW: 'trade_show',
  REFERRAL: 'referral',
  WEB_SEARCH: 'web_search',
  DIRECTORY: 'directory',
  MANUAL: 'manual'
});

export const DISCOVERY_STATUS = Object.freeze({
  FOUND: 'found',
  NO_RESULTS: 'no_results',
  PENDING_PROVIDER: 'pending_provider',
  PROVIDER_ERROR: 'provider_error',
  NOT_CONFIGURED: 'not_configured',
  RATE_LIMITED: 'rate_limited'
});

export class DiscoveryProvider {
  constructor(config = {}) {
    this.config = {
      timeoutMs: config.timeoutMs || 15000,
      maxResults: config.maxResults || 50,
      cacheTtlMs: config.cacheTtlMs || 60 * 60 * 1000, // 1 hour
      ...config
    };
    this.cache = new Map();
    this.providers = new Map();
  }

  registerProvider(source, provider) {
    this.providers.set(source, provider);
  }

  getProvider(source) {
    return this.providers.get(source);
  }

  async searchDirectory({ source, categories, emirate, limit = 50 }) {
    const provider = this.getProvider(source);
    if (!provider) {
      return {
        status: DISCOVERY_STATUS.NOT_CONFIGURED,
        prospects: [],
        reason: `No discovery provider configured for source: ${source}`,
        source
      };
    }

    const cacheKey = `dir:${source}:${categories?.join(',')}:${emirate}:${limit}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.config.cacheTtlMs) {
      return { ...cached.result, cached: true };
    }

    try {
      const result = await Promise.race([
        provider.searchDirectory({ categories, emirate, limit }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Search timeout')), this.config.timeoutMs))
      ]);

      const response = {
        status: DISCOVERY_STATUS.FOUND,
        prospects: result.prospects || [],
        total_found: result.totalFound || result.prospects?.length || 0,
        source,
        searched_at: new Date().toISOString(),
        query: { categories, emirate, limit }
      };

      this.cache.set(cacheKey, { result: response, timestamp: Date.now() });
      return response;
    } catch (error) {
      return {
        status: DISCOVERY_STATUS.PROVIDER_ERROR,
        prospects: [],
        reason: `Directory search failed: ${error.message}`,
        source
      };
    }
  }

  async searchWeb({ query, categories, emirate, limit = 20 }) {
    const provider = this.getProvider(DISCOVERY_SOURCES.WEB_SEARCH);
    if (!provider) {
      return {
        status: DISCOVERY_STATUS.NOT_CONFIGURED,
        prospects: [],
        reason: 'No web search provider configured',
        source: DISCOVERY_SOURCES.WEB_SEARCH
      };
    }

    const cacheKey = `web:${query}:${categories?.join(',')}:${emirate}:${limit}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.config.cacheTtlMs) {
      return { ...cached.result, cached: true };
    }

    try {
      const result = await Promise.race([
        provider.searchWeb({ query, categories, emirate, limit }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Search timeout')), this.config.timeoutMs))
      ]);

      const response = {
        status: DISCOVERY_STATUS.FOUND,
        prospects: result.prospects || [],
        total_found: result.totalFound || result.prospects?.length || 0,
        source: DISCOVERY_SOURCES.WEB_SEARCH,
        searched_at: new Date().toISOString(),
        query: { query, categories, emirate, limit }
      };

      this.cache.set(cacheKey, { result: response, timestamp: Date.now() });
      return response;
    } catch (error) {
      return {
        status: DISCOVERY_STATUS.PROVIDER_ERROR,
        prospects: [],
        reason: `Web search failed: ${error.message}`,
        source: DISCOVERY_SOURCES.WEB_SEARCH
      };
    }
  }

  clearCache() {
    this.cache.clear();
  }
}

// HTTP-based provider for municipality APIs, chamber of commerce, etc.
export class HttpDiscoveryProvider {
  constructor(config = {}) {
    this.apiBase = config.apiBase;
    this.apiKey = config.apiKey;
    this.clientId = config.clientId;
    this.source = config.source;
    this.timeoutMs = config.timeoutMs || 15000;
  }

  async searchDirectory({ categories, emirate, limit }) {
    if (!this.apiBase || !this.apiKey) {
      return { prospects: [], totalFound: 0, reason: 'Provider not fully configured' };
    }

    try {
      const params = new URLSearchParams({
        categories: categories?.join(',') || '',
        emirate: emirate || '',
        limit: String(limit)
      });

      const response = await fetch(`${this.apiBase}/suppliers/search?${params}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'X-Client-ID': this.clientId || '',
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(this.timeoutMs)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      return {
        prospects: (data.suppliers || data.results || []).map(this.normalizeProspect.bind(this)),
        totalFound: data.total || data.count || 0
      };
    } catch (error) {
      throw new Error(`Directory search failed: ${error.message}`);
    }
  }

  async searchWeb({ query, categories, emirate, limit }) {
    if (!this.apiBase || !this.apiKey) {
      return { prospects: [], totalFound: 0, reason: 'Provider not fully configured' };
    }

    try {
      const response = await fetch(`${this.apiBase}/web/search`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'X-Client-ID': this.clientId || '',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query, categories, emirate, limit }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      return {
        prospects: (data.results || []).map(this.normalizeProspect.bind(this)),
        totalFound: data.total || data.count || 0
      };
    } catch (error) {
      throw new Error(`Web search failed: ${error.message}`);
    }
  }

  normalizeProspect(raw) {
    return {
      source: this.source,
      source_reference: raw.reference_url || raw.profile_url || `${this.apiBase}/suppliers/${raw.id}`,
      company_name: raw.company_name || raw.name || raw.trade_name,
      trade_license_no: raw.trade_license_no || raw.license_number || null,
      license_expiry: raw.license_expiry || raw.expiry_date || null,
      categories: Array.isArray(raw.categories) ? raw.categories : (raw.category ? [raw.category] : []),
      subcategories: Array.isArray(raw.subcategories) ? raw.subcategories : [],
      emirate: raw.emirate || raw.location || '',
      city: raw.city || '',
      address: raw.address || '',
      contact_name: raw.contact_name || raw.contact_person || '',
      contact_email: raw.contact_email || raw.email || '',
      contact_phone: raw.contact_phone || raw.phone || '',
      website: raw.website || raw.company_url || '',
      employee_count: raw.employee_count || raw.staff_count || null,
      annual_revenue_aed: raw.annual_revenue || raw.revenue_aed || null,
      certifications: Array.isArray(raw.certifications) ? raw.certifications : [],
      project_references: Array.isArray(raw.projects) ? raw.projects : []
    };
  }
}

// Mock provider for testing - NEVER returns fake data in production
export class MockDiscoveryProvider {
  constructor(config = {}) {
    this.shouldSucceed = config.shouldSucceed ?? true;
    this.delayMs = config.delayMs || 100;
    this.mockData = config.mockData || [];
  }

  async searchDirectory({ categories, emirate, limit }) {
    await new Promise(resolve => setTimeout(resolve, this.delayMs));

    if (process.env.NODE_ENV === 'test' || process.env.ALLOW_MOCK_DISCOVERY === 'true') {
      const filtered = this.mockData.filter(p => {
        if (categories?.length && !categories.some(c => p.categories?.includes(c))) return false;
        if (emirate && p.emirate !== emirate) return false;
        return true;
      }).slice(0, limit);

      return { prospects: filtered, totalFound: filtered.length };
    }

    return { prospects: [], totalFound: 0, reason: 'Mock provider disabled in production' };
  }

  async searchWeb({ query, categories, emirate, limit }) {
    await new Promise(resolve => setTimeout(resolve, this.delayMs));

    if (process.env.NODE_ENV === 'test' || process.env.ALLOW_MOCK_DISCOVERY === 'true') {
      const filtered = this.mockData.filter(p => {
        const text = `${p.company_name} ${p.categories?.join(' ')} ${p.emirate}`.toLowerCase();
        if (query && !text.includes(query.toLowerCase())) return false;
        if (categories?.length && !categories.some(c => p.categories?.includes(c))) return false;
        if (emirate && p.emirate !== emirate) return false;
        return true;
      }).slice(0, limit);

      return { prospects: filtered, totalFound: filtered.length };
    }

    return { prospects: [], totalFound: 0, reason: 'Mock provider disabled in production' };
  }
}

export class FirecrawlDiscoveryProvider {
  constructor(env = {}) {
    this.env = env;
    this.apiKey = env.FIRECRAWL_API_KEY || '';
    this.timeoutMs = parseInt(env.DISCOVERY_TIMEOUT_MS || '15000', 10);
  }

  async key() {
    if (this.apiKey) return this.apiKey;
    const key = this.env.SUPABASE_SERVICE_ROLE_KEY || this.env.SUPABASE_SECRET_KEY || '';
    if (!this.env.SUPABASE_URL || !key) return '';
    const response = await fetch(`${this.env.SUPABASE_URL}/rest/v1/integration_secrets?id=eq.FIRECRAWL_API_KEY&select=value`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    if (!response.ok) return '';
    const rows = await response.json();
    this.apiKey = rows?.[0]?.value || '';
    return this.apiKey;
  }

  async searchDirectory({ categories, emirate, limit }) {
    return this.search({ query: [...(categories || []), emirate, 'contractor'].filter(Boolean).join(' '), categories, emirate, limit, source: 'municipality_list' });
  }

  async searchWeb({ query, categories, emirate, limit }) {
    return this.search({ query, categories, emirate, limit, source: 'web_search' });
  }

  async findPublicEmail(url) {
    const apiKey = await this.key();
    if (!apiKey || !url) return '';
    const response = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
      signal: AbortSignal.timeout(Math.min(this.timeoutMs, 12000))
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return '';
    return pickEmail(data.data?.markdown || data.markdown || '');
  }

  async search({ query, categories, emirate, limit, source }) {
    const apiKey = await this.key();
    if (!apiKey) return { prospects: [], totalFound: 0, reason: 'Firecrawl is not configured' };
    const response = await fetch('https://api.firecrawl.dev/v2/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: [query, emirate, 'UAE'].filter(Boolean).join(' '), limit: Math.min(Number(limit) || 8, 10) }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new Error(data.error || `Firecrawl ${response.status}`);
    const web = Array.isArray(data.data?.web) ? data.data.web : [];
    const prospects = web.map((item) => toProspect(item, { categories, emirate, source })).filter(Boolean);
    return { prospects, totalFound: prospects.length };
  }
}

function usableCompany(name) {
  const text = String(name || '').trim();
  if (text.length < 4 || text.length > 80) return false;
  if (/^(pdf|docx?|xlsx?|csv|list|home|contact|about)$/i.test(text)) return false;
  if (/\b(pdf|directory|membership list|top rated|wikipedia|download)\b/i.test(text)) return false;
  return true;
}

const EMAIL_TLDS = new Set(['com', 'ae', 'net', 'org', 'co', 'me', 'io', 'biz', 'info', 'uk', 'eu', 'de', 'in', 'sa', 'qa', 'bh', 'om']);

export function isDeliverableEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(email)) return false;
  if (/(noreply|no-reply|example\.|sentry|wixpress|godaddy|wordpress|schema\.org)/.test(email)) return false;
  const labels = email.split('@')[1].split('.');
  const tld = labels.pop();
  if (!EMAIL_TLDS.has(tld)) return false;
  return labels.every((label) => label.length >= 2 && /^[a-z0-9-]+$/.test(label));
}

function pickEmail(text) {
  const found = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi) || [];
  return found.map((email) => email.toLowerCase()).find((email) => isDeliverableEmail(email)) || '';
}

function toProspect(item, { categories, emirate, source }) {
  let url;
  try { url = new URL(item.url); } catch { return null; }
  if (/(facebook|instagram|youtube|wikipedia|linkedin|tiktok|yellowpages|protenders|gotoprated|yelp|bark\.com|indeed|dubizzle|bayut|propertyfinder|scribd|slideshare|issuu)\./i.test(url.hostname)) return null;
  if (/\.gov\.ae$/i.test(url.hostname)) return null;
  const parts = String(item.title || '').split(/\s+[|\-–]\s+/).map((part) => part.trim()).filter((part) => part.length > 1 && part.length < 80);
  const company = parts.sort((a, b) => a.length - b.length).find((part) => usableCompany(part));
  if (!company) return null;
  return {
    source,
    source_reference: item.url,
    company_name: company,
    trade_license_no: null,
    categories: (categories || []).filter(Boolean),
    subcategories: [],
    emirate: emirate || '',
    city: '',
    website: item.url,
    contact_email: null,
    contact_phone: null,
    certifications: [],
    project_references: item.description ? [{ note: String(item.description).slice(0, 500) }] : []
  };
}

// Factory to create discovery provider with configured sources
export function createDiscoveryProvider(env = {}) {
  const provider = new DiscoveryProvider({
    timeoutMs: parseInt(env.DISCOVERY_TIMEOUT_MS || '15000'),
    maxResults: parseInt(env.DISCOVERY_MAX_RESULTS || '50'),
    cacheTtlMs: parseInt(env.DISCOVERY_CACHE_TTL_MS || '3600000')
  });

  const firecrawl = new FirecrawlDiscoveryProvider(env);
  if (env.FIRECRAWL_API_KEY || env.SUPABASE_URL) {
    provider.registerProvider('web_search', firecrawl);
    provider.registerProvider('municipality_list', firecrawl);
  }

  // Register HTTP providers for each source if configured
  const sources = [
    { key: 'MUNICIPALITY_LIST', envPrefix: 'MUNICIPALITY' },
    { key: 'FREE_ZONE_LIST', envPrefix: 'FREE_ZONE' },
    { key: 'CHAMBER_OF_COMMERCE', envPrefix: 'CHAMBER' },
    { key: 'TRADE_SHOW', envPrefix: 'TRADE_SHOW' }
  ];

  for (const { key, envPrefix } of sources) {
    const apiBase = env[`${envPrefix}_API_BASE`];
    const apiKey = env[`${envPrefix}_API_KEY`];
    const clientId = env[`${envPrefix}_CLIENT_ID`];

    if (apiBase && apiKey) {
      provider.registerProvider(key, new HttpDiscoveryProvider({
        apiBase,
        apiKey,
        clientId,
        source: key
      }));
    }
  }

  // Register web search provider
  if (env.WEB_SEARCH_API_BASE && env.WEB_SEARCH_API_KEY) {
    provider.registerProvider('web_search', new HttpDiscoveryProvider({
      apiBase: env.WEB_SEARCH_API_BASE,
      apiKey: env.WEB_SEARCH_API_KEY,
      clientId: env.WEB_SEARCH_CLIENT_ID,
      source: 'web_search'
    }));
  }

  // Register mock provider only for testing
  if (env.NODE_ENV === 'test' || env.ALLOW_MOCK_DISCOVERY === 'true') {
    provider.registerProvider('mock', new MockDiscoveryProvider({
      shouldSucceed: env.MOCK_DISCOVERY_SUCCESS !== 'false',
      mockData: env.MOCK_DISCOVERY_DATA ? JSON.parse(env.MOCK_DISCOVERY_DATA) : []
    }));
  }

  return provider;
}

export default DiscoveryProvider;
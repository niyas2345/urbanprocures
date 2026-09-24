/**
 * Trade License Verification Provider Abstraction
 * Supports UAE municipality APIs (DED Dubai, ADDED Abu Dhabi, etc.)
 * Returns explicit PENDING state when not configured - never fakes verification
 */

export const VERIFICATION_STATUS = Object.freeze({
  VERIFIED: 'verified',
  INVALID: 'invalid',
  EXPIRED: 'expired',
  PENDING_PROVIDER: 'pending_provider',
  PROVIDER_ERROR: 'provider_error',
  NOT_CONFIGURED: 'not_configured'
});

export const EMIRATE_AUTHORITIES = Object.freeze({
  DUBAI: { code: 'DUBAI', name: 'Dubai Economy (DED)', apiBase: 'https://api.dubaided.gov.ae' },
  ABU_DHABI: { code: 'ABU_DHABI', name: 'Abu Dhabi Department of Economic Development (ADDED)', apiBase: 'https://api.added.gov.ae' },
  SHARJAH: { code: 'SHARJAH', name: 'Sharjah Economic Development Department (SEDD)', apiBase: 'https://api.sedd.ae' },
  AJMAN: { code: 'AJMAN', name: 'Ajman Department of Economic Development', apiBase: 'https://api.ajmanded.ae' },
  RAS_AL_KHAIMAH: { code: 'RAS_AL_KHAIMAH', name: 'RAK Department of Economic Development', apiBase: 'https://api.rakded.ae' },
  FUJAIRAH: { code: 'FUJAIRAH', name: 'Fujairah Municipality', apiBase: 'https://api.fujairahm municipality.ae' },
  UMM_AL_QUWAIN: { code: 'UMM_AL_QUWAIN', name: 'UAQ Department of Economic Development', apiBase: 'https://api.uaqded.ae' }
});

export class LicenseVerifier {
  constructor(config = {}) {
    this.config = {
      defaultEmirate: config.defaultEmirate || 'DUBAI',
      timeoutMs: config.timeoutMs || 10000,
      cacheTtlMs: config.cacheTtlMs || 24 * 60 * 60 * 1000, // 24 hours
      ...config
    };
    this.cache = new Map();
    this.providers = new Map();
  }

  registerProvider(emirate, provider) {
    this.providers.set(emirate.toUpperCase(), provider);
  }

  getProvider(emirate) {
    return this.providers.get(emirate?.toUpperCase() || this.config.defaultEmirate);
  }

  async verify({ licenseNumber, emirate, companyName }) {
    const normalizedEmirate = (emirate || this.config.defaultEmirate).toUpperCase();
    const provider = this.getProvider(normalizedEmirate);

    if (!provider) {
      return {
        status: VERIFICATION_STATUS.NOT_CONFIGURED,
        verified: false,
        reason: `No license verification provider configured for ${normalizedEmirate}`,
        authority: EMIRATE_AUTHORITIES[normalizedEmirate]?.name || 'Unknown',
        license_number: licenseNumber,
        checked_at: new Date().toISOString()
      };
    }

    // Check cache first
    const cacheKey = `${normalizedEmirate}:${licenseNumber}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.config.cacheTtlMs) {
      return { ...cached.result, cached: true };
    }

    try {
      const result = await Promise.race([
        provider.verify({ licenseNumber, companyName, emirate: normalizedEmirate }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Verification timeout')), this.config.timeoutMs))
      ]);

      const verified = {
        status: result.valid ? VERIFICATION_STATUS.VERIFIED : VERIFICATION_STATUS.INVALID,
        verified: result.valid,
        reason: result.reason || (result.valid ? 'License verified' : 'License invalid or not found'),
        authority: EMIRATE_AUTHORITIES[normalizedEmirate]?.name || 'Unknown',
        license_number: licenseNumber,
        company_name: result.companyName || companyName,
        license_expiry: result.expiryDate || null,
        license_activities: result.activities || [],
        checked_at: new Date().toISOString(),
        provider_response: result.rawResponse || null
      };

      this.cache.set(cacheKey, { result: verified, timestamp: Date.now() });
      return verified;

    } catch (error) {
      const errorResult = {
        status: VERIFICATION_STATUS.PROVIDER_ERROR,
        verified: false,
        reason: `Verification provider error: ${error.message}`,
        authority: EMIRATE_AUTHORITIES[normalizedEmirate]?.name || 'Unknown',
        license_number: licenseNumber,
        checked_at: new Date().toISOString()
      };
      return errorResult;
    }
  }

  clearCache() {
    this.cache.clear();
  }
}

// HTTP-based provider for municipality APIs
export class HttpLicenseProvider {
  constructor(config = {}) {
    this.apiBase = config.apiBase;
    this.apiKey = config.apiKey;
    this.clientId = config.clientId;
    this.timeoutMs = config.timeoutMs || 10000;
  }

  async verify({ licenseNumber, companyName, emirate }) {
    if (!this.apiBase || !this.apiKey) {
      return { valid: false, reason: 'Provider not fully configured (missing apiBase or apiKey)' };
    }

    try {
      const response = await fetch(`${this.apiBase}/licenses/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'X-Client-ID': this.clientId || ''
        },
        body: JSON.stringify({
          license_number: licenseNumber,
          company_name: companyName,
          emirate
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { valid: false, reason: `API error: ${response.status} - ${errorText}`, rawResponse: { status: response.status, body: errorText } };
      }

      const data = await response.json();
      return {
        valid: data.valid === true,
        companyName: data.company_name || data.trade_name,
        expiryDate: data.expiry_date || data.license_expiry,
        activities: data.activities || data.license_activities,
        rawResponse: data
      };
    } catch (error) {
      return { valid: false, reason: `Network error: ${error.message}`, rawResponse: null };
    }
  }
}

// Mock provider for testing/development - NEVER returns fake verified in production
export class MockLicenseProvider {
  constructor(config = {}) {
    this.shouldSucceed = config.shouldSucceed ?? true;
    this.delayMs = config.delayMs || 100;
    this.mockData = config.mockData || {};
  }

  async verify({ licenseNumber, companyName, emirate }) {
    await new Promise(resolve => setTimeout(resolve, this.delayMs));

    // In test mode, check if we have predefined mock data
    if (this.mockData[licenseNumber]) {
      const data = this.mockData[licenseNumber];
      return {
        valid: data.valid ?? this.shouldSucceed,
        companyName: data.companyName || companyName,
        expiryDate: data.expiryDate,
        activities: data.activities,
        rawResponse: data
      };
    }

    // Default mock behavior - only for testing
    if (process.env.NODE_ENV === 'test' || process.env.ALLOW_MOCK_VERIFICATION === 'true') {
      return {
        valid: this.shouldSucceed,
        companyName: companyName || `Mock Company for ${licenseNumber}`,
        expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        activities: ['General Trading', 'Construction'],
        rawResponse: { mock: true, licenseNumber }
      };
    }

    // Production: never fake verification
    return {
      valid: false,
      reason: 'Mock provider disabled in production. Configure real provider.',
      rawResponse: null
    };
  }
}

// Factory to create verifier with configured providers
export function createLicenseVerifier(env = {}) {
  const verifier = new LicenseVerifier({
    defaultEmirate: env.LICENSE_VERIFIER_DEFAULT_EMIRATE || 'DUBAI',
    timeoutMs: parseInt(env.LICENSE_VERIFIER_TIMEOUT_MS || '10000'),
    cacheTtlMs: parseInt(env.LICENSE_VERIFIER_CACHE_TTL_MS || '86400000')
  });

  // Register HTTP providers if configured
  if (env.DED_API_BASE && env.DED_API_KEY) {
    verifier.registerProvider('DUBAI', new HttpLicenseProvider({
      apiBase: env.DED_API_BASE,
      apiKey: env.DED_API_KEY,
      clientId: env.DED_CLIENT_ID
    }));
  }

  if (env.ADDED_API_BASE && env.ADDED_API_KEY) {
    verifier.registerProvider('ABU_DHABI', new HttpLicenseProvider({
      apiBase: env.ADDED_API_BASE,
      apiKey: env.ADDED_API_KEY,
      clientId: env.ADDED_CLIENT_ID
    }));
  }

  // Register mock provider only for testing
  if (env.NODE_ENV === 'test' || env.ALLOW_MOCK_VERIFICATION === 'true') {
    verifier.registerProvider('MOCK', new MockLicenseProvider({
      shouldSucceed: env.MOCK_VERIFICATION_SUCCESS !== 'false'
    }));
    // Use mock as default for testing
    verifier.config.defaultEmirate = 'MOCK';
  }

  return verifier;
}

export default LicenseVerifier;
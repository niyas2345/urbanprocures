import { sanitizeTextForExternalUse } from './document-firewall.js';

const LEAK_PATTERNS = [
  { type: 'email', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { type: 'phone', re: /(?:\+971[\s\-]?[0-9][\s\-0-9]{7,}|\+[0-9][0-9\s\-()]{8,}|\b(?:tel|telephone|mobile|phone|fax|contact)\s*[:\-]?\s*\+?[0-9][0-9 ()\-]{7,})/gi },
  { type: 'url', re: /https?:\/\/[^\s)]+/gi },
  { type: 'trade_license', re: /\b(?:trade\s*license|trn|vat\s*no)\s*[:\-]?\s*[A-Z0-9\-\/]{5,}\b/gi },
];

const AREA_NAMES = /^(dubai|abu dhabi|sharjah|ajman|ras al khaimah|fujairah|umm al quwain|jebel ali|deira|bur dubai|al quoz|dip|dubai investment park)$/i;

export function scanIdentityLeakage(payload, identityTerms = []) {
  const text = flatten(payload);
  const hits = [];
  for (const rule of LEAK_PATTERNS) {
    const found = text.match(rule.re) || [];
    for (const value of found) {
      hits.push({ type: rule.type, value: value.trim() });
    }
  }
  for (const term of identityTerms) {
    const value = String(term || '').trim();
    if (value.length < 4 || AREA_NAMES.test(value)) continue;
    if (text.toLowerCase().includes(value.toLowerCase())) hits.push({ type: 'known_identity_term', value: '[REDACTED]' });
  }
  return {
    leaked: hits.length > 0,
    hits,
    requires_human_review: hits.length > 0,
  };
}

export function sanitizeIdentity(payload) {
  if (payload == null) return payload;
  if (typeof payload === 'string') return sanitizeTextForExternalUse(payload);
  if (Array.isArray(payload)) return payload.map(sanitizeIdentity);
  if (typeof payload === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(payload)) {
      if (isIdentityKey(key)) continue;
      out[key] = sanitizeIdentity(value);
    }
    return out;
  }
  return payload;
}

export function assertNoIdentityLeak(payload) {
  const scan = scanIdentityLeakage(payload);
  if (scan.leaked) {
    const error = new Error('Identity leakage detected');
    error.scan = scan;
    throw error;
  }
  return true;
}

function isIdentityKey(key) {
  return /client|vendor|company|email|phone|mobile|address|contact|logo|license|legal_name|filename|storage_path|storage_key/i.test(key);
}

function flatten(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

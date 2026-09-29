/** Provider-neutral OCR/Vision boundary.
 * Providers return one stable result shape; missing credentials never become
 * fabricated extraction. The caller may inject `provider` for tests or use an
 * HTTP provider configured by environment variables in a worker.
 */
export const ADAPTER_STATUS = Object.freeze({ EXTRACTED: 'extracted', PENDING: 'pending_external', FAILED: 'failed' });

export async function runOcrVision({ bytes, fileName = '', mimeType = '', pages = [], provider, env = {} } = {}) {
  const input = { bytes, fileName, mimeType, pages };
  try {
    const active = provider || await createOcrSpaceProvider(env) || createHttpProvider(env);
    if (!active) return pendingResult('ocr_vision_provider_not_configured');
    const result = await active.extract(input);
    return normalizeResult(result, active.name || 'custom');
  } catch (error) {
    return { status: ADAPTER_STATUS.FAILED, text: '', pages: [], tables: [], confidence: 0,
      warnings: [], provider: provider?.name || env.OCR_VISION_PROVIDER || 'ocr.space', model: env.OCR_VISION_MODEL || null,
      failure_reason: error?.message || 'ocr_vision_failed', metadata: {} };
  }
}

export async function createOcrSpaceProvider(env = {}) {
  const apiKey = await ocrSpaceKey(env);
  if (!apiKey) return null;
  return {
    name: 'ocr.space',
    async extract({ bytes, fileName, mimeType }) {
      const size = bytes?.byteLength || bytes?.length || 0;
      if (!size) return ocrFailure('ocr_space_empty_file');
      if (size > 1024 * 1024) return ocrFailure('ocr_space_file_over_1mb');
      const form = new FormData();
      form.append('language', env.OCR_SPACE_LANGUAGE || 'eng');
      form.append('isOverlayRequired', 'false');
      form.append('OCREngine', '2');
      form.append('scale', 'true');
      form.append('detectOrientation', 'true');
      form.append('file', new Blob([bytes], { type: mimeType || 'application/octet-stream' }), fileName || 'scan');
      try {
        const response = await fetch('https://api.ocr.space/parse/image', { method: 'POST', headers: { apikey: apiKey }, body: form, signal: AbortSignal.timeout(20000) });
        const raw = await response.text();
        let payload;
        try { payload = raw ? JSON.parse(raw) : {}; } catch { return ocrFailure('ocr_space_bad_response'); }
        if (response.status === 401 || response.status === 403) return ocrFailure('ocr_space_invalid_key');
        if (response.status === 429) return ocrFailure('ocr_space_rate_limited');
        if (!response.ok) return ocrFailure(`ocr_space_http_${response.status}`);
        return ocrSpaceResult(payload);
      } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return ocrFailure('ocr_space_timeout');
        throw error;
      }
    },
  };
}

export function ocrSpaceResult(payload = {}) {
  const error = firstError(payload.ErrorMessage, payload.ErrorDetails);
  const exit = Number(payload.OCRExitCode);
  const pages = (payload.ParsedResults || []).map((item, index) => ({
    page_number: index + 1,
    text: String(item.ParsedText || '').trim(),
    error: firstError(item.ErrorMessage, item.ErrorDetails)
  }));
  const pageErrors = pages.map((page) => page.error).filter(Boolean);
  const text = pages.map((page) => page.text).filter(Boolean).join('\n');
  if (payload.IsErroredOnProcessing || exit === 3 || exit === 4) return ocrFailure(ocrReason(error || pageErrors[0], exit));
  if (!text) return ocrFailure(ocrReason(error || pageErrors[0] || 'no_text', exit));
  return { status: ADAPTER_STATUS.EXTRACTED, text, pages, tables: [], confidence: exit === 2 ? 0.6 : 0.8, provider: 'ocr.space', model: '2', warnings: pageErrors };
}

function ocrFailure(reason) {
  return { status: ADAPTER_STATUS.FAILED, text: '', pages: [], tables: [], confidence: 0, warnings: [], provider: 'ocr.space', model: '2', failure_reason: reason || 'ocr_space_failed' };
}

function ocrReason(message, exit) {
  const lower = String(message || '').toLowerCase();
  if (lower.includes('api key') || lower.includes('apikey')) return 'ocr_space_invalid_key';
  if (lower.includes('file size') || lower.includes('too large') || lower.includes('maximum')) return 'ocr_space_file_over_1mb';
  if (lower.includes('timed out') || lower.includes('timeout')) return 'ocr_space_timeout';
  if (lower.includes('rate')) return 'ocr_space_rate_limited';
  if (message && message !== 'no_text') return String(message).slice(0, 300);
  return exit ? `ocr_space_exit_${exit}` : 'ocr_space_failed';
}

function firstError(...values) {
  for (const value of values) {
    const text = (Array.isArray(value) ? value.filter(Boolean).join('; ') : String(value || '')).replace(/\s+/g, ' ').trim();
    if (text && text !== 'null' && text !== 'undefined') return text.slice(0, 300);
  }
  return '';
}

async function ocrSpaceKey(env) {
  if (env.OCR_SPACE_API_KEY) return env.OCR_SPACE_API_KEY;
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || '';
  if (!env.SUPABASE_URL || !key) return '';
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/integration_secrets?id=eq.OCR_SPACE_API_KEY&select=value`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  if (!response.ok) return '';
  const rows = await response.json();
  return rows?.[0]?.value || '';
}

export function createHttpProvider(env = {}) {
  if (!env.OCR_VISION_ENDPOINT || !env.OCR_VISION_API_KEY) return null;
  return {
    name: env.OCR_VISION_PROVIDER || 'http-ocr-vision',
    async extract({ bytes, fileName, mimeType, pages }) {
      const response = await fetch(env.OCR_VISION_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.OCR_VISION_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_name: fileName, mime_type: mimeType, bytes_base64: toBase64(bytes), pages }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`provider_http_${response.status}`);
      return JSON.parse(text);
    },
  };
}

function normalizeResult(value = {}, provider) {
  const status = value.status === ADAPTER_STATUS.EXTRACTED ? ADAPTER_STATUS.EXTRACTED : ADAPTER_STATUS.FAILED;
  return { status, text: typeof value.text === 'string' ? value.text : '', pages: Array.isArray(value.pages) ? value.pages : [],
    tables: Array.isArray(value.tables) ? value.tables : [], confidence: clamp(value.confidence),
    warnings: Array.isArray(value.warnings) ? value.warnings : [], provider: value.provider || provider,
    model: value.model || null, failure_reason: status === ADAPTER_STATUS.FAILED ? (value.failure_reason || 'provider_failed') : null,
    metadata: value.metadata && typeof value.metadata === 'object' ? value.metadata : {} };
}

function pendingResult(reason) {
  return { status: ADAPTER_STATUS.PENDING, text: '', pages: [], tables: [], confidence: 0,
    warnings: ['External OCR/Vision provider is not configured'], provider: null, model: null,
    failure_reason: reason, metadata: {} };
}
function clamp(value) { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; }
function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes || []).toString('base64');
  let binary = ''; for (const byte of new Uint8Array(bytes || [])) binary += String.fromCharCode(byte);
  return btoa(binary);
}

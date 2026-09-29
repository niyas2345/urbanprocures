export function mapQuotes(rows, revealVendor) {
  const byRfq = new Map();
  return rows.map((row) => {
    const group = byRfq.get(row.rfq_id) || [];
    const index = group.length; group.push(row.id); byRfq.set(row.rfq_id, group);
    return anonymousQuote(row, index, revealVendor);
  });
}

export function anonymousQuote(row, index, revealVendor) {
  return {
    id: row.id, rfq_id: row.rfq_id, vendor_id: revealVendor ? row.vendor_user_id : undefined,
    vendor_label: revealVendor ? (row.vendor_user_id || `Vendor ${String.fromCharCode(65 + index)}`) : `Vendor ${String.fromCharCode(65 + index)}`,
    vendor_reference: revealVendor ? row.vendor_reference : undefined,
    subtotal: row.subtotal, vat: row.vat, total: row.total, currency: row.currency,
    validity_days: row.validity_days, completion_period: row.completion_period, mobilization: row.mobilization,
    warranty: row.warranty, inclusions: row.inclusions, exclusions: row.exclusions, deviations: row.deviations,
    payment_terms: row.payment_terms, notes: row.notes, status: row.status,
    arithmetic_valid: row.arithmetic_valid, comparison_flags: row.comparison_flags, created_at: row.created_at,
  };
}

export function vendorSafeRow(row) {
  const safe = row.sanitized_payload || {};
  return {
    id: row.id, title: safe.title || row.title, category: safe.category || row.category,
    subcategory: row.subcategory, emirate: row.emirate, deadline: row.deadline, status: row.status,
    project: row.project, start_date: row.start_date, duration: row.duration, visit: row.visit,
    scope: safe.scope || safe.scope_summary || '', boq_items: safe.boq_items || safe.items || [], sanitized: true,
  };
}

export function mapDocuments(attachments, rfqDocuments, quoteDocuments) {
  const attachmentNames = new Map(attachments.map((row) => [`${row.owner_type}:${row.owner_id}:${row.name}`, row]));
  return [
    ...rfqDocuments.map((row) => ({ id: row.id, kind: 'rfq', owner_id: row.rfq_id, name: row.original_filename, mime_type: row.mime_type, size: row.file_size, status: row.processing_status, requires_review: row.requires_human_review, created_at: row.created_at, attachment: attachmentNames.get(`rfq:${row.rfq_id}:${row.original_filename}`)?.id || null })),
    ...quoteDocuments.map((row) => ({ id: row.id, kind: 'quote', owner_id: row.quotation_id, rfq_id: row.rfq_id, name: row.original_filename, mime_type: row.mime_type, status: row.processing_status, requires_review: row.requires_human_review, created_at: row.created_at })),
  ];
}

export function scoreVendor(rfq, vendor) {
  let score = 0; const reasons = [];
  const categories = (vendor.categories || []).map(lower);
  if (categories.includes(lower(rfq.category))) { score += 60; reasons.push('category'); }
  if (lower(vendor.emirate) === lower(rfq.emirate)) { score += 25; reasons.push('emirate'); }
  if (Number(vendor.capacity || 0) > 0) { score += 10; reasons.push('capacity'); }
  if (vendor.status === 'verified') { score += 5; reasons.push('verified'); }
  return { vendor, score, reasons };
}

export function mergeExtractions(extractions) {
  const first = extractions[0] || {};
  return {
    ...first,
    text: extractions.map((item) => item.text || '').filter(Boolean).join('\n\n'),
    tables: extractions.flatMap((item) => item.tables || []),
    boq: extractions.flatMap((item) => item.boq || item.boq_items || []),
    pages: extractions.flatMap((item) => item.pages || []),
    confidence: Math.min(...extractions.map((item) => Number(item.confidence ?? 1))),
    requires_human_review: extractions.some((item) => item.requires_human_review),
  };
}

export function documentStatus(row) { return { id: row.id, name: row.original_filename, status: row.processing_status, requires_human_review: row.requires_human_review }; }
export function assertRfqOwner(rfq, actor) { if (!rfq) throw notFound('RFQ not found'); if (actor.role !== 'admin' && (actor.role !== 'client' || rfq.client_id !== actor.userId)) throw forbidden('RFQ access denied'); }
export async function getRfq(env, id) { return one(env, `/rest/v1/rfqs?${params({ id: `eq.${id}`, select: '*' })}`); }

export function redactIdentityTerms(text, terms) {
  let out = String(text || '');
  for (const term of terms || []) {
    const value = String(term || '').trim();
    if (value.length < 4) continue;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'gi'), ' ').replace(/\s{2,}/g, ' ').trim();
  }
  return out;
}

export function guestIdentityTerms(rfq) {
  const text = String(rfq?.special_requirements || '');
  const terms = [];
  for (const key of ['name', 'phone', 'email']) {
    const match = text.match(new RegExp(`(?:^|\\n)${key}:\\s*(.+)$`, 'im'));
    if (match?.[1]) terms.push(match[1].trim());
  }
  return terms.filter(Boolean);
}

export async function collectClientIdentityTerms(env, rfq) {
  const clientId = rfq?.client_id || rfq?.client_user_id || rfq?.created_by;
  if (!clientId) return [];
  const profile = await one(env, `/rest/v1/client_profiles?${params({ id: `eq.${clientId}`, select: 'company_name,contact_name,phone,whatsapp,emirate' })}`);
  if (!profile) return [];
  const terms = [];
  if (profile.company_name) terms.push(profile.company_name);
  if (profile.contact_name) terms.push(profile.contact_name);
  if (profile.phone) terms.push(profile.phone);
  if (profile.whatsapp) terms.push(profile.whatsapp);
  return terms.filter(Boolean);
}

export async function notify(env, { userId = null, role, rfqId = null, eventType, message }) {
  return insert(env, 'procurement_notifications', { user_id: userId, role, rfq_id: rfqId, event_type: eventType, message });
}
export async function audit(env, actor, rfqId, eventType, details) {
  return insert(env, 'procurement_audit_events', { rfq_id: rfqId, actor_user_id: actor.userId, actor_role: actor.role, event_type: eventType, details });
}

export async function rest(env, path, init = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
  const response = await fetch(`${env.SUPABASE_URL}${path}`, { ...init, headers: { ...adminHeaders(env, key), 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(readError(text) || `Supabase request failed (${response.status})`);
  return text ? JSON.parse(text) : [];
}
export async function one(env, path) { return (await rest(env, path))[0] || null; }
export async function insert(env, table, row) { const rows = await rest(env, `/rest/v1/${table}`, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) }); return rows[0] || row; }
export async function upsert(env, table, row, conflict) { const rows = await rest(env, `/rest/v1/${table}?on_conflict=${encodeURIComponent(conflict)}`, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(row) }); return rows[0] || row; }
export async function patch(env, table, filter, body) { const rows = await rest(env, `/rest/v1/${table}?${filter}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) }); return rows[0] || body; }
export function adminHeaders(env, key) { return { apikey: key, Authorization: `Bearer ${key}` }; }

export function params(input) { const out = new URLSearchParams(); for (const [key, value] of Object.entries(input)) if (value !== undefined && value !== null && value !== '') out.set(key, value); return out.toString(); }
export function inFilter(values) { return `in.(${values.map((value) => `"${String(value).replaceAll('"', '')}"`).join(',')})`; }
export function encodePath(path) { return String(path || '').split('/').map(encodeURIComponent).join('/'); }
export function clean(value, max = 5000) { return String(value ?? '').trim().slice(0, max); }
export function list(value) { return (Array.isArray(value) ? value : String(value || '').split(/[\n,]/)).map((item) => clean(item, 1000)).filter(Boolean).slice(0, 200); }
export function nullableNumber(value) { if (value === null || value === undefined || value === '') return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
export function positiveInt(value) { const number = Number.parseInt(value, 10); return Number.isFinite(number) && number > 0 ? number : null; }
export function lower(value) { return String(value || '').trim().toLowerCase(); }
export function safeDisposition(value) { return String(value).replace(/[\r\n"\\]/g, '_').slice(0, 180); }
export function readError(text) { try { const data = JSON.parse(text); return data.message || data.error || data.hint; } catch { return text; } }
export function readJson(request) { return request.json().catch(() => ({})); }
export function denied() { return json({ ok: false, error: 'Access denied' }, 403); }
export function forbidden(message) { return Object.assign(new Error(message), { status: 403 }); }
export function notFound(message) { return Object.assign(new Error(message), { status: 404 }); }
export function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }

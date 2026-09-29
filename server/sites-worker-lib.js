import { supabaseSecret, supabaseReady } from "./supabase-env.js";
import { readSessionUser } from "./auth/identity.js";

const DOC_TYPES = new Set(["vendor_tnc", "client_tnc", "annex_a"]);

async function publicStats(env) {
  const empty = {
    ok: true, vendors: 0, companies: 0, rfqs: 0, awards: 0, quotes: 0, volume: 0,
    openRfqs: 0, closingThisWeek: 0, topCategory: "", categories: [], awardsFeed: [], activity: []
  };
  if (!supabaseReady(env)) return json(empty);
  try {
    const [vendors, allVendors, clients, rfqs, awards, quotes] = await Promise.all([
      countRows(env, "/rest/v1/vendor_profiles?status=eq.verified"),
      countRows(env, "/rest/v1/vendor_profiles"),
      countRows(env, "/rest/v1/client_profiles"),
      countRows(env, "/rest/v1/rfqs"),
      countRows(env, "/rest/v1/awards"),
      countRows(env, "/rest/v1/quotations")
    ]);
    const [awardRows, rfqRows, noteRows] = await Promise.all([
      supabaseFetch(env, "/rest/v1/awards?select=rfq_id,awarded_amount,created_at&order=created_at.desc&limit=8").catch(() => []),
      supabaseFetch(env, "/rest/v1/rfqs?select=id,category,status,deadline,created_at&order=created_at.desc&limit=80").catch(() => []),
      supabaseFetch(env, "/rest/v1/procurement_notifications?select=event_type,created_at&order=created_at.desc&limit=8").catch(() => [])
    ]);
    const volume = (awardRows || []).reduce((sum, row) => sum + Number(row.awarded_amount || 0), 0);
    const openStatuses = new Set(["Submitted", "Under Review", "Matching", "Quoting", "Comparing"]);
    const today = new Date();
    const week = new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10);
    const todayStr = today.toISOString().slice(0, 10);
    const openRfqs = (rfqRows || []).filter((row) => openStatuses.has(row.status)).length;
    const closingThisWeek = (rfqRows || []).filter((row) => row.deadline && row.deadline >= todayStr && row.deadline <= week).length;
    const catMap = {};
    (rfqRows || []).forEach((row) => {
      const key = String(row.category || "").trim() || "Other";
      catMap[key] = (catMap[key] || 0) + 1;
    });
    const catTotal = Object.values(catMap).reduce((s, n) => s + n, 0) || 1;
    const categories = Object.entries(catMap).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count, pct: Math.round((count / catTotal) * 100) }));
    const rfqById = Object.fromEntries((rfqRows || []).map((row) => [row.id, row]));
    const awardsFeed = (awardRows || []).map((row) => ({ category: rfqById[row.rfq_id]?.category || "Awarded work", created_at: row.created_at }));
    const activity = (noteRows || []).map((row) => ({ event: publicActivityLabel(row.event_type), created_at: row.created_at }));
    return json({ ok: true, vendors, companies: allVendors + clients, rfqs, awards, quotes, volume, openRfqs, closingThisWeek, topCategory: categories[0]?.name || "", categories, awardsFeed, activity });
  } catch {
    return json(empty);
  }
}

function publicActivityLabel(eventType) {
  const map = {
    rfq_created: "A new RFQ is with the desk",
    quotation_received: "A quotation was received",
    award: "A job was awarded",
    award_disclosed: "A job was awarded",
    vendor_registered: "A vendor applied for verification",
    vendor_status: "A vendor verification was updated",
    rfq_invitation: "A vendor was invited to quote",
    clarification: "A clarification was posted",
    rfq_status: "An RFQ moved forward"
  };
  return map[String(eventType || "")] || "Desk activity";
}

async function publicVendors(env) {
  if (!supabaseReady(env)) return json({ ok: true, vendors: [] });
  try {
    const rows = await supabaseFetch(env, "/rest/v1/vendor_profiles?status=eq.verified&select=company_name,trading_name,categories,emirate,status&order=updated_at.desc&limit=60");
    const vendors = (Array.isArray(rows) ? rows : []).map((row) => ({
      company_name: row.company_name || row.trading_name || "Verified vendor",
      trading_name: row.trading_name || "",
      categories: Array.isArray(row.categories) ? row.categories : [],
      emirate: row.emirate || "UAE",
      status: "verified"
    }));
    return json({ ok: true, vendors });
  } catch {
    return json({ ok: true, vendors: [] });
  }
}

async function countRows(env, path) {
  const key = supabaseSecret(env);
  const joiner = path.includes("?") ? "&" : "?";
  const response = await fetch(`${env.SUPABASE_URL}${path}${joiner}select=id`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact", Range: "0-0" }
  });
  const range = response.headers.get("content-range") || "";
  const n = Number(range.split("/")[1]);
  return Number.isFinite(n) ? n : 0;
}

async function publicRfq(request, env) {
  if (!supabaseReady(env)) return json({ ok: false, error: "The desk is not configured to receive requests." }, 503);
  const payload = await readJson(request);
  const title = String(payload.title || "").trim().slice(0, 220);
  const category = String(payload.category || "").trim().slice(0, 120);
  const scope = String(payload.scope || "").trim().slice(0, 20000);
  const fullName = String(payload.full_name || payload.name || "").trim().slice(0, 160);
  const phone = String(payload.phone || "").trim().slice(0, 60);
  const email = String(payload.email || "").trim().slice(0, 200);
  const address = String(payload.address || payload.location || "").trim().slice(0, 500);
  if (!title || !category || !scope || !fullName || !phone || !email) {
    return json({ ok: false, error: "Name, phone, email, title, category and scope are required." }, 400);
  }
  let clientId = null;
  const session = await readSessionUser(request, env);
  if (session.ok && session.role === "client") clientId = session.userId;
  const tracking = String(payload.tracking_code || "").trim().slice(0, 32) || publicTrackingCode();
  const id = String(payload.id || "").trim().slice(0, 80) || tracking;
  const siteVisit = Boolean(payload.site_visit);
  const emirate = String(payload.emirate || payload.city || "Dubai").trim().slice(0, 80) || "Dubai";
  const deadline = payload.deadline ? String(payload.deadline).slice(0, 10) : null;
  const budget = payload.budget_max || payload.budget;
  const budgetNumber = budget === "" || budget == null ? null : Number(budget);
  const special = ["[UP-CONTACT]", `name: ${fullName}`, `phone: ${phone}`, `email: ${email}`, `tracking: ${tracking}`, `visit: ${siteVisit ? "yes" : "no"}`].join("\n");
  const row = {
    id, client_id: clientId, title, category, emirate, scope,
    budget: Number.isFinite(budgetNumber) ? budgetNumber : null,
    deadline,
    visit: siteVisit ? "Site visit requested (AED 100)" : "Documents only",
    status: "Under Review", source: "web",
    project: String(payload.property_type || payload.project || "Personal property").trim().slice(0, 220),
    location: address, special_requirements: special,
    review_state: "awaiting_processing", sanitized_ready: false
  };
  try {
    await supabaseFetch(env, "/rest/v1/rfqs", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
    await supabaseFetch(env, "/rest/v1/procurement_notifications", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: clientId, role: "admin", rfq_id: id, event_type: "rfq_created", message: `New RFQ ${tracking} requires a work pack` })
    }).catch(() => null);
    return json({ ok: true, rfq: { id, tracking_code: tracking, title }, tracking_code: tracking }, 201);
  } catch (error) {
    return json({ ok: false, error: error?.message || "Could not submit this request." }, 400);
  }
}

function publicTrackingCode() {
  return `UP-${Math.random().toString(36).slice(2, 6).toUpperCase()}${Date.now().toString(36).slice(-4).toUpperCase()}`;
}

async function createAuthUser(env, { email, password, role }) {
  const key = supabaseSecret(env);
  if (!key) return { ok: false, status: 503, error: "Supabase service role key is not configured" };
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true, app_metadata: { role } })
  });
  const data = await response.json().catch(() => ({}));
  const user = data.user || data;
  if (!response.ok || !user?.id) {
    return { ok: false, status: response.status || 400, error: data.msg || data.error_description || data.message || "Registration failed" };
  }
  return { ok: true, user: { id: user.id, email: user.email || email, app_metadata: { role } } };
}

async function signInWithPassword(env, email, password) {
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    return { ok: false, status: response.status || 400, error: data.msg || data.error_description || data.message || "Authentication failed" };
  }
  return { ok: true, session: { ...data, user: { ...data.user, app_metadata: { ...(data.user?.app_metadata || {}), role: data.user?.app_metadata?.role || "" } } } };
}

async function auditProvisionedUser(env, { actor_user_id = null, actor_role = "system", event_type, details }) {
  if (!supabaseReady(env)) return null;
  const key = supabaseSecret(env);
  return fetch(`${env.SUPABASE_URL}/rest/v1/procurement_audit_events`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ rfq_id: null, actor_user_id, actor_role, event_type, details })
  });
}

async function getTermsStatus(env, userId) {
  const [documents, acceptances, vendorProfiles] = await Promise.all([
    listTermsDocuments(env), getAcceptanceMap(env, userId), listVendorProfiles(env, userId)
  ]);
  const compliance = Object.fromEntries(Object.entries(documents).map(([docType, document]) => {
    const acceptance = acceptances[docType] || null;
    return [docType, {
      requiredVersion: document.version,
      acceptedVersion: acceptance?.terms_version || "",
      acceptedAt: acceptance?.accepted_at || "",
      requiresReacceptance: !acceptance || compareVersion(acceptance.terms_version, document.version) < 0
    }];
  }));
  return { ok: true, userId, documents, compliance, vendorProfile: vendorProfiles[0] || null };
}

async function acceptTerms(env, request, userId, docType, contactEmail = "") {
  const documents = await listTermsDocuments(env);
  const document = documents[docType];
  if (!document) return { ok: false, error: "Document not published" };
  const latest = await latestAcceptance(env, userId, docType);
  if (latest && latest.terms_version === document.version) return { ok: true, inserted: false, acceptance: latest };
  const row = {
    user_id: userId, doc_type: docType, terms_version: document.version,
    accepted_at: new Date().toISOString(),
    ip_address: request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "",
    user_agent: request.headers.get("User-Agent") || "", method: "clickwrap"
  };
  if (contactEmail) row.contact_email = contactEmail;
  const inserted = await supabaseFetch(env, "/rest/v1/terms_acceptances", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
  return { ok: true, inserted: true, acceptance: inserted[0] || row };
}

async function enforceTerms(env, userId, docType) {
  const documents = await listTermsDocuments(env);
  const document = documents[docType];
  if (!document) return { ok: false, error: "Document not published" };
  const latest = await latestAcceptance(env, userId, docType);
  if (!latest || compareVersion(latest.terms_version, document.version) < 0) {
    return { ok: false, error: "Terms acceptance required", doc_type: docType, required_version: document.version, accepted_version: latest?.terms_version || "" };
  }
  return { ok: true, doc_type: docType, required_version: document.version, accepted_version: latest.terms_version };
}

async function upsertVendorProfile(env, payload, userId) {
  const row = {
    id: userId,
    company_name: payload.company_name || "",
    trade_license_no: payload.trade_license_no || "",
    license_expiry: payload.license_expiry || "",
    categories: Array.isArray(payload.categories) ? payload.categories : [],
    emirate: payload.emirate || "",
    status: payload.status || "pending_verification",
    verified_at: payload.verified_at || null,
    verification_note: payload.verification_note || "",
    updated_at: new Date().toISOString()
  };
  const inserted = await supabaseFetch(env, "/rest/v1/vendor_profiles?on_conflict=id", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(row)
  });
  return { ok: true, vendorProfile: inserted[0] || row };
}

async function listVendorProfiles(env, userId = "") {
  const params = new URLSearchParams({ select: "*", order: "updated_at.desc" });
  if (userId) params.set("id", `eq.${userId}`);
  const rows = await supabaseFetch(env, `/rest/v1/vendor_profiles?${params.toString()}`);
  return { ok: true, vendorProfiles: rows };
}

async function listTermsDocuments(env) {
  const rows = await supabaseFetch(env, `/rest/v1/terms_documents?${new URLSearchParams({ select: "doc_type,version,content,published_at", order: "published_at.desc" }).toString()}`);
  return rows.reduce((map, row) => {
    if (DOC_TYPES.has(row.doc_type) && !map[row.doc_type]) map[row.doc_type] = row;
    return map;
  }, {});
}

async function latestAcceptance(env, userId, docType) {
  const rows = await supabaseFetch(env, `/rest/v1/terms_acceptances?${new URLSearchParams({ select: "user_id,doc_type,terms_version,accepted_at,ip_address,user_agent,method", user_id: `eq.${userId}`, doc_type: `eq.${docType}`, order: "accepted_at.desc", limit: "1" }).toString()}`);
  return rows[0] || null;
}

async function getAcceptanceMap(env, userId) {
  const rows = await supabaseFetch(env, `/rest/v1/terms_acceptances?${new URLSearchParams({ select: "user_id,doc_type,terms_version,accepted_at,ip_address,user_agent,method", user_id: `eq.${userId}`, order: "accepted_at.desc" }).toString()}`);
  return rows.reduce((map, row) => {
    if (!map[row.doc_type]) map[row.doc_type] = row;
    return map;
  }, {});
}

async function supabaseFetch(env, path, init = {}) {
  const key = supabaseSecret(env);
  const response = await fetch(`${env.SUPABASE_URL}${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers || {}) }
  });
  const text = await response.text();
  const data = text ? safeJson(text) : null;
  if (!response.ok) throw new Error(data?.message || data?.error || text || `Supabase request failed (${response.status})`);
  return data || [];
}

function compareVersion(left = "", right = "") {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  const size = Math.max(a.length, b.length);
  for (let index = 0; index < size; index++) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

function readJson(request) {
  return request.json().catch(() => ({}));
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return { message: text }; }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

export {
  publicStats, publicVendors, publicRfq, createAuthUser, signInWithPassword,
  auditProvisionedUser, getTermsStatus, acceptTerms, enforceTerms,
  upsertVendorProfile, listVendorProfiles, readJson, json
};

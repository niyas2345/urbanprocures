/**
 * Supplier Performance Memory
 * Tracks vendor performance across RFQs for future matching and prioritization
 */

export function calculatePerformanceScore(performances) {
  if (!performances?.length) return { overall: 50, components: {} };

  const weights = {
    quote_competitiveness: 0.25,
    technical_compliance: 0.25,
    commercial_compliance: 0.20,
    responsiveness: 0.15,
    on_time_delivery: 0.15
  };

  const components = {
    quote_competitiveness: avg(performances.map(p => p.quote_competitiveness_score).filter(v => v != null)),
    technical_compliance: avg(performances.map(p => p.technical_compliance_score).filter(v => v != null)),
    commercial_compliance: avg(performances.map(p => p.commercial_compliance_score).filter(v => v != null)),
    responsiveness: avg(performances.map(p => p.responsiveness_score).filter(v => v != null)),
    on_time_delivery: avg(performances.map(p => p.submitted_on_time ? 100 : 0).filter(v => v != null))
  };

  const overall = Object.entries(weights).reduce((sum, [key, weight]) => {
    return sum + (components[key] || 50) * weight;
  }, 0);

  return { overall: Math.round(overall), components };
}

export function calculateReliabilityTier(score) {
  if (score >= 85) return 'premium';
  if (score >= 70) return 'reliable';
  if (score >= 55) return 'standard';
  return 'developing';
}

export function calculateMatchBoost(performanceScore, tier, rfqContext) {
  let boost = 0;
  boost += Math.max(0, (performanceScore - 50) * 0.3); // Up to +15 for high performers
  if (tier === 'premium') boost += 10;
  else if (tier === 'reliable') boost += 5;

  // Category-specific boost
  if (rfqContext?.category && performanceScore?.components?.technical_compliance > 80) {
    boost += 5;
  }

  return Math.min(25, Math.round(boost));
}

export async function recordQuotationPerformance({ env, rfqId, vendorId, quotationId, metrics }) {
  const performance = {
    vendor_user_id: vendorId,
    rfq_id: rfqId,
    quotation_id: quotationId,
    submitted_on_time: metrics.submitted_on_time,
    quote_competitiveness_score: metrics.quote_competitiveness_score,
    technical_compliance_score: metrics.technical_compliance_score,
    commercial_compliance_score: metrics.commercial_compliance_score,
    responsiveness_score: metrics.responsiveness_score,
    awarded: metrics.awarded || false,
    recorded_at: new Date().toISOString(),
    recorded_by: metrics.recorded_by
  };

  return insertPerformance(env, performance);
}

export async function recordProjectPerformance({ env, rfqId, vendorId, awardId, metrics }) {
  const performance = {
    vendor_user_id: vendorId,
    rfq_id: rfqId,
    award_id: awardId,
    project_completed_on_time: metrics.project_completed_on_time,
    project_quality_rating: metrics.project_quality_rating,
    client_satisfaction_rating: metrics.client_satisfaction_rating,
    payment_disputes: metrics.payment_disputes || 0,
    service_fee_paid_on_time: metrics.service_fee_paid_on_time,
    notes: metrics.notes,
    recorded_at: new Date().toISOString(),
    recorded_by: metrics.recorded_by
  };

  return insertPerformance(env, performance);
}

export async function getVendorPerformanceSummary({ env, vendorId }) {
  const performances = await getPerformancesByVendor(env, vendorId);
  const score = calculatePerformanceScore(performances);
  const tier = calculateReliabilityTier(score.overall);

  const stats = {
    total_rfqs: performances.length,
    quotations_submitted: performances.filter(p => p.quotation_id).length,
    awards_won: performances.filter(p => p.awarded).length,
    win_rate: performances.filter(p => p.quotation_id).length > 0
      ? performances.filter(p => p.awarded).length / performances.filter(p => p.quotation_id).length
      : 0,
    avg_competitiveness: avg(performances.map(p => p.quote_competitiveness_score).filter(v => v != null)),
    avg_responsiveness: avg(performances.map(p => p.responsiveness_score).filter(v => v != null)),
    on_time_delivery_rate: performances.filter(p => p.award_id).length > 0
      ? performances.filter(p => p.award_id && p.project_completed_on_time).length / performances.filter(p => p.award_id).length
      : null,
    payment_disputes: performances.reduce((sum, p) => sum + (p.payment_disputes || 0), 0),
    fee_payment_reliability: performances.filter(p => p.service_fee_paid_on_time != null).length > 0
      ? performances.filter(p => p.service_fee_paid_on_time).length / performances.filter(p => p.service_fee_paid_on_time != null).length
      : null
  };

  return { ok: true, vendor_id: vendorId, score, tier, stats, recent_performances: performances.slice(0, 10) };
}

export async function getTopVendorsByCategory({ env, category, emirate, limit = 10, minScore = 60 }) {
  const vendors = await getVerifiedVendors(env, category, emirate);
  const results = [];

  for (const vendor of vendors) {
    const summary = await getVendorPerformanceSummary({ env, vendorId: vendor.id });
    if (summary.score.overall >= minScore) {
      results.push({ vendor, performance: summary });
    }
  }

  results.sort((a, b) => b.performance.score.overall - a.performance.score.overall);
  return { ok: true, vendors: results.slice(0, limit) };
}

export function scoreQuote({ amount, peers = [], createdAt, deadline, awarded = false }) {
  const onTime = submittedOnTime(createdAt, deadline);
  return {
    submitted_on_time: onTime,
    quote_competitiveness_score: competitiveness(amount, peers),
    responsiveness_score: onTime == null ? null : onTime ? 85 : 35,
    awarded: Boolean(awarded)
  };
}

export async function updateSupplierPerformance({ env }) {
  const [quotes, rfqs, awards, existing] = await Promise.all([
    rest(env, '/rest/v1/quotes?status=in.(Submitted,Awarded)&select=id,rfq_id,vendor_id,amount,created_at,status&order=created_at.asc&limit=200'),
    rest(env, '/rest/v1/rfqs?select=id,deadline&limit=500'),
    rest(env, '/rest/v1/awards?select=id,rfq_id,quote_id,winner_vendor_id&limit=200'),
    rest(env, '/rest/v1/supplier_performance?select=id,notes,awarded&order=recorded_at.desc&limit=500')
  ]);
  const deadlines = new Map(rfqs.map((rfq) => [String(rfq.id), rfq.deadline]));
  const awardByQuote = new Map(awards.map((award) => [String(award.quote_id), award]));
  const saved = new Map(existing.filter((row) => row.notes).map((row) => [row.notes, row]));
  const peers = new Map();
  for (const quote of quotes) {
    const list = peers.get(quote.rfq_id) || [];
    list.push(Number(quote.amount));
    peers.set(quote.rfq_id, list);
  }
  let recorded = 0;
  let updated = 0;
  for (const quote of quotes) {
    if (!quote.vendor_id) continue;
    const note = `quote:${quote.id}`;
    const award = awardByQuote.get(String(quote.id));
    const metrics = scoreQuote({
      amount: quote.amount,
      peers: peers.get(quote.rfq_id) || [],
      createdAt: quote.created_at,
      deadline: deadlines.get(String(quote.rfq_id)),
      awarded: Boolean(award && award.winner_vendor_id === quote.vendor_id)
    });
    const prior = saved.get(note);
    if (!prior) {
      await insertPerformance(env, {
        vendor_user_id: quote.vendor_id,
        rfq_id: String(quote.rfq_id),
        award_id: award?.id || null,
        submitted_on_time: metrics.submitted_on_time,
        quote_competitiveness_score: metrics.quote_competitiveness_score,
        responsiveness_score: metrics.responsiveness_score,
        awarded: metrics.awarded,
        notes: note,
        recorded_at: new Date().toISOString()
      });
      recorded += 1;
    } else if (Boolean(prior.awarded) !== metrics.awarded) {
      await patch(env, 'supplier_performance', `id=eq.${encodeURIComponent(prior.id)}`, { awarded: metrics.awarded, award_id: award?.id || null });
      updated += 1;
    }
  }
  return { ok: true, recorded, updated, quotes: quotes.length };
}

function competitiveness(amount, peers) {
  const nums = peers.map(Number).filter((value) => value > 0);
  const price = Number(amount);
  if (!nums.length || !(price > 0)) return null;
  if (nums.length === 1) return 70;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (max === min) return 80;
  return Math.round(100 - ((price - min) / (max - min)) * 60);
}

function submittedOnTime(createdAt, deadline) {
  if (!deadline || !createdAt) return null;
  const end = new Date(deadline);
  if (Number.isNaN(end.getTime())) return null;
  if (String(deadline).length <= 10) end.setUTCHours(23, 59, 59, 999);
  return new Date(createdAt) <= end;
}

function avg(arr) {
  if (!arr.length) return null;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

// Database helpers
async function insertPerformance(env, performance) {
  return insert(env, 'supplier_performance', performance);
}

async function getPerformancesByVendor(env, vendorId) {
  return rest(env, `/rest/v1/supplier_performance?vendor_user_id=eq.${encodeURIComponent(vendorId)}&order=recorded_at.desc&select=*`);
}

async function getVerifiedVendors(env, category, emirate) {
  let path = `/rest/v1/vendor_profiles?status=eq.verified&categories=cs.{${category}}&select=id,company_name,categories,emirate,capacity`;
  if (emirate) path += `&emirate=eq.${emirate}`;
  return rest(env, path);
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
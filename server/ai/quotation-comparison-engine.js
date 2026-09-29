/**
 * Technical/Commercial Quotation Comparison Engine
 * Side-by-side analysis with exception flagging
 */

import { rankQuotations, buildClientComparison } from './quotation-comparison.js';

export const COMPARISON_CRITERIA = Object.freeze({
  COMMERCIAL: {
    total_price: { weight: 0.35, type: 'lower_better' },
    vat_compliance: { weight: 0.10, type: 'boolean' },
    arithmetic_valid: { weight: 0.10, type: 'boolean' },
    payment_terms: { weight: 0.10, type: 'categorical' },
    validity_period: { weight: 0.05, type: 'higher_better' }
  },
  TECHNICAL: {
    scope_completeness: { weight: 0.25, type: 'higher_better' },
    specification_compliance: { weight: 0.20, type: 'higher_better' },
    completion_period: { weight: 0.15, type: 'lower_better' },
    warranty: { weight: 0.10, type: 'higher_better' },
    inclusions_quality: { weight: 0.15, type: 'higher_better' },
    exclusions_risk: { weight: 0.15, type: 'lower_better' }
  }
});

export function compareQuotationsTechnicalCommercial({ rfq, quotations, rfqBoqItems = [] }) {
  if (!quotations?.length) return { ok: false, error: 'No quotations to compare' };

  const normalized = quotations.map(q => normalizeForComparison(q, rfqBoqItems));
  const commercial = compareCommercial(normalized);
  const technical = compareTechnical(normalized, rfqBoqItems);
  const exceptions = detectExceptions(normalized, rfq, rfqBoqItems);
  const ranked = rankOverall(normalized, commercial, technical, exceptions);

  return {
    ok: true,
    rfq_id: rfq?.id,
    comparison: {
      commercial,
      technical,
      overall: ranked,
      exceptions,
      summary: buildComparisonSummary(ranked, exceptions)
    }
  };
}

function normalizeForComparison(quotation, rfqBoqItems) {
  const items = (quotation.items || []).map(item => ({
    ...item,
    quantity: Number(item.quantity) || null,
    unit: item.unit || null,
    unit_rate: Number(item.unit_rate) || null,
    amount: Number(item.amount) || null
  }));

  return {
    ...quotation,
    items,
    total: Number(quotation.total) || 0,
    subtotal: Number(quotation.subtotal) || null,
    vat: Number(quotation.vat) || null,
    currency: quotation.currency || 'AED',
    completion_days: parseCompletionDays(quotation.completion_period),
    warranty_months: parseWarrantyMonths(quotation.warranty),
    arithmetic_valid: quotation.arithmetic_valid ?? true,
    comparison_flags: quotation.comparison_flags || []
  };
}

function compareCommercial(quotations) {
  const totals = quotations.map(q => q.total).filter(t => t > 0);
  const minTotal = Math.min(...totals);
  const maxTotal = Math.max(...totals);
  const range = maxTotal - minTotal;

  return quotations.map(q => ({
    quotation_id: q.id || q.quotation_id,
    vendor_reference: q.vendor_reference || `Vendor ${q.vendor_label || ''}`,
    total: q.total,
    currency: q.currency,
    variance_from_lowest: q.total - minTotal,
    variance_percent: minTotal > 0 ? ((q.total - minTotal) / minTotal) * 100 : 0,
    vat_compliant: q.vat != null && q.vat >= 0,
    arithmetic_valid: q.arithmetic_valid,
    payment_terms_score: scorePaymentTerms(q.payment_terms),
    validity_score: q.validity_days ? Math.min(100, q.validity_days * 2) : 50,
    commercial_score: calculateCommercialScore(q, minTotal, range)
  }));
}

function compareTechnical(quotations, rfqBoqItems) {
  const rfqItemCount = rfqBoqItems?.length || 0;

  return quotations.map(q => {
    const coverage = calculateScopeCoverage(q.items, rfqBoqItems);
    const specCompliance = calculateSpecCompliance(q.items, rfqBoqItems);
    const completionScore = scoreCompletionPeriod(q.completion_days);
    const warrantyScore = scoreWarranty(q.warranty_months);
    const inclusionsScore = scoreInclusions(q.inclusions);
    const exclusionsRisk = scoreExclusions(q.exclusions);

    return {
      quotation_id: q.id || q.quotation_id,
      vendor_reference: q.vendor_reference || `Vendor ${q.vendor_label || ''}`,
      scope_coverage: coverage,
      specification_compliance: specCompliance,
      completion_score: completionScore,
      warranty_score: warrantyScore,
      inclusions_score: inclusionsScore,
      exclusions_risk: exclusionsRisk,
      technical_score: calculateTechnicalScore({
        coverage, specCompliance, completionScore, warrantyScore, inclusionsScore, exclusionsRisk
      }),
      item_count: q.items?.length || 0,
      rfq_item_count: rfqItemCount
    };
  });
}

function detectExceptions(quotations, rfq, rfqBoqItems) {
  const exceptions = [];

  for (const q of quotations) {
    const qExceptions = [];

    // Commercial exceptions
    if (!q.arithmetic_valid) {
      qExceptions.push({ type: 'arithmetic_error', severity: 'high', field: 'total', message: 'Quotation arithmetic does not validate' });
    }
    if (q.vat == null && q.total > 0) {
      qExceptions.push({ type: 'missing_vat', severity: 'medium', field: 'vat', message: 'VAT not specified - may be excluded from total' });
    }
    if (q.payment_terms && /advance|deposit|upfront/i.test(q.payment_terms) && !rfq?.allow_advance) {
      qExceptions.push({ type: 'advance_payment', severity: 'high', field: 'payment_terms', message: 'Advance payment requested against policy' });
    }

    // Technical exceptions
    if (rfqBoqItems?.length) {
      const coverage = calculateScopeCoverage(q.items, rfqBoqItems);
      if (coverage < 0.7) {
        qExceptions.push({ type: 'incomplete_scope', severity: 'high', field: 'scope', message: `Only ${Math.round(coverage * 100)}% of BOQ items covered` });
      }
    }

    const missingItems = q.items?.filter(i => i.quantity == null || !i.unit).length || 0;
    if (missingItems > 0) {
      qExceptions.push({ type: 'incomplete_pricing', severity: 'medium', field: 'items', message: `${missingItems} items missing quantity or unit` });
    }

    if (q.completion_days && rfq?.deadline) {
      const deadlineDays = daysUntil(rfq.deadline);
      if (q.completion_days > deadlineDays * 1.5) {
        qExceptions.push({ type: 'excessive_duration', severity: 'medium', field: 'completion_period', message: `Completion period (${q.completion_days}d) exceeds typical for deadline` });
      }
    }

    if (q.warranty_months != null && q.warranty_months < 12) {
      qExceptions.push({ type: 'short_warranty', severity: 'low', field: 'warranty', message: `Warranty only ${q.warranty_months} months (standard: 12+)` });
    }

    if (qExceptions.length) {
      exceptions.push({
        quotation_id: q.id || q.quotation_id,
        vendor_reference: q.vendor_reference || q.vendor_label,
        exceptions: qExceptions,
        exception_count: qExceptions.length,
        high_severity_count: qExceptions.filter(e => e.severity === 'high').length
      });
    }
  }

  return exceptions;
}

function rankOverall(quotations, commercial, technical, exceptions) {
  return quotations.map((q, idx) => {
    const c = commercial[idx];
    const t = technical[idx];
    const e = exceptions.find(ex => ex.quotation_id === (q.id || q.quotation_id));
    const exceptionPenalty = e ? Math.min(20, e.high_severity_count * 10 + (e.exception_count - e.high_severity_count) * 3) : 0;

    const commercialWeight = 0.55;
    const technicalWeight = 0.45;

    const overallScore = Math.round(
      (c.commercial_score * commercialWeight) +
      (t.technical_score * technicalWeight) -
      exceptionPenalty
    );

    return {
      quotation_id: q.id || q.quotation_id,
      vendor_reference: q.vendor_reference || `Vendor ${q.vendor_label || ''}`,
      rank: idx + 1, // Will be re-sorted
      total: q.total,
      commercial_score: c.commercial_score,
      technical_score: t.technical_score,
      overall_score: Math.max(0, Math.min(100, overallScore)),
      exceptions: e?.exceptions || [],
      exception_summary: e ? `${e.exception_count} exceptions (${e.high_severity_count} high)` : 'No exceptions',
      recommendation: overallScore >= 80 ? 'recommended' : overallScore >= 60 ? 'consider' : 'review_required'
    };
  }).sort((a, b) => b.overall_score - a.overall_score).map((r, i) => ({ ...r, rank: i + 1 }));
}

function buildComparisonSummary(ranked, exceptions) {
  const recommended = ranked.filter(r => r.recommendation === 'recommended');
  const consider = ranked.filter(r => r.recommendation === 'consider');
  const review = ranked.filter(r => r.recommendation === 'review_required');

  return {
    total_quotations: ranked.length,
    recommended_count: recommended.length,
    consider_count: consider.length,
    review_required_count: review.length,
    lowest_price: ranked[ranked.length - 1]?.total || null,
    highest_score: ranked[0]?.overall_score || null,
    price_spread: ranked.length > 1 ? ranked[ranked.length - 1].total - ranked[0].total : 0,
    critical_exceptions: exceptions.filter(e => e.high_severity_count > 0).length,
    key_differentiators: identifyKeyDifferentiators(ranked)
  };
}

function identifyKeyDifferentiators(ranked) {
  const diffs = [];
  if (ranked.length < 2) return diffs;

  const best = ranked[0];
  const worst = ranked[ranked.length - 1];

  if (best.commercial_score - worst.commercial_score > 20) diffs.push('Commercial terms vary significantly');
  if (best.technical_score - worst.technical_score > 20) diffs.push('Technical compliance varies significantly');
  if (best.total && worst.total && (worst.total - best.total) / best.total > 0.3) diffs.push('Price spread exceeds 30%');

  return diffs;
}

// Scoring helpers
function calculateCommercialScore(q, minTotal, range) {
  let score = 50;
  if (range > 0) score += (1 - (q.total - minTotal) / range) * 35;
  if (q.arithmetic_valid) score += 10;
  if (q.vat != null) score += 5;
  score += scorePaymentTerms(q.payment_terms) * 0.1;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function calculateTechnicalScore({ coverage, specCompliance, completionScore, warrantyScore, inclusionsScore, exclusionsRisk }) {
  return Math.round(
    coverage * 0.30 +
    specCompliance * 0.25 +
    completionScore * 0.15 +
    warrantyScore * 0.10 +
    inclusionsScore * 0.10 +
    (100 - exclusionsRisk) * 0.10
  );
}

function calculateScopeCoverage(quoteItems, rfqItems) {
  if (!rfqItems?.length) return 1.0;
  if (!quoteItems?.length) return 0;

  let matched = 0;
  for (const rfqItem of rfqItems) {
    const match = quoteItems.find(qi =>
      qi.description && rfqItem.description &&
      similarity(qi.description, rfqItem.description) > 0.6
    );
    if (match) matched++;
  }
  return matched / rfqItems.length;
}

function calculateSpecCompliance(quoteItems, rfqItems) {
  if (!rfqItems?.length) return 75;
  if (!quoteItems?.length) return 0;

  let compliant = 0;
  let total = 0;
  for (const rfqItem of rfqItems) {
    const match = quoteItems.find(qi =>
      qi.description && rfqItem.description &&
      similarity(qi.description, rfqItem.description) > 0.6
    );
    if (match) {
      total++;
      if (match.specification && rfqItem.specification &&
          similarity(match.specification, rfqItem.specification) > 0.5) {
        compliant++;
      } else if (!rfqItem.specification) {
        compliant++; // No spec required
      }
    }
  }
  return total > 0 ? (compliant / total) * 100 : 75;
}

function similarity(a, b) {
  const sa = String(a).toLowerCase().split(/\s+/);
  const sb = String(b).toLowerCase().split(/\s+/);
  const setA = new Set(sa);
  const setB = new Set(sb);
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return union > 0 ? intersection / union : 0;
}

function scorePaymentTerms(terms) {
  if (!terms) return 50;
  const t = terms.toLowerCase();
  if (/net\s*30|30\s*days/i.test(t)) return 100;
  if (/net\s*45|45\s*days/i.test(t)) return 80;
  if (/net\s*60|60\s*days/i.test(t)) return 60;
  if (/advance|deposit|upfront/i.test(t)) return 20;
  if (/l\/c|letter of credit/i.test(t)) return 70;
  return 50;
}

function scoreCompletionPeriod(days) {
  if (!days) return 50;
  if (days <= 30) return 90;
  if (days <= 60) return 80;
  if (days <= 90) return 70;
  if (days <= 120) return 60;
  return 40;
}

function scoreWarranty(months) {
  if (!months) return 50;
  if (months >= 24) return 100;
  if (months >= 12) return 80;
  if (months >= 6) return 60;
  return 40;
}

function scoreInclusions(inclusions) {
  if (!inclusions?.length) return 50;
  return Math.min(100, 50 + inclusions.length * 10);
}

function scoreExclusions(exclusions) {
  if (!exclusions?.length) return 10;
  const risky = exclusions.filter(e => /liquidated|penalt|delay|consequential|indemnif/i.test(e)).length;
  return Math.min(100, 10 + risky * 20 + (exclusions.length - risky) * 5);
}

function parseCompletionDays(period) {
  if (!period) return null;
  const match = String(period).match(/(\d+)\s*(day|week|month)/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith('day')) return value;
  if (unit.startsWith('week')) return value * 7;
  if (unit.startsWith('month')) return value * 30;
  return value;
}

function parseWarrantyMonths(warranty) {
  if (!warranty) return null;
  const match = String(warranty).match(/(\d+)\s*(month|year)/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  return unit.startsWith('year') ? value * 12 : value;
}

function daysUntil(dateStr) {
  const target = new Date(dateStr);
  const now = new Date();
  const diff = target - now;
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

export function buildClientComparisonTable(quotations, exceptions = []) {
  return buildClientComparison(quotations.map(q => ({
    ...q,
    varianceFromLowest: q.variance_from_lowest,
    variancePercent: q.variance_percent
  }))).map(c => {
    const exc = exceptions.find(e => e.quotation_id === c.quotationId);
    return { ...c, exceptions: exc?.exceptions || [], exception_count: exc?.exception_count || 0 };
  });
}
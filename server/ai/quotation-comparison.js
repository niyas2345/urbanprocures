/**
 * Client-safe quotation comparison helpers.
 * Vendor identity must be resolved by the server only when disclosure is permitted.
 */

export function rankQuotations(quotations = []) {
  return [...quotations]
    .filter((q) => Number.isFinite(Number(q?.total)))
    .sort((a, b) => Number(a.total) - Number(b.total))
    .map((q, index, all) => {
      const lowest = Number(all[0]?.total ?? 0);
      const total = Number(q.total);
      return {
        ...q,
        rank: index + 1,
        varianceFromLowest: Number((total - lowest).toFixed(2)),
        variancePercent: lowest === 0 ? 0 : Number((((total - lowest) / lowest) * 100).toFixed(2)),
      };
    });
}

export function buildClientComparison(quotations = []) {
  return rankQuotations(quotations).map((q) => ({
    quotationId: q.quotationId ?? q.id ?? null,
    vendorReference: q.vendorReference ?? `Vendor ${q.rank}`,
    currency: q.currency ?? 'AED',
    total: Number(q.total),
    rank: q.rank,
    varianceFromLowest: q.varianceFromLowest,
    variancePercent: q.variancePercent,
    completionDays: q.completionDays ?? null,
    warranty: q.warranty ?? null,
    inclusions: q.inclusions ?? [],
    exclusions: q.exclusions ?? [],
    paymentTerms: q.paymentTerms ?? null,
  }));
}

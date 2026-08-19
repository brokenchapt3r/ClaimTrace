import type { Evidence, RetrievalMetrics } from './types';

export const RETRIEVAL_LIMITS = {
  candidateCount: 30,
  finalCount: 12,
  decayDays: 730,
} as const;

const EPSILON = 1e-8;

export function tokenize(value: string) {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .replace(/[^\u4e00-\u9fa5a-z0-9]/g, ' ')
        .split(/\s+/)
        .flatMap((token) => {
          if (/^[\u4e00-\u9fa5]{2,}$/.test(token)) {
            return Array.from({ length: token.length - 1 }, (_, index) =>
              token.slice(index, index + 2),
            );
          }
          return token.length > 1 ? [token] : [];
        })
        .filter(Boolean),
    ),
  );
}

export function normalizeBm25(value: number, minimum: number, maximum: number) {
  return (value - minimum) / (maximum - minimum + EPSILON);
}

export function freshnessScore(effectiveAt: string | undefined, now = new Date()) {
  if (!effectiveAt) return 0.5;
  const timestamp = Date.parse(effectiveAt);
  if (!Number.isFinite(timestamp)) return 0.5;
  const elapsedDays = Math.max(0, (now.getTime() - timestamp) / 86_400_000);
  return Math.max(0, 1 - elapsedDays / RETRIEVAL_LIMITS.decayDays);
}

export function titleCoverage(query: string, hierarchicalTitles: string[]) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;
  return hierarchicalTitles.reduce((maximum, title) => {
    const titleTokens = new Set(tokenize(title));
    const intersection = queryTokens.filter((token) => titleTokens.has(token)).length;
    return Math.max(maximum, intersection / queryTokens.length);
  }, 0);
}

export function combinedRetrievalScore(metrics: Omit<RetrievalMetrics, 'combined'>) {
  return (
    0.65 * metrics.semantic +
    0.35 * metrics.bm25Normalized +
    0.08 * metrics.freshness +
    0.05 * metrics.titleCoverage
  );
}

export function scoreEvidence(
  evidence: Evidence[],
  query: string,
  now = new Date(),
) {
  if (evidence.length === 0) return [];
  const bm25Values = evidence.map((item) => item.metrics.bm25);
  const minimum = Math.min(...bm25Values);
  const maximum = Math.max(...bm25Values);

  return evidence
    .map((item) => {
      const metrics = {
        semantic: Math.max(0, Math.min(1, item.metrics.semantic)),
        bm25: item.metrics.bm25,
        bm25Normalized: normalizeBm25(item.metrics.bm25, minimum, maximum),
        freshness: freshnessScore(item.effectiveAt || item.createdAt, now),
        titleCoverage: titleCoverage(
          query,
          item.hierarchicalTitles.length ? item.hierarchicalTitles : [item.title],
        ),
      };
      return {
        ...item,
        metrics: { ...metrics, combined: combinedRetrievalScore(metrics) },
      };
    })
    .sort((left, right) => right.metrics.combined - left.metrics.combined)
    .slice(0, RETRIEVAL_LIMITS.finalCount)
    .map((item, index) => ({ ...item, id: `E${index + 1}` }));
}

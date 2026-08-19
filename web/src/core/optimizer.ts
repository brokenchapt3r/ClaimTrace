import { allRelations } from './graph';
import type { Claim, ClaimStatus, Evidence, OptimizationResult } from './types';

const BETA = 2;
const GAMMA = 0.3;
const DELTA = 0.15;

function objective(status: Record<string, ClaimStatus>, selectedIds: Set<string>, evidence: Evidence[]) {
  const selected = allRelations(evidence).filter((edge) => selectedIds.has(edge.id));
  const support = selected.reduce(
    (total, edge) => total + (edge.type === 'support' ? edge.supportProbability : 0),
    0,
  );
  const conflict = selected.reduce(
    (total, edge) => total + (edge.type === 'conflict' ? edge.conflictProbability : 0),
    0,
  );
  const abstained = Object.values(status).filter((value) => value === 'ABSTAINED').length;
  const partial = Object.values(status).filter((value) => value === 'PARTIALLY_SUPPORTED').length;
  return support - BETA * conflict - GAMMA * abstained - DELTA * partial;
}

function isFeasible(
  claims: Claim[],
  status: Record<string, ClaimStatus>,
  selectedIds: Set<string>,
  evidence: Evidence[],
) {
  const relations = allRelations(evidence);
  return claims.every((claim) => {
    const state = status[claim.id];
    const selected = relations.filter(
      (edge) => edge.claimId === claim.id && selectedIds.has(edge.id),
    );
    if (state === 'NO_PERMISSION' || state === 'ABSTAINED') return selected.length === 0;
    if (state === 'CONFLICTED') {
      const availableConflicts = relations.filter(
        (edge) => edge.claimId === claim.id && edge.active && edge.type === 'conflict',
      );
      return availableConflicts.length === 0
        ? selected.length === 0
        : selected.some((edge) => edge.type === 'conflict');
    }
    const covered = new Set(
      selected.filter((edge) => edge.type === 'support').flatMap((edge) => edge.coveredComponentIds),
    );
    if (state === 'SUPPORTED') {
      return claim.components.every((component) => covered.has(component.id));
    }
    return state === 'PARTIALLY_SUPPORTED' && covered.size > 0;
  });
}

function initialSelection(claims: Claim[], status: Record<string, ClaimStatus>, evidence: Evidence[]) {
  const selected = new Set<string>();
  const relations = allRelations(evidence).filter((edge) => edge.active);
  claims.forEach((claim) => {
    const state = status[claim.id];
    const linked = relations.filter((edge) => edge.claimId === claim.id);
    if (state === 'CONFLICTED') {
      const conflict = linked
        .filter((edge) => edge.type === 'conflict')
        .sort((left, right) => right.conflictProbability - left.conflictProbability)[0];
      if (conflict) selected.add(conflict.id);
      return;
    }
    if (state !== 'SUPPORTED' && state !== 'PARTIALLY_SUPPORTED') return;
    const supportEdges = linked.filter((edge) => edge.type === 'support');
    if (state === 'PARTIALLY_SUPPORTED') {
      const strongest = [...supportEdges].sort(
        (left, right) => right.supportProbability - left.supportProbability,
      )[0];
      if (strongest) selected.add(strongest.id);
      return;
    }

    // A citation is useful only when it adds semantic coverage. Greedy set cover keeps the
    // selection small while guaranteeing that a SUPPORTED claim retains every required part.
    const uncovered = new Set(claim.components.map((component) => component.id));
    const remaining = [...supportEdges];
    while (uncovered.size > 0 && remaining.length > 0) {
      remaining.sort((left, right) => {
        const leftGain = left.coveredComponentIds.filter((id) => uncovered.has(id)).length;
        const rightGain = right.coveredComponentIds.filter((id) => uncovered.has(id)).length;
        return rightGain - leftGain || right.supportProbability - left.supportProbability;
      });
      const edge = remaining.shift();
      if (!edge || !edge.coveredComponentIds.some((id) => uncovered.has(id))) break;
      selected.add(edge.id);
      edge.coveredComponentIds.forEach((id) => uncovered.delete(id));
    }
  });
  return selected;
}

function seededRandom(seedText: string) {
  let state = Array.from(seedText).reduce(
    (seed, character) => Math.imul(seed ^ (character.codePointAt(0) || 0), 16_777_619),
    2_166_136_261,
  );
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function optimizeGraph(
  claims: Claim[],
  evidence: Evidence[],
  claimStatus: Record<string, ClaimStatus>,
  budgetMs = 50,
): OptimizationResult {
  const started = performance.now();
  const fallback = claims.length > 15 || evidence.length > 12 || claims.length * evidence.length > 180;
  const initial = initialSelection(claims, claimStatus, evidence);
  if (fallback || !isFeasible(claims, claimStatus, initial, evidence)) {
    return {
      claimStatus: { ...claimStatus },
      selectedEdgeIds: [...initial],
      objective: objective(claimStatus, initial, evidence),
      elapsedMs: performance.now() - started,
      fallback: true,
    };
  }

  let best = initial;
  let bestObjective = objective(claimStatus, best, evidence);
  const candidates = allRelations(evidence).filter((edge) => edge.active);
  const random = seededRandom(candidates.map((edge) => edge.id).join('|'));
  while (performance.now() - started < budgetMs && candidates.length > 0) {
    const candidate = candidates[Math.floor(random() * candidates.length)];
    const next = new Set(best);
    if (next.has(candidate.id)) next.delete(candidate.id);
    else next.add(candidate.id);
    if (!isFeasible(claims, claimStatus, next, evidence)) continue;
    const nextObjective = objective(claimStatus, next, evidence);
    if (nextObjective > bestObjective) {
      best = next;
      bestObjective = nextObjective;
    }
  }

  return {
    claimStatus: { ...claimStatus },
    selectedEdgeIds: [...best],
    objective: bestObjective,
    elapsedMs: performance.now() - started,
    fallback: false,
  };
}

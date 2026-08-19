import { topologicalOrder } from './dependencies';
import type {
  AccessContext,
  Claim,
  ClaimDependency,
  ClaimStatus,
  Evidence,
  EvidenceRelation,
  PropagationSnapshot,
} from './types';

const statusRank: Record<ClaimStatus, number> = {
  SUPPORTED: 4,
  PARTIALLY_SUPPORTED: 3,
  CONFLICTED: 2,
  ABSTAINED: 1,
  NO_PERMISSION: 0,
};

function lowerStatus(current: ClaimStatus, next: ClaimStatus) {
  return statusRank[next] < statusRank[current] ? next : current;
}

function sameStringSet(left: string[], right: string[]) {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index]);
}

export function hasEvidenceAccess(evidence: Evidence, access: AccessContext) {
  return (
    evidence.requiredScopes.length === 0 ||
    evidence.requiredScopes.every((scope) => access.scopes.includes(scope))
  );
}

export function applyPermissionGate(evidence: Evidence[], access: AccessContext) {
  const changedEdgeIds: string[] = [];
  const next = evidence.map((item) => {
    const accessAllowed = hasEvidenceAccess(item, access);
    return {
      ...item,
      accessAllowed,
      relations: item.relations.map((relation) => {
        if (accessAllowed || !relation.active) return relation;
        changedEdgeIds.push(relation.id);
        return { ...relation, active: false, selected: false, cutReason: 'permission' as const };
      }),
    };
  });
  return { evidence: next, changedEdgeIds };
}

function lcsLength(left: string, right: string) {
  const previous = new Uint32Array(right.length + 1);
  const current = new Uint32Array(right.length + 1);
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      current[column] =
        left[row - 1] === right[column - 1]
          ? previous[column - 1] + 1
          : Math.max(previous[column], current[column - 1]);
    }
    previous.set(current);
    current.fill(0);
  }
  return previous[right.length];
}

export function adjustedVersionDifference(oldText: string, newText: string) {
  const denominator = oldText.length + newText.length;
  const difference = denominator === 0 ? 0 : 1 - (2 * lcsLength(oldText, newText)) / denominator;
  const oldNumbers = oldText.match(/\d+(?:\.\d+)?/g) || [];
  const newNumbers = newText.match(/\d+(?:\.\d+)?/g) || [];
  const numericMismatch = sameStringSet(oldNumbers, newNumbers) ? 0 : 1;
  return Math.max(difference, numericMismatch);
}

function versionTimestamp(item: Evidence) {
  const parsed = Date.parse(item.effectiveAt || item.createdAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

// Newer clauses dominate only when their substantive content changed. This prevents harmless
// formatting revisions from silently invalidating otherwise useful evidence.
export function applyVersionDominance(evidence: Evidence[]) {
  const changedEdgeIds: string[] = [];
  const grouped = new Map<string, Evidence[]>();
  evidence.forEach((item) => {
    if (!item.canonicalSourceId || (!item.version && !item.effectiveAt)) return;
    const key = `${item.canonicalSourceId || item.docId || item.source}::${item.clauseKey || '*'}`;
    grouped.set(key, [...(grouped.get(key) || []), item]);
  });
  const superseded = new Set<string>();
  grouped.forEach((versions) => {
    if (versions.length < 2) return;
    const ordered = [...versions].sort((left, right) => versionTimestamp(right) - versionTimestamp(left));
    const newest = ordered[0];
    ordered.slice(1).forEach((older) => {
      if (adjustedVersionDifference(older.text, newest.text) >= 0.15) superseded.add(older.id);
    });
  });

  return {
    evidence: evidence.map((item) => ({
      ...item,
      relations: item.relations.map((relation) => {
        if (!superseded.has(item.id) || !relation.active) return relation;
        changedEdgeIds.push(relation.id);
        return { ...relation, active: false, selected: false, cutReason: 'superseded' as const };
      }),
    })),
    changedEdgeIds,
  };
}

function linkedRelations(claimId: string, evidence: Evidence[]) {
  return evidence.flatMap((item) =>
    item.relations
      .filter((relation) => relation.claimId === claimId)
      .map((relation) => ({ evidence: item, relation })),
  );
}

function statusFromEvidence(claim: Claim, evidence: Evidence[]): ClaimStatus {
  const linked = linkedRelations(claim.id, evidence);
  if (linked.length === 0) return 'ABSTAINED';
  const active = linked.filter(({ relation }) => relation.active);
  if (
    linked.length > 0 &&
    linked.every(({ relation }) => relation.cutReason === 'permission')
  ) {
    return 'NO_PERMISSION';
  }
  if (active.some(({ relation }) => relation.type === 'conflict')) return 'CONFLICTED';

  const supportedComponents = new Set(
    active
      .filter(({ relation }) => relation.type === 'support')
      .flatMap(({ relation }) => relation.coveredComponentIds),
  );
  const requiredComponents = claim.components.map((component) => component.id);
  if (requiredComponents.length === 0) {
    return active.some(({ relation }) => relation.type === 'support') ? 'SUPPORTED' : 'ABSTAINED';
  }
  if (requiredComponents.every((component) => supportedComponents.has(component))) return 'SUPPORTED';
  if (supportedComponents.size > 0) return 'PARTIALLY_SUPPORTED';
  return 'ABSTAINED';
}

function supportStrength(claimId: string, evidence: Evidence[]) {
  return linkedRelations(claimId, evidence)
    .filter(({ relation }) => relation.active && relation.type === 'support')
    .reduce((total, { relation }) => total + relation.supportProbability, 0);
}

function evidenceStatus(item: Evidence): ClaimStatus {
  if (!item.accessAllowed) return 'NO_PERMISSION';
  const active = item.relations.filter((relation) => relation.active);
  if (active.some((relation) => relation.type === 'conflict')) return 'CONFLICTED';
  if (active.some((relation) => relation.type === 'support')) return 'SUPPORTED';
  return 'ABSTAINED';
}

function snapshot(
  id: string,
  state: string,
  note: string,
  evidence: Evidence[],
  claimStatus: Record<string, ClaimStatus>,
  changedClaimIds: string[],
  changedEdgeIds: string[],
): PropagationSnapshot {
  return {
    id,
    label: `Iteration ${id}`,
    state,
    note,
    claimStatus: { ...claimStatus },
    evidenceStatus: Object.fromEntries(evidence.map((item) => [item.id, evidenceStatus(item)])),
    activeEdgeIds: evidence.flatMap((item) => item.relations.filter((edge) => edge.active).map((edge) => edge.id)),
    changedClaimIds,
    changedEdgeIds,
  };
}

export function propagateConstraints(
  claims: Claim[],
  inputEvidence: Evidence[],
  dependencies: ClaimDependency[],
  access: AccessContext,
) {
  let claimStatus = Object.fromEntries(
    claims.map((claim) => [claim.id, 'SUPPORTED' as ClaimStatus]),
  );
  const snapshots: PropagationSnapshot[] = [
    snapshot('0', '乐观初始化', '所有声明以完全支持状态进入约束检查。', inputEvidence, claimStatus, [], []),
  ];

  const permission = applyPermissionGate(inputEvidence, access);
  const versioned = applyVersionDominance(permission.evidence);
  let evidence = versioned.evidence;
  snapshots.push(
    snapshot(
      '1',
      '权限与版本门控',
      `权限裁剪 ${permission.changedEdgeIds.length} 条边，版本替代裁剪 ${versioned.changedEdgeIds.length} 条边。`,
      evidence,
      claimStatus,
      [],
      [...permission.changedEdgeIds, ...versioned.changedEdgeIds],
    ),
  );

  const evidenceChanged: string[] = [];
  claims.forEach((claim) => {
    const next = statusFromEvidence(claim, evidence);
    const lowered = lowerStatus(claimStatus[claim.id], next);
    if (lowered !== claimStatus[claim.id]) evidenceChanged.push(claim.id);
    claimStatus[claim.id] = lowered;
    const covered = new Set(
      linkedRelations(claim.id, evidence)
        .filter(({ relation }) => relation.active && relation.type === 'support')
        .flatMap(({ relation }) => relation.coveredComponentIds),
    );
    claim.missingComponents = claim.components
      .filter((component) => !covered.has(component.id))
      .map((component) => component.text);
  });
  dependencies
    .filter((edge) => edge.type === 'exclusion')
    .forEach((edge) => {
      const left = claimStatus[edge.from];
      const right = claimStatus[edge.to];
      const accepted = (status: ClaimStatus) =>
        status === 'SUPPORTED' || status === 'PARTIALLY_SUPPORTED';
      if (!accepted(left) || !accepted(right)) return;
      const loser =
        supportStrength(edge.from, evidence) < supportStrength(edge.to, evidence)
          ? edge.from
          : edge.to;
      const lowered = lowerStatus(claimStatus[loser], 'CONFLICTED');
      if (lowered !== claimStatus[loser] && !evidenceChanged.includes(loser)) {
        evidenceChanged.push(loser);
      }
      claimStatus[loser] = lowered;
    });
  snapshots.push(
    snapshot('2', '覆盖与冲突判定', '按语义成分覆盖矩阵和 NLI 冲突边执行首次降级。', evidence, claimStatus, evidenceChanged, []),
  );

  const order = topologicalOrder(claims.map((claim) => claim.id), dependencies);
  let round = 0;
  for (;;) {
    round += 1;
    const changed: string[] = [];
    order.forEach((claimId) => {
      const incoming = dependencies.filter(
        (edge) => edge.to === claimId && (edge.type === 'premise' || edge.type === 'implication'),
      );
      const invalidPremise = incoming.some((edge) =>
        ['CONFLICTED', 'ABSTAINED', 'NO_PERMISSION'].includes(claimStatus[edge.from]),
      );
      if (!invalidPremise) return;
      const lowered = lowerStatus(claimStatus[claimId], 'ABSTAINED');
      if (lowered !== claimStatus[claimId]) changed.push(claimId);
      claimStatus[claimId] = lowered;
    });
    snapshots.push(
      snapshot(
        `${round + 2}`,
        '依赖级联传播',
        changed.length
          ? `沿无环依赖图降级 ${changed.length} 个下游声明。`
          : '本轮没有节点或边变化，状态达到固定点。',
        evidence,
        claimStatus,
        changed,
        [],
      ),
    );
    if (changed.length === 0 || round >= claims.length) break;
  }

  return { evidence, claimStatus, snapshots };
}

export function allRelations(evidence: Evidence[]): EvidenceRelation[] {
  return evidence.flatMap((item) => item.relations);
}

import { describe, expect, it } from 'vitest';
import { adjustedVersionDifference, applyVersionDominance, propagateConstraints } from './graph';
import { optimizeGraph } from './optimizer';
import { combinedRetrievalScore, freshnessScore, normalizeBm25 } from './retrieval';
import { totalJointLoss } from './training';
import type { Claim, Evidence, EvidenceRelation } from './types';

function claim(id: string, components = ['事实 A']): Claim {
  return {
    id,
    title: id,
    atom: `${id} statement`,
    subject: '',
    predicate: '',
    object: '',
    condition: '',
    time: '',
    components: components.map((text, index) => ({ id: `${id}.S${index + 1}`, text })),
    missingComponents: [],
    x: 0,
    y: 0,
  };
}

function relation(
  claimId: string,
  evidenceId: string,
  type: EvidenceRelation['type'],
  coveredComponentIds: string[] = [],
): EvidenceRelation {
  return {
    id: `L:${claimId}:${evidenceId}`,
    claimId,
    evidenceId,
    type,
    supportProbability: type === 'support' ? 0.9 : 0.05,
    conflictProbability: type === 'conflict' ? 0.9 : 0.05,
    unknownProbability: 0.05,
    threshold: 0.45,
    coveredComponentIds,
    active: true,
    selected: false,
    reason: 'test relation',
  };
}

function evidence(id: string, relations: EvidenceRelation[], requiredScopes: string[] = []): Evidence {
  return {
    id,
    title: id,
    source: id,
    text: `${id} evidence`,
    x: 0,
    y: 0,
    admissionScopes: [],
    requiredScopes,
    hierarchicalTitles: [],
    accessAllowed: true,
    metrics: {
      semantic: 0.8,
      bm25: 4,
      bm25Normalized: 0.7,
      freshness: 0.5,
      titleCoverage: 0.4,
      combined: 0,
    },
    relations,
  };
}

const publicAccess = { userId: 'u1', scopes: ['public'], sensitivity: 'normal' as const };

describe('retrieval scoring', () => {
  it('uses the configured hybrid weights and stable normalization', () => {
    expect(normalizeBm25(5, 1, 9)).toBeCloseTo(0.5);
    expect(combinedRetrievalScore({
      semantic: 0.8,
      bm25: 5,
      bm25Normalized: 0.5,
      freshness: 0.25,
      titleCoverage: 0.4,
    })).toBeCloseTo(0.735);
  });

  it('uses neutral freshness for missing dates', () => {
    expect(freshnessScore(undefined)).toBe(0.5);
  });
});

describe('constraint propagation', () => {
  it('marks a claim partially supported when a semantic component is missing', () => {
    const c1 = claim('C1', ['事实 A', '事实 B']);
    const e1 = evidence('E1', [relation('C1', 'E1', 'support', ['C1.S1'])]);
    const result = propagateConstraints([c1], [e1], [], publicAccess);
    expect(result.claimStatus.C1).toBe('PARTIALLY_SUPPORTED');
    expect(c1.missingComponents).toEqual(['事实 B']);
  });

  it('cuts inaccessible edges and preserves the access-specific state', () => {
    const c1 = claim('C1');
    const e1 = evidence('E1', [relation('C1', 'E1', 'support', ['C1.S1'])], ['internal']);
    const result = propagateConstraints([c1], [e1], [], publicAccess);
    expect(result.claimStatus.C1).toBe('NO_PERMISSION');
    expect(result.evidence[0].relations[0].cutReason).toBe('permission');
  });

  it('does not expose relation semantics when every linked edge is inaccessible', () => {
    const c1 = claim('C1');
    const e1 = evidence('E1', [relation('C1', 'E1', 'unknown')], ['internal']);
    const result = propagateConstraints([c1], [e1], [], publicAccess);
    expect(result.claimStatus.C1).toBe('NO_PERMISSION');
  });

  it('cascades an invalid premise to downstream claims', () => {
    const c1 = claim('C1');
    const c2 = claim('C2');
    const e1 = evidence('E1', [relation('C1', 'E1', 'conflict')]);
    const e2 = evidence('E2', [relation('C2', 'E2', 'support', ['C2.S1'])]);
    const result = propagateConstraints(
      [c1, c2],
      [e1, e2],
      [{ from: 'C1', to: 'C2', type: 'premise', confidence: 0.9 }],
      publicAccess,
    );
    expect(result.claimStatus.C1).toBe('CONFLICTED');
    expect(result.claimStatus.C2).toBe('ABSTAINED');
  });

  it('resolves mutually exclusive accepted claims by support strength', () => {
    const c1 = claim('C1');
    const c2 = claim('C2');
    const strong = relation('C1', 'E1', 'support', ['C1.S1']);
    strong.supportProbability = 0.95;
    const weak = relation('C2', 'E2', 'support', ['C2.S1']);
    weak.supportProbability = 0.55;
    const result = propagateConstraints(
      [c1, c2],
      [evidence('E1', [strong]), evidence('E2', [weak])],
      [{ from: 'C1', to: 'C2', type: 'exclusion', confidence: 0.9 }],
      publicAccess,
    );
    expect(result.claimStatus.C1).toBe('SUPPORTED');
    expect(result.claimStatus.C2).toBe('CONFLICTED');
  });
});

describe('version and optimization behavior', () => {
  it('treats numeric changes as substantive even when text is similar', () => {
    expect(adjustedVersionDifference('限值为 10 mg', '限值为 12 mg')).toBe(1);
  });

  it('cuts an older clause after a substantive replacement', () => {
    const oldEdge = relation('C1', 'E1', 'support', ['C1.S1']);
    const newEdge = relation('C1', 'E2', 'support', ['C1.S1']);
    const oldEvidence = {
      ...evidence('E1', [oldEdge]),
      canonicalSourceId: 'policy-a',
      clauseKey: '4.2',
      effectiveAt: '2024-01-01',
      text: '限值为 10 mg',
    };
    const newEvidence = {
      ...evidence('E2', [newEdge]),
      canonicalSourceId: 'policy-a',
      clauseKey: '4.2',
      effectiveAt: '2025-01-01',
      text: '限值为 12 mg',
    };
    const result = applyVersionDominance([oldEvidence, newEvidence]);
    expect(result.evidence[0].relations[0].cutReason).toBe('superseded');
    expect(result.evidence[1].relations[0].active).toBe(true);
  });

  it('selects a feasible supporting citation', () => {
    const c1 = claim('C1');
    const e1 = evidence('E1', [relation('C1', 'E1', 'support', ['C1.S1'])]);
    const optimized = optimizeGraph([c1], [e1], { C1: 'SUPPORTED' }, 2);
    expect(optimized.fallback).toBe(false);
    expect(optimized.selectedEdgeIds).toEqual(['L:C1:E1']);
  });

  it('retains enough citations to cover every component of a supported claim', () => {
    const c1 = claim('C1', ['事实 A', '事实 B', '事实 C']);
    const evidenceRows = ['E1', 'E2', 'E3'].map((id, index) => evidence(
      id,
      [relation('C1', id, 'support', [`C1.S${index + 1}`])],
    ));
    const optimized = optimizeGraph([c1], evidenceRows, { C1: 'SUPPORTED' }, 2);
    expect(optimized.selectedEdgeIds).toHaveLength(3);
    expect(new Set(optimized.selectedEdgeIds)).toEqual(new Set([
      'L:C1:E1',
      'L:C1:E2',
      'L:C1:E3',
    ]));
  });

  it('keeps the documented multi-task loss weights', () => {
    expect(totalJointLoss({ edge: 1, claim: 1, state: 1, rank: 1 })).toBeCloseTo(2.6);
  });
});

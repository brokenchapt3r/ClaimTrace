import type { Claim, ClaimDependency, ClaimStatus, Evidence, EvidenceRelation } from './types';

function citations(edges: EvidenceRelation[]) {
  const ids = Array.from(new Set(edges.map((edge) => edge.evidenceId)));
  return ids.map((id) => `[${id}]`).join('');
}

export function rewriteAnswer(
  claims: Claim[],
  evidence: Evidence[],
  status: Record<string, ClaimStatus>,
  selectedEdgeIds: string[],
  dependencies: ClaimDependency[] = [],
) {
  const selected = new Set(selectedEdgeIds);
  const explanations: Record<string, string> = {};
  const lines = claims.map((claim) => {
    const linked = evidence.flatMap((item) =>
      item.relations.filter((edge) => edge.claimId === claim.id && selected.has(edge.id)),
    );
    const supports = linked.filter((edge) => edge.type === 'support');
    const conflicts = linked.filter((edge) => edge.type === 'conflict');
    const state = status[claim.id];

    if (state === 'SUPPORTED') {
      explanations[claim.id] = `所有语义成分均被选中的支持边覆盖：${supports.map((edge) => edge.reason).join('；')}`;
      return `${claim.atom}${citations(supports)}`;
    }
    if (state === 'PARTIALLY_SUPPORTED') {
      const missing = claim.missingComponents.join('、') || '未覆盖事实成分';
      explanations[claim.id] = `已覆盖部分语义成分，仍缺少：${missing}。`;
      return `${claim.atom}${citations(supports)}（仅部分得到证据支持；缺少：${missing}）`;
    }
    if (state === 'CONFLICTED') {
      const supportSide = supports.length ? citations(supports) : '无已选支持证据';
      const conflictSide = conflicts.length ? citations(conflicts) : '无可公开冲突证据';
      const exclusions = dependencies
        .filter((edge) => edge.type === 'exclusion' && (edge.from === claim.id || edge.to === claim.id))
        .map((edge) => edge.from === claim.id ? edge.to : edge.from);
      explanations[claim.id] = conflicts.map((edge) => edge.reason).join('；') ||
        (exclusions.length ? `与声明 ${exclusions.join('、')} 互斥，按支持强度执行降级。` : '存在达到门限的冲突关系。');
      return `关于“${claim.atom}”，现有来源不一致：支持侧 ${supportSide}，冲突侧 ${conflictSide}，需进一步复核。`;
    }
    if (state === 'NO_PERMISSION') {
      explanations[claim.id] = '相关证据在当前访问范围外，关联边已在权限复核阶段停用。';
      return `关于“${claim.atom}”，当前访问权限不足，无法基于受限材料给出结论。`;
    }
    const invalidPremises = dependencies
      .filter((edge) => edge.to === claim.id && edge.type !== 'exclusion')
      .map((edge) => edge.from)
      .filter((id) => ['CONFLICTED', 'ABSTAINED', 'NO_PERMISSION'].includes(status[id]));
    explanations[claim.id] = invalidPremises.length
      ? `前提声明 ${invalidPremises.join('、')} 无效，依赖约束阻止该结论继续采纳。`
      : '当前可访问证据未形成足够的支持或冲突关系。';
    return `关于“${claim.atom}”，当前证据不足，暂不作确定结论。`;
  });
  return { answer: lines.join('\n\n'), explanations };
}

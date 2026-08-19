import { ModelAdapter } from '@/adapters/model';
import { propagateConstraints } from './graph';
import { optimizeGraph } from './optimizer';
import { rewriteAnswer } from './rewrite';
import type {
  AccessContext,
  ClaimStatus,
  Evidence,
  PipelineResult,
  PropagationSnapshot,
} from './types';

type ProgressEvent = {
  stage: 'draft' | 'claims' | 'relations' | 'propagation' | 'optimization' | 'complete';
  message: string;
  draft?: string;
};

export async function runVerificationPipeline(
  question: string,
  inputEvidence: Evidence[],
  access: AccessContext,
  model: ModelAdapter,
  onProgress?: (event: ProgressEvent) => void,
): Promise<PipelineResult> {
  onProgress?.({ stage: 'draft', message: '正在基于候选证据生成原始答案' });
  const draft = await model.generateDraft(question, inputEvidence);

  onProgress?.({ stage: 'claims', message: '正在抽取原子声明、语义成分和依赖关系', draft });
  const parsed = await model.parseClaims(draft);

  onProgress?.({ stage: 'relations', message: '正在批量执行声明-证据自然语言推断' });
  const relations = await model.classifyRelations(
    parsed.claims,
    inputEvidence,
    access,
    (completed, total) => onProgress?.({
      stage: 'relations',
      message: completed === 0
        ? `正在准备 ${total} 个声明-证据推断批次`
        : `正在执行声明-证据关系推断（${completed}/${total}）`,
    }),
  );
  const evidence = inputEvidence.map((item) => ({
    ...item,
    relations: relations.filter((relation) => relation.evidenceId === item.id),
  }));

  onProgress?.({ stage: 'propagation', message: '正在执行权限、版本、覆盖、冲突和依赖传播' });
  const propagated = propagateConstraints(parsed.claims, evidence, parsed.dependencies, access);

  onProgress?.({ stage: 'optimization', message: '正在求解全局一致性目标并选择引用边' });
  const optimization = optimizeGraph(
    parsed.claims,
    propagated.evidence,
    propagated.claimStatus,
  );
  const selected = new Set(optimization.selectedEdgeIds);
  const optimizedEvidence = propagated.evidence.map((item) => ({
    ...item,
    relations: item.relations.map((relation) => ({
      ...relation,
      selected: selected.has(relation.id),
      active: relation.active && selected.has(relation.id),
      cutReason:
        relation.active && !selected.has(relation.id)
          ? ('optimizer' as const)
          : relation.cutReason,
    })),
  }));
  const rewritten = rewriteAnswer(
    parsed.claims,
    optimizedEvidence,
    optimization.claimStatus,
    optimization.selectedEdgeIds,
    parsed.dependencies,
  );
  const finalEvidenceStatus = Object.fromEntries(optimizedEvidence.map((item) => {
    if (!item.accessAllowed) return [item.id, 'NO_PERMISSION' as ClaimStatus];
    if (item.relations.some((edge) => edge.selected && edge.type === 'conflict')) {
      return [item.id, 'CONFLICTED' as ClaimStatus];
    }
    if (item.relations.some((edge) => edge.selected && edge.type === 'support')) {
      return [item.id, 'SUPPORTED' as ClaimStatus];
    }
    return [item.id, 'ABSTAINED' as ClaimStatus];
  }));
  const finalSnapshot: PropagationSnapshot = {
    ...propagated.snapshots[propagated.snapshots.length - 1],
    id: `${propagated.snapshots.length}`,
    label: `Iteration ${propagated.snapshots.length}`,
    state: '全局一致性优化',
    note: `目标值 ${optimization.objective.toFixed(3)}，选中 ${optimization.selectedEdgeIds.length} 条引用边，耗时 ${optimization.elapsedMs.toFixed(1)}ms。`,
    claimStatus: optimization.claimStatus,
    evidenceStatus: finalEvidenceStatus,
    activeEdgeIds: optimization.selectedEdgeIds,
    changedEdgeIds: optimizedEvidence.flatMap((item) =>
      item.relations.filter((edge) => edge.cutReason === 'optimizer').map((edge) => edge.id),
    ),
    changedClaimIds: [],
  };

  onProgress?.({ stage: 'complete', message: '可信答案和解释链路已生成' });
  return {
    draft,
    claims: parsed.claims,
    evidence: optimizedEvidence,
    dependencies: parsed.dependencies,
    snapshots: [...propagated.snapshots, finalSnapshot],
    optimization,
    answer: rewritten.answer,
    explanations: rewritten.explanations,
  };
}

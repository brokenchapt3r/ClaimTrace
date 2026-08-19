import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ClaimStatus, Evidence, PropagationSnapshot } from '@/core/types';
import { cn } from '@/lib/utils';
import { ArrowLeft, ArrowRight, FileText } from 'lucide-react';

function statusVariant(status: ClaimStatus) {
  if (status === 'SUPPORTED') return 'success' as const;
  if (status === 'CONFLICTED') return 'destructive' as const;
  return 'secondary' as const;
}

function statusReason(item: Evidence, status: ClaimStatus, activeEdgeIds: string[]) {
  if (status === 'NO_PERMISSION') return '当前访问范围不满足证据权限标签，关联边已停用。';
  const active = item.relations.filter((edge) => activeEdgeIds.includes(edge.id));
  if (status === 'CONFLICTED') {
    return active.find((edge) => edge.type === 'conflict')?.reason || '存在达到门限的冲突边。';
  }
  if (status === 'SUPPORTED') {
    return active.find((edge) => edge.type === 'support')?.reason || '存在达到门限的支持边。';
  }
  return '没有形成可用于当前状态的有效关系边。';
}

function fileExtension(name: string) {
  return name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || 'docx';
}

type Props = {
  items: Evidence[];
  snapshot: PropagationSnapshot;
  page: number;
  thumbnails: Record<string, string>;
  onPageChange: (page: number) => void;
};

export function EvidencePanel({ items, snapshot, page, thumbnails, onPageChange }: Props) {
  const visible = items[Math.min(page, items.length - 1)];
  return (
    <Card className="evg-side">
      <CardHeader><CardTitle>证据详情侧栏</CardTitle></CardHeader>
      <CardContent>
        {!visible ? (
          <p className="evg-muted">点击图中的证据节点选择证据。</p>
        ) : (
          <div className="evg-evidence-pager">
            <div className="evg-selection-summary">
              <span>已选择 {items.length} 条：{items.map((item) => item.id).join('、')}</span>
              <span>{page + 1} / {items.length}</span>
            </div>
            <div className="evg-evidence-tabs">
              {items.map((item, index) => (
                <button className={cn(index === page && 'active')} key={item.id} onClick={() => onPageChange(index)} type="button">
                  {item.id}
                </button>
              ))}
            </div>
            <article className="evg-evidence">
              <header className="evg-evidence-title-row">
                <h3>{visible.id}. {visible.title}</h3>
                <Badge variant={statusVariant(snapshot.evidenceStatus[visible.id] || 'ABSTAINED')}>
                  {snapshot.evidenceStatus[visible.id] || 'ABSTAINED'}
                </Badge>
              </header>
              <div className="evg-document-preview">
                <div className="evg-document-preview-head">
                  <span><FileText size={15} /> 证据原文预览</span>
                  <em>{fileExtension(visible.title).toUpperCase()}</em>
                </div>
                {visible.docId && thumbnails[visible.docId] ? (
                  <img src={thumbnails[visible.docId]} alt={visible.title} />
                ) : (
                  <div className="evg-document-sheet">
                    <strong>{visible.title}</strong>
                    <span>页码：{visible.pageNumbers?.join(', ') || '未标注'}</span>
                    <p>{visible.text}</p>
                  </div>
                )}
                <div className="evg-document-meta">
                  <span>doc_id: {visible.docId || '-'}</span>
                  <span>chunk_id: {visible.chunkId || '-'}</span>
                  <span>字符位置：{visible.position?.flat().join(', ') || '-'}</span>
                </div>
              </div>
              <dl>
                <dt>来源</dt><dd>{visible.source}</dd>
                <dt>权限标签</dt><dd>{visible.permissionLabel || 'public'} / {visible.accessAllowed ? '允许' : '拒绝'}</dd>
                <dt>综合评分</dt>
                <dd>
                  score={visible.metrics.combined.toFixed(3)} / cos={visible.metrics.semantic.toFixed(3)} /
                  BM25norm={visible.metrics.bm25Normalized.toFixed(3)} / fresh={visible.metrics.freshness.toFixed(3)} /
                  title={visible.metrics.titleCoverage.toFixed(3)}
                </dd>
                <dt>状态理由</dt><dd>{statusReason(visible, snapshot.evidenceStatus[visible.id] || 'ABSTAINED', snapshot.activeEdgeIds)}</dd>
              </dl>
              <div className="evg-relations">
                {visible.relations.length === 0 ? (
                  <span>没有达到门限的关系</span>
                ) : visible.relations.map((relation) => {
                  const active = snapshot.activeEdgeIds.includes(relation.id);
                  return (
                    <span key={relation.id}>
                      {relation.claimId} / {relation.type.toUpperCase()} / Ps={relation.supportProbability.toFixed(3)} /
                      Pc={relation.conflictProbability.toFixed(3)} / Pu={relation.unknownProbability.toFixed(3)} /
                      gate={relation.threshold.toFixed(2)} / {active ? relation.selected ? 'SELECTED' : 'ACTIVE' : `CUT:${relation.cutReason || 'iteration'}`} /
                      {relation.reason}
                    </span>
                  );
                })}
              </div>
            </article>
            <div className="evg-evidence-page-actions">
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => onPageChange(page - 1)}>
                <ArrowLeft size={14} /> 上一条
              </Button>
              <Button variant="outline" size="sm" disabled={page >= items.length - 1} onClick={() => onPageChange(page + 1)}>
                下一条 <ArrowRight size={14} />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

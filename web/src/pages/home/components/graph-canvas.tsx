import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { Claim, ClaimStatus, Evidence, PropagationSnapshot } from '@/core/types';
import { cn } from '@/lib/utils';
import { Network } from 'lucide-react';
import { useMemo } from 'react';

const statusClass: Record<ClaimStatus, string> = {
  SUPPORTED: 'status-supported',
  PARTIALLY_SUPPORTED: 'status-partial',
  CONFLICTED: 'status-conflicted',
  ABSTAINED: 'status-abstained',
  NO_PERMISSION: 'status-permission',
};

function edgePath(from: Claim, to: Evidence) {
  const startX = from.x + 88;
  const endX = to.x - 88;
  const middleX = (startX + endX) / 2;
  return `M ${startX} ${from.y} C ${middleX} ${from.y}, ${middleX} ${to.y}, ${endX} ${to.y}`;
}
type Props = {
  claims: Claim[];
  evidence: Evidence[];
  snapshot: PropagationSnapshot;
  height: number;
  selectedEvidenceIds: string[];
  onToggleEvidence: (id: string) => void;
};

export function GraphCanvas({
  claims,
  evidence,
  snapshot,
  height,
  selectedEvidenceIds,
  onToggleEvidence,
}: Props) {
  const activeEdges = useMemo(() => new Set(snapshot.activeEdgeIds), [snapshot.activeEdgeIds]);
  const edges = useMemo(
    () => evidence.flatMap((item) =>
      item.relations.flatMap((relation) => {
        const claim = claims.find((candidate) => candidate.id === relation.claimId);
        return claim ? [{ relation, claim, evidence: item }] : [];
      }),
    ),
    [claims, evidence],
  );

  return (
    <Card className="evg-graph-card">
      <CardHeader className="evg-card-head">
        <CardTitle><Network size={17} /> 声明-证据二分图</CardTitle>
        <div className="evg-legend">
          {Object.keys(statusClass).map((status) => (
            <span key={status}><i className={statusClass[status as ClaimStatus]} />{status}</span>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <svg className="evg-graph" style={{ minHeight: `${height}px` }} viewBox={`0 0 900 ${height}`}>
          {claims.length === 0 && (
            <text x="450" y={height / 2} textAnchor="middle" className="evg-svg-muted">
              完整查询后生成关系图
            </text>
          )}
          {edges.map(({ relation, claim, evidence: item }) => (
            <path
              className={cn(
                'evg-edge',
                relation.type,
                activeEdges.has(relation.id) ? 'active' : 'cut',
              )}
              d={edgePath(claim, item)}
              key={relation.id}
            />
          ))}
          {claims.map((claim) => {
            const status = snapshot.claimStatus[claim.id] || 'ABSTAINED';
            return (
              <g className={cn('evg-node', statusClass[status])} key={claim.id} transform={`translate(${claim.x}, ${claim.y})`}>
                <rect x="-88" y="-34" width="176" height="68" rx="8" />
                <text y="-4" textAnchor="middle">{claim.id}</text>
                <text y="18" textAnchor="middle" className="sub">{status}</text>
              </g>
            );
          })}
          {evidence.map((item) => {
            const status = snapshot.evidenceStatus[item.id] || 'ABSTAINED';
            return (
              <g
                className={cn(
                  'evg-node',
                  'clickable',
                  selectedEvidenceIds.includes(item.id) && 'selected',
                  statusClass[status],
                )}
                key={item.id}
                transform={`translate(${item.x}, ${item.y})`}
                onClick={() => onToggleEvidence(item.id)}
              >
                <rect x="-88" y="-34" width="176" height="68" rx="8" />
                <text y="-4" textAnchor="middle">{item.id}</text>
                <text y="18" textAnchor="middle" className="sub">{status}</text>
              </g>
            );
          })}
        </svg>
      </CardContent>
    </Card>
  );
}

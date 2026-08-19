import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { PropagationSnapshot } from '@/core/types';
import { ArrowLeft, ArrowRight } from 'lucide-react';

type Props = {
  snapshots: PropagationSnapshot[];
  step: number;
  onStepChange: (step: number) => void;
};

export function PropagationPanel({ snapshots, step, onStepChange }: Props) {
  return (
    <Card className="evg-propagation">
      <CardHeader className="evg-card-head">
        <CardTitle>约束传播动态更新</CardTitle>
        <div className="evg-stepper">
          <Button variant="outline" size="sm" disabled={step === 0} onClick={() => onStepChange(step - 1)}>
            <ArrowLeft size={14} /> 上一步
          </Button>
          <Button variant="outline" size="sm" disabled={step >= snapshots.length - 1} onClick={() => onStepChange(step + 1)}>
            下一步 <ArrowRight size={14} />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <ol className="evg-timeline">
          {snapshots.map((item, index) => (
            <li className={index === step ? 'active' : ''} key={item.id}>
              <strong>{item.label} · {item.state}</strong>
              <span>{item.note}</span>
              <span>节点变化 {item.changedClaimIds.length} / 边变化 {item.changedEdgeIds.length}</span>
            </li>
          ))}
        </ol>
        <div className="evg-constraint-grid">
          <span>覆盖约束</span><strong>语义成分逐项覆盖</strong>
          <span>冲突约束</span><strong>高敏门限 0.25</strong>
          <span>版本约束</span><strong>LCS + 数值差异 ≥ 0.15</strong>
          <span>权限约束</span><strong>召回准入 + 建图复核</strong>
          <span>优化约束</span><strong>β=2.0 / γ=0.3 / δ=0.15</strong>
        </div>
      </CardContent>
    </Card>
  );
}

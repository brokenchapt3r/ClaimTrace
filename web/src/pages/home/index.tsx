import { ModelAdapter } from '@/adapters/model';
import { retrieveEvidence } from '@/adapters/retrieval';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { createAuditRecord, type AuditEnvelope } from '@/core/audit';
import { runVerificationPipeline } from '@/core/pipeline';
import type {
  AccessContext,
  Claim,
  ClaimStatus,
  Evidence,
  PipelineResult,
  PropagationSnapshot,
} from '@/core/types';
import { PageContainer } from '@/layouts/components/page-container';
import { cn } from '@/lib/utils';
import { EvidencePanel } from './components/evidence-panel';
import { GraphCanvas } from './components/graph-canvas';
import { ModelSettings } from './components/model-settings';
import { PropagationPanel } from './components/propagation-panel';
import {
  AlertTriangle,
  Database,
  Download,
  Network,
  Play,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import './index.less';

type Dataset = {
  id: string;
  name: string;
  description: string;
  documentCount: number;
  chunkCount: number;
};

type ThumbnailResponse = {
  code?: number;
  data?: Record<string, string>;
};

type DatasetResponse = {
  code?: number;
  data?: Array<{
    id: string;
    name: string;
    description: string;
    document_count: number | string;
    chunk_count: number | string;
  }>;
};

type RuntimeResponse = {
  code?: number;
  data?: { chatModel?: string; embeddingModel?: string };
};

const runtimeConfig = {
  tenantId: import.meta.env.VITE_CLAIMTRACE_TENANT_ID || 'local-tenant',
  model: import.meta.env.VITE_CLAIMTRACE_CHAT_MODEL || '/model',
  modelId: import.meta.env.VITE_CLAIMTRACE_CHAT_MODEL_ID || '/model@local@VLLM',
  apiKey: '',
  dataset: {
    id: import.meta.env.VITE_CLAIMTRACE_DATASET_ID || 'claimtrace-default',
    name: import.meta.env.VITE_CLAIMTRACE_DATASET_NAME || '默认知识库',
    description: 'ClaimTrace 独立知识库',
    documentCount: 0,
    chunkCount: 0,
  } satisfies Dataset,
};

const graphTopPadding = 74;
const graphNodeGap = 96;
const graphMinHeight = 520;

function statusVariant(status: ClaimStatus) {
  if (status === 'SUPPORTED') return 'success' as const;
  if (status === 'CONFLICTED') return 'destructive' as const;
  return 'secondary' as const;
}

function graphHeightForRows(rowCount: number) {
  return Math.max(graphMinHeight, graphTopPadding * 2 + Math.max(1, rowCount) * graphNodeGap);
}

function graphNodeY(index: number, total: number) {
  if (total <= 1) return graphHeightForRows(total) / 2;
  const height = graphHeightForRows(total);
  return graphTopPadding + ((height - graphTopPadding * 2) * index) / (total - 1);
}

function layoutClaims(claims: Claim[]) {
  return claims.map((claim, index) => ({
    ...claim,
    x: 150,
    y: graphNodeY(index, claims.length),
  }));
}

function layoutEvidence(evidence: Evidence[], rows = evidence.length) {
  return evidence.map((item, index) => ({
    ...item,
    x: 700,
    y: graphNodeY(index, Math.max(rows, evidence.length)),
  }));
}

function previewText(value: string, limit = 320) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function logPipelineEvent(label: string, payload: Record<string, unknown>) {
  fetch('/claimtrace-runtime-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, payload, at: new Date().toISOString() }),
  }).catch(() => undefined);
}

function emptySnapshot(claims: Claim[], evidence: Evidence[]): PropagationSnapshot {
  return {
    id: '0',
    label: 'Iteration 0',
    state: '等待建模',
    note: '执行查询后生成状态轨迹。',
    claimStatus: Object.fromEntries(claims.map((claim) => [claim.id, 'ABSTAINED'])),
    evidenceStatus: Object.fromEntries(evidence.map((item) => [item.id, 'ABSTAINED'])),
    activeEdgeIds: [],
    changedClaimIds: [],
    changedEdgeIds: [],
  };
}

function AnswerText({
  value,
  onCitation,
}: {
  value: string;
  onCitation: (id: string) => void;
}) {
  return (
    <p className="evg-final-answer">
      {value.split(/(\[E\d+\])/g).map((part, index) => {
        const citation = part.match(/^\[(E\d+)\]$/)?.[1];
        return citation ? (
          <button key={`${part}-${index}`} type="button" onClick={() => onCitation(citation)}>
            {part}
          </button>
        ) : (
          <span key={`${part}-${index}`}>{part}</span>
        );
      })}
    </p>
  );
}

export default function Home() {
  const [question, setQuestion] = useState('');
  const [datasets, setDatasets] = useState<Dataset[]>([runtimeConfig.dataset]);
  const [datasetId, setDatasetId] = useState<string>(runtimeConfig.dataset.id);
  const [scopeInput, setScopeInput] = useState('public');
  const [sensitivity, setSensitivity] = useState<AccessContext['sensitivity']>('normal');
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [result, setResult] = useState<PipelineResult>();
  const [candidateDraft, setCandidateDraft] = useState('');
  const [step, setStep] = useState(0);
  const [selectedEvidenceIds, setSelectedEvidenceIds] = useState<string[]>([]);
  const [evidencePage, setEvidencePage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [runtimeState, setRuntimeState] = useState('等待输入');
  const [activeStage, setActiveStage] = useState(-1);
  const [retrievalInfo, setRetrievalInfo] = useState<string[]>([]);
  const [auditEnvelope, setAuditEnvelope] = useState<AuditEnvelope>();
  const [error, setError] = useState('');
  const [documentThumbnails, setDocumentThumbnails] = useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelNames, setModelNames] = useState({ chat: runtimeConfig.model, embedding: 'bge-m3' });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeDataset = datasets.find((dataset) => dataset.id === datasetId) || runtimeConfig.dataset;

  const claims = result?.claims || [];
  const snapshots = result?.snapshots || [];
  const current = snapshots[Math.min(step, snapshots.length - 1)] || emptySnapshot(claims, evidence);
  const graphHeight = graphHeightForRows(Math.max(claims.length, evidence.length, 4));
  const selectedEvidenceItems = evidence.filter((item) => selectedEvidenceIds.includes(item.id));

  useEffect(() => {
    const docIds = Array.from(new Set(evidence.map((item) => item.docId).filter(Boolean))) as string[];
    if (docIds.length === 0) {
      setDocumentThumbnails({});
      return;
    }
    const query = docIds.map((id) => `doc_ids=${encodeURIComponent(id)}`).join('&');
    fetch(`/api/v1/thumbnails?${query}`, { credentials: 'include' })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((value: ThumbnailResponse | undefined) => setDocumentThumbnails(value?.data || {}))
      .catch(() => setDocumentThumbnails({}));
  }, [evidence]);

  useEffect(() => {
    setEvidencePage((page) => Math.min(page, Math.max(0, selectedEvidenceItems.length - 1)));
  }, [selectedEvidenceItems.length]);

  async function loadDatasets() {
    const response = await fetch('/api/v1/datasets');
    if (!response.ok) throw new Error(`知识库接口返回 HTTP ${response.status}`);
    const result = await response.json() as DatasetResponse;
    const rows = (result.data || []).map((dataset) => ({
      id: dataset.id,
      name: dataset.name,
      description: dataset.description,
      documentCount: Number(dataset.document_count) || 0,
      chunkCount: Number(dataset.chunk_count) || 0,
    }));
    if (rows.length > 0) {
      setDatasets(rows);
      setDatasetId((currentId) => rows.some((dataset) => dataset.id === currentId)
        ? currentId
        : rows[0].id);
    }
  }

  async function loadRuntime() {
    const response = await fetch('/api/v1/runtime');
    if (!response.ok) throw new Error(`运行配置接口返回 HTTP ${response.status}`);
    const payload = await response.json() as RuntimeResponse;
    setModelNames({
      chat: payload.data?.chatModel || runtimeConfig.model,
      embedding: payload.data?.embeddingModel || 'bge-m3',
    });
  }

  useEffect(() => {
    void loadDatasets().catch((cause) => {
      setError(cause instanceof Error ? cause.message : '知识库加载失败');
    });
    void loadRuntime().catch(() => undefined);
  }, []);

  async function importDocument(file: File) {
    setBusy(true);
    setError('');
    setRuntimeState(`正在解析并索引 ${file.name}`);
    try {
      const form = new FormData();
      form.append('datasetId', datasetId);
      form.append('admissionScopes', scopeInput || 'public');
      form.append('permissionScopes', scopeInput || 'public');
      form.append('file', file);
      const response = await fetch('/api/v1/documents/import', { method: 'POST', body: form });
      const payload = await response.json() as { message?: string; data?: { chunk_count?: number } };
      if (!response.ok) throw new Error(payload.message || `文档导入返回 HTTP ${response.status}`);
      await loadDatasets();
      setRuntimeState(`文档已索引：${payload.data?.chunk_count || 0} 个证据分块`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '文档导入失败';
      setError(message);
      setRuntimeState('文档导入失败');
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function accessContext(): AccessContext {
    return {
      userId: runtimeConfig.tenantId,
      scopes: scopeInput.split(',').map((item) => item.trim()).filter(Boolean),
      sensitivity,
    };
  }

  function selectCitation(id: string) {
    setSelectedEvidenceIds((currentIds) => (currentIds.includes(id) ? currentIds : [...currentIds, id]));
    const selected = evidence.filter((item) =>
      (selectedEvidenceIds.includes(item.id) || item.id === id),
    );
    setEvidencePage(Math.max(0, selected.findIndex((item) => item.id === id)));
  }

  function toggleEvidence(id: string) {
    setSelectedEvidenceIds((ids) => {
      if (!ids.includes(id)) return [...ids, id];
      const next = ids.filter((candidate) => candidate !== id);
      setEvidencePage(0);
      return next;
    });
  }

  async function executeRetrieval() {
    if (!question.trim()) throw new Error('请输入自然语言问题');
    if (!datasetId) throw new Error('请选择知识库');
    setRuntimeState('正在执行混合召回与准入过滤');
    setActiveStage(0);
    const retrieval = await retrieveEvidence(question.trim(), [datasetId], accessContext());
    const positioned = layoutEvidence(retrieval.evidence);
    setEvidence(positioned);
    setSelectedEvidenceIds(positioned.map((item) => item.id));
    setEvidencePage(0);
    setRetrievalInfo([
      `候选窗口：${retrieval.candidateCount} / 最终证据：${positioned.length}`,
      `准入过滤：${retrieval.filteredCount} 条`,
      `查询 token：${retrieval.queryTokens.slice(0, 18).join(' ')}`,
      '评分：0.65×cos + 0.35×BM25norm + 0.08×fresh + 0.05×title',
    ]);
    logPipelineEvent('retrieval.completed', {
      question,
      candidateCount: retrieval.candidateCount,
      selected: positioned.map((item) => ({
        id: item.id,
        docId: item.docId,
        chunkId: item.chunkId,
        score: item.metrics.combined,
        preview: previewText(item.text),
      })),
    });
    return positioned;
  }

  async function retrieveOnly() {
    setBusy(true);
    setError('');
    setResult(undefined);
    setCandidateDraft('');
    setAuditEnvelope(undefined);
    try {
      await executeRetrieval();
      setRuntimeState('候选证据已就绪');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '检索失败';
      setError(message);
      setRuntimeState('运行失败');
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    setBusy(true);
    setError('');
    setResult(undefined);
    setCandidateDraft('');
    setAuditEnvelope(undefined);
    setStep(0);
    try {
      const retrieved = await executeRetrieval();
      if (retrieved.length === 0) throw new Error('没有通过准入过滤的候选证据');
      const model = new ModelAdapter({
        endpoint: '/api/model/chat/completions',
        model: runtimeConfig.model,
        apiKey: runtimeConfig.apiKey,
      });
      const pipeline = await runVerificationPipeline(
        question.trim(),
        retrieved,
        accessContext(),
        model,
        (event) => {
          setRuntimeState(event.message);
          if (event.draft) setCandidateDraft(event.draft);
          const stages = {
            draft: 1,
            claims: 2,
            relations: 3,
            propagation: 3,
            optimization: 4,
            complete: 4,
          } as const;
          setActiveStage(stages[event.stage]);
        },
      );
      const positionedClaims = layoutClaims(pipeline.claims);
      const positionedEvidence = layoutEvidence(pipeline.evidence, positionedClaims.length);
      const completed = { ...pipeline, claims: positionedClaims, evidence: positionedEvidence };
      setResult(completed);
      setEvidence(positionedEvidence);
      setSelectedEvidenceIds(positionedEvidence.map((item) => item.id));
      setStep(0);
      setActiveStage(3);
      setRuntimeState('正在回放单调约束传播轨迹');
      for (let index = 1; index < completed.snapshots.length; index += 1) {
        await delay(450);
        setStep(index);
      }
      setActiveStage(4);
      logPipelineEvent('pipeline.completed', {
        draft: previewText(completed.draft, 700),
        finalAnswer: previewText(completed.answer, 900),
        claims: completed.claims.map((claim) => ({
          id: claim.id,
          status: completed.optimization.claimStatus[claim.id],
          text: claim.atom,
        })),
        objective: completed.optimization.objective,
      });
      const audit = await createAuditRecord(question.trim(), accessContext(), completed);
      setAuditEnvelope(audit.envelope);
      setRuntimeState('可信答案、解释链路和审计记录已生成');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '运行失败';
      setError(message);
      setRuntimeState('运行失败');
      logPipelineEvent('pipeline.failed', { message });
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setQuestion('');
    setEvidence([]);
    setResult(undefined);
    setCandidateDraft('');
    setStep(0);
    setSelectedEvidenceIds([]);
    setEvidencePage(0);
    setRuntimeState('等待输入');
    setActiveStage(-1);
    setRetrievalInfo([]);
    setAuditEnvelope(undefined);
    setError('');
  }

  return (
    <PageContainer className="evg-page">
      <section className="evg-shell">
        <aside className="evg-sidebar">
          <div className="evg-brand">
            <div className="evg-mark">CT</div>
            <div><strong>ClaimTrace</strong><span>可信知识问答</span></div>
          </div>
          <div className="evg-side-section">
            <span className="evg-side-title">运行流程</span>
            {['用户输入', '候选答案', '声明建模', '图约束传播', '一致性输出'].map((item, index) => (
              <button className={cn('evg-side-step', index <= activeStage && 'active')} key={item} type="button">
                {index + 1}. {item}
              </button>
            ))}
          </div>
          <button className="evg-side-tool" type="button" onClick={() => setSettingsOpen(true)}>
            <Settings2 size={16} />
            <span><strong>模型连接</strong><small>{modelNames.chat} / {modelNames.embedding}</small></span>
          </button>
          <div className="evg-run">
            <span>当前运行</span><strong>{runtimeState}</strong>
            <small>{modelNames.chat}</small><small>{activeDataset.name}</small>
          </div>
        </aside>

        <main className="evg-main">
          <Card className="evg-query">
            <CardHeader><CardTitle>声明-证据可信问答工作台</CardTitle></CardHeader>
            <CardContent>
              <div className="evg-runtime-toolbar">
                <label><span><Settings2 size={14} /> 大模型</span><select value={modelNames.chat} disabled><option>{modelNames.chat}</option></select></label>
                <label><span><Database size={14} /> 知识库</span><select value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>{datasets.map((dataset) => <option value={dataset.id} key={dataset.id}>{dataset.name}</option>)}</select></label>
                <input className="evg-file-input" ref={fileInputRef} type="file" accept=".txt,.md,.markdown,.csv,.json,.html,.htm,.docx,.pdf" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importDocument(file); }} />
                <Button variant="outline" size="sm" disabled={busy} onClick={() => fileInputRef.current?.click()}><Upload size={14} /> 导入文档</Button>
                <label><span><ShieldCheck size={14} /> 访问范围</span><input value={scopeInput} onChange={(event) => setScopeInput(event.target.value)} /></label>
                <label><span>场景门限</span><select value={sensitivity} onChange={(event) => setSensitivity(event.target.value as AccessContext['sensitivity'])}><option value="normal">普通 0.45</option><option value="high">高敏支持 0.72 / 冲突 0.25</option></select></label>
              </div>
              <div className="evg-model-line">
                <span>{activeDataset.documentCount} 个文档 / {activeDataset.chunkCount} 个分块</span>
                <span>{runtimeState}</span>
                <span>{claims.length} 个声明 / {evidence.length} 条证据</span>
              </div>
              {retrievalInfo.length > 0 && <div className="evg-retrieval-info">{retrievalInfo.map((item) => <span key={item}>{item}</span>)}</div>}
              <div className="evg-query-row">
                <Textarea value={question} resize="vertical" disabled={busy} placeholder="输入需要核验的自然语言问题" onChange={(event) => setQuestion(event.target.value)} />
                <div className="evg-query-actions">
                  <Button variant="accent" size="lg" disabled={busy} onClick={() => void run()}><Play size={16} /> 查询并核验</Button>
                  <Button variant="outline" size="lg" disabled={busy} onClick={() => void retrieveOnly()}><Network size={16} /> 仅检索证据</Button>
                </div>
              </div>
              {error && <div className="evg-warning"><AlertTriangle size={16} />{error}</div>}
            </CardContent>
          </Card>

          <section className="evg-draft-grid">
            <Card className="evg-draft-card">
              <CardHeader><CardTitle>大模型候选答案</CardTitle></CardHeader>
              <CardContent><p className="evg-muted evg-draft-text">{result?.draft || candidateDraft || (busy ? runtimeState : '')}</p></CardContent>
            </Card>
            <Card className="evg-draft-card">
              <CardHeader><CardTitle>运行摘要</CardTitle></CardHeader>
              <CardContent><div className="evg-kv-grid">
                <span>传播轮次</span><strong>{snapshots.length}</strong>
                <span>优化目标</span><strong>{result?.optimization.objective.toFixed(3) || '-'}</strong>
                <span>审计摘要</span><strong>{auditEnvelope?.digest.slice(0, 16) || '-'}</strong>
              </div></CardContent>
            </Card>
          </section>

          <section className="evg-grid">
            <Card className="evg-claims">
              <CardHeader className="evg-card-head"><CardTitle>原子声明与语义成分</CardTitle><Button variant="outline" size="sm" disabled={busy} onClick={reset}><RotateCcw size={14} /> 重置</Button></CardHeader>
              <CardContent className="evg-list">
                {claims.map((claim) => {
                  const status = current.claimStatus[claim.id] || 'ABSTAINED';
                  return <article className="evg-claim" key={claim.id}>
                    <header><strong>{claim.id}. {claim.title}</strong><Badge variant={statusVariant(status)}>{status}</Badge></header>
                    <p>{claim.atom}</p>
                    <dl className="evg-claim-meta">
                      <dt>主体</dt><dd>{claim.subject || '-'}</dd><dt>谓词</dt><dd>{claim.predicate || '-'}</dd>
                      <dt>客体</dt><dd>{claim.object || '-'}</dd><dt>条件</dt><dd>{claim.condition || '-'}</dd><dt>时间</dt><dd>{claim.time || '-'}</dd>
                    </dl>
                    <div className="evg-relations">{claim.components.map((component) => <span key={component.id}>{component.id} / {component.text}</span>)}</div>
                    {claim.missingComponents.length > 0 && <p className="evg-missing">未覆盖：{claim.missingComponents.join('、')}</p>}
                  </article>;
                })}
              </CardContent>
            </Card>

            <GraphCanvas
              claims={claims}
              evidence={evidence}
              snapshot={current}
              height={graphHeight}
              selectedEvidenceIds={selectedEvidenceIds}
              onToggleEvidence={toggleEvidence}
            />

            <EvidencePanel
              items={selectedEvidenceItems}
              snapshot={current}
              page={evidencePage}
              thumbnails={documentThumbnails}
              onPageChange={setEvidencePage}
            />

            <PropagationPanel snapshots={snapshots} step={step} onStepChange={setStep} />
          </section>

          <Card className="evg-result">
            <CardHeader><CardTitle>结构化问答结果与可解释路径</CardTitle></CardHeader>
            <CardContent>
              {!result || step < result.snapshots.length - 1 ? <p className="evg-muted">完成检索、建模、传播和优化后显示可信答案。</p> : <>
                <div className="evg-answer"><h3>可信优化答案</h3><AnswerText value={result.answer} onCitation={selectCitation} /></div>
                <div className="evg-result-grid">{result.claims.map((claim) => {
                  const status = result.optimization.claimStatus[claim.id];
                  const linked = result.evidence.flatMap((item) => item.relations.filter((edge) => edge.claimId === claim.id && edge.selected));
                  return <article className="evg-result-card" key={claim.id}><h3>{claim.title}</h3><Badge variant={statusVariant(status)}>{status}</Badge><p>{claim.atom}</p><p>引用链路：{linked.map((edge) => `${claim.id} ← ${edge.evidenceId}(${edge.type})`).join('，') || '无可用引用边'}</p><p>状态理由：{result.explanations[claim.id]}</p><p>推理路径：原子声明 → NLI 关系 → 覆盖/冲突判定 → 依赖级联 → 全局一致性选择。</p></article>;
                })}</div>
                {auditEnvelope && <div className="evg-audit"><strong>可验证审计记录</strong><span>{auditEnvelope.algorithm}</span><code>{auditEnvelope.digest}</code><span>{auditEnvelope.signedAt}</span><a href={auditEnvelope.downloadUrl}><Download size={14} /> 下载完整记录</a></div>}
              </>}
            </CardContent>
          </Card>
        </main>
      </section>
      <ModelSettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => void loadRuntime()}
      />
    </PageContainer>
  );
}

import { Button } from '@/components/ui/button';
import { CheckCircle2, PlugZap, Save, X } from 'lucide-react';
import { useEffect, useState } from 'react';

type ModelKind = 'CHAT' | 'EMBEDDING';

type Connection = {
  kind: ModelKind;
  instanceName: string;
  provider: string;
  baseUrl: string;
  modelName: string;
  apiKey: string;
  enabled: boolean;
  verifiedAt?: string | null;
};

type ApiResponse<T> = { code?: number; data?: T; message?: string };

const labels: Record<ModelKind, { title: string; description: string }> = {
  CHAT: {
    title: '对话模型',
    description: '用于候选答案、声明解析、关系判定和答案重写',
  },
  EMBEDDING: {
    title: '嵌入模型',
    description: '用于文档分块与问题的向量化检索',
  },
};

const emptyConnection = (kind: ModelKind): Connection => ({
  kind,
  instanceName: kind === 'CHAT' ? 'Primary Chat API' : 'Primary Embedding API',
  provider: 'OPENAI_COMPATIBLE',
  baseUrl: '',
  modelName: kind === 'CHAT' ? 'qwen3:8b' : 'bge-m3',
  apiKey: '',
  enabled: true,
});

export function ModelSettings({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [connections, setConnections] = useState<Record<ModelKind, Connection>>({
    CHAT: emptyConnection('CHAT'),
    EMBEDDING: emptyConnection('EMBEDDING'),
  });
  const [working, setWorking] = useState<ModelKind>();
  const [message, setMessage] = useState<Record<ModelKind, { ok: boolean; text: string } | undefined>>({
    CHAT: undefined,
    EMBEDDING: undefined,
  });

  useEffect(() => {
    if (!open) return;
    fetch('/api/v1/model-connections')
      .then(async (response) => {
        const payload = await response.json() as ApiResponse<Connection[]>;
        if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
        const rows = payload.data || [];
        setConnections({
          CHAT: rows.find((item) => item.kind === 'CHAT') || emptyConnection('CHAT'),
          EMBEDDING: rows.find((item) => item.kind === 'EMBEDDING') || emptyConnection('EMBEDDING'),
        });
      })
      .catch((error) => setMessage((current) => ({
        ...current,
        CHAT: { ok: false, text: error instanceof Error ? error.message : '配置读取失败' },
      })));
  }, [open]);

  if (!open) return null;

  function update(kind: ModelKind, field: keyof Connection, value: string) {
    setConnections((current) => ({
      ...current,
      [kind]: { ...current[kind], [field]: value },
    }));
    setMessage((current) => ({ ...current, [kind]: undefined }));
  }

  async function submit(kind: ModelKind, save: boolean) {
    setWorking(kind);
    setMessage((current) => ({ ...current, [kind]: undefined }));
    const connection = connections[kind];
    const endpoint = save
      ? `/api/v1/model-connections/${kind.toLowerCase()}`
      : '/api/v1/model-connections/verify';
    try {
      const response = await fetch(endpoint, {
        method: save ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          instanceName: connection.instanceName,
          baseUrl: connection.baseUrl,
          modelName: connection.modelName,
          apiKey: connection.apiKey === 'configured' ? '' : connection.apiKey,
        }),
      });
      const payload = await response.json() as ApiResponse<{ models?: string[] }>;
      if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
      setMessage((current) => ({
        ...current,
        [kind]: {
          ok: true,
          text: save ? '连接已验证并保存' : `验证成功，可用模型 ${payload.data?.models?.length || 1} 个`,
        },
      }));
      if (save) {
        setConnections((current) => ({
          ...current,
          [kind]: { ...current[kind], apiKey: 'configured', verifiedAt: new Date().toISOString() },
        }));
        onSaved();
      }
    } catch (error) {
      setMessage((current) => ({
        ...current,
        [kind]: { ok: false, text: error instanceof Error ? error.message : '连接验证失败' },
      }));
    } finally {
      setWorking(undefined);
    }
  }

  return (
    <div className="evg-modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="evg-model-settings" role="dialog" aria-modal="true" aria-labelledby="model-settings-title">
        <header>
          <div>
            <h2 id="model-settings-title">模型连接</h2>
            <p>OpenAI 兼容 API</p>
          </div>
          <Button variant="ghost" size="icon" title="关闭" onClick={onClose}><X size={18} /></Button>
        </header>
        <div className="evg-model-settings-body">
          {(['CHAT', 'EMBEDDING'] as ModelKind[]).map((kind) => {
            const connection = connections[kind];
            const status = message[kind];
            return (
              <article className="evg-connection" key={kind}>
                <div className="evg-connection-heading">
                  <div><h3>{labels[kind].title}</h3><p>{labels[kind].description}</p></div>
                  <span>{connection.provider}</span>
                </div>
                <div className="evg-connection-fields">
                  <label><span>实例名称</span><input value={connection.instanceName} onChange={(event) => update(kind, 'instanceName', event.target.value)} /></label>
                  <label><span>模型名称</span><input value={connection.modelName} onChange={(event) => update(kind, 'modelName', event.target.value)} /></label>
                  <label className="wide"><span>Base URL</span><input placeholder="http://model-host:8001/v1" value={connection.baseUrl} onChange={(event) => update(kind, 'baseUrl', event.target.value)} /></label>
                  <label className="wide"><span>API Key</span><input type="password" autoComplete="new-password" placeholder={connection.apiKey === 'configured' ? '已安全保存，留空保持不变' : '输入 API Key'} value={connection.apiKey === 'configured' ? '' : connection.apiKey} onChange={(event) => update(kind, 'apiKey', event.target.value)} /></label>
                </div>
                <div className="evg-connection-footer">
                  <div className={status ? (status.ok ? 'success' : 'error') : ''}>
                    {status?.ok && <CheckCircle2 size={15} />}{status?.text || (connection.verifiedAt ? `上次验证 ${new Date(connection.verifiedAt).toLocaleString()}` : '尚未验证')}
                  </div>
                  <Button variant="outline" size="sm" disabled={Boolean(working)} onClick={() => void submit(kind, false)}><PlugZap size={14} /> 验证</Button>
                  <Button variant="accent" size="sm" disabled={Boolean(working)} onClick={() => void submit(kind, true)}><Save size={14} /> 保存</Button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

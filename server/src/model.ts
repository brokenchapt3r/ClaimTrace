import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import type { AppConfig } from './config.js';
import { CredentialCipher } from './credentials.js';
import type { Database } from './db.js';

export type ModelKind = 'CHAT' | 'EMBEDDING';

export type ModelConnectionInput = {
  kind: ModelKind;
  instanceName: string;
  baseUrl: string;
  modelName: string;
  apiKey?: string;
};

type ModelConnectionRow = RowDataPacket & {
  id: string;
  user_id: string;
  kind: ModelKind;
  instance_name: string;
  provider: string;
  base_url: string;
  model_name: string;
  api_key_ciphertext: string;
  enabled: number | boolean;
  verified_at: string | null;
  updated_at: string;
};

type OpenAiEmbeddingResponse = {
  data?: Array<{ embedding?: number[]; index?: number }>;
};

type OpenAiModelsResponse = {
  data?: Array<{ id?: string }>;
};

type ResolvedConnection = ModelConnectionInput & { apiKey: string };

function normalizeBaseUrl(value: string) {
  const normalized = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(normalized)) throw new Error('Base URL must start with http:// or https://');
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}

function matchesModel(available: string, configured: string) {
  return available === configured ||
    available === `${configured}:latest` ||
    configured === `${available}:latest`;
}

function maskedApiKey(ciphertext: string) {
  return ciphertext ? 'configured' : '';
}

function connectionError(error: unknown, role: string, baseUrl: string) {
  if (error instanceof Error && error.name === 'AbortError') {
    return new Error(`${role}连接超时：${baseUrl}`);
  }
  const cause = error instanceof Error ? error.cause as NodeJS.ErrnoException | undefined : undefined;
  const detail = cause?.code ? `（${cause.code}）` : '';
  return new Error(`${role}不可用：无法连接 ${baseUrl}${detail}`);
}

function normalizeEmbeddingInput(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\uFFFD/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function meanNormalized(vectors: number[][]) {
  if (vectors.length === 0 || vectors[0].length === 0) throw new Error('Cannot pool empty embeddings');
  const dimensions = vectors[0].length;
  if (vectors.some((vector) => vector.length !== dimensions)) {
    throw new Error('Cannot pool embeddings with different dimensions');
  }
  const mean = Array.from({ length: dimensions }, (_, index) =>
    vectors.reduce((sum, vector) => sum + vector[index], 0) / vectors.length,
  );
  const norm = Math.sqrt(mean.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new Error('Pooled embedding has an invalid norm');
  return mean.map((value) => value / norm);
}

export class ModelService {
  constructor(
    private readonly config: AppConfig,
    private readonly database: Database,
    private readonly cipher: CredentialCipher,
  ) {}

  async initialize() {
    const defaults: ModelConnectionInput[] = [
      {
        kind: 'CHAT',
        instanceName: 'Primary Chat API',
        baseUrl: this.config.chat.baseUrl,
        modelName: this.config.chat.model,
        apiKey: this.config.chat.apiKey,
      },
      {
        kind: 'EMBEDDING',
        instanceName: 'Primary Embedding API',
        baseUrl: this.config.embedding.baseUrl,
        modelName: this.config.embedding.model,
        apiKey: this.config.embedding.apiKey,
      },
    ];
    for (const connection of defaults) {
      await this.database.execute(
        `INSERT IGNORE INTO model_connections (
          id, user_id, kind, instance_name, base_url, model_name, api_key_ciphertext
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID().replaceAll('-', ''),
          this.config.defaultUserId,
          connection.kind,
          connection.instanceName,
          normalizeBaseUrl(connection.baseUrl),
          connection.modelName,
          this.cipher.encrypt(connection.apiKey || ''),
        ],
      );
    }
  }

  private async row(kind: ModelKind, userId: string) {
    const rows = await this.database.query<ModelConnectionRow[]>(
      `SELECT id, user_id, kind, instance_name, provider, base_url, model_name,
        api_key_ciphertext, enabled, verified_at, updated_at
       FROM model_connections WHERE user_id=? AND kind=? AND enabled=TRUE LIMIT 1`,
      [userId, kind],
    );
    if (!rows[0]) throw new Error(`No enabled ${kind.toLowerCase()} model connection`);
    return rows[0];
  }

  private async resolve(kind: ModelKind, userId: string): Promise<ResolvedConnection> {
    const row = await this.row(kind, userId);
    return {
      kind,
      instanceName: row.instance_name,
      baseUrl: row.base_url,
      modelName: row.model_name,
      apiKey: this.cipher.decrypt(row.api_key_ciphertext),
    };
  }

  async list(userId: string) {
    const rows = await this.database.query<ModelConnectionRow[]>(
      `SELECT id, user_id, kind, instance_name, provider, base_url, model_name,
        api_key_ciphertext, enabled, verified_at, updated_at
       FROM model_connections WHERE user_id=? ORDER BY kind`,
      [userId],
    );
    return rows.map((row) => ({
      kind: row.kind,
      instanceName: row.instance_name,
      provider: row.provider,
      baseUrl: row.base_url,
      modelName: row.model_name,
      apiKey: maskedApiKey(row.api_key_ciphertext),
      enabled: Boolean(row.enabled),
      verifiedAt: row.verified_at,
      updatedAt: row.updated_at,
    }));
  }

  private async availableModels(connection: ResolvedConnection, signal: AbortSignal) {
    let response: Response;
    try {
      response = await fetch(`${connection.baseUrl}/models`, {
        signal,
        headers: { Authorization: `Bearer ${connection.apiKey}` },
      });
    } catch (error) {
      throw connectionError(error, `${connection.kind === 'CHAT' ? '对话' : '嵌入'}模型 API`, connection.baseUrl);
    }
    if (!response.ok) throw new Error(`Model catalog returned HTTP ${response.status}`);
    const payload = await response.json() as OpenAiModelsResponse;
    return (payload.data || []).map((item) => item.id).filter(Boolean) as string[];
  }

  private async connectionFromInput(input: ModelConnectionInput, userId: string) {
    const apiKey = input.apiKey?.trim() || this.cipher.decrypt((await this.row(input.kind, userId)).api_key_ciphertext);
    return {
      ...input,
      instanceName: input.instanceName.trim(),
      baseUrl: normalizeBaseUrl(input.baseUrl),
      modelName: input.modelName.trim(),
      apiKey,
    };
  }

  async verify(input: ModelConnectionInput, userId: string) {
    const connection = await this.connectionFromInput(input, userId);
    if (!connection.instanceName || !connection.modelName) throw new Error('Instance name and model name are required');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const models = await this.availableModels(connection, controller.signal);
      if (!models.some((model) => matchesModel(model, connection.modelName))) {
        throw new Error(`Model ${connection.modelName} was not returned by the provider`);
      }
      if (connection.kind === 'CHAT') {
        const response = await fetch(`${connection.baseUrl}/chat/completions`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${connection.apiKey}`,
          },
          body: JSON.stringify({
            model: connection.modelName,
            messages: [{ role: 'user', content: 'Reply with OK.' }],
            max_tokens: 8,
            temperature: 0,
            stream: false,
          }),
        });
        if (!response.ok) throw new Error(`Chat verification returned HTTP ${response.status}`);
      } else {
        const response = await fetch(`${connection.baseUrl}/embeddings`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${connection.apiKey}`,
          },
          body: JSON.stringify({ model: connection.modelName, input: ['connection test'], encoding_format: 'float' }),
        });
        if (!response.ok) throw new Error(`Embedding verification returned HTTP ${response.status}`);
        const payload = await response.json() as OpenAiEmbeddingResponse;
        const dimensions = payload.data?.[0]?.embedding?.length || 0;
        if (dimensions !== this.config.elasticsearch.dimensions) {
          throw new Error(`Embedding dimension mismatch: expected ${this.config.elasticsearch.dimensions}, received ${dimensions}`);
        }
      }
      return { models, modelName: connection.modelName };
    } finally {
      clearTimeout(timeout);
    }
  }

  async save(input: ModelConnectionInput, userId: string) {
    const connection = await this.connectionFromInput(input, userId);
    const verification = await this.verify({ ...connection, apiKey: connection.apiKey }, userId);
    await this.database.execute(
      `INSERT INTO model_connections (
        id, user_id, kind, instance_name, base_url, model_name, api_key_ciphertext, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE instance_name=VALUES(instance_name), base_url=VALUES(base_url),
        model_name=VALUES(model_name), api_key_ciphertext=VALUES(api_key_ciphertext),
        enabled=TRUE, verified_at=VALUES(verified_at)`,
      [
        randomUUID().replaceAll('-', ''),
        userId,
        connection.kind,
        connection.instanceName,
        connection.baseUrl,
        connection.modelName,
        this.cipher.encrypt(connection.apiKey),
      ],
    );
    return verification;
  }

  async health(userId = this.config.defaultUserId) {
    const connections = await Promise.all([
      this.resolve('CHAT', userId),
      this.resolve('EMBEDDING', userId),
    ]);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      await Promise.all(connections.map(async (connection) => {
        const available = await this.availableModels(connection, controller.signal);
        if (!available.some((model) => matchesModel(model, connection.modelName))) {
          throw new Error(`Configured model is unavailable: ${connection.modelName}`);
        }
      }));
      return { configured: connections.map((connection) => connection.modelName) };
    } finally {
      clearTimeout(timeout);
    }
  }

  async embed(inputs: string[], userId = this.config.defaultUserId) {
    const connection = await this.resolve('EMBEDDING', userId);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.embedding.timeoutMs);
    try {
      const requestBatch = async (batch: string[], recoveryDepth = 0): Promise<number[][]> => {
        let response: Response;
        try {
          response = await fetch(`${connection.baseUrl}/embeddings`, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${connection.apiKey}`,
            },
            body: JSON.stringify({ model: connection.modelName, input: batch, encoding_format: 'float' }),
          });
        } catch (error) {
          throw connectionError(error, '嵌入模型 API', connection.baseUrl);
        }
        const responseText = await response.text();
        if (!response.ok) {
          // Local inference servers commonly reject a large batch when memory is tight. Splitting
          // sequentially preserves ordering and lets small deployments complete without data loss.
          if (response.status >= 500 && batch.length > 1) {
            const middle = Math.ceil(batch.length / 2);
            return [
              ...await requestBatch(batch.slice(0, middle), recoveryDepth),
              ...await requestBatch(batch.slice(middle), recoveryDepth),
            ];
          }
          const nanFailure = response.status >= 500 && /unsupported value:\s*NaN/i.test(responseText);
          if (nanFailure && batch.length === 1 && batch[0].length >= 48 && recoveryDepth < 5) {
            const source = batch[0];
            const middle = Math.floor(source.length / 2);
            const left = (await requestBatch([source.slice(0, middle)], recoveryDepth + 1))[0];
            const right = (await requestBatch([source.slice(middle)], recoveryDepth + 1))[0];
            return [meanNormalized([left, right])];
          }
          throw new Error(`嵌入模型返回 HTTP ${response.status}：${responseText.slice(0, 500) || '无错误详情'}`);
        }
        let result: OpenAiEmbeddingResponse;
        try {
          result = JSON.parse(responseText) as OpenAiEmbeddingResponse;
        } catch {
          throw new Error('嵌入模型返回了无法解析的 JSON');
        }
        const batchEmbeddings = [...(result.data || [])]
          .sort((left, right) => (left.index || 0) - (right.index || 0))
          .map((item) => item.embedding || []);
        if (batchEmbeddings.length !== batch.length) {
          throw new Error(`Embedding count mismatch: expected ${batch.length}, received ${batchEmbeddings.length}`);
        }
        if (batchEmbeddings.some((embedding) => embedding.some((value) => !Number.isFinite(value)))) {
          throw new Error('嵌入模型返回了非有限数值');
        }
        return batchEmbeddings;
      };

      const normalizedInputs = inputs.map(normalizeEmbeddingInput);
      if (normalizedInputs.some((input) => !input)) throw new Error('规范化后的嵌入文本为空');
      const embeddings = await requestBatch(normalizedInputs);
      if (embeddings.length !== inputs.length) {
        throw new Error(`Embedding count mismatch: expected ${inputs.length}, received ${embeddings.length}`);
      }
      embeddings.forEach((embedding) => {
        if (embedding.length !== this.config.elasticsearch.dimensions) {
          throw new Error(`Embedding dimension mismatch: expected ${this.config.elasticsearch.dimensions}, received ${embedding.length}`);
        }
      });
      return embeddings;
    } finally {
      clearTimeout(timeout);
    }
  }

  async chatCompletion(body: Record<string, unknown>, userId = this.config.defaultUserId) {
    const connection = await this.resolve('CHAT', userId);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.chat.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(`${connection.baseUrl}/chat/completions`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${connection.apiKey}`,
          },
          body: JSON.stringify({ ...body, model: connection.modelName, stream: false }),
        });
      } catch (error) {
        throw connectionError(error, '对话模型 API', connection.baseUrl);
      }
      const text = await response.text();
      if (!response.ok) throw new Error(`Chat service ${response.status}: ${text.slice(0, 500)}`);
      return JSON.parse(text) as Record<string, unknown>;
    } finally {
      clearTimeout(timeout);
    }
  }
}

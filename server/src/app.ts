import path from 'node:path';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyRequest } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { AuditService } from './audit.js';
import type { AppConfig } from './config.js';
import { CredentialCipher } from './credentials.js';
import type { Database } from './db.js';
import { DocumentService, extractDocumentText } from './documents.js';
import { ElasticStore } from './elastic.js';
import { ModelService, type ModelConnectionInput, type ModelKind } from './model.js';
import { RetrievalService } from './retrieval.js';

type DatasetRow = RowDataPacket & {
  id: string;
  name: string;
  description: string;
  owner_id: string;
  required_scopes: string | string[];
  document_count: number;
  chunk_count: number;
};

type AuditRow = RowDataPacket & {
  digest: string;
  algorithm: string;
  signature: string;
  public_key: string;
  record_json: string | Record<string, unknown>;
  created_at: string;
};

function userContext(request: FastifyRequest, config: AppConfig) {
  const scopes = String(request.headers['x-claimtrace-scopes'] || 'public')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  return {
    userId: String(request.headers['x-claimtrace-user'] || config.defaultUserId),
    scopes,
  };
}

function stringArray(value: unknown, fallback: string[] = []) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return fallback;
}

function parseJsonObject(value: string | undefined) {
  if (!value) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('metadata must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function modelConnectionInput(value: unknown, routeKind?: string): ModelConnectionInput {
  const body = (value || {}) as Record<string, unknown>;
  const kind = String(routeKind || body.kind || '').toUpperCase() as ModelKind;
  if (kind !== 'CHAT' && kind !== 'EMBEDDING') throw new Error('kind must be CHAT or EMBEDDING');
  return {
    kind,
    instanceName: String(body.instanceName || '').trim(),
    baseUrl: String(body.baseUrl || '').trim(),
    modelName: String(body.modelName || '').trim(),
    apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
  };
}

export async function buildApp(config: AppConfig, database: Database) {
  const app = Fastify({ logger: { level: config.logLevel }, bodyLimit: 20 * 1024 * 1024 });
  const elastic = new ElasticStore(config);
  const credentialCipher = await CredentialCipher.create(config.credentials.keyPath);
  const models = new ModelService(config, database, credentialCipher);
  await models.initialize();
  const retrieval = new RetrievalService(config, database, elastic, models);
  const documents = new DocumentService(database, elastic, models);
  const audit = new AuditService(config, database);
  await elastic.ensureIndex();

  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1 } });

  app.get('/livez', async () => ({ status: 'ok' }));

  app.get('/healthz', async (_request, reply) => {
    const [mysqlHealth, elasticHealth, modelHealth] = await Promise.allSettled([
      database.query<RowDataPacket[]>('SELECT 1 AS ok'),
      elastic.request('/_cluster/health'),
      models.health(),
    ]);
    const services = {
      mysql: mysqlHealth.status === 'fulfilled' ? 'ok' : 'unavailable',
      elasticsearch: elasticHealth.status === 'fulfilled' ? 'ok' : 'unavailable',
      models: modelHealth.status === 'fulfilled' ? modelHealth.value.configured : 'unavailable',
    };
    if ([mysqlHealth, elasticHealth, modelHealth].some((result) => result.status === 'rejected')) {
      return reply.code(503).send({ status: 'degraded', ...services });
    }
    return { status: 'ok', ...services };
  });

  app.get('/api/v1/runtime', async (request) => {
    const context = userContext(request, config);
    const connections = await models.list(context.userId);
    return {
      code: 0,
      data: {
        chatModel: connections.find((item) => item.kind === 'CHAT')?.modelName,
        embeddingModel: connections.find((item) => item.kind === 'EMBEDDING')?.modelName,
        retrieval: config.retrieval,
      },
    };
  });

  app.get('/api/v1/model-connections', async (request) => {
    const context = userContext(request, config);
    return { code: 0, data: await models.list(context.userId) };
  });

  app.post('/api/v1/model-connections/verify', async (request, reply) => {
    const context = userContext(request, config);
    try {
      const result = await models.verify(modelConnectionInput(request.body), context.userId);
      return { code: 0, data: result, message: 'Connection verified' };
    } catch (error) {
      request.log.warn({ event: 'model.verify_failed', error }, 'model connection verification failed');
      return reply.code(422).send({ code: 422, message: error instanceof Error ? error.message : 'Verification failed' });
    }
  });

  app.put('/api/v1/model-connections/:kind', async (request, reply) => {
    const context = userContext(request, config);
    const { kind } = request.params as { kind: string };
    try {
      const result = await models.save(modelConnectionInput(request.body, kind), context.userId);
      return { code: 0, data: result, message: 'Connection saved' };
    } catch (error) {
      request.log.warn({ event: 'model.save_failed', error }, 'model connection save failed');
      return reply.code(422).send({ code: 422, message: error instanceof Error ? error.message : 'Save failed' });
    }
  });

  app.get('/api/v1/datasets', async (request) => {
    const context = userContext(request, config);
    const rows = await database.query<DatasetRow[]>(
      `SELECT d.id, d.name, d.description, d.owner_id, d.required_scopes,
        COUNT(doc.id) AS document_count, COALESCE(SUM(doc.chunk_count), 0) AS chunk_count
       FROM datasets d LEFT JOIN documents doc ON doc.dataset_id=d.id AND doc.status='READY'
       WHERE d.owner_id=? GROUP BY d.id ORDER BY d.created_at`,
      [context.userId],
    );
    return { code: 0, data: rows };
  });

  app.post('/api/v1/retrieval', async (request, reply) => {
    const body = request.body as { question?: unknown; dataset_ids?: unknown };
    const question = typeof body?.question === 'string' ? body.question.trim() : '';
    const datasetIds = stringArray(body?.dataset_ids);
    if (!question || datasetIds.length === 0) {
      return reply.code(400).send({ code: 400, message: 'question and dataset_ids are required' });
    }
    const context = userContext(request, config);
    const result = await retrieval.retrieve(question, datasetIds, context.userId, context.scopes);
    request.log.info({
      event: 'retrieval.completed',
      question,
      candidateCount: result.candidateCount,
      selectedCount: result.chunks.length,
    });
    return {
      code: 0,
      data: {
        total: result.chunks.length,
        candidate_count: result.candidateCount,
        permission_filtered_documents: result.filteredDocumentCount,
        chunks: result.chunks,
      },
    };
  });

  app.post('/api/model/chat/completions', async (request) => {
    const context = userContext(request, config);
    const result = await models.chatCompletion(request.body as Record<string, unknown>, context.userId);
    const choices = result.choices as Array<{
      message?: { content?: string };
      finish_reason?: string;
    }> | undefined;
    const output = choices?.[0]?.message?.content || '';
    request.log.info({
      event: 'model.completed',
      stage: request.headers['x-claimtrace-stage'] || 'unspecified',
      model: result.model || config.chat.model,
      finishReason: choices?.[0]?.finish_reason || 'unknown',
      outputLength: output.length,
      output: output.slice(0, 1000),
    });
    return result;
  });

  app.post('/api/v1/documents/import', async (request, reply) => {
    const context = userContext(request, config);
    const fields: Record<string, string> = {};
    let filename = '';
    let fileBuffer: Buffer | undefined;
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        filename = part.filename;
        fileBuffer = await part.toBuffer();
      } else fields[part.fieldname] = String(part.value || '');
    }
    if (!fileBuffer || !filename || !fields.datasetId) {
      return reply.code(400).send({ code: 400, message: 'datasetId and file are required' });
    }
    const owned = await database.query<RowDataPacket[]>(
      'SELECT id FROM datasets WHERE id=? AND owner_id=? LIMIT 1',
      [fields.datasetId, context.userId],
    );
    if (!owned[0]) return reply.code(403).send({ code: 403, message: 'Dataset is not writable' });
    try {
      const content = await extractDocumentText(filename, fileBuffer);
      const result = await documents.ingest({
        userId: context.userId,
        datasetId: fields.datasetId,
        title: fields.title || filename,
        sourceName: filename,
        content,
        effectiveAt: fields.effectiveAt || undefined,
        version: fields.version || undefined,
        canonicalSourceId: fields.canonicalSourceId || undefined,
        clauseKey: fields.clauseKey || undefined,
        admissionScopes: stringArray(fields.admissionScopes, ['public']),
        permissionScopes: stringArray(fields.permissionScopes, ['public']),
        hierarchicalTitles: stringArray(fields.hierarchicalTitles),
        metadata: parseJsonObject(fields.metadata),
      });
      request.log.info({ event: 'document.indexed', filename, ...result });
      return { code: 0, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : '文档导入失败';
      request.log.warn({ event: 'document.import_failed', filename, error }, message);
      return reply.code(422).send({ code: 422, message });
    }
  });

  app.delete('/api/v1/datasets/:datasetId/documents/:documentId', async (request, reply) => {
    const params = request.params as { datasetId: string; documentId: string };
    const context = userContext(request, config);
    const owned = await database.query<RowDataPacket[]>(
      'SELECT id FROM datasets WHERE id=? AND owner_id=? LIMIT 1',
      [params.datasetId, context.userId],
    );
    if (!owned[0]) return reply.code(403).send({ code: 403, message: 'Dataset is not writable' });
    const removed = await documents.remove(params.documentId, params.datasetId);
    return removed ? { code: 0 } : reply.code(404).send({ code: 404, message: 'Document not found' });
  });

  app.get('/api/v1/thumbnails', async () => ({ code: 0, data: {} }));

  app.post('/claimtrace-runtime-log', async (request, reply) => {
    request.log.info({ event: 'client.pipeline', payload: request.body });
    return reply.code(204).send();
  });

  app.post('/claimtrace-audit', async (request) => {
    const context = userContext(request, config);
    return audit.signRecord(context.userId, request.body);
  });

  app.get('/claimtrace-audit/:digest', async (request, reply) => {
    const { digest } = request.params as { digest: string };
    if (!/^[a-f0-9]{64}$/.test(digest)) return reply.code(400).send({ message: 'Invalid digest' });
    const rows = await database.query<AuditRow[]>(
      `SELECT digest, algorithm, signature, public_key, record_json, created_at
       FROM audit_records WHERE digest=? LIMIT 1`,
      [digest],
    );
    if (!rows[0]) return reply.code(404).send({ message: 'Audit record not found' });
    const row = rows[0];
    reply.header('Content-Disposition', `attachment; filename="claimtrace-${digest}.json"`);
    return {
      record: typeof row.record_json === 'string' ? JSON.parse(row.record_json) : row.record_json,
      envelope: {
        algorithm: row.algorithm,
        digest: row.digest,
        signature: row.signature,
        publicKey: row.public_key,
        signedAt: row.created_at,
      },
    };
  });

  await app.register(fastifyStatic, {
    root: path.resolve(config.publicDirectory),
    prefix: '/',
    wildcard: false,
  });
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/claimtrace-')) {
      return reply.code(404).send({ code: 404, message: 'Route not found' });
    }
    return reply.sendFile('index.html');
  });
  return app;
}

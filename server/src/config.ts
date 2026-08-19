import path from 'node:path';

function numberValue(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanValue(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  return value.toLowerCase() === 'true';
}

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const dataDirectory = process.env.CLAIMTRACE_DATA_DIR || '/var/lib/claimtrace';
  return {
    host: process.env.CLAIMTRACE_HOST || '0.0.0.0',
    port: numberValue(process.env.CLAIMTRACE_PORT, 9222),
    logLevel: process.env.CLAIMTRACE_LOG_LEVEL || 'info',
    publicDirectory: process.env.CLAIMTRACE_PUBLIC_DIR || path.resolve('public'),
    dataDirectory,
    defaultUserId: process.env.CLAIMTRACE_DEFAULT_USER_ID || 'local-user',
    defaultDatasetId: process.env.CLAIMTRACE_DEFAULT_DATASET_ID || 'claimtrace-default',
    defaultDatasetName: process.env.CLAIMTRACE_DEFAULT_DATASET_NAME || '默认知识库',
    mysql: {
      host: process.env.MYSQL_HOST || 'mysql',
      port: numberValue(process.env.MYSQL_PORT, 3306),
      database: process.env.MYSQL_DATABASE || 'claimtrace',
      user: process.env.MYSQL_USER || 'claimtrace',
      password: process.env.MYSQL_PASSWORD || '',
      connectionLimit: numberValue(process.env.MYSQL_CONNECTION_LIMIT, 20),
    },
    elasticsearch: {
      url: (process.env.ELASTICSEARCH_URL || 'http://elasticsearch:9200').replace(/\/$/, ''),
      index: process.env.ELASTICSEARCH_INDEX || 'claimtrace_chunks_v1',
      username: process.env.ELASTICSEARCH_USERNAME || '',
      password: process.env.ELASTICSEARCH_PASSWORD || '',
      dimensions: numberValue(process.env.EMBEDDING_DIMENSIONS, 1024),
    },
    embedding: {
      baseUrl: (process.env.EMBEDDING_BASE_URL || 'http://host.docker.internal:6380/v1').replace(/\/$/, ''),
      model: process.env.EMBEDDING_MODEL || 'bge-m3',
      apiKey: process.env.EMBEDDING_API_KEY || 'local-api-key',
      timeoutMs: numberValue(process.env.EMBEDDING_TIMEOUT_MS, 120_000),
    },
    chat: {
      baseUrl: (process.env.CHAT_BASE_URL || 'http://host.docker.internal:8001/v1').replace(/\/$/, ''),
      model: process.env.CHAT_MODEL || 'qwen3:8b',
      apiKey: process.env.CHAT_API_KEY || 'local-api-key',
      timeoutMs: numberValue(process.env.CHAT_TIMEOUT_MS, 180_000),
    },
    retrieval: {
      candidateCount: numberValue(process.env.RETRIEVAL_CANDIDATE_COUNT, 30),
      finalCount: numberValue(process.env.RETRIEVAL_FINAL_COUNT, 12),
      decayDays: numberValue(process.env.RETRIEVAL_DECAY_DAYS, 730),
    },
    audit: {
      privateKeyPath: process.env.AUDIT_PRIVATE_KEY_PATH || path.join(dataDirectory, 'audit-ed25519.pem'),
    },
    credentials: {
      keyPath: process.env.MODEL_CREDENTIAL_KEY_PATH || path.join(dataDirectory, 'model-credentials.key'),
    },
    allowRegistration: booleanValue(process.env.CLAIMTRACE_ALLOW_REGISTRATION, false),
  };
}

import mysql, { type Pool, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import type { AppConfig } from './config.js';

const migrationStatements = [
  `CREATE TABLE IF NOT EXISTS datasets (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    required_scopes JSON NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX idx_datasets_owner (owner_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS documents (
    id VARCHAR(64) PRIMARY KEY,
    dataset_id VARCHAR(64) NOT NULL,
    title VARCHAR(512) NOT NULL,
    source_name VARCHAR(512) NOT NULL,
    content_hash CHAR(64) NOT NULL,
    status ENUM('INDEXING','READY','FAILED') NOT NULL DEFAULT 'INDEXING',
    chunk_count INT NOT NULL DEFAULT 0,
    effective_at DATETIME(3) NULL,
    version_label VARCHAR(128) NULL,
    canonical_source_id VARCHAR(255) NULL,
    clause_key VARCHAR(255) NULL,
    admission_scopes JSON NOT NULL,
    permission_scopes JSON NOT NULL,
    metadata JSON NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_documents_dataset FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE,
    UNIQUE KEY uq_document_hash (dataset_id, content_hash),
    INDEX idx_documents_dataset_status (dataset_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS chunks (
    id VARCHAR(64) PRIMARY KEY,
    document_id VARCHAR(64) NOT NULL,
    dataset_id VARCHAR(64) NOT NULL,
    ordinal_no INT NOT NULL,
    content_hash CHAR(64) NOT NULL,
    char_start INT NOT NULL,
    char_end INT NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_chunks_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
    CONSTRAINT fk_chunks_dataset FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE,
    UNIQUE KEY uq_chunk_ordinal (document_id, ordinal_no),
    INDEX idx_chunks_dataset (dataset_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS audit_records (
    digest CHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    algorithm VARCHAR(64) NOT NULL,
    signature TEXT NOT NULL,
    public_key TEXT NOT NULL,
    record_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_audit_user_created (user_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS model_connections (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    kind ENUM('CHAT','EMBEDDING') NOT NULL,
    instance_name VARCHAR(128) NOT NULL,
    provider VARCHAR(64) NOT NULL DEFAULT 'OPENAI_COMPATIBLE',
    base_url VARCHAR(1024) NOT NULL,
    model_name VARCHAR(255) NOT NULL,
    api_key_ciphertext TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    verified_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_model_connection_kind (user_id, kind),
    INDEX idx_model_connection_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
];

export type Database = {
  pool: Pool;
  query<T extends RowDataPacket[]>(sql: string, values?: unknown[]): Promise<T>;
  execute(sql: string, values?: unknown[]): Promise<ResultSetHeader>;
  close(): Promise<void>;
};

export async function createDatabase(config: AppConfig): Promise<Database> {
  const pool = mysql.createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    database: config.mysql.database,
    user: config.mysql.user,
    password: config.mysql.password,
    connectionLimit: config.mysql.connectionLimit,
    waitForConnections: true,
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: true,
  });
  for (const statement of migrationStatements) await pool.execute(statement);
  await pool.execute(
    `INSERT INTO datasets (id, name, description, owner_id, required_scopes)
     VALUES (?, ?, ?, ?, JSON_ARRAY('public'))
     ON DUPLICATE KEY UPDATE name=VALUES(name), description=VALUES(description)`,
    [
      config.defaultDatasetId,
      config.defaultDatasetName,
      'ClaimTrace 独立知识库',
      config.defaultUserId,
    ],
  );
  return {
    pool,
    async query<T extends RowDataPacket[]>(sql: string, values: unknown[] = []) {
      const [rows] = await pool.query<T>(sql, values as never[]);
      return rows;
    },
    async execute(sql: string, values: unknown[] = []) {
      const [result] = await pool.execute<ResultSetHeader>(sql, values as never[]);
      return result;
    },
    async close() {
      await pool.end();
    },
  };
}

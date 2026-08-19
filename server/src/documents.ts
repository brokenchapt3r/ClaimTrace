import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import mammoth from 'mammoth';
import pdf from 'pdf-parse';
import type { RowDataPacket } from 'mysql2/promise';
import { chunkDocument } from './chunking.js';
import type { Database } from './db.js';
import { ElasticStore } from './elastic.js';
import { ModelService } from './model.js';

export type IngestDocumentInput = {
  userId: string;
  datasetId: string;
  title: string;
  sourceName: string;
  content: string;
  effectiveAt?: string;
  version?: string;
  canonicalSourceId?: string;
  clauseKey?: string;
  admissionScopes: string[];
  permissionScopes: string[];
  hierarchicalTitles: string[];
  metadata: Record<string, unknown>;
};

type ExistingDocument = RowDataPacket & { id: string; status: string; chunk_count: number };

function mysqlDate(value: string | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid effective date: ${value}`);
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

export async function extractDocumentText(filename: string, buffer: Buffer) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (extension === '.pdf') {
    const result = await pdf(buffer);
    return result.text;
  }
  if (['.txt', '.md', '.markdown', '.csv', '.json', '.html', '.htm'].includes(extension)) {
    return buffer.toString('utf8');
  }
  throw new Error(`Unsupported document type: ${extension || 'unknown'}`);
}

export class DocumentService {
  constructor(
    private readonly database: Database,
    private readonly elastic: ElasticStore,
    private readonly models: ModelService,
  ) {}

  async ingest(input: IngestDocumentInput) {
    const content = input.content.trim();
    if (!content) throw new Error('Document content is empty');
    const contentHash = createHash('sha256').update(content).digest('hex');
    const existing = await this.database.query<ExistingDocument[]>(
      'SELECT id, status, chunk_count FROM documents WHERE dataset_id=? AND content_hash=? LIMIT 1',
      [input.datasetId, contentHash],
    );
    if (existing[0]) return { ...existing[0], duplicate: true };

    const chunks = chunkDocument(content);
    if (chunks.length === 0) throw new Error('Document did not produce any indexable chunks');
    const documentId = randomUUID().replaceAll('-', '');
    const chunkRows = chunks.map((chunk) => ({
      ...chunk,
      id: randomUUID().replaceAll('-', ''),
    }));
    const embeddings: number[][] = [];
    for (let offset = 0; offset < chunkRows.length; offset += 16) {
      embeddings.push(...await this.models.embed(
        chunkRows.slice(offset, offset + 16).map((chunk) => chunk.content),
        input.userId,
      ));
    }

    const connection = await this.database.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO documents (
          id, dataset_id, title, source_name, content_hash, status, chunk_count, effective_at,
          version_label, canonical_source_id, clause_key, admission_scopes, permission_scopes, metadata
        ) VALUES (?, ?, ?, ?, ?, 'INDEXING', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          documentId,
          input.datasetId,
          input.title,
          input.sourceName,
          contentHash,
          chunkRows.length,
          mysqlDate(input.effectiveAt),
          input.version || null,
          input.canonicalSourceId || null,
          input.clauseKey || null,
          JSON.stringify(input.admissionScopes),
          JSON.stringify(input.permissionScopes),
          JSON.stringify(input.metadata),
        ],
      );
      for (const chunk of chunkRows) {
        await connection.execute(
          `INSERT INTO chunks (id, document_id, dataset_id, ordinal_no, content_hash, char_start, char_end)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            chunk.id,
            documentId,
            input.datasetId,
            chunk.ordinal,
            chunk.hash,
            chunk.charStart,
            chunk.charEnd,
          ],
        );
      }
      await this.elastic.bulkIndex(chunkRows.map((chunk, index) => ({
        id: chunk.id,
        document: {
          id: chunk.id,
          dataset_id: input.datasetId,
          document_id: documentId,
          title: input.title,
          hierarchical_titles: input.hierarchicalTitles,
          content: chunk.content,
          content_hash: chunk.hash,
          embedding: embeddings[index],
          effective_at: input.effectiveAt || null,
          created_at: new Date().toISOString(),
          version: input.version || null,
          canonical_source_id: input.canonicalSourceId || null,
          clause_key: input.clauseKey || null,
          admission_scopes: input.admissionScopes,
          permission_scopes: input.permissionScopes,
          ordinal_no: chunk.ordinal,
          char_start: chunk.charStart,
          char_end: chunk.charEnd,
        },
      })));
      await connection.execute("UPDATE documents SET status='READY' WHERE id=?", [documentId]);
      await connection.commit();
      return { id: documentId, status: 'READY', chunk_count: chunkRows.length, duplicate: false };
    } catch (error) {
      await connection.rollback();
      await this.elastic.deleteDocument(documentId).catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async remove(documentId: string, datasetId: string) {
    await this.elastic.deleteDocument(documentId);
    const result = await this.database.execute(
      'DELETE FROM documents WHERE id=? AND dataset_id=?',
      [documentId, datasetId],
    );
    return result.affectedRows > 0;
  }
}

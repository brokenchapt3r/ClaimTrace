import type { RowDataPacket } from 'mysql2/promise';
import type { AppConfig } from './config.js';
import type { Database } from './db.js';
import { ElasticStore } from './elastic.js';
import { ModelService } from './model.js';

type DocumentRow = RowDataPacket & {
  id: string;
  dataset_id: string;
  admission_scopes: string | string[];
};

type DatasetAccessRow = RowDataPacket & {
  id: string;
  owner_id: string;
  required_scopes: string | string[];
};

type ElasticHit = {
  _id: string;
  _score?: number;
  _source: {
    id: string;
    dataset_id: string;
    document_id: string;
    title: string;
    hierarchical_titles?: string[];
    content: string;
    effective_at?: string;
    created_at?: string;
    version?: string;
    canonical_source_id?: string;
    clause_key?: string;
    admission_scopes?: string[];
    permission_scopes?: string[];
    ordinal_no?: number;
    char_start?: number;
    char_end?: number;
  };
};

type MultiSearchResponse = {
  responses?: Array<{ hits?: { hits?: ElasticHit[] }; error?: unknown }>;
};

export type RetrievalChunk = {
  chunk_id: string;
  content: string;
  document_id: string;
  document_keyword: string;
  dataset_id: string;
  positions: number[][];
  similarity: number;
  vector_similarity: number;
  bm25: number;
  bm25_normalized: number;
  freshness: number;
  title_coverage: number;
  document_metadata: Record<string, unknown>;
};

function parseStringArray(value: string | string[] | null | undefined) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function tokenize(value: string) {
  return Array.from(new Set(
    value
      .toLowerCase()
      .replace(/[^\u4e00-\u9fa5a-z0-9]/g, ' ')
      .split(/\s+/)
      .flatMap((token) => {
        if (/^[\u4e00-\u9fa5]{2,}$/.test(token)) {
          return Array.from({ length: token.length - 1 }, (_, index) => token.slice(index, index + 2));
        }
        return token.length > 1 ? [token] : [];
      })
      .filter(Boolean),
  ));
}

export function freshnessScore(effectiveAt: string | undefined, decayDays: number, now = Date.now()) {
  if (!effectiveAt) return 0.5;
  const timestamp = Date.parse(effectiveAt);
  if (!Number.isFinite(timestamp)) return 0.5;
  const elapsedDays = Math.max(0, (now - timestamp) / 86_400_000);
  return Math.max(0, 1 - elapsedDays / decayDays);
}

export function titleCoverage(query: string, titles: string[]) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;
  return titles.reduce((maximum, title) => {
    const titleTokens = new Set(tokenize(title));
    return Math.max(
      maximum,
      queryTokens.filter((token) => titleTokens.has(token)).length / queryTokens.length,
    );
  }, 0);
}

export function combinedScore(
  semantic: number,
  bm25Normalized: number,
  freshness: number,
  headingCoverage: number,
) {
  return 0.65 * semantic + 0.35 * bm25Normalized + 0.08 * freshness + 0.05 * headingCoverage;
}

function canAccess(required: string[], scopes: string[]) {
  return required.length === 0 || required.every((scope) => scopes.includes(scope));
}

export class RetrievalService {
  constructor(
    private readonly config: AppConfig,
    private readonly database: Database,
    private readonly elastic: ElasticStore,
    private readonly models: ModelService,
  ) {}

  async retrieve(question: string, datasetIds: string[], userId: string, scopes: string[]) {
    const requestedPlaceholders = datasetIds.map(() => '?').join(',');
    const datasetRows = await this.database.query<DatasetAccessRow[]>(
      `SELECT id, owner_id, required_scopes FROM datasets WHERE id IN (${requestedPlaceholders})`,
      datasetIds,
    );
    const permittedDatasetIds = datasetRows
      .filter((dataset) =>
        dataset.owner_id === userId || canAccess(parseStringArray(dataset.required_scopes), scopes),
      )
      .map((dataset) => dataset.id);
    if (permittedDatasetIds.length === 0) {
      return { candidateCount: 0, filteredDocumentCount: 0, chunks: [] as RetrievalChunk[] };
    }
    const placeholders = permittedDatasetIds.map(() => '?').join(',');
    const documents = await this.database.query<DocumentRow[]>(
      `SELECT id, dataset_id, admission_scopes FROM documents
       WHERE status='READY' AND dataset_id IN (${placeholders})`,
      permittedDatasetIds,
    );
    const admittedDocumentIds = documents
      .filter((document) => canAccess(parseStringArray(document.admission_scopes), scopes))
      .map((document) => document.id);
    if (admittedDocumentIds.length === 0) {
      return { candidateCount: 0, filteredDocumentCount: documents.length, chunks: [] as RetrievalChunk[] };
    }

    const [queryVector] = await this.models.embed([question], userId);
    const tokens = tokenize(question).join(' ');
    const filters = [{ terms: { document_id: admittedDocumentIds } }];
    const lexicalQuery = {
      size: this.config.retrieval.candidateCount,
      query: {
        bool: {
          filter: filters,
          should: [
            { match: { content: { query: tokens, boost: 3 } } },
            { match: { title: { query: tokens, boost: 2 } } },
            { match: { hierarchical_titles: { query: tokens, boost: 1 } } },
          ],
          minimum_should_match: 1,
        },
      },
      _source: { excludes: ['embedding'] },
    };
    const vectorQuery = {
      size: this.config.retrieval.candidateCount,
      knn: {
        field: 'embedding',
        query_vector: queryVector,
        k: this.config.retrieval.candidateCount,
        num_candidates: Math.max(100, this.config.retrieval.candidateCount * 4),
        filter: { terms: { document_id: admittedDocumentIds } },
      },
      _source: { excludes: ['embedding'] },
    };
    const msearchBody = [
      JSON.stringify({ index: this.config.elasticsearch.index }),
      JSON.stringify(lexicalQuery),
      JSON.stringify({ index: this.config.elasticsearch.index }),
      JSON.stringify(vectorQuery),
    ].join('\n') + '\n';
    const search = await this.elastic.request<MultiSearchResponse>('/_msearch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: msearchBody,
    });
    if (search.responses?.some((response) => response.error)) {
      throw new Error(`Elasticsearch multi-search failed: ${JSON.stringify(search.responses)}`);
    }
    const lexicalHits = search.responses?.[0]?.hits?.hits || [];
    const vectorHits = search.responses?.[1]?.hits?.hits || [];
    const candidates = new Map<string, { hit: ElasticHit; bm25: number; semantic: number }>();
    lexicalHits.forEach((hit) => {
      candidates.set(hit._id, { hit, bm25: Number(hit._score) || 0, semantic: 0 });
    });
    vectorHits.forEach((hit) => {
      const semantic = Math.max(-1, Math.min(1, 2 * (Number(hit._score) || 0) - 1));
      const existing = candidates.get(hit._id);
      candidates.set(hit._id, {
        hit: existing?.hit || hit,
        bm25: existing?.bm25 || 0,
        semantic,
      });
    });
    const values = [...candidates.values()];
    if (values.length === 0) {
      return {
        candidateCount: 0,
        filteredDocumentCount: documents.length - admittedDocumentIds.length,
        chunks: [] as RetrievalChunk[],
      };
    }
    const bm25Values = values.map((candidate) => candidate.bm25);
    const bm25Minimum = Math.min(...bm25Values);
    const bm25Maximum = Math.max(...bm25Values);
    const normalized = (value: number) =>
      (value - bm25Minimum) / (bm25Maximum - bm25Minimum + 1e-8);

    const ranked = values
      .map(({ hit, bm25, semantic }) => {
        const source = hit._source;
        const freshness = freshnessScore(source.effective_at || source.created_at, this.config.retrieval.decayDays);
        const headingCoverage = titleCoverage(question, source.hierarchical_titles?.length
          ? source.hierarchical_titles
          : [source.title]);
        const bm25Normalized = normalized(bm25);
        return {
          hit,
          bm25,
          semantic,
          bm25Normalized,
          freshness,
          headingCoverage,
          combined: combinedScore(semantic, bm25Normalized, freshness, headingCoverage),
        };
      })
      .sort((left, right) => right.combined - left.combined)
      .slice(0, this.config.retrieval.finalCount);

    return {
      candidateCount: values.length,
      filteredDocumentCount: documents.length - admittedDocumentIds.length,
      chunks: ranked.map(({ hit, bm25, semantic, bm25Normalized, freshness, headingCoverage, combined }) => {
        const source = hit._source;
        return {
          chunk_id: source.id,
          content: source.content,
          document_id: source.document_id,
          document_keyword: source.title,
          dataset_id: source.dataset_id,
          positions: [[source.char_start || 0, source.char_end || source.content.length]],
          similarity: combined,
          vector_similarity: semantic,
          bm25,
          bm25_normalized: bm25Normalized,
          freshness,
          title_coverage: headingCoverage,
          document_metadata: {
            effective_at: source.effective_at,
            version: source.version,
            canonical_source_id: source.canonical_source_id,
            clause_key: source.clause_key,
            admission_scopes: source.admission_scopes || [],
            permission_scopes: source.permission_scopes || [],
            hierarchical_titles: source.hierarchical_titles || [],
          },
        } satisfies RetrievalChunk;
      }),
    };
  }
}

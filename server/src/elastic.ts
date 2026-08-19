import type { AppConfig } from './config.js';

export class ElasticStore {
  constructor(private readonly config: AppConfig) {}

  private headers() {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const { username, password } = this.config.elasticsearch;
    if (username && password) {
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }
    return headers;
  }

  async request<T>(path: string, init: RequestInit = {}) {
    const response = await fetch(`${this.config.elasticsearch.url}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init.headers || {}) },
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Elasticsearch ${response.status}: ${message.slice(0, 500)}`);
    }
    return response.status === 204 ? undefined as T : await response.json() as T;
  }

  async ensureIndex() {
    const { index, dimensions } = this.config.elasticsearch;
    const exists = await fetch(`${this.config.elasticsearch.url}/${index}`, {
      method: 'HEAD',
      headers: this.headers(),
    });
    if (exists.ok) return;
    if (exists.status !== 404) throw new Error(`Elasticsearch index check returned ${exists.status}`);
    await this.request(`/${index}`, {
      method: 'PUT',
      body: JSON.stringify({
        settings: { number_of_shards: 1, number_of_replicas: 0 },
        mappings: {
          properties: {
            id: { type: 'keyword' },
            dataset_id: { type: 'keyword' },
            document_id: { type: 'keyword' },
            title: { type: 'text', analyzer: 'standard' },
            hierarchical_titles: { type: 'text', analyzer: 'standard' },
            content: { type: 'text', analyzer: 'standard' },
            content_hash: { type: 'keyword' },
            embedding: { type: 'dense_vector', dims: dimensions, index: true, similarity: 'cosine' },
            effective_at: { type: 'date' },
            created_at: { type: 'date' },
            version: { type: 'keyword' },
            canonical_source_id: { type: 'keyword' },
            clause_key: { type: 'keyword' },
            admission_scopes: { type: 'keyword' },
            permission_scopes: { type: 'keyword' },
            ordinal_no: { type: 'integer' },
            char_start: { type: 'integer' },
            char_end: { type: 'integer' },
          },
        },
      }),
    });
  }

  async bulkIndex(rows: Array<{ id: string; document: Record<string, unknown> }>) {
    if (rows.length === 0) return;
    const body = rows.flatMap((row) => [
      JSON.stringify({ index: { _index: this.config.elasticsearch.index, _id: row.id } }),
      JSON.stringify(row.document),
    ]).join('\n') + '\n';
    const result = await this.request<{ errors?: boolean; items?: unknown[] }>('/_bulk?refresh=wait_for', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson' },
      body,
    });
    if (result.errors) throw new Error('Elasticsearch bulk indexing reported item errors');
  }

  async deleteDocument(documentId: string) {
    await this.request(`/${this.config.elasticsearch.index}/_delete_by_query?refresh=true`, {
      method: 'POST',
      body: JSON.stringify({ query: { term: { document_id: documentId } } }),
    });
  }
}

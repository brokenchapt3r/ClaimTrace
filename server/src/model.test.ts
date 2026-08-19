import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import type { CredentialCipher } from './credentials.js';
import type { Database } from './db.js';
import { ModelService } from './model.js';

function modelService() {
  const config = loadConfig();
  config.chat.baseUrl = 'http://chat.example/v1';
  config.chat.model = 'qwen3:8b';
  config.chat.apiKey = 'chat-secret';
  config.embedding.baseUrl = 'http://embedding.example/v1';
  config.embedding.model = 'bge-m3';
  config.embedding.apiKey = 'embedding-secret';
  config.elasticsearch.dimensions = 3;
  const database = {
    query: vi.fn(async (_sql: string, values: unknown[] = []) => {
      const kind = values[1] as 'CHAT' | 'EMBEDDING';
      return [{
        id: kind,
        user_id: 'local-user',
        kind,
        instance_name: kind === 'CHAT' ? 'Chat API' : 'Embedding API',
        provider: 'OPENAI_COMPATIBLE',
        base_url: kind === 'CHAT' ? config.chat.baseUrl : config.embedding.baseUrl,
        model_name: kind === 'CHAT' ? config.chat.model : config.embedding.model,
        api_key_ciphertext: kind === 'CHAT' ? 'chat-secret' : 'embedding-secret',
        enabled: true,
        verified_at: null,
        updated_at: '',
      }];
    }),
  } as unknown as Database;
  const cipher = {
    decrypt: (value: string) => value,
    encrypt: (value: string) => value,
  } as CredentialCipher;
  return new ModelService(config, database, cipher);
}

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI-compatible model APIs', () => {
  it('uses the embeddings endpoint and preserves input order', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { index: 1, embedding: [4, 5, 6] },
        { index: 0, embedding: [1, 2, 3] },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const embeddings = await modelService().embed(['first', 'second']);

    expect(embeddings).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://embedding.example/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer embedding-secret' }),
      }),
    );
  });

  it('requires both configured models to appear in their API catalogs', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'qwen3:8b' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'bge-m3' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(modelService().health()).resolves.toEqual({
      configured: ['qwen3:8b', 'bge-m3'],
    });
  });

  it('splits overloaded embedding batches and preserves their order', async () => {
    const embedding = (index: number) => ({ index, embedding: [index, index + 1, index + 2] });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"out of memory"}', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [embedding(0), embedding(1)] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [embedding(0), embedding(1)] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const embeddings = await modelService().embed(['a', 'b', 'c', 'd']);

    expect(embeddings).toEqual([
      [0, 1, 2],
      [1, 2, 3],
      [0, 1, 2],
      [1, 2, 3],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('recovers a NaN-producing passage by pooling embeddings from smaller spans', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'failed to encode response: json: unsupported value: NaN' },
      }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ index: 0, embedding: [1, 0, 0] }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ index: 0, embedding: [0, 1, 0] }],
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const [embedding] = await modelService().embed(['异常 PDF 文本段落。'.repeat(12)]);

    expect(embedding[0]).toBeCloseTo(Math.SQRT1_2);
    expect(embedding[1]).toBeCloseTo(Math.SQRT1_2);
    expect(embedding[2]).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

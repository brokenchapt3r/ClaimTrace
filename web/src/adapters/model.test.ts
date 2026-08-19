import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelAdapter } from './model';
import type { Claim, Evidence } from '@/core/types';

function completion(content: string, finishReason = 'stop') {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: finishReason }],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ModelAdapter structured output', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('regenerates malformed claim JSON and returns only validated model data', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion('{"claims":[{"text":"响应被截断"}'))
      .mockResolvedValueOnce(completion(JSON.stringify({
        claims: [{
          text: '系统使用声明与证据构建二分图',
          subject: '系统',
          predicate: '构建',
          object: '声明与证据二分图',
          components: ['系统使用声明与证据构建二分图'],
        }],
        dependencies: [],
      })));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new ModelAdapter({
      endpoint: '/api/model/chat/completions',
      model: 'configured-by-server',
      apiKey: '',
    });
    const result = await adapter.parseClaims('候选答案');

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].atom).toBe('系统使用声明与证据构建二分图');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstRequest = fetchMock.mock.calls[0][1] as RequestInit;
    const requestBody = JSON.parse(String(firstRequest.body)) as Record<string, unknown>;
    expect(requestBody.response_format).toEqual({ type: 'json_object' });
    expect((firstRequest.headers as Record<string, string>)['X-ClaimTrace-Stage']).toBe('claims');
  });

  it('regenerates a response stopped by the provider token limit', async () => {
    const valid = JSON.stringify({ claims: [{ text: '完整声明' }], dependencies: [] });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion('{"claims":[]}', 'length'))
      .mockResolvedValueOnce(completion(valid));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new ModelAdapter({
      endpoint: '/api/model/chat/completions',
      model: 'configured-by-server',
      apiKey: '',
    });

    await expect(adapter.parseClaims('候选答案')).resolves.toMatchObject({
      claims: [{ atom: '完整声明' }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('evaluates relation tiles with bounded concurrency and reports progress', async () => {
    let activeRequests = 0;
    let maximumConcurrency = 0;
    let firstTileCalls = 0;
    const fetchMock = vi.fn().mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      activeRequests += 1;
      maximumConcurrency = Math.max(maximumConcurrency, activeRequests);
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>;
      };
      const prompt = body.messages[1].content;
      const claims = JSON.parse(prompt.split('声明：')[1].split('\n证据：')[0]) as Array<{ id: string }>;
      const evidence = JSON.parse(prompt.split('\n证据：')[1].split('\n必须计算的组合：')[0]) as Array<{ id: string }>;
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeRequests -= 1;
      const relations = claims.flatMap((claim) => evidence.map((item) => ({
        claim_id: claim.id,
        evidence_id: item.id,
        support: 0.8,
        conflict: 0.1,
        unknown: 0.1,
        covered_components: [`${claim.id}.S1`],
        reason: '证据直接覆盖声明内容',
      })));
      const stage = (init?.headers as Record<string, string>)['X-ClaimTrace-Stage'];
      if (stage === 'relations:1/4' && firstTileCalls === 0) relations.splice(0);
      if (stage === 'relations:1/4') firstTileCalls += 1;
      return completion(JSON.stringify({
        relations,
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const claims: Claim[] = Array.from({ length: 6 }, (_, index) => ({
      id: `C${index + 1}`,
      title: `声明 ${index + 1}`,
      atom: `声明内容 ${index + 1}`,
      subject: '',
      predicate: '',
      object: '',
      condition: '',
      time: '',
      components: [{ id: `C${index + 1}.S1`, text: `声明内容 ${index + 1}` }],
      missingComponents: [],
      x: 0,
      y: 0,
    }));
    const evidence: Evidence[] = Array.from({ length: 4 }, (_, index) => ({
      id: `E${index + 1}`,
      title: `证据 ${index + 1}`,
      source: 'test',
      text: `证据内容 ${index + 1}`,
      x: 0,
      y: 0,
      hierarchicalTitles: [],
      admissionScopes: ['public'],
      requiredScopes: ['public'],
      accessAllowed: true,
      metrics: {
        semantic: 1,
        bm25: 1,
        bm25Normalized: 1,
        freshness: 1,
        titleCoverage: 1,
        combined: 1,
      },
      relations: [],
    }));
    const progress: Array<[number, number]> = [];
    const adapter = new ModelAdapter({
      endpoint: '/api/model/chat/completions',
      model: 'configured-by-server',
      apiKey: '',
    });

    const relations = await adapter.classifyRelations(
      claims,
      evidence,
      { userId: 'u1', scopes: ['public'], sensitivity: 'normal' },
      (completed, total) => progress.push([completed, total]),
    );

    expect(fetchMock).toHaveBeenCalledTimes(9);
    expect(firstTileCalls).toBe(6);
    expect(maximumConcurrency).toBe(3);
    expect(relations).toHaveLength(24);
    expect(progress.at(-1)).toEqual([4, 4]);
  });
});

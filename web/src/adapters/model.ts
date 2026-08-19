import { makeAcyclic } from '@/core/dependencies';
import type {
  AccessContext,
  Claim,
  ClaimDependency,
  Evidence,
  EvidenceRelation,
  RelationType,
} from '@/core/types';

type CompletionResponse = {
  choices?: Array<{
    message?: { content?: string };
    text?: string;
    finish_reason?: string;
  }>;
};

type CompletionOptions = {
  maxTokens?: number;
  json?: boolean;
  stage: 'draft' | 'claims' | `relations:${number}/${number}`;
};

type ModelClientOptions = {
  endpoint: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
};

type ParsedClaim = {
  text?: string;
  subject?: string;
  predicate?: string;
  object?: string;
  condition?: string;
  time?: string;
  components?: string[];
};

type ParsedDependency = {
  from?: number;
  to?: number;
  type?: ClaimDependency['type'];
  confidence?: number;
};

type NliResult = {
  claim_id?: string;
  evidence_id?: string;
  support?: number;
  conflict?: number;
  unknown?: number;
  covered_components?: string[];
  reason?: string;
};

function extractJson<T>(content: string): T {
  const withoutFence = content.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const objectStart = withoutFence.indexOf('{');
  const arrayStart = withoutFence.indexOf('[');
  const start = [objectStart, arrayStart].filter((value) => value >= 0).sort((a, b) => a - b)[0];
  if (start === undefined) throw new Error('模型没有返回 JSON');
  const end = Math.max(withoutFence.lastIndexOf('}'), withoutFence.lastIndexOf(']'));
  if (end < start) throw new Error('模型返回的 JSON 不完整');
  return JSON.parse(withoutFence.slice(start, end + 1)) as T;
}

function probability(value: number | undefined) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function normalizeDistribution(result: NliResult) {
  const raw = [probability(result.support), probability(result.conflict), probability(result.unknown)];
  const total = raw.reduce((sum, value) => sum + value, 0);
  if (total === 0) return { support: 0, conflict: 0, unknown: 1 };
  return {
    support: raw[0] / total,
    conflict: raw[1] / total,
    unknown: raw[2] / total,
  };
}

export class ModelAdapter {
  constructor(private readonly options: ModelClientOptions) {}

  private async complete(system: string, prompt: string, options: CompletionOptions) {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), this.options.timeoutMs || 90_000);
    try {
      const response = await fetch(this.options.endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.options.apiKey
            ? { Authorization: `Bearer ${this.options.apiKey}` }
            : {}),
          'X-ClaimTrace-Stage': options.stage,
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          temperature: 0.1,
          max_tokens: options.maxTokens || 4096,
          stream: false,
          chat_template_kwargs: { enable_thinking: false },
          ...(options.json ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
      if (!response.ok) {
        const detail = (await response.text()).trim();
        throw new Error(`模型服务返回 HTTP ${response.status}${detail ? `：${detail.slice(0, 300)}` : ''}`);
      }
      const result = (await response.json()) as CompletionResponse;
      const content = result.choices?.[0]?.message?.content || result.choices?.[0]?.text || '';
      if (!content.trim()) throw new Error('模型没有返回内容');
      if (result.choices?.[0]?.finish_reason === 'length') {
        throw new Error(`模型输出达到 ${options.maxTokens || 4096} token 上限`);
      }
      return content.trim();
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  private async completeJson<T>(
    system: string,
    prompt: string,
    options: Omit<CompletionOptions, 'json'>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retryInstruction = attempt === 0
        ? ''
        : '\n上一次响应未通过 JSON 语法或完整性校验。请重新生成更紧凑的完整 JSON；不得省略必需字段，不得输出注释或 Markdown。';
      try {
        const raw = await this.complete(`${system}${retryInstruction}`, prompt, {
          ...options,
          json: true,
        });
        return extractJson<T>(raw);
      } catch (error) {
        lastError = error;
      }
    }
    const detail = lastError instanceof Error ? lastError.message : '未知格式错误';
    throw new Error(`模型连续两次未返回可用的结构化数据：${detail}`);
  }

  async generateDraft(question: string, evidence: Evidence[]) {
    const context = evidence
      .map((item) => `${item.id} | ${item.title} | ${item.text}`)
      .join('\n\n');
    return this.complete(
      '你是知识库问答引擎。仅依据给定证据形成候选答案，不输出分析过程，不补充证据外事实。',
      `问题：${question}\n\n证据：\n${context}\n\n请给出完整候选答案，每项事实后标注证据编号。`,
      { maxTokens: 8192, stage: 'draft' },
    );
  }

  async parseClaims(draft: string) {
    const parsed = await this.completeJson<{ claims?: ParsedClaim[]; dependencies?: ParsedDependency[] }>(
      '你是结构化事实解析器。只返回合法 JSON，不输出 Markdown。每个声明必须能够独立判断真伪。',
      `把候选答案拆成最多 15 个原子声明，并抽取六元组字段。忽略证据编号、引用标记和排版标题，不要把同一事实重复表述。复合声明还要拆成可独立覆盖的语义成分。识别声明间的 premise、implication、exclusion 关系，索引从 1 开始。\n\n返回格式：{"claims":[{"text":"","subject":"","predicate":"","object":"","condition":"","time":"","components":[""]}],"dependencies":[{"from":1,"to":2,"type":"premise","confidence":0.0}]}\n\n候选答案：\n${draft}`,
      { maxTokens: 8192, stage: 'claims' },
    );
    const rows = (parsed.claims || []).filter((item) => item.text?.trim()).slice(0, 15);
    if (rows.length === 0) throw new Error('模型未解析出原子声明');
    const claims: Claim[] = rows.map((item, index) => {
      const id = `C${index + 1}`;
      const components = (item.components?.filter(Boolean).length ? item.components : [item.text || '']) || [];
      return {
        id,
        title: `声明 ${index + 1}`,
        atom: item.text?.trim() || '',
        subject: item.subject?.trim() || '',
        predicate: item.predicate?.trim() || '',
        object: item.object?.trim() || '',
        condition: item.condition?.trim() || '',
        time: item.time?.trim() || '',
        components: components.map((text, componentIndex) => ({
          id: `${id}.S${componentIndex + 1}`,
          text: text.trim(),
        })),
        missingComponents: [],
        x: 0,
        y: 0,
      };
    });
    const dependencies: ClaimDependency[] = (parsed.dependencies || [])
      .map((item) => ({
        from: `C${item.from || 0}`,
        to: `C${item.to || 0}`,
        type: item.type || 'premise',
        confidence: probability(item.confidence),
      }));
    return { claims, dependencies: makeAcyclic(claims.map((claim) => claim.id), dependencies) };
  }

  async classifyRelations(
    claims: Claim[],
    evidence: Evidence[],
    access: AccessContext,
    onProgress?: (completed: number, total: number) => void,
  ) {
    const claimPayload = claims.map((claim) => ({
      id: claim.id,
      text: claim.atom,
      components: claim.components,
    }));
    const tiles: Array<{
      claims: typeof claimPayload;
      evidence: Array<{ id: string; text: string }>;
    }> = [];
    // The matrix is evaluated in bounded tiles so every pair receives a reason without allowing
    // a large graph to exhaust the provider's output budget midway through a JSON document.
    for (let offset = 0; offset < evidence.length; offset += 3) {
      const evidencePayload = evidence
        .slice(offset, offset + 3)
        .map((item) => ({ id: item.id, text: item.text }));
      for (let claimOffset = 0; claimOffset < claimPayload.length; claimOffset += 5) {
        tiles.push({
          claims: claimPayload.slice(claimOffset, claimOffset + 5),
          evidence: evidencePayload,
        });
      }
    }

    const tileResults: NliResult[][] = Array.from({ length: tiles.length }, () => []);
    let nextTile = 0;
    let completedTiles = 0;
    const runWorker = async () => {
      while (nextTile < tiles.length) {
        const tileIndex = nextTile;
        nextTile += 1;
        const tile = tiles[tileIndex];
        const expectedPairs = tile.claims.flatMap((claim) =>
          tile.evidence.map((item) => `${claim.id}::${item.id}`),
        );
        const collected = new Map<string, NliResult>();
        const evaluatePairs = async (pairKeys: string[]) => {
          const requestedPairs = pairKeys.map((pair) => {
            const [claimId, evidenceId] = pair.split('::');
            return { claim_id: claimId, evidence_id: evidenceId };
          });
          const claimIds = new Set(requestedPairs.map((pair) => pair.claim_id));
          const evidenceIds = new Set(requestedPairs.map((pair) => pair.evidence_id));
          const scopedClaims = tile.claims.filter((claim) => claimIds.has(claim.id));
          const scopedEvidence = tile.evidence.filter((item) => evidenceIds.has(item.id));
          const parsed = await this.completeJson<{ relations?: NliResult[] }>(
            '你是自然语言推断分类器。必须为指定的每一个声明-证据组合输出一条结果。不相关不是空结果，而是 unknown 概率最高。三个概率之和必须为 1；理由必须指出判断依据并控制在 80 字以内。只返回合法 JSON。',
            `敏感级别：${access.sensitivity}\n声明：${JSON.stringify(scopedClaims)}\n证据：${JSON.stringify(scopedEvidence)}\n必须计算的组合：${JSON.stringify(requestedPairs)}\n\nrelations 数组必须恰好包含 ${requestedPairs.length} 条并覆盖上述每个组合：{"relations":[{"claim_id":"C1","evidence_id":"E1","support":0.0,"conflict":0.0,"unknown":1.0,"covered_components":["C1.S1"],"reason":"证据未涉及该声明"}]}`,
            { maxTokens: 8192, stage: `relations:${tileIndex + 1}/${tiles.length}` },
          );
          const requested = new Set(pairKeys);
          (parsed.relations || []).forEach((relation) => {
            const key = `${relation.claim_id}::${relation.evidence_id}`;
            if (requested.has(key)) collected.set(key, relation);
          });
        };

        await evaluatePairs(expectedPairs);
        // Some providers treat a wholly unrelated batch as an empty sparse graph. Shrinking the
        // unresolved set first by claim and then by pair obtains explicit model judgments while
        // keeping the common path to one request per tile.
        for (const repairGroupSize of [3, 1]) {
          const missingPairs = expectedPairs.filter((pair) => !collected.has(pair));
          if (missingPairs.length === 0) break;
          for (let offset = 0; offset < missingPairs.length; offset += repairGroupSize) {
            await evaluatePairs(missingPairs.slice(offset, offset + repairGroupSize));
          }
        }
        const unresolvedPairs = expectedPairs.filter((pair) => !collected.has(pair));
        if (unresolvedPairs.length > 0) {
          throw new Error(
            `模型未完成关系批次 ${tileIndex + 1}/${tiles.length}，缺少 ${unresolvedPairs
              .slice(0, 8)
              .map((pair) => pair.replace('::', '/'))
              .join('、')}`,
          );
        }
        tileResults[tileIndex] = expectedPairs.map((pair) => collected.get(pair) as NliResult);
        completedTiles += 1;
        onProgress?.(completedTiles, tiles.length);
      }
    };
    onProgress?.(0, tiles.length);
    const concurrency = Math.min(3, tiles.length);
    await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
    const batches = tileResults.flat();
    const byPair = new Map(
      batches.map((item) => [`${item.claim_id}::${item.evidence_id}`, item]),
    );
    const missingPairs = claimPayload.flatMap((claim) =>
      evidence.flatMap((item) =>
        byPair.has(`${claim.id}::${item.id}`) ? [] : [`${claim.id}/${item.id}`],
      ),
    );
    if (missingPairs.length > 0) {
      throw new Error(`模型关系矩阵不完整，缺少 ${missingPairs.slice(0, 8).join('、')}`);
    }
    const relations: EvidenceRelation[] = [];
    claims.forEach((claim) => {
      evidence.forEach((item) => {
        const result = byPair.get(`${claim.id}::${item.id}`);
        if (!result) return;
        const { support, conflict, unknown } = normalizeDistribution(result);
        const ranked: Array<[RelationType, number]> = [
          ['support', support],
          ['conflict', conflict],
          ['unknown', unknown],
        ];
        const [type, maximum] = ranked.sort((left, right) => right[1] - left[1])[0];
        const threshold =
          type === 'support'
            ? access.sensitivity === 'high'
              ? 0.72
              : 0.45
            : type === 'conflict' && access.sensitivity === 'high'
              ? 0.25
              : 0.45;
        if (maximum < threshold) return;
        const validComponents = new Set(claim.components.map((component) => component.id));
        relations.push({
          id: `L:${claim.id}:${item.id}`,
          claimId: claim.id,
          evidenceId: item.id,
          type,
          supportProbability: support,
          conflictProbability: conflict,
          unknownProbability: unknown,
          threshold,
          coveredComponentIds: (result.covered_components || []).filter((id) => validComponents.has(id)),
          active: true,
          selected: false,
          reason: result.reason?.trim() || '模型未提供关系理由',
        });
      });
    });
    return relations;
  }
}

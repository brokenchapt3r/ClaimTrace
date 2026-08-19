import { RETRIEVAL_LIMITS, tokenize } from '@/core/retrieval';
import type { AccessContext, Evidence } from '@/core/types';

type RetrievalChunk = {
  chunk_id?: string;
  content?: string;
  content_ltks?: string;
  document_id?: string;
  document_keyword?: string;
  dataset_id?: string;
  image_id?: string;
  positions?: number[][];
  page_num_int?: number[];
  similarity?: number;
  vector_similarity?: number;
  term_similarity?: number;
  bm25?: number;
  bm25_normalized?: number;
  freshness?: number;
  title_coverage?: number;
  metadata?: Record<string, unknown>;
  document_metadata?: Record<string, unknown>;
};

type RetrievalResponse = {
  code?: number;
  message?: string;
  data?: {
    chunks?: RetrievalChunk[];
    candidate_count?: number;
    permission_filtered_documents?: number;
  };
};

function asStringArray(value: unknown) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

function hasAdmission(item: Evidence, access: AccessContext) {
  return item.admissionScopes.length === 0 || item.admissionScopes.every((scope) => access.scopes.includes(scope));
}

export async function retrieveEvidence(
  question: string,
  datasetIds: string[],
  access: AccessContext,
) {
  const response = await fetch('/api/v1/retrieval', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-ClaimTrace-User': access.userId,
      'X-ClaimTrace-Scopes': access.scopes.join(','),
    },
    body: JSON.stringify({
      question,
      dataset_ids: datasetIds,
      page: 1,
      page_size: RETRIEVAL_LIMITS.candidateCount,
      top_k: RETRIEVAL_LIMITS.candidateCount,
      similarity_threshold: 0,
      vector_similarity_weight: 0.65,
      highlight: false,
      reference_metadata: { include: true },
    }),
  });
  if (!response.ok) {
    throw new Error(`知识库检索服务返回 HTTP ${response.status}；请确认当前工作区会话有效`);
  }
  const result = (await response.json()) as RetrievalResponse;
  if (result.code !== 0) throw new Error(result.message || '知识库检索失败');
  const chunks = result.data?.chunks || [];
  const candidates: Evidence[] = chunks.map((chunk, index) => {
    const metadata = chunk.document_metadata || chunk.metadata || {};
    const requiredScopes = asStringArray(metadata.required_scopes || metadata.permission_scopes);
    const admissionScopes = asStringArray(metadata.admission_scopes || metadata.acl_scopes);
    const pageNumbers = chunk.page_num_int;
    return {
      id: `E${index + 1}`,
      title: chunk.document_keyword || `检索片段 ${index + 1}`,
      source: chunk.document_id || chunk.chunk_id || '',
      text: chunk.content || chunk.content_ltks || '',
      x: 0,
      y: 0,
      score: Number(chunk.similarity) || 0,
      docId: chunk.document_id,
      kbId: chunk.dataset_id,
      chunkId: chunk.chunk_id,
      imageId: chunk.image_id,
      pageNumbers,
      position: chunk.positions,
      createdAt: typeof metadata.create_time === 'string' ? metadata.create_time : undefined,
      effectiveAt: typeof metadata.effective_at === 'string' ? metadata.effective_at : undefined,
      version: typeof metadata.version === 'string' ? metadata.version : undefined,
      clauseKey: typeof metadata.clause_key === 'string' ? metadata.clause_key : undefined,
      canonicalSourceId:
        typeof metadata.source_document_id === 'string'
          ? metadata.source_document_id
          : undefined,
      hierarchicalTitles: asStringArray(metadata.hierarchical_titles || metadata.section_path),
      permissionLabel: typeof metadata.permission_label === 'string' ? metadata.permission_label : undefined,
      admissionScopes,
      requiredScopes,
      accessAllowed: true,
      metrics: {
        semantic: Number(chunk.vector_similarity) || 0,
        bm25: Number(chunk.bm25) || 0,
        bm25Normalized: Number(chunk.bm25_normalized) || 0,
        freshness: Number(chunk.freshness) || 0,
        titleCoverage: Number(chunk.title_coverage) || 0,
        combined: Number(chunk.similarity) || 0,
      },
      relations: [],
    };
  });

  // Admission filtering happens before graph construction. The same permissions are checked
  // again when edges are initialized because an access grant may change during a long run.
  const admitted = candidates.filter((item) => hasAdmission(item, access));
  return {
    evidence: admitted,
    candidateCount: result.data?.candidate_count ?? chunks.length,
    queryTokens: tokenize(question),
    filteredCount:
      (result.data?.permission_filtered_documents || 0) + candidates.length - admitted.length,
  };
}

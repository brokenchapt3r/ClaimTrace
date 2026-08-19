import type { AccessContext, PipelineResult } from './types';

export type AuditEnvelope = {
  algorithm: string;
  digest: string;
  signature: string;
  publicKey: string;
  signedAt: string;
  recordId: string;
  downloadUrl: string;
};

export async function createAuditRecord(
  query: string,
  access: AccessContext,
  result: PipelineResult,
) {
  const record = {
    version: 1,
    query,
    access: { userId: access.userId, scopes: [...access.scopes].sort(), sensitivity: access.sensitivity },
    topology: {
      claims: result.claims,
      evidence: result.evidence,
      dependencies: result.dependencies,
    },
    trajectory: result.snapshots,
    final: {
      status: result.optimization.claimStatus,
      selectedEdgeIds: result.optimization.selectedEdgeIds,
      answer: result.answer,
    },
    createdAt: new Date().toISOString(),
  };
  const response = await fetch('/claimtrace-audit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-ClaimTrace-User': access.userId,
      'X-ClaimTrace-Scopes': access.scopes.join(','),
    },
    body: JSON.stringify(record),
  });
  if (!response.ok) throw new Error(`审计签名服务返回 HTTP ${response.status}`);
  return { record, envelope: (await response.json()) as AuditEnvelope };
}

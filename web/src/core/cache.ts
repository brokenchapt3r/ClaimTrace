import type { AccessContext, PipelineResult } from './types';

type CacheEntry = {
  queryVector: number[];
  scopes: string[];
  metadataRevision: string;
  result: PipelineResult;
  savedAt: string;
};

const CACHE_KEY = 'claimtrace.graph-cache.v1';

function cosine(left: number[], right: number[]) {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm) || 1);
}
function sameScopes(left: string[], right: string[]) {
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((scope, index) => scope === normalizedRight[index]);
}

export function findGraphSnapshot(
  queryVector: number[],
  access: AccessContext,
  metadataRevision: string,
) {
  const entries = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]') as CacheEntry[];
  return entries.find(
    (entry) =>
      sameScopes(entry.scopes, access.scopes) &&
      entry.metadataRevision === metadataRevision &&
      cosine(entry.queryVector, queryVector) > 0.95,
  )?.result;
}

export function storeGraphSnapshot(
  queryVector: number[],
  access: AccessContext,
  metadataRevision: string,
  result: PipelineResult,
) {
  if (queryVector.length === 0) return;
  const entries = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]') as CacheEntry[];
  entries.unshift({
    queryVector,
    scopes: [...access.scopes],
    metadataRevision,
    result,
    savedAt: new Date().toISOString(),
  });
  localStorage.setItem(CACHE_KEY, JSON.stringify(entries.slice(0, 20)));
}

import { describe, expect, it } from 'vitest';
import { chunkDocument } from './chunking.js';
import { combinedScore, freshnessScore, titleCoverage, tokenize } from './retrieval.js';

describe('document chunking', () => {
  it('preserves content order and stable character offsets', () => {
    const input = `${'安全要求。'.repeat(30)}\n\n${'维护要求。'.repeat(30)}`;
    const chunks = chunkDocument(input);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.length <= 320)).toBe(true);
    expect(chunks.map((chunk) => chunk.content).join('')).toBe(input.replace(/\n\n/g, ''));
    expect(chunks.every((chunk) => chunk.charEnd > chunk.charStart)).toBe(true);
  });

  it('returns no chunks for blank input', () => {
    expect(chunkDocument('  \n ')).toEqual([]);
  });
});
describe('hybrid retrieval math', () => {
  it('uses the configured weighted objective', () => {
    expect(combinedScore(0.8, 0.5, 0.25, 0.4)).toBeCloseTo(0.735);
  });

  it('keeps missing effective dates neutral', () => {
    expect(freshnessScore(undefined, 730)).toBe(0.5);
  });

  it('calculates title coverage from normalized query tokens', () => {
    expect(tokenize('防爆电气设备采购').length).toBeGreaterThan(2);
    expect(titleCoverage('防爆电气设备采购', ['防爆电气设备采购规范'])).toBeGreaterThan(0.7);
  });
});

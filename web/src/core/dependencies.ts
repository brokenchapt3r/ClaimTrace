import type { ClaimDependency } from './types';

function findCycle(nodes: string[], edges: ClaimDependency[]) {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: ClaimDependency[] = [];

  const visit = (node: string): ClaimDependency[] | undefined => {
    if (visiting.has(node)) {
      const start = path.findIndex((edge) => edge.from === node);
      return path.slice(Math.max(0, start));
    }
    if (visited.has(node)) return undefined;
    visiting.add(node);
    for (const edge of edges.filter((candidate) => candidate.from === node)) {
      path.push(edge);
      const cycle = visit(edge.to);
      if (cycle) return cycle;
      path.pop();
    }
    visiting.delete(node);
    visited.add(node);
    return undefined;
  };

  for (const node of nodes) {
    const cycle = visit(node);
    if (cycle?.length) return cycle;
  }
  return undefined;
}
export function makeAcyclic(nodes: string[], input: ClaimDependency[]) {
  const edges = input
    .filter((edge) => edge.from !== edge.to && nodes.includes(edge.from) && nodes.includes(edge.to))
    .map((edge) => ({ ...edge, confidence: Math.max(0, Math.min(1, edge.confidence)) }));

  for (;;) {
    const cycle = findCycle(nodes, edges);
    if (!cycle) return edges;
    const weakest = cycle.reduce((selected, edge) =>
      edge.confidence < selected.confidence ? edge : selected,
    );
    const index = edges.indexOf(weakest);
    if (index >= 0) edges.splice(index, 1);
  }
}

export function topologicalOrder(nodes: string[], edges: ClaimDependency[]) {
  const indegree = Object.fromEntries(nodes.map((node) => [node, 0]));
  edges.forEach((edge) => {
    indegree[edge.to] = (indegree[edge.to] || 0) + 1;
  });
  const queue = nodes.filter((node) => indegree[node] === 0);
  const ordered: string[] = [];
  while (queue.length) {
    const node = queue.shift();
    if (!node) break;
    ordered.push(node);
    edges
      .filter((edge) => edge.from === node)
      .forEach((edge) => {
        indegree[edge.to] -= 1;
        if (indegree[edge.to] === 0) queue.push(edge.to);
      });
  }
  return ordered.length === nodes.length ? ordered : nodes;
}

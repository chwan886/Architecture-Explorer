import { stableId, type ArchitectureIndex, type ArchitectureNode, type ArchitectureEdge, type EdgeKind, type Confidence, type GraphResult } from '../../schema/src/index.ts';

interface Lookup {
  nodes: Map<string, ArchitectureNode>;
  children: Map<string, ArchitectureNode[]>;
  incoming: Map<string, ArchitectureEdge[]>;
  outgoing: Map<string, ArchitectureEdge[]>;
  rootId?: string;
}
const lookups = new WeakMap<ArchitectureIndex, Lookup>();
function lookup(index: ArchitectureIndex): Lookup {
  const cached = lookups.get(index); if (cached) return cached;
  const result: Lookup = { nodes: new Map(index.nodes.map(node => [node.id, node])), children: new Map(), incoming: new Map(), outgoing: new Map(),
    rootId: index.nodes.find(node => node.kind === 'project')?.id };
  for (const node of index.nodes) {
    if (!node.parentId) continue;
    const siblings = result.children.get(node.parentId) ?? []; siblings.push(node); result.children.set(node.parentId, siblings);
  }
  for (const edge of index.edges) {
    const incoming = result.incoming.get(edge.target) ?? []; incoming.push(edge); result.incoming.set(edge.target, incoming);
    const outgoing = result.outgoing.get(edge.source) ?? []; outgoing.push(edge); result.outgoing.set(edge.source, outgoing);
  }
  lookups.set(index, result); return result;
}

export interface GraphOptions {
  rootId?: string; view?: 'architecture' | 'calls' | 'data' | 'impact';
  direction?: 'both' | 'up' | 'down'; depth?: number; limit?: number;
  kinds?: EdgeKind[]; confidence?: Confidence[];
}
function allowed(edge: ArchitectureEdge, options: GraphOptions): boolean {
  return (!options.kinds?.length || options.kinds.includes(edge.kind)) && (!options.confidence?.length || options.confidence.includes(edge.confidence));
}
const rank: Record<Confidence, number> = { 'static-confirmed': 0, 'runtime-verified': 0, inferred: 1 };

export function graph(index: ArchitectureIndex, options: GraphOptions = {}): GraphResult {
  const store = lookup(index); const rootId = options.rootId ?? store.rootId;
  if (!rootId || !store.nodes.has(rootId)) throw Object.assign(new Error('图节点不属于当前索引'), { statusCode: 404 });
  const limit = Math.max(1, Math.min(options.limit ?? 80, 200));
  const view = options.view ?? 'architecture';
  if (view === 'architecture') {
    const candidates = store.children.get(rootId) ?? [];
    const nodes = candidates.slice(0, limit);
    const visible = new Set(nodes.map(node => node.id));
    const owner = new Map<string, string | undefined>();
    const visibleOwner = (id: string): string | undefined => {
      if (owner.has(id)) return owner.get(id);
      let current: string | undefined = id; const traversed: string[] = []; const seen = new Set<string>();
      while (current && !seen.has(current)) {
        seen.add(current); traversed.push(current);
        if (visible.has(current)) { for (const item of traversed) owner.set(item, current); return current; }
        if (owner.has(current)) { const value = owner.get(current); for (const item of traversed) owner.set(item, value); return value; }
        current = store.nodes.get(current)?.parentId;
      }
      for (const item of traversed) owner.set(item, undefined);
      return undefined;
    };
    const edges = new Map<string, ArchitectureEdge>();
    for (const edge of index.edges) {
      if (edge.kind === 'contains' || !allowed(edge, options)) continue;
      const source = visibleOwner(edge.source); const target = visibleOwner(edge.target);
      if (!source || !target || source === target) continue;
      if (source === edge.source && target === edge.target) { edges.set(edge.id, edge); continue; }
      const id = stableId(index.metadata.scopeId, 'aggregate', `${rootId}|${source}|${target}|${edge.kind}|${edge.confidence}`);
      const existing = edges.get(id);
      if (existing) {
        existing.evidenceIds = [...new Set([...existing.evidenceIds, ...edge.evidenceIds])];
        if (rank[edge.confidence] > rank[existing.confidence]) existing.confidence = edge.confidence;
        existing.limitations = [...new Set([...(existing.limitations ?? []), ...(edge.limitations ?? [])])];
      } else edges.set(id, { ...edge, id, source, target, condition: undefined, dispatch: undefined, evidenceIds: [...edge.evidenceIds],
        rule: `aggregate:${edge.kind}:源关系按可见祖先聚合；不表示模块内任意符号之间均存在关系`,
        limitations: [...new Set(['此线聚合了具有源码证据的下级关系，请进入模块查看具体端点、条件分支与分发方式。', ...(edge.limitations ?? [])])] });
    }
    return { nodes, edges: [...edges.values()], rootId, totalNodes: candidates.length, truncated: candidates.length > nodes.length, revision: index.metadata.revision };
  }
  const kinds: EdgeKind[] = view === 'calls' ? ['calls'] : view === 'data' ? ['reads', 'writes', 'initializes', 'passes', 'returns']
    : ['calls', 'references', 'imports', 'inherits', 'implements', 'reads', 'writes', 'initializes', 'passes', 'returns', 'subscribes', 'publishes', 'contract-mapping'];
  const direction = options.direction ?? (view === 'impact' ? 'up' : 'both');
  const depth = Math.max(1, Math.min(options.depth ?? 1, 5));
  const included = new Set<string>([rootId]); const selectedEdges = new Map<string, ArchitectureEdge>();
  let frontier = [rootId]; let truncated = false; const discovered = new Set<string>([rootId]);
  for (let level = 0; level < depth && frontier.length; level++) {
    const next: string[] = [];
    for (const id of frontier) {
      const neighbors = [...(direction !== 'down' ? store.incoming.get(id) ?? [] : []), ...(direction !== 'up' ? store.outgoing.get(id) ?? [] : [])];
      for (const edge of neighbors) {
        if (!kinds.includes(edge.kind) || !allowed(edge, options)) continue;
        const other = edge.source === id ? edge.target : edge.source;
        discovered.add(other);
        if (!included.has(other)) {
          if (included.size >= limit) { truncated = true; continue; }
          included.add(other); next.push(other);
        }
        selectedEdges.set(edge.id, edge);
      }
    }
    frontier = next;
  }
  // Preserve original direction and evidence. Impact reachability is only a review candidate.
  return { nodes: [...included].map(id => store.nodes.get(id)!), edges: [...selectedEdges.values()], rootId,
    totalNodes: discovered.size, truncated, revision: index.metadata.revision };
}

export function search(index: ArchitectureIndex, query: string, limit = 40): { nodes: ArchitectureNode[]; revision: string } {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return { nodes: [], revision: index.metadata.revision };
  const matches = index.nodes.map(node => {
    const label = node.label.toLocaleLowerCase(); const qualified = node.qualifiedName.toLocaleLowerCase();
    const score = label === normalized ? 0 : label.startsWith(normalized) ? 1 : label.includes(normalized) ? 2 : qualified.includes(normalized) ? 3 : node.filePath?.toLocaleLowerCase().includes(normalized) ? 4 : 10;
    return { node, score };
  }).filter(item => item.score < 10).sort((a, b) => a.score - b.score || a.node.qualifiedName.localeCompare(b.node.qualifiedName));
  return { nodes: matches.slice(0, Math.max(1, Math.min(limit, 100))).map(item => item.node), revision: index.metadata.revision };
}

export function nodeDetail(index: ArchitectureIndex, nodeId: string) {
  const store = lookup(index); const node = store.nodes.get(nodeId);
  if (!node) throw Object.assign(new Error('节点不存在于当前作用域'), { statusCode: 404 });
  const parents: ArchitectureNode[] = []; let parentId = node.parentId; const seen = new Set<string>([node.id]);
  while (parentId && !seen.has(parentId) && parents.length < 20) {
    seen.add(parentId); const parent = store.nodes.get(parentId); if (!parent) break;
    parents.unshift(parent); parentId = parent.parentId;
  }
  const allIncoming = store.incoming.get(nodeId) ?? []; const allOutgoing = store.outgoing.get(nodeId) ?? [];
  const incoming = allIncoming.filter(edge => edge.kind !== 'contains').slice(0, 150);
  const outgoing = allOutgoing.filter(edge => edge.kind !== 'contains').slice(0, 150);
  const relatedIds = new Set([...incoming.map(edge => edge.source), ...outgoing.map(edge => edge.target)]);
  const evidenceIds = new Set([...node.evidenceIds, ...incoming.flatMap(edge => edge.evidenceIds), ...outgoing.flatMap(edge => edge.evidenceIds)]);
  return { node, parents, incoming, outgoing, relatedNodes: [...relatedIds].map(id => store.nodes.get(id)!).filter(Boolean),
    evidence: index.evidence.filter(item => evidenceIds.has(item.id)).slice(0, 200), revision: index.metadata.revision,
    truncated: allIncoming.filter(edge => edge.kind !== 'contains').length > incoming.length || allOutgoing.filter(edge => edge.kind !== 'contains').length > outgoing.length };
}

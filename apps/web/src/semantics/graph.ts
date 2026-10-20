import type { ResolvedSemanticFlow, SemanticEdge, SemanticNode } from '../../../../packages/semantic-model/src/types';

const shortRelationLabels = { 'direct-call': '调用', 'indirect-call': '间接', dependency: '依赖', 'data-access': '读写', event: '事件', 'source-order': '顺序', protocol: '协议', 'request-boundary': '请求', related: '关联' };
export function semanticEdgeShortLabel(edge: SemanticEdge): string { return shortRelationLabels[edge.kinds[0]] || '关联'; }

// Cross-granularity edges are deliberately omitted rather than invented by
// reconnecting a detail endpoint to its parent summary. All originals remain in
// the Inspector, with the hidden count exposed beside the canvas.
export function visibleSemanticGraph(flow: ResolvedSemanticFlow, expanded: ReadonlySet<string>) {
  const nodes: SemanticNode[] = [];
  for (const group of flow.summaryNodes) {
    if (expanded.has(group.id)) nodes.push(...flow.detailNodes.filter(node => group.childIds.includes(node.id)));
    else nodes.push(group);
  }
  const ids = new Set(nodes.map(node => node.id));
  const edges = [...flow.summaryEdges, ...flow.detailEdges].filter(edge => ids.has(edge.source) && ids.has(edge.target));
  return { nodes, edges, hiddenEdges: flow.summaryEdges.length + flow.detailEdges.length - edges.length };
}

export function visibleSemanticMatches(flow: ResolvedSemanticFlow, ids: string[], visibleIds: ReadonlySet<string>) {
  const found = new Set<string>();
  for (const id of ids) {
    if (visibleIds.has(id)) found.add(id);
    const node = flow.detailNodes.find(item => item.id === id);
    if (node?.parentId && visibleIds.has(node.parentId)) found.add(node.parentId);
    const group = flow.summaryNodes.find(item => item.id === id);
    group?.childIds.forEach(child => { if (visibleIds.has(child)) found.add(child); });
  }
  return found;
}

export function codeMapping(flow: ResolvedSemanticFlow, node?: SemanticNode, edge?: SemanticEdge) {
  const nodeIds = new Set(node?.codeNodeIds || []);
  const edgeIds = new Set(edge?.codeEdgeIds || []);
  edge?.paths.forEach(path => { path.nodeIds.forEach(id => nodeIds.add(id)); path.edgeIds.forEach(id => edgeIds.add(id)); });
  for (const id of edgeIds) {
    const fact = flow.codeEdges.find(item => item.id === id);
    if (fact) { nodeIds.add(fact.source); nodeIds.add(fact.target); }
  }
  return { nodeIds, edgeIds };
}

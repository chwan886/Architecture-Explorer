import assert from 'node:assert/strict';
import { IndexManager, loadConfig } from '../packages/indexer/src/index.ts';
import { ArchitectureService } from '../apps/server/src/architecture.ts';
import { SemanticService } from '../apps/server/src/semantics.ts';

// Reads existing authorized snapshots and source only; never builds/runs the
// analyzed project. Derived cache stays within the tool's own cache directory.
const manager = new IndexManager(await loadConfig());
await manager.initialize();
try {
  const service = new SemanticService(manager, new ArchitectureService(manager));
  const results = [];
  for (const scope of manager.scopes.values()) {
    assert.ok(scope.index, `先为 ${scope.id} 建立源码索引`);
    const { index, projection } = await service.current(scope);
    const nodes = new Set(index.nodes.map(node => node.id)), edges = new Map(index.edges.map(edge => [edge.id, edge]));
    for (const flow of projection.flows) {
      for (const node of flow.detailNodes) { assert.ok(node.codeNodeIds.length, `${node.id} 缺少主实现`); for (const id of node.codeNodeIds) assert.ok(nodes.has(id)); }
      for (const edge of [...flow.detailEdges, ...flow.summaryEdges]) {
        for (const id of edge.codeEdgeIds) assert.ok(edges.has(id));
        for (const item of edge.paths) {
          assert.equal(item.nodeIds.length, item.edgeIds.length + 1);
          item.edgeIds.forEach((id, i) => { assert.equal(edges.get(id)?.source, item.nodeIds[i]); assert.equal(edges.get(id)?.target, item.nodeIds[i + 1]); });
        }
      }
      const sourceFlow = projection.flows.find(item => item.id === flow.id)!;
      results.push({ scopeId: scope.id, sourceRevision: projection.metadata.sourceRevision, flow: flow.id,
        groups: flow.summaryNodes.length, steps: flow.detailNodes.length, currentSteps: flow.detailNodes.filter(node => node.status === 'current').length,
        codeEntities: flow.codeNodes.length, codeRelations: flow.codeEdges.length, verifiedCalls: flow.detailEdges.filter(edge => edge.verification === 'static-confirmed').length,
        unverifiedRelations: sourceFlow.detailEdges.filter(edge => edge.verification === 'unverified').length,
        controls: flow.detailNodes.flatMap(node => node.controls).length,
        multiStepEntities: Object.values(flow.reverseNodes).filter(ids => ids.length > 1).length,
        diagnostics: flow.diagnostics.map(item => ({ code: item.code, targetId: item.targetId, message: item.message })) });
    }
  }
  console.log(JSON.stringify({ verified: true, results }, null, 2));
} finally { await manager.close(); }

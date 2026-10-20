import test from 'node:test';
import assert from 'node:assert/strict';
import { ExplorerTools } from '../apps/mcp/src/tools.ts';
import type { AnalysisPresentation, SnapshotDescriptor } from '../packages/control-protocol/src/types.ts';
import type { SemanticBundle } from '../packages/semantic-model/src/types.ts';

const snapshot: SnapshotDescriptor = { snapshotId: 'snapshot-1', projectId: 'project', worktreeId: 'primary', scopeId: 'project:primary', indexSnapshotId: 'index-1', architectureRevision: 'model-1', semanticViewRevision: 'semantic-1', expiresAt: new Date(Date.now() + 600000).toISOString(), indexState: 'synced' };
test('MCP tool arguments are strict and expose no URL, path, command or mutation capability', async () => {
  let requests = 0;
  const tools = new ExplorerTools({ query: async () => { requests++; return snapshot; }, control: async () => { requests++; return {}; } });
  assert.ok(tools.definitions.length >= 20);
  for (const args of [{ snapshotId: 's', evidenceId: 'e', filePath: 'E:/secret' }, { snapshotId: 's', evidenceId: 'e', url: 'http://evil' }]) {
    const result = await tools.call('get_source_evidence', args); assert.equal(result.isError, true);
  }
  assert.equal((await tools.call('run_shell', { command: 'anything' })).isError, true);
  assert.equal((await tools.call('search_architecture', { snapshotId: 's', query: 's', limit: 100000 })).isError, true);
  assert.equal(requests, 0);
});

test('MCP convenience tools preserve snapshot/flow, require explicit CAS, and never upgrade a pending receipt', async () => {
  const submissions: Record<string, unknown>[] = [];
  const tools = new ExplorerTools({ query: async () => snapshot, control: async (operation, args) => { assert.equal(operation, 'submit'); submissions.push(args); return { commandId: 'c', presentationId: (args.presentation as AnalysisPresentation).presentationId, status: 'pending' }; } });
  await tools.invoke('begin_analysis', { projectId: 'project', worktreeId: 'primary' });
  await assert.rejects(tools.invoke('show_flow', { snapshotId: 'snapshot-1', flowId: 'f', bindingId: 'b' }), /需要明确/);
  const first = await tools.invoke('show_flow', { snapshotId: 'snapshot-1', flowId: 'f', bindingId: 'b', expectedUserRevision: 2, expectedControlRevision: 3 }) as { presentationId: string; status: string };
  assert.equal(first.status, 'pending');
  await tools.invoke('set_view_mode', { basePresentationId: first.presentationId, bindingId: 'b', expectedUserRevision: 2, expectedControlRevision: 4, viewMode: 'compare', semanticGranularity: 'detailed' });
  const second = submissions[1].presentation as AnalysisPresentation;
  assert.equal(second.snapshotId, snapshot.snapshotId); assert.equal(second.indexSnapshotId, snapshot.indexSnapshotId);
  assert.equal(second.flowId, 'f'); assert.equal(second.viewMode, 'compare'); assert.equal(second.semanticGranularity, 'detailed');
  assert.deepEqual(second.orderedSteps, [], 'convenience tools cannot invent execution steps');
  assert.equal(submissions[1].expectedUserRevision, 2, 'versions must come from the caller, never silently refresh');
  assert.equal(submissions[1].expectedControlRevision, 4);
  await tools.invoke('open_architecture', { snapshotId: 'snapshot-1', targetView: 'systems' });
  const system = submissions[2].presentation as AnalysisPresentation;
  await assert.rejects(tools.invoke('set_view_mode', { basePresentationId: system.presentationId, bindingId: 'b', expectedUserRevision: 2, expectedControlRevision: 5, viewMode: 'explanation', semanticGranularity: 'detailed' }), /不支持语义粒度/);
});

test('view switching projects many-to-many focus through the same real flow and refuses unmapped semantics', async () => {
  const submissions: AnalysisPresentation[] = [];
  const bundle = { flow: { id: 'f', summaryNodes: [{ id: 'group', level: 'summary', codeNodeIds: ['a', 'b'], childIds: ['step', 'other'] }], detailNodes: [{ id: 'step', parentId: 'group', level: 'detail', codeNodeIds: ['a', 'b'] }, { id: 'other', parentId: 'group', level: 'detail', codeNodeIds: ['a'] }], summaryEdges: [], detailEdges: [], reverseNodes: { a: ['step', 'other'], b: ['step'] }, reverseEdges: {} } } as unknown as SemanticBundle;
  const tools = new ExplorerTools({ query: async operation => operation === 'get_flow' ? { bundle } : snapshot, control: async (_operation, args) => { const p = args.presentation as AnalysisPresentation; submissions.push(p); return { presentationId: p.presentationId, status: 'pending' }; } });
  await tools.invoke('begin_analysis', { projectId: 'project', worktreeId: 'primary' });
  await tools.invoke('show_flow', { snapshotId: 'snapshot-1', flowId: 'f', focusNodeId: { layer: 'semantic', flowId: 'f', id: 'other' }, highlightedNodeIds: [{ layer: 'semantic', flowId: 'f', id: 'step' }] });
  const base = submissions[0];
  await tools.invoke('set_view_mode', { basePresentationId: base.presentationId, bindingId: 'b', expectedUserRevision: 0, expectedControlRevision: 1, viewMode: 'code' });
  assert.deepEqual(submissions[1].highlightedNodeIds.map(ref => ref.id), ['a', 'b']);
  assert.equal(submissions[1].focusNodeId?.id, 'a');
  await tools.invoke('set_view_mode', { basePresentationId: submissions[1].presentationId, bindingId: 'b', expectedUserRevision: 0, expectedControlRevision: 2, viewMode: 'explanation', semanticGranularity: 'detailed' });
  assert.deepEqual(new Set(submissions[2].highlightedNodeIds.map(ref => ref.id)), new Set(['step', 'other']));
  assert.equal(submissions[2].focusNodeId?.id, 'other', 'many-to-many reverse order must not replace the originally selected later step');
  assert.equal(submissions[2].snapshotId, snapshot.snapshotId);
  await tools.invoke('set_view_mode', { basePresentationId: submissions[2].presentationId, bindingId: 'b', expectedUserRevision: 0, expectedControlRevision: 3, viewMode: 'explanation', semanticGranularity: 'simple' });
  assert.equal(submissions[3].focusNodeId?.id, 'group');
  await tools.invoke('set_view_mode', { basePresentationId: submissions[3].presentationId, bindingId: 'b', expectedUserRevision: 0, expectedControlRevision: 4, viewMode: 'explanation', semanticGranularity: 'detailed' });
  assert.equal(submissions[4].focusNodeId?.id, 'other', 'collapsing a group must retain the original detailed focus for re-expansion');
  await tools.invoke('focus_node', { basePresentationId: base.presentationId, bindingId: 'b', expectedUserRevision: 0, expectedControlRevision: 3, ref: { layer: 'code', id: 'unmapped' } });
  await assert.rejects(tools.invoke('set_view_mode', { basePresentationId: submissions[5].presentationId, bindingId: 'b', expectedUserRevision: 0, expectedControlRevision: 4, viewMode: 'explanation' }), /没有当前粒度/);
});

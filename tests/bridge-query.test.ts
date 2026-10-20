import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { IndexManager, loadConfig, TOOL_ROOT } from '../packages/indexer/src/index.ts';
import { runWorker } from '../packages/indexer/src/workers.ts';
import { declarationHash } from '../packages/semantic-model/src/index.ts';
import type { SemanticDefinitions } from '../packages/semantic-model/src/types.ts';
import type { ArchitectureModel } from '../packages/architecture-model/src/types.ts';
import { validatePresentation } from '../packages/control-protocol/src/index.ts';
import type { AnalysisPresentation, EntityRef, SnapshotDescriptor } from '../packages/control-protocol/src/types.ts';
import { ArchitectureService } from '../apps/server/src/architecture.ts';
import { SemanticService } from '../apps/server/src/semantics.ts';
import { BridgeQueryService } from '../apps/server/src/bridge-query.ts';

const source = 'def entry(value):\n    return middle(value)\n\ndef middle(value):\n    return finish(value)\n\ndef finish(value):\n    return value\n\ndef orphan(value):\n    return value + 100\n';
const text = (title: string) => ({ title, summary: title, purpose: title, detail: title, inputs: [], processing: [], outputs: [], changes: [] });
const clone = <T>(value: T): T => structuredClone(value);
const errorCode = (code: string) => (error: unknown) => (error as { code: string }).code === code;
async function fixture(content = source) {
  const parent = path.join(TOOL_ROOT, '.tmp'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'bridge-query-')), tool = path.join(directory, 'tool'), target = path.join(directory, 'target'), feature = path.join(directory, 'feature');
  await mkdir(tool);
  for (const root of [target, feature]) { await mkdir(path.join(root, 'src'), { recursive: true }); await writeFile(path.join(root, 'src/actions.py'), content); }
  await writeFile(path.join(target, 'secret.py'), 'outside_policy = True\n');
  const configPath = path.join(directory, 'projects.json');
  await writeFile(configPath, JSON.stringify({ projects: [{ id: 'bridge-fixture', name: 'Bridge fixture', root: './target', worktrees: ['./feature'], include: ['src'], exclude: [] }], cacheDir: './tool/cache', port: 4310 }));
  const config = { ...await loadConfig(configPath), toolRoot: tool };
  const manager = new IndexManager(config, { worker: (language, request, settings) => runWorker(language, request, { ...settings, toolRoot: TOOL_ROOT }) });
  await manager.initialize(); for (const scope of manager.scopes.values()) await manager.requestScan(scope.id);
  const primary = manager.scope('bridge-fixture:primary'), index = primary.index!; assert.ok(index, JSON.stringify(primary.status));
  const node = (name: string) => index.nodes.find(node => node.qualifiedName === 'src.actions.' + name)!;
  const names = ['entry', 'middle', 'finish'];
  const architecture: ArchitectureModel = { schemaVersion: '1.0.0', projectId: 'bridge-fixture', name: 'Architecture fixture',
    systems: ['left', 'right'].map(id => ({ id, name: id, responsibility: id, features: [], inputs: [], outputs: [], keyData: [], kind: 'business', anchorIds: [] })),
    modules: ['left', 'right'].map(id => ({ id: id + '-module', systemId: id, name: id, responsibility: id, inputs: [], outputs: [], anchorIds: [] })),
    memberships: names.map((name, i) => ({ id: 'owner-' + name, systemId: i ? 'right' : 'left', moduleId: (i ? 'right' : 'left') + '-module', role: 'owner', origin: 'curated', selector: { qualifiedName: node(name).qualifiedName }, anchorIds: [] })),
    anchors: [], reviews: [], flows: [{ id: 'source-action', name: 'Source action', description: 'Actual Python calls', trigger: 'Call entry', systemIds: ['left', 'right'], lanes: [{ id: 'python', name: 'Python' }],
      steps: names.map((name, phase) => ({ id: 'source-' + name, laneId: 'python', phase, name, description: name, selector: { qualifiedName: node(name).qualifiedName }, anchorIds: [], reads: [], writes: [] })),
      transitions: [{ id: 'first-call', source: 'source-entry', target: 'source-middle', basis: 'static-call', anchorIds: [], limitations: [] }, { id: 'second-call', source: 'source-middle', target: 'source-finish', basis: 'static-call', anchorIds: [], limitations: [] }], limitations: [] }] };
  const definitions: SemanticDefinitions = { schemaVersion: '1.0.0', projectId: 'bridge-fixture', flows: ['semantic-action', 'second-interpretation'].map(id => ({ id, sourceFlowId: 'source-action', title: id, description: 'Two interpretations share code and detail IDs',
    groups: [{ id: 'intent-group', ...text('Intent'), childIds: ['entry-step'], origin: 'curated' }, { id: 'finish-group', ...text('Finish'), childIds: ['middle-step', 'finish-step'], origin: 'curated' }],
    steps: names.map(name => ({ id: name + '-step', ...text(name), sourceStepIds: ['source-' + name], bindings: [{ id: 'binding-' + name, sourceStepId: 'source-' + name, role: 'implementation', anchorIds: [], expectedDeclarationHash: declarationHash(index, node(name).id, { 'src/actions.py': content }) }], controls: [], origin: 'curated' })) })) };
  const modelPath = path.join(tool, 'architecture/models/bridge-fixture/model.json'), definitionPath = path.join(tool, 'architecture/semantics/bridge-fixture/definitions.json');
  await mkdir(path.dirname(modelPath), { recursive: true }); await writeFile(modelPath, JSON.stringify(architecture));
  await mkdir(path.dirname(definitionPath), { recursive: true }); await writeFile(definitionPath, JSON.stringify(definitions));
  const architectureService = new ArchitectureService(manager), semanticService = new SemanticService(manager, architectureService), query = new BridgeQueryService(manager, architectureService, semanticService);
  const begin = (worktreeId = 'primary') => query.dispatch('begin_analysis', { projectId: 'bridge-fixture', worktreeId }) as Promise<SnapshotDescriptor>;
  const presentation = (snapshot: SnapshotDescriptor): AnalysisPresentation => ({ schemaVersion: '1.0', presentationId: 'presentation-1', projectId: snapshot.projectId, worktreeId: snapshot.worktreeId, indexSnapshotId: snapshot.indexSnapshotId, snapshotId: snapshot.snapshotId,
    title: '真实代码查询', summary: '静态代码事实与阅读说明', targetView: 'code', viewMode: 'code', semanticGranularity: 'simple', focusNodeId: { layer: 'code', id: node('entry').id }, highlightedNodeIds: [], highlightedEdgeIds: [], orderedSteps: [], evidenceIds: [], warnings: [], createdAt: new Date().toISOString() });
  const close = async () => { await manager.close(); assert.ok(directory.startsWith(path.join(TOOL_ROOT, '.tmp', 'bridge-query-'))); await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); };
  return { directory, target, tool, config, manager, primary, index, node, architecture, definitions, modelPath, definitionPath, architectureService, semanticService, query, begin, presentation, close };
}

test('presentation protocol rejects unknown fields, ambiguous semantic refs and invented path order', async () => {
  const f = await fixture(); try {
    const snapshot = await f.begin(), value = f.presentation(snapshot); validatePresentation(value);
    assert.throws(() => validatePresentation({ ...value, filePath: 'C:/secret' }), errorCode('INVALID_PRESENTATION'));
    const semantic = clone(value); semantic.focusNodeId = { layer: 'semantic', id: 'entry-step' }; assert.throws(() => validatePresentation(semantic), errorCode('INVALID_PRESENTATION'));
    const step = { id: 'read', name: 'Read', codeNodeIds: [], codeEdgeIds: [], inputs: [], outputs: [], evidenceIds: [], verification: 'unverified' as const, orderBasis: 'call-path' as const };
    assert.throws(() => validatePresentation({ ...value, orderedSteps: [step] }), errorCode('INVALID_PRESENTATION'));
    assert.throws(() => validatePresentation({ ...value, createdAt: 'never' }), errorCode('INVALID_PRESENTATION'));
  } finally { await f.close(); }
});

test('unified query captures one current snapshot and resolves code, logical architecture and flow-scoped semantics', async () => {
  const f = await fixture(); try {
    const capabilities = await f.query.dispatch('get_capabilities', {}) as { runtimeCollector: boolean }; assert.equal(capabilities.runtimeCollector, false);
    const modes = await f.query.dispatch('get_capabilities', {}) as { supportedPresentationTargets: Record<string, string[]>; uiControl: { successRequiresPresentedReceipt: boolean } }; assert.deepEqual(modes.supportedPresentationTargets.code, ['code']); assert.equal(modes.uiControl.successRequiresPresentedReceipt, true);
    assert.equal((await f.query.dispatch('list_projects', {}) as { projects: unknown[] }).projects.length, 1);
    const worktrees = (await f.query.dispatch('list_worktrees', { projectId: 'bridge-fixture' }) as { worktrees: { authorized: boolean; scopeId: string; path: string }[] }).worktrees;
    assert.equal(worktrees.length, f.manager.scopes.size); assert.ok(worktrees.every(worktree => worktree.authorized && f.manager.scopes.has(worktree.scopeId)));
    assert.ok(worktrees.every(worktree => path.resolve(worktree.path) === path.resolve(f.target) || path.resolve(worktree.path) === path.resolve(f.directory, 'feature')), 'registered but unauthorized repository paths must not be returned by MCP');
    const snapshot = await f.begin(); assert.equal(snapshot.indexSnapshotId, f.index.metadata.revision);
    await assert.rejects(f.query.dispatch('begin_analysis', { projectId: 'unconfigured', worktreeId: 'primary' }), errorCode('UNAUTHORIZED_SCOPE'));
    await assert.rejects(f.query.dispatch('get_flow', { snapshotId: snapshot.snapshotId, flowId: 'invented' }), errorCode('UNKNOWN_FLOW'));
    const search = await f.query.dispatch('search_architecture', { snapshotId: snapshot.snapshotId, query: 'entry' }) as { metadata: SnapshotDescriptor; matches: { ref: EntityRef }[] };
    assert.equal(search.metadata.snapshotId, snapshot.snapshotId); assert.ok(search.matches.some(match => match.ref.layer === 'semantic' && match.ref.flowId === 'semantic-action'));
    const detail = await f.query.dispatch('get_node_details', { snapshotId: snapshot.snapshotId, ref: { layer: 'architecture', id: 'left' } }) as { detail: { entity: { id: string } } }; assert.equal(detail.detail.entity.id, 'left');
    const node = await f.query.dispatch('get_node_details', { snapshotId: snapshot.snapshotId, ref: { layer: 'semantic', flowId: 'second-interpretation', id: 'entry-step' } }) as { detail: { node: { id: string } } }; assert.equal(node.detail.node.id, 'entry-step');
    await assert.rejects(f.query.dispatch('get_node_details', { snapshotId: snapshot.snapshotId, ref: { layer: 'semantic', id: 'entry-step' } }), errorCode('INVALID_REFERENCE'));
    await assert.rejects(f.query.dispatch('get_node_details', { snapshotId: snapshot.snapshotId, ref: { layer: 'code', id: 'entry-step' } }), errorCode('UNKNOWN_REFERENCE'));
    const reverse = await f.query.dispatch('semantic_reverse', { snapshotId: snapshot.snapshotId, nodeId: f.node('entry').id }) as { matches: unknown[] }; assert.equal(reverse.matches.length, 2);
    await assert.rejects(f.query.dispatch('search_architecture', { snapshotId: snapshot.snapshotId, query: 'entry', path: '../secret.py' }), errorCode('INVALID_ARGUMENT'));
    await assert.rejects(f.query.dispatch('scan', { snapshotId: snapshot.snapshotId }), errorCode('UNSUPPORTED_OPERATION'));
  } finally { await f.close(); }
});

test('registered directed call paths preserve every raw hop and cannot be forged from BFS or another snapshot', async () => {
  const f = await fixture(); try {
    const snapshot = await f.begin(), paths = await f.query.dispatch('get_call_paths', { snapshotId: snapshot.snapshotId, sourceNodeId: f.node('entry').id, targetNodeId: f.node('finish').id }) as { paths: { id: string; nodeIds: string[]; edgeIds: string[]; verification: 'static-confirmed' }[] };
    assert.equal(paths.paths.length, 1); const path = paths.paths[0]; assert.equal(path.edgeIds.length, 2); assert.equal(path.verification, 'static-confirmed');
    for (let i = 0; i < path.edgeIds.length; i++) { const edge = f.index.edges.find(edge => edge.id === path.edgeIds[i])!; assert.equal(edge.kind, 'calls'); assert.equal(edge.source, path.nodeIds[i]); assert.equal(edge.target, path.nodeIds[i + 1]); }
    const value = f.presentation(snapshot); value.orderedSteps = [{ id: 'path-reading', name: '沿真实调用查看', codeNodeIds: path.nodeIds, codeEdgeIds: path.edgeIds, pathId: path.id, inputs: [], outputs: [], evidenceIds: [], verification: 'static-confirmed', orderBasis: 'call-path' }];
    const resolved = await f.query.resolve(value); assert.ok(path.nodeIds.every(id => resolved.codeGraph!.nodes.some(node => node.id === id))); assert.ok(path.edgeIds.every(id => resolved.codeGraph!.edges.some(edge => edge.id === id))); assert.deepEqual(new Set(resolved.codeGraph!.nodes.map(node => node.id)), new Set(path.nodeIds), 'explicit paths remain readable without incidental neighbor expansion'); assert.ok(resolved.warnings.length);
    const forged = clone(value); forged.orderedSteps[0].pathId = 'invented'; await assert.rejects(f.query.resolve(forged), errorCode('UNKNOWN_PATH'));
    const second = await f.begin(), cross = { ...clone(value), snapshotId: second.snapshotId }; await assert.rejects(f.query.resolve(cross), errorCode('UNKNOWN_PATH'));
    const backwards = await f.query.dispatch('get_call_paths', { snapshotId: snapshot.snapshotId, sourceNodeId: f.node('finish').id, targetNodeId: f.node('entry').id }) as { paths: unknown[] }; assert.equal(backwards.paths.length, 0);
  } finally { await f.close(); }
});

test('an unchanged scan invalidates old handles but new analysis rebuilds projections against the newly published index object', async () => {
  const f = await fixture(); try {
    const first = await f.begin(), previous = f.primary.index!;
    await f.manager.requestScan(f.primary.id);
    assert.notEqual(f.primary.index, previous); assert.equal(f.primary.index!.metadata.revision, first.indexSnapshotId);
    await assert.rejects(f.query.dispatch('get_node_details', { snapshotId: first.snapshotId, ref: { layer: 'code', id: f.node('entry').id } }), errorCode('STALE_SNAPSHOT'));
    const second = await f.begin(); assert.notEqual(second.snapshotId, first.snapshotId); assert.equal(second.indexSnapshotId, first.indexSnapshotId);
    assert.equal((await f.architectureService.current(f.primary)).index, f.primary.index);
    assert.equal((await f.semanticService.current(f.primary)).index, f.primary.index);
    const resolved = await f.query.resolve(f.presentation(second)); assert.ok(resolved.codeGraph?.nodes.some(node => node.id === f.node('entry').id));
  } finally { await f.close(); }
});

test('presentation targets retain logical IDs, reject hidden mixed layers, and support code with no predefined flow', async () => {
  const f = await fixture(); try {
    const snapshot = await f.begin(), value = f.presentation(snapshot); value.focusNodeId = { layer: 'code', id: f.node('orphan').id };
    const code = await f.query.resolve(value); assert.ok(code.codeGraph!.nodes.some(node => node.id === f.node('orphan').id)); assert.equal(code.semantic, undefined);
    const flow = { ...clone(value), targetView: 'flow' as const, viewMode: 'compare' as const, flowId: 'semantic-action' }; await assert.rejects(f.query.resolve(flow), errorCode('UNMAPPED_REFERENCE'));
    flow.focusNodeId = { layer: 'semantic', flowId: 'semantic-action', id: 'entry-step' };
    const semantic = await f.query.resolve(flow); assert.equal(semantic.semantic!.flow!.id, 'semantic-action'); assert.ok(semantic.highlights.codeNodeIds.includes(f.node('entry').id)); assert.equal(semantic.presentation.focusNodeId!.id, 'entry-step');
    await assert.rejects(f.query.resolve({ ...clone(flow), evidenceIds: [f.node('orphan').evidenceIds[0]] }), errorCode('UNMAPPED_REFERENCE'));
    flow.highlightedNodeIds = [{ layer: 'semantic', flowId: 'second-interpretation', id: 'entry-step' }]; await assert.rejects(f.query.resolve(flow), errorCode('UNSUPPORTED_PRESENTATION'));
    const systems = { ...f.presentation(snapshot), targetView: 'systems' as const, viewMode: 'explanation' as const, focusNodeId: { layer: 'architecture' as const, id: 'left' }, highlightedNodeIds: [{ layer: 'architecture' as const, id: 'right' }] };
    const rendered = await f.query.resolve(systems); assert.equal(rendered.presentation.focusNodeId!.id, 'left'); assert.ok(rendered.highlights.architectureNodeIds.every(id => rendered.architecture!.graph.nodes.some(node => node.id === id))); assert.ok(!rendered.highlights.architectureNodeIds.includes('left'));
    systems.focusNodeId.id = 'left-module'; await assert.rejects(f.query.resolve(systems), errorCode('UNPRESENTABLE_REFERENCE'));
    const mixed = f.presentation(snapshot); mixed.highlightedNodeIds = [{ layer: 'architecture', id: 'left' }]; await assert.rejects(f.query.resolve(mixed), errorCode('UNSUPPORTED_PRESENTATION'));
    const technical = { ...f.presentation(snapshot), targetView: 'technical' as const, viewMode: 'explanation' as const }; assert.ok((await f.query.resolve(technical)).architecture!.graph.nodes.some(node => node.id === f.node('entry').id));
    for (const viewMode of ['explanation', 'compare'] as const) await assert.rejects(f.query.resolve({ ...value, viewMode }), errorCode('UNSUPPORTED_PRESENTATION'));
    for (const viewMode of ['code', 'compare'] as const) await assert.rejects(f.query.resolve({ ...systems, viewMode }), errorCode('UNSUPPORTED_PRESENTATION'));
    await assert.rejects(f.query.resolve({ ...flow, viewMode: 'code', highlightedNodeIds: [] }), errorCode('UNSUPPORTED_PRESENTATION'));
  } finally { await f.close(); }
});

test('snapshots expire on source, model, semantic overlay, authorization or TTL changes and isolate Worktrees', async () => {
  const f = await fixture(); try {
    let snapshot = await f.begin(); const other = [...f.manager.scopes.values()].find(scope => scope.id !== f.primary.id)!; const otherSnapshot = await f.begin(other.worktree.id);
    await assert.rejects(f.query.dispatch('get_node_details', { snapshotId: otherSnapshot.snapshotId, ref: { layer: 'code', id: f.node('entry').id } }), errorCode('UNKNOWN_REFERENCE'));
    const originalIndex = f.primary.index!; f.primary.index = { ...originalIndex, metadata: { ...originalIndex.metadata, revision: 'new-index' } };
    await assert.rejects(f.query.dispatch('get_flow', { snapshotId: snapshot.snapshotId }), errorCode('STALE_SNAPSHOT')); f.primary.index = originalIndex;
    await writeFile(f.modelPath, JSON.stringify({ ...f.architecture, name: 'updated model' })); await assert.rejects(f.query.dispatch('get_flow', { snapshotId: snapshot.snapshotId }), errorCode('STALE_SNAPSHOT'));
    await writeFile(f.modelPath, '{invalid'); await assert.rejects(f.query.dispatch('get_flow', { snapshotId: snapshot.snapshotId }), errorCode('STALE_SNAPSHOT')); await writeFile(f.modelPath, JSON.stringify({ ...f.architecture, name: 'updated model' }));
    snapshot = await f.begin(); const saved = await f.semanticService.store.read('bridge-fixture', f.primary.id); await f.semanticService.store.save('bridge-fixture', f.primary.id, saved.overlayRevision, overlay => { overlay.reviews.push({ flowId: 'semantic-action', targetType: 'node', targetId: 'entry-step', fingerprint: 'a'.repeat(64), decision: 'rejected', reviewedAt: new Date().toISOString() }); return overlay; });
    await assert.rejects(f.query.dispatch('get_flow', { snapshotId: snapshot.snapshotId }), errorCode('STALE_SNAPSHOT'));
    snapshot = await f.begin(); const previousExclude = [...f.config.projects[0].exclude]; f.config.projects[0].exclude.push('src/**');
    await assert.rejects(f.query.dispatch('get_flow', { snapshotId: snapshot.snapshotId }), errorCode('STALE_SNAPSHOT')); f.config.projects[0].exclude = previousExclude;
    const now = Date.now; Date.now = () => Date.parse(snapshot.expiresAt) + 1;
    try { await assert.rejects(f.query.dispatch('get_flow', { snapshotId: snapshot.snapshotId }), errorCode('STALE_SNAPSHOT')); } finally { Date.now = now; }
    const first = await f.begin(); for (let i = 0; i < 16; i++) await f.begin(); await assert.rejects(f.query.dispatch('get_flow', { snapshotId: first.snapshotId }), errorCode('STALE_SNAPSHOT'));
  } finally { await f.close(); }
});

test('evidence is read from the pinned authorized fact, detects disk/model races and never delegates to latest-index evidence', async () => {
  const f = await fixture(); try {
    const snapshot = await f.begin(), proof = f.node('entry').evidenceIds[0];
    f.manager.evidence = async () => { throw new Error('query must never call latest-index evidence'); };
    const evidence = await f.query.dispatch('get_source_evidence', { snapshotId: snapshot.snapshotId, evidenceId: proof }) as { revision: string; content: string }; assert.equal(evidence.revision, snapshot.indexSnapshotId); assert.match(evidence.content, /def entry/);
    await assert.rejects(f.query.dispatch('get_source_evidence', { snapshotId: snapshot.snapshotId, evidenceId: '../secret.py' }), errorCode('UNKNOWN_EVIDENCE'));
    const read = f.semanticService.store.read.bind(f.semanticService.store); let reads = 0; const previous = f.primary.index!;
    f.semanticService.store.read = async (...args) => { const result = await read(...args); if (++reads === 2) f.primary.index = { ...previous, metadata: { ...previous.metadata, revision: 'race' } }; return result; };
    await assert.rejects(f.query.dispatch('get_source_evidence', { snapshotId: snapshot.snapshotId, evidenceId: proof }), errorCode('STALE_SNAPSHOT')); f.primary.index = previous; f.semanticService.store.read = read;
    await writeFile(path.join(f.target, 'src/actions.py'), source + '\n# unindexed change'); await assert.rejects(f.query.dispatch('get_source_evidence', { snapshotId: snapshot.snapshotId, evidenceId: proof }), errorCode('STALE_SNAPSHOT'));
  } finally { await f.close(); }
});

test('claims cannot upgrade inferred paths or fake source order; dense queries and explicit graphs enforce budgets', async () => {
  const wide = source.replace('    return middle(value)', Array.from({ length: 220 }, (_, i) => `    extra${i}(value)`).join('\n') + '\n    return middle(value)') + Array.from({ length: 220 }, (_, i) => `\ndef extra${i}(value):\n    return value\n`).join('');
  const f = await fixture(wide); try {
    const snapshot = await f.begin(), bounded = await f.query.dispatch('get_call_paths', { snapshotId: snapshot.snapshotId, sourceNodeId: f.node('entry').id, targetNodeId: f.node('finish').id }) as { paths: unknown[]; truncated: boolean }; assert.equal(bounded.truncated, true); assert.equal(bounded.paths.length, 0);
    const large = f.presentation(snapshot); large.highlightedNodeIds = f.index.nodes.filter(node => node.kind === 'function' && node.id !== f.node('entry').id).slice(0, 80).map(node => ({ layer: 'code' as const, id: node.id })); await assert.rejects(f.query.resolve(large), errorCode('PRESENTATION_TOO_LARGE'));
    const fake = f.presentation(snapshot); fake.orderedSteps = [{ id: 'fake', name: 'Unproven', codeNodeIds: [f.node('entry').id], codeEdgeIds: [], inputs: [], outputs: [], evidenceIds: [], verification: 'static-confirmed', orderBasis: 'reading-order' }]; await assert.rejects(f.query.resolve(fake), errorCode('UNSUPPORTED_CLAIM'));
    fake.orderedSteps[0].verification = 'source-supported'; fake.orderedSteps[0].orderBasis = 'source-supported'; fake.orderedSteps[0].evidenceIds = [f.node('entry').evidenceIds[0], f.node('finish').evidenceIds[0]]; await assert.rejects(f.query.resolve(fake), errorCode('UNSUPPORTED_CLAIM'));
    f.architecture.memberships[0].selector = { qualifiedNamePrefix: 'src.actions' }; await writeFile(f.modelPath, JSON.stringify(f.architecture));
    const searchSnapshot = await f.begin(), compact = await f.query.dispatch('search_architecture', { snapshotId: searchSnapshot.snapshotId, query: 'left', limit: 2 }) as { matches: { evidenceIds: string[]; evidenceCount: number; evidenceTruncated: boolean }[] };
    assert.ok(compact.matches.some(match => match.evidenceCount > 12 && match.evidenceTruncated));
    assert.ok(compact.matches.every(match => match.evidenceIds.length <= 12), 'search summaries must not flood MCP with thousands of system evidence IDs');
  } finally { await f.close(); }
  const inferred = await fixture(); try {
    // Explicit gold fact mutation exercises confidence propagation independently
    // of language-specific unresolved-call heuristics.
    const edge = inferred.index.edges.find(edge => edge.kind === 'calls' && edge.source === inferred.node('middle').id)!; edge.confidence = 'inferred';
    const snapshot = await inferred.begin(), paths = await inferred.query.dispatch('get_call_paths', { snapshotId: snapshot.snapshotId, sourceNodeId: inferred.node('entry').id, targetNodeId: inferred.node('finish').id }) as { paths: { id: string; nodeIds: string[]; edgeIds: string[]; verification: string }[] }; assert.equal(paths.paths[0].verification, 'inferred');
    const value = inferred.presentation(snapshot); value.orderedSteps = [{ id: 'bad-upgrade', name: 'Wrong confidence', codeNodeIds: paths.paths[0].nodeIds, codeEdgeIds: [paths.paths[0].edgeIds[0]], pathId: paths.paths[0].id, inputs: [], outputs: [], evidenceIds: [], verification: 'static-confirmed', orderBasis: 'call-path' }]; await assert.rejects(inferred.query.resolve(value), errorCode('UNSUPPORTED_CLAIM'));
  } finally { await inferred.close(); }
});

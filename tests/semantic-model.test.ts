import assert from 'node:assert/strict';
import test from 'node:test';
import { runWorker } from '../packages/indexer/src/workers.ts';
import { TOOL_ROOT, type LoadedConfig } from '../packages/indexer/src/config.ts';
import { contentHash, type ArchitectureIndex, type ArchitectureNode, type Evidence } from '../packages/schema/src/index.ts';
import type { ArchitectureModel } from '../packages/architecture-model/src/types.ts';
import { buildSemanticProjection, declarationHash, semanticBundle, semanticReverse, semanticReviewFingerprint, semanticRevision, validateDefinitions, validateOverlay } from '../packages/semantic-model/src/index.ts';
import type { SemanticDefinitions, SemanticOverlay, SemanticText } from '../packages/semantic-model/src/types.ts';

const original = 'def start(value):\n    return bridge(value)\n\ndef bridge(value):\n    return finish(value)\n\ndef finish(value):\n    return value\n\ndef neighbor(value):\n    return value + 1\n\ndef unicode():\n    return "😀中文"\n';
const clone = <T>(value: T): T => structuredClone(value);
const text = (id: string): SemanticText => ({ title: id, summary: '当前源码解释', purpose: '解释职责', detail: '保留真实证据', inputs: ['输入'], processing: ['处理'], outputs: ['输出'], changes: [] });
const rawCache = new Map<string, ReturnType<typeof runWorker>>();
const workerConfig: LoadedConfig = { toolRoot: TOOL_ROOT, projects: [], configPath: '', cacheDir: TOOL_ROOT + '/.tmp/semantic-model-tests', fingerprint: 'semantic-fixture' };
async function fixture(source = original, scope = 'semantic-fixture:primary') {
  const key = scope + '|' + source;
  let pending = rawCache.get(key); if (!pending) { pending = runWorker('python', { scopeId: scope, files: [{ path: 'src/flow.py', hash: contentHash(source), content: source }] }, workerConfig); rawCache.set(key, pending); }
  const raw = clone(await pending);
  const index: ArchitectureIndex = { ...raw, files: [{ path: 'src/flow.py', hash: contentHash(source), language: 'python', size: source.length }], flows: [], metadata: {
    schemaVersion: '1.0.0', analyzerVersion: '0.1.0', projectId: 'semantic-fixture', projectName: 'Semantic fixture', worktreeId: scope.split(':')[1], scopeId: scope, rootPath: 'C:/semantic-fixture', gitHead: 'head', gitBranch: 'main', gitDirty: false, gitStatusHash: '', generatedAt: '2026-10-20T12:00:00Z', configFingerprint: 'config', compilationFingerprint: 'compile', revision: contentHash(scope + source), fileCount: 1, durationMs: 1, changedFiles: 1, reusedFiles: 0, coverage: { languages: ['python'], limitations: [] } } };
  const node = (name: string) => index.nodes.find(node => node.qualifiedName === 'src.flow.' + name)!;
  const sourceTexts = { 'src/flow.py': source };
  const names = ['start', 'bridge', 'finish'];
  const anchors = names.map(name => ({ id: 'anchor-' + name, filePath: 'src/flow.py', startLine: source.split('\n').findIndex(line => line.startsWith('def ' + name + '(')) + 1,
    endLine: source.split('\n').findIndex(line => line.startsWith('def ' + name + '(')) + 1, expectedFileHash: contentHash(source), quote: `def ${name}(value):`, description: name }));
  const architecture: ArchitectureModel = { schemaVersion: '1.0.0', projectId: 'semantic-fixture', name: 'Fixture', systems: [], modules: [], memberships: [], anchors, reviews: [], flows: [{ id: 'source-flow', name: 'Source flow', description: 'Actual static calls and an explicit protocol boundary', trigger: 'Input', systemIds: [], lanes: [{ id: 'lane', name: 'Code' }],
    steps: names.map((name, phase) => ({ id: 'source-' + name, laneId: 'lane', phase, name, description: name, selector: { qualifiedName: 'src.flow.' + name, filePath: 'src/flow.py', kinds: ['function'] }, anchorIds: ['anchor-' + name], reads: [], writes: [] })),
    transitions: [{ id: 'call-one', source: 'source-start', target: 'source-bridge', basis: 'static-call', anchorIds: ['anchor-start'], limitations: [] },
      { id: 'call-two', source: 'source-bridge', target: 'source-finish', basis: 'static-call', anchorIds: ['anchor-bridge'], limitations: [] },
      { id: 'boundary', source: 'source-start', target: 'source-finish', basis: 'protocol-contract', anchorIds: ['anchor-start', 'anchor-finish'], limitations: ['Protocol correspondence only'] }], limitations: [] }] };
  const definitions: SemanticDefinitions = { schemaVersion: '1.0.0', projectId: 'semantic-fixture', flows: [{ id: 'explained', sourceFlowId: 'source-flow', title: 'Fixture explanation', description: 'Separate semantic and source graphs', groups: [
    { id: 'intent', ...text('Intent'), childIds: ['start'], origin: 'curated' }, { id: 'resolve', ...text('Resolve'), childIds: ['bridge', 'finish'], origin: 'curated' }],
    steps: names.map(name => ({ id: name, ...text(name), sourceStepIds: ['source-' + name], bindings: [{ id: 'binding-' + name, sourceStepId: 'source-' + name, role: 'implementation', anchorIds: ['anchor-' + name], expectedDeclarationHash: node(name) ? declarationHash(index, node(name).id, sourceTexts) : undefined }], controls: [], origin: 'curated' })) }] };
  const overlay: SemanticOverlay = { schemaVersion: '1.0.0', scopeId: scope, baseDefinitionRevision: semanticRevision(definitions), flowOverrides: [], reviews: [], history: [] };
  const build = (previous?: ReturnType<typeof buildSemanticProjection>) => buildSemanticProjection(index, architecture, definitions, overlay, { sourceTexts, previous });
  return { index, architecture, definitions, overlay, sourceTexts, build, node };
}

test('semantic definitions and scoped overlays reject unknown keys, unsafe paths and incomplete grouping', async () => {
  const f = await fixture(); validateDefinitions(f.definitions); validateOverlay(f.overlay);
  assert.throws(() => validateDefinitions({ ...f.definitions, sourceRoot: 'C:/secret' }), /Schema/);
  const definitions = clone(f.definitions); definitions.flows[0].groups[0].childIds.push('bridge'); assert.throws(() => validateDefinitions(definitions), /唯一覆盖/);
  const unsafe = clone(f.definitions); unsafe.flows[0].steps[0].bindings[0].selector = { filePath: '../secret.py' }; assert.throws(() => validateDefinitions(unsafe));
  const empty = clone(f.definitions); delete empty.flows[0].steps[0].bindings[0].sourceStepId; assert.throws(() => validateDefinitions(empty), /需要/);
  assert.throws(() => validateOverlay({ ...f.overlay, arbitraryFiles: [] }), /Schema/);
  const badTime = clone(f.overlay); badTime.reviews.push({ flowId: 'explained', targetType: 'flow', targetId: 'explained', decision: 'confirmed', fingerprint: contentHash(''), reviewedAt: 'never' }); assert.throws(() => validateOverlay(badTime), /时间/);
});

test('exact primary bindings support many-to-many reverse mapping without including parameters or descendants', async () => {
  const f = await fixture(); const definition = f.definitions.flows[0];
  definition.steps[0].bindings.push({ id: 'start-context', selector: { qualifiedName: 'src.flow.neighbor' }, role: 'context', anchorIds: [], expectedDeclarationHash: declarationHash(f.index, f.node('neighbor').id, f.sourceTexts) });
  definition.steps.push({ ...clone(definition.steps[0]), id: 'second-reading', bindings: [{ ...clone(definition.steps[0].bindings[0]), id: 'second-binding' }] }); definition.groups[0].childIds.push('second-reading');
  const projection = f.build(), flow = projection.flows[0], first = flow.detailNodes.find(node => node.id === 'start')!;
  assert.deepEqual(first.codeNodeIds, [f.node('start').id]); assert.deepEqual(first.contextNodeIds, [f.node('neighbor').id]);
  assert.ok(first.bindings.every(binding => binding.status === 'current'));
  assert.ok(flow.codeNodes.every(node => node.kind !== 'parameter'));
  const reverse = semanticReverse(projection, { nodeId: f.node('start').id });
  assert.deepEqual(reverse.matches[0].nodeIds.sort(), ['second-reading', 'start']);
  assert.equal(semanticBundle(projection).flow?.id, 'explained'); assert.throws(() => semanticBundle(projection, 'missing'), /不存在/);
});

test('detail and summary edges retain continuous directed facts and internal boundaries without adding a bridge', async () => {
  const f = await fixture(), projection = f.build(), flow = projection.flows[0];
  assert.equal(flow.detailEdges.length, 3); assert.equal(flow.summaryEdges.length, 1);
  assert.match(flow.summaryEdges[0].title, /调用/); assert.match(flow.summaryEdges[0].title, /协议/);
  assert.equal(flow.summaryEdges[0].verification, 'unverified', 'mixed summaries preserve the boundary ceiling');
  assert.ok(flow.summaryNodes.find(node => node.id === 'resolve')!.limitations.some(value => value.includes('组内保留 1 条')));
  const edge = flow.detailEdges.find(edge => edge.source === 'start' && edge.target === 'bridge')!;
  assert.equal(edge.verification, 'static-confirmed'); assert.equal(edge.paths[0].edgeIds.length, 1);
  for (const edge of flow.detailEdges) for (const path of edge.paths) for (let i = 0; i < path.edgeIds.length; i++) {
    const raw = f.index.edges.find(item => item.id === path.edgeIds[i])!; assert.equal(raw.source, path.nodeIds[i]); assert.equal(raw.target, path.nodeIds[i + 1]);
  }
  assert.ok(semanticReverse(projection, { edgeId: edge.codeEdgeIds[0] }).matches[0].edgeIds.includes(edge.id));
  const boundary = flow.detailEdges.find(edge => edge.source === 'start' && edge.target === 'finish')!;
  assert.equal(boundary.verification, 'unverified'); assert.equal(boundary.paths.length, 0); assert.ok(boundary.boundaries.length);
  assert.ok(flow.codeEdges.every(edge => f.index.edges.some(raw => raw.id === edge.id)));
});

test('indirect call paths preserve every real hop and inferred confidence, never convert protocol into execution', async () => {
  const f = await fixture();
  const target = f.definitions.flows[0].steps.find(node => node.id === 'bridge')!;
  target.bindings.push({ id: 'end-implementation', selector: { qualifiedName: 'src.flow.finish' }, role: 'implementation', anchorIds: [], expectedDeclarationHash: declarationHash(f.index, f.node('finish').id, f.sourceTexts) });
  const projection = f.build(), flow = projection.flows[0], edge = flow.detailEdges.find(edge => edge.source === 'start' && edge.target === 'bridge')!;
  const path = edge.paths.find(path => path.edgeIds.length === 2)!;
  assert.deepEqual(path.nodeIds, [f.node('start').id, f.node('bridge').id, f.node('finish').id]); assert.equal(path.verification, 'static-confirmed');
  const raw = f.index.edges.find(edge => edge.source === f.node('bridge').id && edge.target === f.node('finish').id && edge.kind === 'calls')!; raw.confidence = 'inferred';
  const inferred = f.build().flows[0].detailEdges.find(edge => edge.source === 'start' && edge.target === 'bridge')!;
  assert.equal(inferred.verification, 'inferred'); assert.ok(inferred.paths.some(path => path.verification === 'inferred'));
  assert.equal(f.build().flows[0].detailEdges.find(edge => edge.source === 'start' && edge.target === 'finish')!.verification, 'unverified');
});

test('unrelated methods in the same file preserve local fingerprints and confirmation across source revisions', async () => {
  const baseline = await fixture(), initial = baseline.build();
  baseline.overlay.reviews.push({ flowId: 'explained', targetType: 'node', targetId: 'start', decision: 'confirmed', fingerprint: semanticReviewFingerprint(initial, 'explained', 'node', 'start'), reviewedAt: '2026-10-20T12:30:00Z' });
  const reviewed = baseline.build(); assert.equal(reviewed.flows[0].detailNodes[0].reviewState, 'confirmed');
  const changed = await fixture(original.replace('return value + 1', 'return value + 200'));
  changed.architecture = baseline.architecture; changed.definitions = baseline.definitions; changed.overlay = baseline.overlay;
  const projection = buildSemanticProjection(changed.index, changed.architecture, changed.definitions, changed.overlay, { sourceTexts: changed.sourceTexts, previous: reviewed });
  assert.notEqual(projection.metadata.sourceRevision, reviewed.metadata.sourceRevision);
  const start = projection.flows[0].detailNodes.find(node => node.id === 'start')!;
  assert.equal(start.status, 'current'); assert.equal(start.reviewState, 'confirmed'); assert.equal(start.fingerprint, reviewed.flows[0].detailNodes[0].fingerprint);
  assert.ok(projection.flows[0].changes.unchangedNodeIds.includes('start'));
  assert.ok(projection.flows[0].detailEdges.filter(edge => edge.kinds.includes('direct-call')).every(edge => edge.verification === 'static-confirmed'));
  assert.ok(projection.flows[0].diagnostics.some(item => item.code === 'semantic-anchor-relocated'));
  const newEvidence = projection.flows[0].evidence.filter(item => item.rule === 'semantic:verified-source-anchor');
  assert.ok(newEvidence.every(item => item.fileHash === changed.index.files[0].hash));
  assert.deepEqual(baseline.architecture.anchors[0].expectedFileHash, contentHash(original), 'original anchor stays unchanged');
});

test('changed or deleted bound processes invalidate only affected interpretations and preserve human overrides', async () => {
  const baseline = await fixture(), first = baseline.build();
  baseline.overlay.reviews.push({ flowId: 'explained', targetType: 'node', targetId: 'start', decision: 'confirmed', fingerprint: semanticReviewFingerprint(first, 'explained', 'node', 'start'), reviewedAt: '2026-10-20T12:30:00Z' });
  const changed = await fixture(original.replace('return bridge(value)', 'return bridge(value + 1)'));
  const projection = buildSemanticProjection(changed.index, baseline.architecture, baseline.definitions, baseline.overlay, { sourceTexts: changed.sourceTexts, previous: first });
  assert.equal(projection.flows[0].detailNodes[0].status, 'stale'); assert.equal(projection.flows[0].detailNodes[0].reviewState, 'needs-review');
  assert.equal(projection.flows[0].detailNodes[1].fingerprint, first.flows[0].detailNodes[1].fingerprint);
  const removed = await fixture(original.replace('def start(value):\n    return bridge(value)\n\n', ''));
  const missing = buildSemanticProjection(removed.index, baseline.architecture, baseline.definitions, baseline.overlay, { sourceTexts: removed.sourceTexts });
  assert.equal(missing.flows[0].detailNodes[0].status, 'missing');
  const edited = clone(baseline.definitions.flows[0]); edited.steps[0].title = '人工维护文字'; baseline.overlay.flowOverrides = [edited];
  const overridden = buildSemanticProjection(changed.index, baseline.architecture, baseline.definitions, baseline.overlay, { sourceTexts: changed.sourceTexts }); assert.equal(overridden.flows[0].detailNodes[0].title, '人工维护文字');
});

test('anchor relocation requires one exact complete quote inside the bound declaration', async () => {
  const baseline = await fixture();
  baseline.architecture.anchors[0] = { ...baseline.architecture.anchors[0], startLine: 2, endLine: 2, quote: '    return bridge(value)' };
  const moved = await fixture('\n\n' + original);
  const resolved = buildSemanticProjection(moved.index, baseline.architecture, baseline.definitions, baseline.overlay, { sourceTexts: moved.sourceTexts });
  assert.equal(resolved.flows[0].detailNodes[0].status, 'current');
  assert.ok(resolved.flows[0].evidence.some(item => item.rule === 'semantic:verified-source-anchor' && item.startLine === 4));
  const duplicate = await fixture(original + '\ndef duplicate(value):\n    return bridge(value)\n');
  const ambiguous = buildSemanticProjection(duplicate.index, baseline.architecture, baseline.definitions, baseline.overlay, { sourceTexts: duplicate.sourceTexts }); assert.equal(ambiguous.flows[0].detailNodes[0].status, 'stale');
  baseline.architecture.anchors[0].quote = 'def neighbor(value):';
  const outside = buildSemanticProjection(moved.index, baseline.architecture, baseline.definitions, baseline.overlay, { sourceTexts: moved.sourceTexts }); assert.equal(outside.flows[0].detailNodes[0].status, 'stale');
  const forged = buildSemanticProjection(moved.index, baseline.architecture, baseline.definitions, baseline.overlay, { sourceTexts: { 'src/flow.py': 'forged' } }); assert.equal(forged.flows[0].detailNodes[0].status, 'stale');
});

test('scope isolation prevents review reuse and missing definitions remain empty', async () => {
  const f = await fixture(), projection = f.build();
  const other = await fixture(original, 'semantic-fixture:feature');
  assert.throws(() => buildSemanticProjection(other.index, other.architecture, other.definitions, f.overlay, { sourceTexts: other.sourceTexts }), /Scope/);
  assert.notEqual(projection.flows[0].detailNodes[0].fingerprint, other.build().flows[0].detailNodes[0].fingerprint);
  const definitions = { ...f.definitions, flows: [] }; const overlay = { ...f.overlay, baseDefinitionRevision: semanticRevision(definitions) };
  assert.equal(buildSemanticProjection(f.index, f.architecture, definitions, overlay).flows.length, 0);
  const missing = clone(f.definitions); missing.flows[0].sourceFlowId = 'nonexistent'; const empty = buildSemanticProjection(f.index, f.architecture, missing, f.overlay); assert.equal(empty.flows.length, 0); assert.ok(empty.diagnostics.some(item => item.code === 'semantic-flow-missing'));
});

test('source-flow definition drift requires flow review without clearing unaffected node confirmations or inventing mappings', async () => {
  const f = await fixture(); const first = f.build();
  f.overlay.reviews.push({ flowId: 'explained', targetType: 'node', targetId: 'start', fingerprint: semanticReviewFingerprint(first, 'explained', 'node', 'start'), decision: 'confirmed', reviewedAt: '2026-10-20T12:30:00Z' });
  f.overlay.reviews.push({ flowId: 'explained', targetType: 'flow', targetId: 'explained', fingerprint: semanticReviewFingerprint(first, 'explained', 'flow', 'explained'), decision: 'confirmed', reviewedAt: '2026-10-20T12:30:00Z' });
  const reviewed = f.build(), added = clone(f.architecture);
  added.flows[0].steps.push({ ...clone(added.flows[0].steps[0]), id: 'source-new', phase: 3, selector: { qualifiedName: 'src.flow.neighbor' }, anchorIds: [] });
  added.flows[0].transitions.push({ id: 'source-new-edge', source: 'source-finish', target: 'source-new', basis: 'narrative', anchorIds: [], limitations: [] });
  const projection = buildSemanticProjection(f.index, added, f.definitions, f.overlay, { sourceTexts: f.sourceTexts, previous: reviewed }), flow = projection.flows[0];
  assert.equal(flow.reviewState, 'needs-review'); assert.equal(flow.detailNodes.find(node => node.id === 'start')!.reviewState, 'confirmed');
  assert.equal(flow.detailNodes.length, 3); assert.equal(flow.detailEdges.length, 3);
  assert.ok(flow.diagnostics.some(item => item.code === 'semantic-source-step-unmapped')); assert.ok(flow.diagnostics.some(item => item.code === 'semantic-source-transition-unmapped'));
  assert.notEqual(flow.fingerprint, reviewed.flows[0].fingerprint);
  const removed = clone(f.architecture); removed.flows[0].transitions = removed.flows[0].transitions.filter(item => item.id !== 'call-one');
  const deleted = buildSemanticProjection(f.index, removed, f.definitions, f.overlay, { sourceTexts: f.sourceTexts, previous: reviewed }).flows[0];
  assert.equal(deleted.reviewState, 'needs-review'); assert.ok(deleted.diagnostics.some(item => item.code === 'semantic-source-transition-removed')); assert.equal(deleted.detailEdges.length, 2);
  const changed = clone(f.architecture); changed.flows[0].transitions[0].condition = 'value > 0';
  const conditions = buildSemanticProjection(f.index, changed, f.definitions, f.overlay, { sourceTexts: f.sourceTexts, previous: reviewed }).flows[0];
  assert.equal(conditions.reviewState, 'needs-review'); assert.ok(conditions.detailEdges.some(edge => edge.conditions.includes('value > 0')));
  assert.ok(conditions.diagnostics.some(item => item.code === 'semantic-source-definition-changed'));
  assert.equal(conditions.detailNodes.find(node => node.id === 'start')!.reviewState, 'confirmed');
});

test('declaration hashing normalizes CRLF and correctly consumes UTF-16 worker evidence with Unicode', async () => {
  const f = await fixture(), crlf = await fixture(original.replaceAll('\n', '\r\n'));
  assert.equal(declarationHash(f.index, f.node('unicode').id, f.sourceTexts), contentHash('def unicode():\n    return "😀中文"'));
  assert.equal(declarationHash(f.index, f.node('unicode').id, f.sourceTexts), declarationHash(crlf.index, crlf.node('unicode').id, crlf.sourceTexts));
  assert.equal(declarationHash(f.index, f.node('start').id, { 'src/flow.py': 'forged' }), undefined);
  const mutable = { ...f.sourceTexts }; assert.ok(declarationHash(f.index, f.node('start').id, mutable)); mutable['src/flow.py'] = 'forged'; assert.equal(declarationHash(f.index, f.node('start').id, mutable), undefined, 'a reused source record cannot reuse evidence after its content changes');
  const ambiguous = clone(f.index), node = ambiguous.nodes.find(node => node.id === f.node('start').id)!;
  const declaration = ambiguous.evidence.find(item => item.id === node.evidenceIds[0])!;
  const extra: Evidence = { ...declaration, id: 'second-declaration', startLine: 4, endLine: 5, startColumn: 1, endColumn: '    return finish(value)'.length + 1 };
  ambiguous.evidence.push(extra); node.evidenceIds.push(extra.id); assert.equal(declarationHash(ambiguous, node.id, f.sourceTexts), undefined);
});

test('call traversal budget and canvas budget retain full mapping with explicit truncation', async () => {
  const f = await fixture();
  // Extra exact implementations are fixture declarations; a dense fan-out must
  // not produce fabricated shortcuts or silently claim complete traversal.
  const nodeIds: string[] = [];
  for (let n = 0; n < 220; n++) {
    const id = 'wide-node-' + n; nodeIds.push(id);
    f.index.nodes.push({ ...clone(f.node('bridge')), id, qualifiedName: 'wide.' + n });
    f.index.edges.push({ id: 'wide-call-' + n, source: f.node('start').id, target: id, kind: 'calls', confidence: 'static-confirmed', evidenceIds: [...f.node('start').evidenceIds], rule: 'fixture:dense-call' });
  }
  const bridge = f.definitions.flows[0].steps.find(step => step.id === 'bridge')!;
  // A context selector intentionally remains ambiguous rather than absorbing
  // every matching symbol as one implementation.
  bridge.bindings.push({ id: 'wide-context', selector: { qualifiedNamePrefix: 'wide.' }, role: 'context', anchorIds: [] });
  const flow = f.build().flows[0];
  assert.equal(flow.detailNodes.find(node => node.id === 'bridge')!.status, 'ambiguous');
  assert.ok(flow.codeNodes.length >= 220); assert.equal(flow.codeGraph.nodes.length, 80); assert.equal(flow.codeGraph.truncated, true);
  assert.ok(flow.detailEdges.some(edge => edge.limitations.some(value => value.includes('200访问预算'))));
});

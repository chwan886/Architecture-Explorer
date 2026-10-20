import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProjection, architectureView, entityDetail, relationMembers, ownership, modelRevision, validateModel, reviewFingerprint } from '../packages/architecture-model/src/index.ts';
import type { ArchitectureModel, BusinessFlow } from '../packages/architecture-model/src/types.ts';
import { contentHash, stableId, type ArchitectureIndex, type ArchitectureNode, type ArchitectureEdge, type Evidence } from '../packages/schema/src/index.ts';

function fixture(scope = 'fixture:primary') {
  const id = (key: string) => stableId(scope, 'fixture', key);
  const files = ['a.cs', 'b.py', 'other.py', 'combat.asset'].map(path => ({ path, hash: contentHash(path + ':source'), size: 100, language: (path.endsWith('.cs') ? 'csharp' : path.endsWith('.py') ? 'python' : 'unity') as 'csharp' | 'python' | 'unity' }));
  const ev = (key: string, path: string, line = 1): Evidence => ({ id: id('proof:' + key), filePath: path, fileHash: files.find(f => f.path === path)!.hash,
    startLine: line, endLine: line, startColumn: 1, endColumn: 4, rule: 'fixture:explicit-source', excerpt: key });
  const evidence = [ev('a', 'a.cs'), ev('b', 'b.py'), ev('c', 'other.py')];
  const nodes: ArchitectureNode[] = [];
  const node = (key: string, kind: ArchitectureNode['kind'], parent?: string, path?: string, name = key, language: ArchitectureNode['language'] = 'csharp') => {
    const n: ArchitectureNode = { id: id(key), kind, label: key, qualifiedName: name, language, evidenceIds: path ? [evidence.find(e => e.filePath === path)!.id] : [],
      parentId: parent ? id(parent) : undefined, filePath: path };
    nodes.push(n); return n;
  };
  node('project', 'project'); node('csharp', 'system', 'project');
  for (const name of ['Domain', 'Application', 'Infrastructure', 'Presentation']) node(name, 'module', 'csharp', undefined, 'Game.' + name);
  node('python', 'system', 'project', undefined, 'Python', 'python'); node('python-module', 'module', 'python', undefined, 'Server', 'python');
  node('resources', 'system', 'project', undefined, 'Resources', 'unity');
  node('file-a', 'file', 'Domain', 'a.cs'); node('class-a', 'class', 'file-a', 'a.cs', 'Game.Actor');
  node('a', 'method', 'class-a', 'a.cs', 'Game.Actor.Run()'); node('a-event', 'event', 'class-a', 'a.cs', 'Game.Actor.Changed');
  node('file-b', 'file', 'python-module', 'b.py', 'b', 'python'); node('b', 'function', 'file-b', 'b.py', 'Server.rules.handle', 'python');
  node('b-data', 'data', 'b', 'b.py', "Server.rules.handle::actor['hp']", 'python');
  node('other-file', 'file', 'python-module', 'other.py', 'other', 'python'); node('unowned', 'function', 'other-file', 'other.py', 'Server.other', 'python');
  const edge = (key: string, source: string, target: string, kind: ArchitectureEdge['kind'], confidence: ArchitectureEdge['confidence'] = 'static-confirmed'): ArchitectureEdge => ({
    id: id(key), source: id(source), target: id(target), kind, confidence, evidenceIds: [evidence[0].id], rule: 'fixture:' + key,
  });
  const edges = [edge('call', 'a', 'b', 'calls'), edge('read', 'a', 'b-data', 'reads'), edge('write', 'a', 'b-data', 'writes'),
    edge('pass', 'a', 'b-data', 'passes', 'inferred'), edge('event', 'b', 'a-event', 'publishes')];
  const index: ArchitectureIndex = { nodes, edges, evidence, diagnostics: [], flows: [], files,
    metadata: { schemaVersion: '1.0.0', analyzerVersion: '0.1.0', projectId: 'fixture', projectName: 'Fixture', worktreeId: scope.split(':')[1], scopeId: scope,
      rootPath: 'C:/fixture-read-only', gitHead: 'a', gitBranch: 'main', gitDirty: false, gitStatusHash: contentHash(''), generatedAt: '2026-10-20T12:00:00Z',
      configFingerprint: 'config', compilationFingerprint: 'compilation', revision: id('revision'), fileCount: files.length, durationMs: 1, changedFiles: files.length, reusedFiles: 0,
      coverage: { languages: ['csharp', 'python'], limitations: ['Explicit test fixture.'] } } };
  const system = (id: string) => ({ id, name: id, responsibility: id + ' responsibility', features: [], inputs: [], outputs: [], keyData: [], kind: 'business' as const, anchorIds: [] });
  const model: ArchitectureModel = { schemaVersion: '1.0.0', projectId: 'fixture', name: 'Fixture architecture', systems: [system('combat'), system('rewards'), system('shared')],
    modules: [{ id: 'actor', systemId: 'combat', name: 'Actor', responsibility: 'Actor behavior', inputs: [], outputs: [], anchorIds: [] },
      { id: 'rules', systemId: 'rewards', name: 'Rules', responsibility: 'Rules behavior', inputs: [], outputs: [], anchorIds: [] },
      { id: 'support', systemId: 'shared', name: 'Support', responsibility: 'Participation only', inputs: [], outputs: [], anchorIds: [] }],
    memberships: [{ id: 'owner-a', systemId: 'combat', moduleId: 'actor', selector: { filePath: 'a.cs' }, role: 'owner', origin: 'curated', anchorIds: [] },
      { id: 'owner-b', systemId: 'rewards', moduleId: 'rules', selector: { filePath: 'b.py' }, role: 'owner', origin: 'curated', anchorIds: [] },
      { id: 'duplicate-owner-a', systemId: 'combat', moduleId: 'actor', selector: { qualifiedName: 'Game.Actor' }, role: 'owner', origin: 'rule', anchorIds: [] },
      { id: 'participant-a', systemId: 'shared', moduleId: 'support', selector: { filePath: 'a.cs' }, role: 'participant', origin: 'curated', anchorIds: [] },
      { id: 'shared-b', systemId: 'shared', moduleId: 'support', selector: { filePath: 'b.py' }, role: 'shared', origin: 'curated', anchorIds: [] }],
    anchors: [{ id: 'anchor-a', filePath: 'a.cs', startLine: 1, endLine: 1, expectedFileHash: files[0].hash, quote: 'a', description: 'Current fixture anchor' }], flows: [], reviews: [] };
  return { index, model, id };
}
const clone = <T>(value: T): T => structuredClone(value);
function confirm(model: ArchitectureModel, projection: ReturnType<typeof buildProjection>, targetType: 'system' | 'membership' | 'flow', targetId: string) {
  model.reviews.push({ scopeId: projection.metadata.scopeId, targetType, targetId, decision: 'confirmed', fingerprint: reviewFingerprint(projection, targetType, targetId), reviewedAt: '2026-10-20T13:00:00Z' });
}

test('strict standalone model validation rejects unknown keys, unsafe paths, dangling references and empty selectors', () => {
  const { model } = fixture(); validateModel(model);
  assert.throws(() => validateModel({ ...model, absoluteRoot: 'C:/secret' }), /Schema/);
  const bad = clone(model); bad.memberships[0].selector = { filePath: '../secret.py' }; assert.throws(() => validateModel(bad));
  bad.memberships[0].selector = {}; assert.throws(() => validateModel(bad));
  bad.memberships[0].selector = { filePath: 'C:/secret' }; assert.throws(() => validateModel(bad));
  bad.memberships[0].selector = { filePath: 'a.cs' }; bad.modules[0].systemId = 'missing'; assert.throws(() => validateModel(bad), /系统不存在/);
  assert.equal(modelRevision(model), modelRevision(clone(model)));
});

test('business systems cross technical layers; participant/shared do not create Cartesian collaboration edges', () => {
  const { index, model, id } = fixture(); const projection = buildProjection(index, model);
  assert.equal(projection.relations.filter(r => r.level === 'system').length, 2);
  const combat = projection.entities.find(e => e.id === 'combat')!; const rewards = projection.entities.find(e => e.id === 'rewards')!;
  const relation = projection.relations.find(r => r.level === 'system' && r.source === combat.nodeId && r.target === rewards.nodeId)!;
  assert.equal(relation.totalMembers, 4); assert.equal(new Set(relation.memberEdgeIds).size, 4);
  assert.deepEqual(relation.confidenceCounts, { 'static-confirmed': 3, 'runtime-verified': 0, inferred: 1 });
  assert.equal(relation.membershipPending, true);
  assert.ok(relation.memberNodeIds.includes(id('a')) && relation.dataNodeIds.includes(id('b-data')));
  assert.ok(projection.unclassifiedNodeIds.includes(id('unowned')));
  assert.equal(ownership(projection, id('a')).owners.length, 3);
  assert.ok(projection.relations.every(r => !r.condition && !r.dispatch));
});

test('category filtering recomputes the single direction summary and paged original evidence exactly', () => {
  const { index, model } = fixture(); const projection = buildProjection(index, model);
  const view = architectureView(projection, index, 'business', undefined, 'data-access');
  assert.equal(view.relations.length, 1); assert.equal(view.relations[0].totalMembers, 3);
  assert.deepEqual(view.relations[0].confidenceCounts, { 'static-confirmed': 2, 'runtime-verified': 0, inferred: 1 });
  const page = relationMembers(projection, index, view.relations[0].id, 1, 1);
  assert.equal(page.total, 3); assert.equal(page.edges.length, 1); assert.equal(page.truncated, true);
  assert.ok(['reads', 'writes', 'passes'].includes(page.edges[0].kind));
  assert.deepEqual(page.evidence.map(e => e.id), page.edges[0].evidenceIds);
  assert.throws(() => relationMembers(projection, index, view.relations[0].id.replace('data-access', 'imaginary')), /类别无效/);
});

test('entity details prioritize current definition anchors before other anchors and declaration evidence without changing facts', () => {
  const { index, model, id } = fixture();
  const declarations = Array.from({ length: 220 }, (_, position): Evidence => ({ ...index.evidence[0], id: id('declaration-' + position), startLine: position + 1, endLine: position + 1 }));
  index.evidence.push(...declarations);
  index.nodes.find(node => node.id === id('a'))!.evidenceIds.push(...declarations.map(item => item.id));
  model.anchors.push({ ...model.anchors[0], id: 'definition-anchor', startLine: 4, endLine: 4, quote: 'definition', description: 'System responsibility source' });
  model.systems[0].anchorIds = ['definition-anchor'];
  model.memberships[0].anchorIds = ['anchor-a'];
  const facts = clone(index); const projection = buildProjection(index, model);
  const detail = entityDetail(projection, index, 'combat');
  assert.equal(detail.evidence.length, 200);
  assert.equal(detail.evidence[0].excerpt, 'definition');
  assert.equal(detail.evidence[1].excerpt, 'a');
  assert.ok(detail.evidence.slice(0, 2).every(item => item.rule === 'architecture:curated-source-anchor'));
  assert.equal(new Set(detail.evidence.map(item => item.id)).size, 200);
  assert.ok(declarations.every(item => projection.evidence.some(evidence => evidence.id === item.id)), 'full underlying declarations stay available for drill-down');
  assert.deepEqual(index, facts, 'presentation ordering must not mutate source evidence or edge confidence');
  const changed = clone(index); changed.metadata.revision = 'anchor-source-changed'; changed.files[0].hash = contentHash('changed');
  assert.ok(entityDetail(buildProjection(changed, model), changed, 'combat').evidence.every(item => item.rule !== 'architecture:curated-source-anchor'));
});

test('system confirmation does not confirm memberships; reviewed ownership is separate from raw confidence', () => {
  const { index, model } = fixture(); let projection = buildProjection(index, model);
  confirm(model, projection, 'system', 'combat'); projection = buildProjection(index, model);
  assert.equal(projection.entities.find(e => e.id === 'combat')!.reviewState, 'confirmed');
  assert.equal(projection.memberships[0].reviewState, 'pending');
  for (const membership of projection.memberships.filter(m => m.role === 'owner')) confirm(model, projection, 'membership', membership.id);
  const reviewed = buildProjection(index, model);
  assert.ok(reviewed.relations.filter(r => r.level === 'system').every(r => !r.membershipPending));
  assert.equal(reviewed.relations.find(r => r.kinds.includes('passes'))!.confidence, 'inferred');
});

test('source hash changes invalidate human reviews and anchors; deleted targets remain explicitly missing', () => {
  const { index, model, id } = fixture(); model.memberships[0].anchorIds = ['anchor-a'];
  const initial = buildProjection(index, model); confirm(model, initial, 'membership', 'owner-a');
  const changed = clone(index); changed.metadata.revision = 'changed-revision'; changed.files[0].hash = contentHash('new a.cs content');
  const projection = buildProjection(changed, model);
  assert.equal(projection.memberships[0].reviewState, 'needs-review');
  assert.ok(projection.diagnostics.some(d => d.code === 'anchor-needs-review'));
  assert.ok(!projection.evidence.some(e => e.rule === 'architecture:curated-source-anchor'));
  const deleted = clone(index); deleted.metadata.revision = 'deleted-revision'; deleted.files = deleted.files.filter(f => f.path !== 'a.cs');
  deleted.nodes = deleted.nodes.filter(n => n.filePath !== 'a.cs'); deleted.edges = [];
  const missing = buildProjection(deleted, model);
  assert.equal(missing.memberships[0].resolution, 'missing'); assert.equal(missing.memberships[0].nodeIds.length, 0);
  assert.throws(() => ownership(missing, id('a')), /当前 Scope/);
});

test('multiple primary owners conflict rather than duplicating cross-system edges; rejected rules do not own', () => {
  const { index, model, id } = fixture(); model.memberships.push({ ...clone(model.memberships[0]), id: 'conflicting-a', systemId: 'shared', moduleId: 'support' });
  const conflict = buildProjection(index, model);
  assert.ok(ownership(conflict, id('a')).owners.filter(o => o.role === 'owner').every(o => o.resolution === 'conflict'));
  assert.equal(conflict.relations.filter(r => r.level === 'system').length, 0);
  model.reviews.push({ scopeId: index.metadata.scopeId, targetType: 'membership', targetId: 'conflicting-a', decision: 'rejected',
    fingerprint: reviewFingerprint(conflict, 'membership', 'conflicting-a'), reviewedAt: '2026-10-20T13:00:00Z' });
  assert.equal(buildProjection(index, model).relations.filter(r => r.level === 'system').length, 2);
});

test('Scope and source versions isolate projection routes, evidence IDs and review decisions', () => {
  const main = fixture(); const primary = buildProjection(main.index, main.model); confirm(main.model, primary, 'membership', 'owner-a');
  const feature = fixture('fixture:feature'); feature.model.reviews = clone(main.model.reviews);
  const projection = buildProjection(feature.index, feature.model);
  assert.equal(projection.memberships[0].reviewState, 'pending');
  assert.notEqual(projection.metadata.viewRevision, primary.metadata.viewRevision);
  assert.notEqual(projection.entities[0].nodeId, primary.entities[0].nodeId);
  assert.throws(() => architectureView(primary, feature.index, 'business'), /Scope 或版本/);
  assert.throws(() => ownership(projection, main.id('a')), /当前 Scope/);
  assert.throws(() => relationMembers(projection, feature.index, primary.relations[0].id), /不存在/);
  assert.throws(() => entityDetail(projection, feature.index, primary.entities[0].nodeId), /不存在/);
});

test('four C# assembly entries plus Python/resources reuse the technical source hierarchy', () => {
  const { index, model, id } = fixture(); const projection = buildProjection(index, model);
  const root = architectureView(projection, index, 'technical'); assert.equal(root.graph.nodes.length, 6);
  const domain = architectureView(projection, index, 'technical', id('Domain'));
  assert.equal(domain.graph.nodes[0].id, id('file-a'));
  const systems = architectureView(projection, index, 'business'); assert.equal(systems.entities.length, 3);
  const modules = architectureView(projection, index, 'business', 'combat'); assert.equal(modules.entities[0].id, 'actor');
  const components = architectureView(projection, index, 'business', 'actor'); assert.ok(components.graph.nodes.some(n => n.id === id('class-a')));
  assert.equal(entityDetail(projection, index, 'actor').components[0].id, id('class-a'));
});

test('business flow order is confirmed only for real static calls, with narrative and request boundaries unverified', () => {
  const { index, model } = fixture();
  model.anchors.push({ ...model.anchors[0], id: 'flow-anchor-after', startLine: 3, endLine: 3, quote: 'flow source', description: 'Primary flow responsibility' });
  const sourceAnchors = ['flow-anchor-after', 'anchor-a'];
  const flow: BusinessFlow = { id: 'flow', name: 'Fixture flow', description: 'Explicit narrative with source binding', trigger: 'Intent', systemIds: ['combat', 'rewards'],
    lanes: [{ id: 'client', name: 'Client', systemId: 'combat' }, { id: 'server', name: 'Server', systemId: 'rewards' }],
    steps: [{ id: 'start', laneId: 'client', phase: 0, name: 'Run', description: 'Run method', selector: { qualifiedName: 'Game.Actor.Run()' }, anchorIds: sourceAnchors, reads: [], writes: [] },
      { id: 'handle', laneId: 'server', phase: 1, name: 'Handle', description: 'Handle function', selector: { qualifiedName: 'Server.rules.handle' }, anchorIds: [], reads: [], writes: [] },
      { id: 'story', laneId: 'server', phase: 2, name: 'Narrative', description: 'No claimed implementation', anchorIds: [], reads: [], writes: [] }],
    transitions: [{ id: 'call', source: 'start', target: 'handle', basis: 'static-call', anchorIds: sourceAnchors, limitations: [] },
      { id: 'not-call', source: 'handle', target: 'start', basis: 'static-call', anchorIds: [], limitations: [] },
      { id: 'request', source: 'handle', target: 'story', basis: 'request-boundary', anchorIds: [], limitations: [] }], limitations: [] };
  model.flows = [flow]; const projection = buildProjection(index, model), resolved = projection.flows[0];
  assert.equal(resolved.transitions[0].verification, 'static-confirmed'); assert.equal(resolved.transitions[0].memberEdgeIds.length, 1);
  assert.equal(resolved.transitions[1].verification, 'unverified'); assert.equal(resolved.transitions[2].verification, 'unverified');
  assert.equal(resolved.steps[2].nodeIds.length, 0); assert.equal(resolved.reviewState, 'pending');
  const excerpts = (ids: string[]) => ids.map(id => projection.evidence.find(item => item.id === id)!.excerpt);
  assert.deepEqual(excerpts(resolved.steps[0].evidenceIds.slice(0, 2)), ['flow source', 'a']);
  assert.deepEqual(excerpts(resolved.transitions[0].evidenceIds.slice(0, 2)), ['flow source', 'a']);
  assert.equal(new Set(resolved.transitions[0].evidenceIds).size, resolved.transitions[0].evidenceIds.length);
});

test('source-order requires both current endpoint anchors; stale locations are never used as new evidence', () => {
  const { index, model } = fixture();
  model.anchors.push({ id: 'anchor-after', filePath: 'a.cs', startLine: 3, endLine: 3, expectedFileHash: index.files[0].hash, quote: 'after', description: 'Later source position' });
  model.flows.push({ id: 'source-order', name: 'Source order', description: 'Positions, not runtime ordering', trigger: 'Inspect', systemIds: ['combat'],
    lanes: [{ id: 'lane', name: 'Source' }],
    steps: [{ id: 'before', laneId: 'lane', phase: 0, name: 'Before', description: 'Earlier source position', anchorIds: ['anchor-a'], reads: [], writes: [] },
      { id: 'after', laneId: 'lane', phase: 1, name: 'After', description: 'Later source position', anchorIds: ['anchor-after'], reads: [], writes: [] }],
    transitions: [{ id: 'ordered', source: 'before', target: 'after', basis: 'source-order', anchorIds: ['anchor-a', 'anchor-after'], limitations: [] },
      { id: 'not-enough', source: 'before', target: 'after', basis: 'source-order', anchorIds: ['anchor-a'], limitations: [] }], limitations: [] });
  const initial = buildProjection(index, model);
  assert.equal(initial.flows[0].transitions[0].verification, 'source-supported');
  assert.equal(initial.flows[0].transitions[1].verification, 'unverified');
  confirm(model, initial, 'flow', 'source-order');
  const changed = clone(index); changed.metadata.revision = 'new-source'; changed.files[0].hash = contentHash('edited source');
  const stale = buildProjection(changed, model);
  assert.equal(stale.flows[0].reviewState, 'needs-review');
  assert.equal(stale.flows[0].transitions[0].verification, 'unverified');
  assert.ok(!stale.evidence.some(e => e.rule === 'architecture:curated-source-anchor'));
});

test('category filtering recomputes pending ownership and membership IDs from only retained raw edges', () => {
  const { index, model, id } = fixture();
  // Separate precise owners have the same system destination but different
  // review states. A call-only rule must not taint a data-only filtered result.
  model.memberships = model.memberships.filter(m => m.role !== 'owner');
  index.nodes.find(n => n.id === id('b-data'))!.parentId = id('file-b');
  model.memberships.push(
    { id: 'method-a', systemId: 'combat', moduleId: 'actor', selector: { qualifiedName: 'Game.Actor.Run()' }, role: 'owner', origin: 'curated', anchorIds: [] },
    { id: 'function-b', systemId: 'rewards', moduleId: 'rules', selector: { qualifiedName: 'Server.rules.handle', kinds: ['function'] }, role: 'owner', origin: 'curated', anchorIds: [] },
    { id: 'data-b', systemId: 'rewards', moduleId: 'rules', selector: { qualifiedName: "Server.rules.handle::actor['hp']" }, role: 'owner', origin: 'curated', anchorIds: [] });
  const first = buildProjection(index, model);
  for (const m of first.memberships.filter(m => ['method-a', 'data-b'].includes(m.id))) confirm(model, first, 'membership', m.id);
  const reviewed = buildProjection(index, model);
  assert.ok(architectureView(reviewed, index, 'business').relations.some(r => r.membershipPending));
  const filtered = architectureView(reviewed, index, 'business', undefined, 'data-access');
  assert.equal(filtered.relations.length, 1);
  assert.ok(filtered.relations.every(r => !r.membershipPending));
  assert.ok(filtered.relations.every(r => r.membershipIds.every(id => ['method-a', 'data-b'].includes(id))));
});

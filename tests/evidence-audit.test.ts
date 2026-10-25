import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { contentHash, type ArchitectureIndex, type Evidence } from '../packages/schema/src/index.ts';
import { auditEvidence, type EvidenceAuditInput } from '../packages/evidence-audit/src/index.ts';
import { buildProjection } from '../packages/architecture-model/src/index.ts';
import type { ArchitectureModel, ArchitectureProjection } from '../packages/architecture-model/src/types.ts';
import type { SemanticNode, SemanticProjection } from '../packages/semantic-model/src/types.ts';

function fixture(): EvidenceAuditInput {
  const content = 'def start(value):\n    return finish(value)\ndef finish(value):\n    return value\n';
  const hash = contentHash(content);
  const proof: Evidence = { id: 'proof', filePath: 'src/flow.py', startLine: 2, startColumn: 5, endLine: 2, endColumn: 25, fileHash: hash, rule: 'python.call' };
  const index: ArchitectureIndex = {
    nodes: ['start', 'finish', 'value'].map(id => ({ id, kind: id === 'value' ? 'parameter' : 'function', label: id, qualifiedName: `src.flow.${id}`, language: 'python', filePath: 'src/flow.py', evidenceIds: ['proof'] })),
    edges: [{ id: 'call', source: 'start', target: 'finish', kind: 'calls', confidence: 'static-confirmed', evidenceIds: ['proof'], rule: 'python.call' }], evidence: [proof], diagnostics: [], flows: [],
    files: [{ path: 'src/flow.py', hash, size: content.length, language: 'python' }],
    metadata: { schemaVersion: '1.0.0', analyzerVersion: 'audit-fixture', projectId: 'fixture', projectName: 'Fixture', worktreeId: 'primary', scopeId: 'fixture:primary', rootPath: 'C:/fixture', gitHead: 'head', gitBranch: 'main', gitDirty: false, gitStatusHash: 'status', generatedAt: '2026-10-20T12:00:00Z', configFingerprint: 'config', compilationFingerprint: 'compile', revision: 'source-revision', fileCount: 1, durationMs: 0, changedFiles: 0, reusedFiles: 1, coverage: { languages: ['python'], limitations: [] } },
  };
  const model: ArchitectureModel = { schemaVersion: '1.0.0', projectId: 'fixture', name: 'Fixture', systems: [{ id: 'combat', name: '战斗', responsibility: '核验', features: [], inputs: [], outputs: [], keyData: [], kind: 'business', anchorIds: ['entry'] }], modules: [], memberships: [], anchors: [{ id: 'entry', filePath: 'src/flow.py', startLine: 1, endLine: 1, expectedFileHash: hash, quote: 'def start(value):', description: '入口' }], flows: [], reviews: [] };
  const projection: ArchitectureProjection = { metadata: { scopeId: 'fixture:primary', projectId: 'fixture', sourceRevision: 'source-revision', modelRevision: 'model', viewRevision: 'architecture-view', projectionVersion: '1.0.0' }, entities: [], memberships: [], relations: [], technicalNodes: [], technicalRelations: [], ownership: { start: [{ systemId: 'combat', systemName: '战斗', moduleId: 'module', moduleName: '模块', membershipId: 'owner', role: 'owner', reviewState: 'pending', resolution: 'resolved' }] }, flows: [], evidence: [], diagnostics: [], unclassifiedNodeIds: ['finish'] };
  const node = (id: string, codeId: string): SemanticNode => ({ id, level: 'detail', childIds: [], sourceStepIds: [], codeNodeIds: [codeId], contextNodeIds: [], evidenceIds: ['proof'], fragments: [[codeId]], bindings: [], controls: [], origin: 'curated', status: 'current', reviewState: 'confirmed', fingerprint: id, limitations: [], title: id, summary: '解释', purpose: '说明', detail: '细节', inputs: [], processing: [], outputs: [], changes: [] });
  const semantic: SemanticProjection = { metadata: { scopeId: 'fixture:primary', projectId: 'fixture', sourceRevision: 'source-revision', architectureRevision: 'model', definitionRevision: 'definitions', overlayRevision: 'overlay', viewRevision: 'semantic-view', generatorVersion: 'test', projectionVersion: '1.0.0' }, diagnostics: [], flows: [{ id: 'attack', sourceFlowId: 'attack', title: '攻击', description: 'fixture', summaryNodes: [], detailNodes: [node('begin', 'start'), node('end', 'finish')], summaryEdges: [], detailEdges: [{ id: 'semantic-call', source: 'begin', target: 'end', level: 'detail', title: '调用', description: '真实静态调用', kinds: ['direct-call'], sourceTransitionIds: [], codeEdgeIds: ['call'], paths: [{ nodeIds: ['start', 'finish'], edgeIds: ['call'], kind: 'call-path', verification: 'static-confirmed' }], evidenceIds: ['proof'], conditions: [], boundaries: [], verification: 'static-confirmed', status: 'current', reviewState: 'confirmed', fingerprint: 'edge', limitations: [] }], codeGraph: { nodes: index.nodes.slice(0, 2), edges: index.edges, totalNodes: 2, truncated: false, revision: 'source-revision' }, codeNodes: index.nodes.slice(0, 2), codeEdges: index.edges, evidence: [proof], reviewState: 'confirmed', fingerprint: 'flow', diagnostics: [], limitations: [], reverseNodes: {}, reverseEdges: {}, changes: { unchangedNodeIds: [], changedNodeIds: [], removedNodeIds: [], unchangedEdgeIds: [], changedEdgeIds: [], removedEdgeIds: [] } }] };
  return { index, architecture: { model, projection }, semantic, sourceFiles: { 'src/flow.py': { content } }, generatedAt: '2026-10-20T14:00:00Z' };
}

test('audit keeps static calls, candidate ownership, source support and human review independent', () => {
  const input = fixture();
  input.architecture!.projection.memberships.push({ id: 'owner', systemId: 'combat', moduleId: 'module', selector: { qualifiedName: 'src.flow.start' }, role: 'owner', origin: 'curated', anchorIds: ['entry'], nodeIds: ['start'], resolution: 'resolved', reviewState: 'pending', fingerprint: 'owner', evidenceIds: ['proof'] });
  const before = JSON.stringify(input), report = auditEvidence(input);
  assert.equal(report.coverage.rawRelations.calls['static-confirmed'], 1);
  assert.equal(report.coverage.reviews.ownership.pending, 1);
  assert.equal(report.coverage.reviews.semanticNodes.confirmed, 2);
  assert.equal(report.coverage.runtimeVerificationClaimedByAudit, false);
  assert.equal(report.totals.byReason['candidate-ownership'], 1);
  assert.equal(report.totals.byReason['unverified-order'], undefined);
  assert.equal(report.coverage.evidence.currentHashValid, 1);
  assert.equal(report.snapshot.analyzerVersion, 'audit-fixture');
  assert.equal(report.snapshot.definitionRevision, 'definitions');
  assert.equal(report.coverage.systems[0].relationsByKind.calls, 1);
  assert.equal(JSON.stringify(input), before, 'audit never edits facts or human decisions');
});

test('callback argument flow never becomes an invented runtime call', () => {
  const input = fixture();
  input.index.edges.push({ id: 'pass', source: 'start', target: 'value', kind: 'passes', confidence: 'static-confirmed', evidenceIds: ['proof'], rule: 'csharp.argument-binding', dispatch: 'declared-parameter', limitations: ['参数绑定不证明值或对象身份。'] });
  input.index.edges.push({ id: 'invoke', source: 'start', target: 'value', kind: 'references', confidence: 'static-confirmed', evidenceIds: ['proof'], rule: 'csharp.delegate-invocation', dispatch: 'delegate-storage', limitations: ['委托槽已知，处理器集合未知。'] });
  input.index.edges.push({ id: 'inferred', source: 'finish', target: 'start', kind: 'calls', confidence: 'inferred', evidenceIds: ['proof'], rule: 'dynamic-rule', dispatch: 'virtual-declaration' });
  input.index.edges.push({ id: 'python-pass', source: 'finish', target: 'value', kind: 'passes', confidence: 'inferred', evidenceIds: ['proof'], rule: 'python.callback-argument', dispatch: 'argument:callback' });
  input.index.diagnostics.push({ id: 'callback-warning', severity: 'warning', code: 'CS_DELEGATE_TARGETS', message: '调用点已知，实际处理器未知。' });
  const report = auditEvidence(input);
  assert.deepEqual(report.coverage.rawRelations.calls, { 'static-confirmed': 1, inferred: 1 });
  assert.equal(report.coverage.rawRelations.byKind.passes, 2);
  assert.deepEqual(report.coverage.rawRelations.byKindAndConfidence.passes, { 'static-confirmed': 1, inferred: 1 });
  assert.equal(report.coverage.rawRelations.byRule['csharp.delegate-invocation'], 1);
  assert.equal(report.totals.byReason['unknown-runtime-target'], 1);
  assert.equal(report.totals.byReason['inferred-relation'], 2);
  assert.equal(report.totals.byReason['dynamic-dispatch'], 1);
  assert.equal(report.coverage.rawRelations.dynamicDispatch, 1);
  assert.deepEqual(report.findings.filter(item => item.reason === 'dynamic-dispatch').map(item => item.targetId), ['inferred']);
});

test('dispatch metadata on parameter bindings, storage references and direct calls does not imply dynamic calls', () => {
  const input = fixture();
  input.index.edges[0].dispatch = 'direct';
  input.index.edges.push({ ...input.index.edges[0], id: 'static-call', dispatch: 'static' });
  input.index.edges.push({ ...input.index.edges[0], id: 'parameter', kind: 'passes', dispatch: 'declared-parameter' });
  input.index.edges.push({ ...input.index.edges[0], id: 'callback-argument', kind: 'passes', dispatch: 'argument:callback' });
  input.index.edges.push({ ...input.index.edges[0], id: 'delegate-slot', kind: 'references', dispatch: 'delegate-storage' });
  input.index.edges.push({ ...input.index.edges[0], id: 'structure', kind: 'contains', dispatch: 'grouping' });
  const report = auditEvidence(input);
  assert.equal(report.coverage.rawRelations.dynamicDispatch, 0);
  assert.equal(report.totals.byReason['dynamic-dispatch'], undefined);
});

test('request, protocol and source order remain distinct from confirmed execution', () => {
  const input = fixture(), projection = input.architecture!.projection;
  projection.flows.push({ id: 'flow', name: '跨请求流程', description: '', trigger: '', systemIds: ['combat'], lanes: [], steps: ['before', 'after'].map(id => ({ id, laneId: 'lane', phase: 0, name: id, description: '', anchorIds: ['entry'], reads: [], writes: [], nodeIds: ['start'], evidenceIds: ['proof'], resolution: 'resolved' })),
    transitions: [
      { id: 'request', source: 'before', target: 'after', basis: 'request-boundary', anchorIds: [], limitations: ['跨 HTTP 请求未追踪'], memberEdgeIds: [], evidenceIds: ['proof'], verification: 'unverified' },
      { id: 'protocol', source: 'before', target: 'after', basis: 'protocol-contract', anchorIds: [], limitations: [], memberEdgeIds: [], evidenceIds: ['proof'], verification: 'unverified' },
      { id: 'order', source: 'before', target: 'after', basis: 'source-order', anchorIds: [], limitations: [], memberEdgeIds: [], evidenceIds: ['proof'], verification: 'source-supported' },
    ], limitations: [], reviewState: 'confirmed', fingerprint: 'flow' });
  const report = auditEvidence(input);
  assert.equal(report.coverage.flowRelations.architecture['request-boundary:unverified'], 1);
  assert.equal(report.coverage.flowRelations.architecture['protocol-contract:unverified'], 1);
  assert.equal(report.coverage.flowRelations.architecture['source-order:source-supported'], 1);
  assert.equal(report.totals.byReason['unverified-order'], 2);
  assert.equal(report.totals.byReason['source-supported-order'], 1);
  assert.equal(report.groups.flows.find(flow => flow.id === 'flow')!.reasons['unverified-order'], 2);
});

function sourcePositionFixture(selectProcedures = false) {
  const input = fixture();
  delete input.semantic;
  const model = input.architecture!.model;
  model.anchors.push({ ...model.anchors[0], id: 'finish-entry', startLine: 3, endLine: 3, quote: 'def finish(value):' });
  model.flows.push({ id: 'positions', name: 'Source positions', description: 'File positions do not prove execution order', trigger: 'Inspect source', systemIds: ['combat'],
    lanes: [{ id: 'source', name: 'Source' }],
    steps: ['before', 'after'].map((id, phase) => ({ id, phase, laneId: 'source', name: id, description: 'Position in source',
      anchorIds: [phase === 0 ? 'entry' : 'finish-entry'], reads: [], writes: [],
      ...(selectProcedures ? { selector: { qualifiedName: `src.flow.${phase === 0 ? 'start' : 'finish'}` } } : {}) })),
    transitions: [{ id: 'position-order', source: 'before', target: 'after', basis: 'source-order', anchorIds: ['entry', 'finish-entry'], limitations: [] }], limitations: [] });
  input.architecture!.projection = buildProjection(input.index, model);
  return input;
}

test('the real projection and audit agree on source position support without claiming a common procedure', () => {
  for (const selectProcedures of [false, true]) {
    const input = sourcePositionFixture(selectProcedures), transition = input.architecture!.projection.flows[0].transitions[0];
    assert.equal(transition.verification, 'source-supported');
    assert.deepEqual(transition.memberEdgeIds, [], 'source positions must not invent a call');
    const before = JSON.stringify(input), report = auditEvidence(input);
    assert.equal(report.totals.byReason['invalid-proof'], undefined, 'valid file positions must survive the audit');
    assert.notEqual(report.result, 'invalid');
    const finding = report.findings.find(item => item.reason === 'source-supported-order')!;
    assert.ok(finding.message.includes('源码位置'));
    assert.ok(!finding.message.includes('同一过程'));
    assert.equal(JSON.stringify(input), before);
  }
});

test('forged source support still rejects stale, missing, reversed, cross-file and invalid-range anchors', () => {
  const edits: Array<(input: EvidenceAuditInput) => void> = [
    input => { input.architecture!.model.anchors[1].expectedFileHash = contentHash('stale source'); },
    input => { input.architecture!.projection.flows[0].transitions[0].anchorIds = ['entry']; },
    input => {
      const anchors = input.architecture!.model.anchors;
      [anchors[0].startLine, anchors[1].startLine] = [anchors[1].startLine, anchors[0].startLine];
      [anchors[0].endLine, anchors[1].endLine] = [anchors[1].endLine, anchors[0].endLine];
      [anchors[0].quote, anchors[1].quote] = [anchors[1].quote, anchors[0].quote];
    },
    input => {
      const file = { ...input.index.files[0], path: 'src/other.py' };
      input.index.files.push(file); input.sourceFiles![file.path] = { ...input.sourceFiles!['src/flow.py'] };
      input.architecture!.model.anchors[1].filePath = file.path;
    },
    input => { input.architecture!.model.anchors[1].endLine = 2; },
    input => { input.architecture!.model.anchors[1].endLine = 4; },
  ];
  for (const edit of edits) {
    const input = sourcePositionFixture(); edit(input);
    const report = auditEvidence(input);
    assert.equal(report.result, 'invalid');
    assert.ok(report.findings.some(item => item.targetId === 'position-order' && item.reason === 'invalid-proof'));
  }
  const forgedQuote = sourcePositionFixture(); forgedQuote.architecture!.model.anchors[1].quote = 'invented source';
  assert.ok(auditEvidence(forgedQuote).totals.byReason['anchor-quote-mismatch'], 'current source text still rejects fabricated quotes');
});

test('audit catches missing endpoints/references, stale hashes, invalid ranges and complete anchor quotes', () => {
  const input = fixture();
  input.index.edges[0].target = 'deleted'; input.index.nodes[0].evidenceIds = ['removed'];
  input.index.evidence[0].endLine = 999;
  input.architecture!.model.anchors[0].quote = 'partial text';
  let report = auditEvidence(input);
  for (const reason of ['missing-node', 'missing-evidence', 'invalid-source-range', 'anchor-quote-mismatch']) assert.ok(report.totals.byReason[reason], reason);
  input.sourceFiles!['src/flow.py'].content += '# changed';
  report = auditEvidence(input);
  assert.ok(report.totals.byReason['source-stale']); assert.ok(report.totals.byReason['anchor-stale']);
  assert.equal(report.result, 'invalid');
});

test('semantic evidence cannot satisfy a missing raw analyzer proof and mixed snapshots fail', () => {
  const input = fixture();
  input.semantic!.flows[0].evidence.push({ ...input.index.evidence[0], id: 'only-semantic' });
  input.index.edges[0].evidenceIds = ['only-semantic'];
  input.semantic!.metadata.scopeId = 'fixture:other';
  input.architecture!.projection.metadata.sourceRevision = 'old';
  input.semantic!.flows[0].detailEdges[0].paths[0].nodeIds.reverse();
  const report = auditEvidence(input);
  assert.ok(report.totals.byReason['missing-evidence']); assert.equal(report.totals.byReason['snapshot-mismatch'], 2);
  assert.equal(report.totals.byReason['invalid-path'], 1);
});

test('budgets report incomplete checks and exact omission counts, retaining errors before info', () => {
  const input = fixture(); input.limits = { maxFindings: 1, maxGroupSamples: 0 };
  input.index.edges[0].limitations = ['保留静态限制'];
  input.semantic!.flows[0].detailNodes[0].status = 'missing';
  const report = auditEvidence(input);
  assert.equal(report.findings.length, 1); assert.equal(report.findings[0].severity, 'error');
  assert.equal(report.truncation.findings, true); assert.equal(report.truncation.omittedFindings, report.totals.findings - 1);
  assert.equal(report.truncation.groupSamples, true);
  input.limits = { maxItems: 2 };
  const limited = auditEvidence(input);
  assert.equal(limited.result, 'incomplete'); assert.equal(limited.truncation.checkedItems, 2);
  assert.ok(limited.coverage.checked.edges < limited.coverage.available.edges);
  assert.throws(() => auditEvidence({ ...input, limits: { maxItems: NaN } }), /预算/);
});

test('missing current source is disclosed, service failures cannot masquerade as full coverage', () => {
  const input = fixture(); delete input.sourceFiles;
  input.serviceErrors = [{ service: 'semantic', message: '源文件变化' }];
  const report = auditEvidence(input);
  assert.equal(report.coverage.sourceCheck, 'not-provided'); assert.equal(report.coverage.evidence.currentHashValid, 0);
  assert.equal(report.totals.byReason['service-unavailable'], 1); assert.equal(report.result, 'invalid');
  assert.ok(report.limitations.some(text => text.includes('尚未实读核验')));
});

test('bounded samples keep business review gaps ahead of repetitive raw limitation notices', () => {
  const input = fixture(); input.limits = { maxFindings: 1 };
  input.index.edges[0].limitations = ['普通限制1', '普通限制2'];
  input.semantic!.flows[0].detailNodes[0].reviewState = 'pending';
  const report = auditEvidence(input);
  assert.equal(report.findings[0].reason, 'candidate-explanation');
  assert.equal(report.totals.byReason['analysis-limitation'], 2);
  assert.equal(report.truncation.omittedFindings, 2);
});

test('audit CLI rejects arbitrary output paths before initialization', () => {
  const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'Tools/audit-evidence.ts', '--output', '../outside.json'], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /用法/);
});

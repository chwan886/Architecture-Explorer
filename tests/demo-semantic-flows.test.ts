import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildProjection, validateModel } from '../packages/architecture-model/src/index.ts';
import type { ArchitectureModel } from '../packages/architecture-model/src/types.ts';
import { validateDefinitions } from '../packages/semantic-model/src/index.ts';
import type { SemanticDefinitions } from '../packages/semantic-model/src/types.ts';
import { ANALYZER_VERSION, SCHEMA_VERSION, type ArchitectureIndex } from '../packages/schema/src/index.ts';

const model: ArchitectureModel = JSON.parse(await readFile(new URL('../architecture/models/combat-demo/model.json', import.meta.url), 'utf8'));
const definitions: SemanticDefinitions = JSON.parse(await readFile(new URL('../architecture/semantics/combat-demo/definitions.json', import.meta.url), 'utf8'));
validateModel(model); validateDefinitions(definitions);

function sourceIndex(): ArchitectureIndex {
  const flow = model.flows[0];
  const files = [...new Map(model.anchors.map(anchor => [anchor.filePath, { path: anchor.filePath, hash: anchor.expectedFileHash, size: anchor.quote.length, language: 'csharp' as const }])).values()];
  return {
    metadata: { schemaVersion: SCHEMA_VERSION, analyzerVersion: ANALYZER_VERSION, projectId: model.projectId, projectName: model.name, worktreeId: 'primary', scopeId: `${model.projectId}:primary`, rootPath: '/synthetic-public-demo', gitHead: '', gitBranch: '', gitDirty: false, gitStatusHash: '', generatedAt: '2026-01-01T00:00:00Z', configFingerprint: 'fixture', compilationFingerprint: 'fixture', revision: 'public-demo-fixture', fileCount: files.length, durationMs: 0, changedFiles: 0, reusedFiles: 0, coverage: { languages: ['csharp'], limitations: ['Synthetic fact fixture, not an analyzer execution.'] } },
    nodes: flow.steps.map(step => ({ id: step.id, kind: 'method', label: step.name, qualifiedName: step.selector!.qualifiedName!, language: 'csharp', filePath: step.selector!.filePath, evidenceIds: step.anchorIds })),
    edges: flow.transitions.filter(edge => edge.basis === 'static-call').map(edge => ({ id: edge.id, source: edge.source, target: edge.target, kind: 'calls', confidence: 'static-confirmed', evidenceIds: edge.anchorIds, rule: 'fixture.explicit-call' })),
    evidence: model.anchors.map(anchor => ({ id: anchor.id, filePath: anchor.filePath, fileHash: anchor.expectedFileHash, startLine: anchor.startLine, endLine: anchor.endLine, startColumn: 1, endColumn: 1, rule: 'fixture.declaration' })),
    files, flows: [], diagnostics: [],
  };
}

test('public semantic groups cover every real detail exactly once and retain authored candidate text', () => {
  assert.equal(definitions.projectId, model.projectId);
  assert.deepEqual(definitions.flows.map(flow => flow.sourceFlowId).sort(), model.flows.map(flow => flow.id).sort());
  assert.deepEqual(model.reviews, []);
  for (const flow of definitions.flows) {
    const source = model.flows.find(item => item.id === flow.sourceFlowId)!;
    assert.deepEqual(flow.groups.flatMap(group => group.childIds).sort(), flow.steps.map(step => step.id).sort());
    assert.deepEqual([...new Set(flow.steps.flatMap(step => step.sourceStepIds))].sort(), source.steps.map(step => step.id).sort());
    for (const node of [...flow.groups, ...flow.steps]) {
      assert.equal(node.origin, 'curated');
      assert.ok(node.title && node.summary && node.purpose && node.detail && node.inputs.length && node.processing.length && node.outputs.length);
    }
  }
});

test('public semantic bindings preserve source selectors, declaration baselines and control anchors', () => {
  const anchors = new Set(model.anchors.map(anchor => anchor.id));
  for (const flow of definitions.flows) for (const step of flow.steps) {
    const source = model.flows.find(item => item.id === flow.sourceFlowId)!;
    assert.ok(step.bindings.length);
    for (const binding of step.bindings) {
      const sourceStep = source.steps.find(item => item.id === binding.sourceStepId)!;
      assert.ok(sourceStep && step.sourceStepIds.includes(sourceStep.id));
      assert.deepEqual(binding.selector, sourceStep.selector);
      assert.equal(binding.role, 'implementation');
      assert.match(binding.expectedDeclarationHash ?? '', /^[a-f0-9]{64}$/);
      assert.ok(binding.anchorIds.every(id => anchors.has(id) && sourceStep.anchorIds.includes(id)));
    }
    for (const control of step.controls) assert.ok(control.anchorIds.every(id => anchors.has(id)));
  }
});

test('public demo call projection requires real raw direct edges and loses confirmation when an edge disappears', () => {
  const index = sourceIndex();
  const current = buildProjection(index, model).flows[0];
  assert.ok(current.transitions.length);
  assert.ok(current.transitions.every(edge => edge.verification === 'static-confirmed' && edge.memberEdgeIds.length > 0));
  const missing = structuredClone(index); missing.edges = [];
  assert.ok(buildProjection(missing, model).flows[0].transitions.every(edge => edge.verification === 'unverified'));
});

test('synthetic protocol, request and narrative boundaries never become a runtime or static call chain', () => {
  const candidate = structuredClone(model), flow = candidate.flows[0];
  const bases = ['protocol-contract', 'request-boundary', 'narrative'] as const;
  flow.transitions = bases.map(basis => ({ id: basis, source: flow.steps[0].id, target: flow.steps.at(-1)!.id, basis, anchorIds: [], limitations: ['This boundary is not an execution proof.'] }));
  const projected = buildProjection(sourceIndex(), candidate).flows[0];
  assert.deepEqual(projected.transitions.map(edge => edge.verification), bases.map(() => 'unverified'));
  assert.ok(projected.transitions.every(edge => edge.limitations.length));
});

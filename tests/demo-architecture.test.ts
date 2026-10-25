import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateModel } from '../packages/architecture-model/src/index.ts';
import type { ArchitectureModel } from '../packages/architecture-model/src/types.ts';
import { contentHash } from '../packages/schema/src/index.ts';
import { createFilePolicy, relativeSourcePath } from '../packages/indexer/src/security.ts';

const model: ArchitectureModel = JSON.parse(await readFile(new URL('../architecture/models/combat-demo/model.json', import.meta.url), 'utf8'));
validateModel(model);
const config = JSON.parse(await readFile(new URL('../config/demo.json', import.meta.url), 'utf8'));
const project = config.projects.find((item: { id: string }) => item.id === model.projectId)!;
const root = new URL('../examples/combat/', import.meta.url);

test('public demo responsibilities and memberships remain candidates without forged human approvals', () => {
  assert.ok(project);
  assert.ok(model.systems.length && model.modules.length && model.memberships.length);
  assert.deepEqual(model.reviews, []);
  for (const system of model.systems) {
    assert.ok(system.responsibility && system.inputs.length && system.outputs.length);
    assert.ok(model.modules.some(module => module.systemId === system.id));
  }
  for (const rule of model.memberships) {
    assert.ok(model.modules.some(module => module.id === rule.moduleId && module.systemId === rule.systemId));
    assert.equal(rule.origin, 'curated');
  }
});

test('public demo anchors contain the exact current full source lines and hashes', async () => {
  const policy = createFilePolicy(project.include, project.exclude);
  assert.ok(model.anchors.length);
  assert.equal(new Set(model.anchors.map(anchor => anchor.id)).size, model.anchors.length);
  for (const anchor of model.anchors) {
    relativeSourcePath(anchor.filePath);
    assert.ok(policy.included(anchor.filePath));
    const source = await readFile(new URL(anchor.filePath, root), 'utf8');
    assert.equal(contentHash(source), anchor.expectedFileHash, anchor.id);
    assert.equal(source.split(/\r?\n/).slice(anchor.startLine - 1, anchor.endLine).join('\n'), anchor.quote.replaceAll('\r\n', '\n'), anchor.id);
    assert.ok(anchor.endLine >= anchor.startLine && anchor.endLine - anchor.startLine < 80);
  }
});

test('public demo membership selectors identify included source without conflicting primary file owners', async () => {
  const primary = new Map<string, string>();
  const policy = createFilePolicy(project.include, project.exclude);
  for (const rule of model.memberships) {
    assert.ok(rule.selector.filePath, 'this portable demo uses explicit file memberships');
    const file = relativeSourcePath(rule.selector.filePath!);
    assert.ok(policy.included(file));
    assert.ok((await readFile(new URL(file, root), 'utf8')).length);
    if (rule.role === 'owner') {
      assert.ok(!primary.has(file), `${file} has conflicting primary responsibilities`);
      primary.set(file, rule.moduleId);
    }
  }
});

test('public demo static-call claims have distinct exact endpoints and real invocation text', () => {
  const anchors = new Map(model.anchors.map(anchor => [anchor.id, anchor]));
  assert.ok(model.flows.length);
  for (const flow of model.flows) {
    assert.ok(flow.limitations.length);
    const steps = new Map(flow.steps.map(step => [step.id, step]));
    for (const transition of flow.transitions) {
      assert.ok(steps.has(transition.source) && steps.has(transition.target));
      if (transition.basis !== 'static-call') { assert.ok(transition.limitations.length); continue; }
      const source = steps.get(transition.source)!, target = steps.get(transition.target)!;
      assert.ok(source.selector?.qualifiedName && target.selector?.qualifiedName);
      assert.notEqual(source.selector.qualifiedName, target.selector.qualifiedName);
      const callee = target.selector.qualifiedName.split('(')[0].split('.').at(-1)!;
      assert.ok(transition.anchorIds.some(id => new RegExp(`\\b${callee}\\s*\\(`).test(anchors.get(id)!.quote)), transition.id);
    }
  }
});

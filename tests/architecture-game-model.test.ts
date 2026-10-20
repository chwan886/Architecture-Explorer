import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateModel } from '../packages/architecture-model/src/index.ts';
import type { ArchitectureModel } from '../packages/architecture-model/src/types.ts';

const value: unknown = JSON.parse(await readFile(new URL('../architecture/models/game-demo-02/model.json', import.meta.url), 'utf8'));
validateModel(value);
const model: ArchitectureModel = value;
const businessIds = ['account-access', 'production-facilities', 'people-cultivation', 'vein-exploration', 'forge-loadout', 'solo-combat'];

test('GameDemo02 seed has six independent business candidates and separate support/legacy groups', () => {
  assert.deepEqual(model.systems.filter(system => system.kind === 'business').map(system => system.id), businessIds);
  assert.equal(model.systems.filter(system => system.kind === 'support').length, 1);
  assert.equal(model.systems.filter(system => system.kind === 'legacy').length, 1);
  assert.equal(model.modules.length, 20);
  assert.deepEqual(model.reviews, [], 'initial authored classifications must never imply human confirmation');
  for (const system of model.systems) {
    assert.ok(system.responsibility.length && system.anchorIds.length);
    assert.ok(model.modules.some(module => module.systemId === system.id));
  }
});

test('authored anchors are portable full-line source ranges confined to indexed Game/Server sources', () => {
  assert.equal(model.anchors.length, 188);
  for (const anchor of model.anchors) {
    assert.match(anchor.filePath, /^(Assets\/Game\/|Server\/)/);
    assert.ok(!anchor.filePath.includes('..') && !anchor.filePath.includes('\\'));
    assert.match(anchor.expectedFileHash, /^[a-f0-9]{64}$/);
    assert.equal(anchor.quote.split(/\r?\n/).length, anchor.endLine - anchor.startLine + 1, anchor.id);
    assert.ok(anchor.endLine - anchor.startLine < 20, anchor.id);
    assert.ok(anchor.description.length > 0);
  }
});

test('multi-domain dispatch and settlement cannot become six conflicting primary owners', () => {
  for (const name of ['Server.sect_rules.command', 'Server.sect_rules.settle', 'Server.sect_combat.command']) {
    const rules = model.memberships.filter(rule => rule.selector.qualifiedName === name);
    assert.ok(rules.length > 1, name);
    assert.ok(rules.every(rule => rule.role !== 'owner'), name);
  }
  for (const rule of model.memberships) {
    assert.ok(rule.anchorIds.length, rule.id);
    assert.equal(rule.selector.filePathPrefix, undefined, 'folder membership must not substitute for business responsibilities');
    if (rule.role === 'owner') assert.ok(!['Server/sect_rules.py', 'Server/sect_combat.py', 'Server/sect_server.py'].includes(rule.selector.filePath ?? ''), rule.id);
    assert.ok(rule.selector.qualifiedName || rule.selector.qualifiedNamePrefix || rule.selector.filePath, rule.id);
  }
});

test('flow contracts preserve request and protocol uncertainty instead of claiming runtime sequence', () => {
  assert.deepEqual(model.flows.map(flow => flow.id), ['claim-reserve', 'battle-start-poll-result']);
  const transitions = model.flows.flatMap(flow => flow.transitions);
  assert.equal(transitions.filter(transition => transition.basis === 'static-call').length, 10);
  assert.equal(transitions.filter(transition => transition.basis === 'source-order').length, 1);
  assert.equal(transitions.filter(transition => ['narrative', 'protocol-contract', 'request-boundary'].includes(transition.basis)).length, 22);
  assert.ok(model.flows[1].transitions.filter(transition => transition.basis === 'request-boundary').length >= 2);
  for (const flow of model.flows) {
    assert.ok(flow.limitations.length);
    const steps = new Map(flow.steps.map(step => [step.id, step]));
    for (const transition of flow.transitions) {
      assert.ok(transition.anchorIds.length, transition.id);
      if (transition.basis !== 'static-call') assert.ok(transition.limitations.length, transition.id);
      if (transition.basis === 'static-call') {
        assert.ok(steps.get(transition.source)?.selector?.qualifiedName, transition.id);
        assert.ok(steps.get(transition.target)?.selector?.qualifiedName, transition.id);
      }
    }
  }
});

test('the sole source-order proof is two non-overlapping statements in the same selected procedure', () => {
  const anchors = new Map(model.anchors.map(anchor => [anchor.id, anchor]));
  for (const flow of model.flows) {
    const steps = new Map(flow.steps.map(step => [step.id, step]));
    for (const transition of flow.transitions.filter(item => item.basis === 'source-order')) {
      const source = steps.get(transition.source)!;
      const target = steps.get(transition.target)!;
      assert.deepEqual(source.selector, target.selector, 'caller proof cannot imply cross-file callee ordering');
      assert.ok(transition.condition);
      const sourceProofs = transition.anchorIds.filter(id => source.anchorIds.includes(id)).map(id => anchors.get(id)!);
      const targetProofs = transition.anchorIds.filter(id => target.anchorIds.includes(id)).map(id => anchors.get(id)!);
      assert.ok(sourceProofs.some(before => targetProofs.some(after => before.filePath === after.filePath && before.endLine < after.startLine)));
    }
  }
});

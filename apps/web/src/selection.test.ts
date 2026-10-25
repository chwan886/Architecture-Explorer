import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ArchitectureEdge, ArchitectureNode } from '../../../packages/schema/src/index';
import { applySelectionResponse, edgeForKeyboardActivation, isCurrentSelectionRequest, nodeForKeyboardActivation } from './selection';

const hp: ArchitectureNode = { id: 'field:hp', kind: 'field', label: 'hp', qualifiedName: 'SelectionFixture.Actor.hp', language: 'csharp', evidenceIds: [] };
const damage: ArchitectureNode = { id: 'function:damage', kind: 'function', label: 'damage', qualifiedName: 'Server.rules.damage', language: 'python', evidenceIds: [] };

test('programmatic selection notifications do not activate a graph node', () => {
  assert.equal(nodeForKeyboardActivation('', hp.id, [hp]), undefined);
  assert.equal(nodeForKeyboardActivation('Tab', hp.id, [hp]), undefined);
  assert.equal(nodeForKeyboardActivation('ArrowDown', hp.id, [hp]), undefined);
});

test('keyboard activation accepts Enter and Space only for current graph nodes', () => {
  assert.equal(nodeForKeyboardActivation('Enter', damage.id, [damage]), damage);
  assert.equal(nodeForKeyboardActivation(' ', damage.id, [damage]), damage);
  assert.equal(nodeForKeyboardActivation('Enter', hp.id, [damage]), undefined);
  assert.equal(nodeForKeyboardActivation('Enter', null, [damage]), undefined);
});

test('nested buttons and editable controls keep their own keyboard behavior', () => {
  assert.equal(nodeForKeyboardActivation('Enter', hp.id, [hp], true), undefined);
  assert.equal(nodeForKeyboardActivation(' ', hp.id, [hp], true), undefined);
});

test('HP to search damage regression: a delayed HP response never replaces damage', () => {
  const oldHp = { scopeId: 'game:main', nodeId: hp.id, sequence: 1 };
  const currentDamage = { scopeId: 'game:main', nodeId: damage.id, sequence: 3 };
  assert.equal(applySelectionResponse(damage, hp, oldHp, currentDamage), damage);
  assert.equal(applySelectionResponse(damage, hp, oldHp, oldHp), damage);
});

test('responses from an old worktree or request sequence are rejected', () => {
  const active = { scopeId: 'game:feature', nodeId: damage.id, sequence: 4 };
  assert.equal(isCurrentSelectionRequest({ ...active, scopeId: 'game:main' }, active), false);
  assert.equal(isCurrentSelectionRequest({ ...active, sequence: 3 }, active), false);
  const refreshed = { ...damage, signature: 'def damage(actor, amount)' };
  assert.equal(applySelectionResponse(damage, refreshed, { ...active, sequence: 3 }, active), damage);
});

test('a current response refreshes metadata without changing selection identity', () => {
  const request = { scopeId: 'game:main', nodeId: damage.id, sequence: 5 };
  const refreshed = { ...damage, signature: 'def damage(actor, amount)' };
  assert.equal(applySelectionResponse(damage, refreshed, request, request), refreshed);
  assert.equal(applySelectionResponse(damage, hp, request, request), damage);
  assert.equal(applySelectionResponse(undefined, refreshed, request, request), undefined);
});

test('keyboard relation activation accepts Enter and Space only for an edge in the current graph', () => {
  const edge: ArchitectureEdge = { id: 'edge:damage-reads-hp', source: damage.id, target: hp.id, kind: 'reads', confidence: 'static-confirmed', evidenceIds: [], rule: 'test:read' };
  assert.equal(edgeForKeyboardActivation('Enter', edge.id, [edge]), edge);
  assert.equal(edgeForKeyboardActivation(' ', edge.id, [edge]), edge);
  assert.equal(edgeForKeyboardActivation('Enter', 'edge:old-index', [edge]), undefined);
  assert.equal(edgeForKeyboardActivation('Enter', null, [edge]), undefined);
});

test('programmatic edge selection and nested controls cannot open relation evidence', () => {
  const edge: ArchitectureEdge = { id: 'edge:damage-reads-hp', source: damage.id, target: hp.id, kind: 'reads', confidence: 'static-confirmed', evidenceIds: [], rule: 'test:read' };
  assert.equal(edgeForKeyboardActivation('', edge.id, [edge]), undefined);
  assert.equal(edgeForKeyboardActivation('Tab', edge.id, [edge]), undefined);
  assert.equal(edgeForKeyboardActivation('Enter', edge.id, [edge], true), undefined);
  assert.equal(edgeForKeyboardActivation(' ', edge.id, [edge], true), undefined);
});

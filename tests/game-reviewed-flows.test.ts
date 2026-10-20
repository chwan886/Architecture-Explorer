import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ArchitectureModel, BusinessFlow } from '../packages/architecture-model/src/types.ts';
import type { SemanticDefinitions } from '../packages/semantic-model/src/types.ts';
import { validateModel } from '../packages/architecture-model/src/index.ts';
import { validateDefinitions } from '../packages/semantic-model/src/index.ts';

const model: ArchitectureModel = JSON.parse(await readFile(new URL('../architecture/models/game-demo-02/model.json', import.meta.url), 'utf8'));
const definitions: SemanticDefinitions = JSON.parse(await readFile(new URL('../architecture/semantics/game-demo-02/definitions.json', import.meta.url), 'utf8'));
validateModel(model); validateDefinitions(definitions);
const flow = (id: string): BusinessFlow => { const item = model.flows.find(f => f.id === id); assert.ok(item, id); return item; };
const semantic = (id: string) => { const item = definitions.flows.find(f => f.id === id); assert.ok(item, id); return item; };
const proof = (id: string) => { const item = model.anchors.find(a => a.id === id); assert.ok(item, id); return item.quote; };
const step = (id: string, node: string) => { const item = semantic(id).steps.find(s => s.id === node); assert.ok(item, node); return item; };
const edge = (id: string, source: string, target: string) => { const item = flow(id).transitions.find(e => e.source === source && e.target === target); assert.ok(item, `${source} → ${target}`); return item; };
const additions = ['sword-hit-resolution', 'forge-equip-operations', 'cultivation-breakthrough', 'mining-queue-progress', 'state-transaction-persistence'];

test('review adds five maintainable source-backed projections without rewriting the original two or approving candidates', () => {
  assert.deepEqual(model.flows.map(f => f.id), ['claim-reserve', 'battle-start-poll-result', ...additions]);
  assert.deepEqual(definitions.flows.map(f => f.sourceFlowId), model.flows.map(f => f.id));
  assert.deepEqual(model.reviews, [], 'Agent source review is never a human confirmation');
  for (const id of additions) {
    const original = flow(id), explanation = semantic(id);
    assert.ok(original.limitations.some(text => text.includes('候选') && text.includes('运行时')), id);
    assert.ok(explanation.groups.length < explanation.steps.length, 'simple view groups real detail, without replacing it');
    assert.deepEqual(explanation.groups.flatMap(g => g.childIds).sort(), original.steps.map(s => s.id).sort());
    for (const node of explanation.steps) {
      assert.equal(node.origin, 'curated');
      assert.ok(node.title && node.purpose && node.inputs.length && node.outputs.length && node.processing.length, node.id);
      assert.equal(node.bindings.length, 1);
      const binding = node.bindings[0], source = original.steps.find(s => node.sourceStepIds.includes(s.id));
      assert.ok(source);
      assert.deepEqual(binding.selector, source.selector, node.id);
      assert.equal(binding.role, 'implementation');
      assert.ok(binding.selector?.filePath && binding.selector.qualifiedName);
      assert.equal(binding.selector.filePathPrefix, undefined);
      assert.equal(binding.selector.qualifiedNamePrefix, undefined);
      assert.match(binding.expectedDeclarationHash ?? '', /^[a-f0-9]{64}$/);
      assert.ok(binding.anchorIds.length && binding.anchorIds.every(a => source.anchorIds.includes(a)));
    }
  }
});

test('static-call claims have a concrete invocation spelling and never turn phases in one command into self calls', () => {
  for (const f of model.flows) {
    const nodes = new Map(f.steps.map(s => [s.id, s]));
    for (const e of f.transitions.filter(e => e.basis === 'static-call')) {
      const from = nodes.get(e.source)!, to = nodes.get(e.target)!;
      assert.notEqual(from.selector?.qualifiedName, to.selector?.qualifiedName, e.id);
      const name = to.selector!.qualifiedName!.split('(')[0].split('.').at(-1)!;
      assert.match(name, /^\w+$/, `exact callee required for ${e.id}`);
      assert.ok(e.anchorIds.some(a => new RegExp(`\\b${name}\\s*\\(`).test(proof(a))), e.id);
    }
  }
});

test('flying sword keeps the unbound callback as a boundary while the local hit and damage calls remain explicit', () => {
  const id = 'sword-hit-resolution';
  assert.match(proof('review-flight-dispatch'), /advance\(b, dt, t, projectile_hit\)/);
  assert.match(proof('review-contact-gate'), /on_hit\(p,victim\)/);
  const callback = edge(id, 'sword-contact-gate', 'sword-hit-callback');
  assert.equal(callback.basis, 'narrative');
  assert.ok(callback.limitations.some(text => text.includes('动态') && text.includes('未验证')));
  assert.equal(edge(id, 'sword-hit-callback', 'sword-critical').basis, 'static-call');
  assert.equal(edge(id, 'sword-critical', 'sword-damage').basis, 'static-call');
  assert.ok(semantic(id).steps.every(s => s.controls.every(c => c.kind !== 'async')), 'a synchronous callback is not labeled asynchronous');
  assert.match(proof('review-contact-gate'), /if not p\['damageEnabled'\]:return/);
  assert.match(proof('review-contact-gate'), /if kind=='damage'/);
});

test('shield absorption, lethal early return and old-attachment-before-new-status semantics survive grouping', () => {
  const id = 'sword-hit-resolution';
  assert.match(proof('review-damage-rules'), /amount -= used/);
  assert.match(proof('review-damage-rules'), /max\(0\.0, a\['hp'\]-amount\)/);
  assert.ok(step(id, 'sword-damage').controls.some(c => c.description.includes('最终生命损失为0')));
  const survivor = step(id, 'sword-survivor');
  assert.ok(survivor.controls.some(c => c.kind === 'early-return' && c.description.includes('致死')));
  const quote = proof('review-hit-survivor');
  assert.ok(quote.indexOf('sect_reactions.match') < quote.indexOf('if on_hit_status:'), 'old attachments are checked before the new on-hit attachment');
  assert.equal(edge(id, 'sword-critical', 'sword-survivor').basis, 'source-order');
  assert.match(edge(id, 'sword-critical', 'sword-survivor').condition ?? '', /仍存活/);
  assert.match(proof('review-reaction-match'), /if not element: return None/);
  assert.match(proof('review-reaction-match'), /return None/);
});

test('crafting never implies automatic equip; equip and enhance stay mutually exclusive independent operations', () => {
  const id = 'forge-equip-operations', f = flow(id);
  assert.match(proof('review-craft-store'), /equipment.*append/);
  assert.doesNotMatch(proof('review-craft-store'), /p\[item\[.slot/);
  assert.ok(!f.transitions.some(e => e.source === 'forge-store' && ['forge-equip', 'forge-enhance'].includes(e.target)));
  assert.ok(!f.transitions.some(e => e.source === 'forge-equip' && e.target === 'forge-enhance'));
  assert.match(edge(id, 'forge-item-check', 'forge-equip').condition ?? '', /action == equip/);
  assert.match(edge(id, 'forge-item-check', 'forge-enhance').condition ?? '', /action == enhance/);
  assert.match(proof('review-item-transfer'), /m\[item\["slot"\]\] = ""/);
  assert.match(proof('review-item-transfer'), /p\[item\["slot"\]\] = item\["id"\]/);
  assert.equal(edge(id, 'forge-equip', 'forge-combat-stats').basis, 'request-boundary');
  assert.equal(edge(id, 'forge-enhance', 'forge-combat-stats').basis, 'request-boundary');
});

test('training, breakthrough and passive cultivation retain separate branch guards and one method maps to multiple steps', () => {
  const id = 'cultivation-breakthrough', f = flow(id);
  assert.ok(!f.transitions.some(e => e.source === 'growth-train-gain' && e.target.startsWith('growth-break')));
  assert.match(edge(id, 'growth-train-check', 'growth-train-gain').condition ?? '', /action == train/);
  assert.match(edge(id, 'growth-break-check', 'growth-break-gain').condition ?? '', /action == breakthrough/);
  assert.match(proof('review-passive-cultivation'), /activity.*== "cultivate"/);
  assert.match(proof('review-breakthrough-check'), /弟子境界不能超过掌门/);
  assert.equal(edge(id, 'growth-break-gain', 'growth-battle-stats').basis, 'request-boundary');
  const train = step(id, 'growth-train-pay'), breakthrough = step(id, 'growth-break-pay');
  assert.deepEqual(train.bindings[0].selector, breakthrough.bindings[0].selector);
  assert.equal(train.bindings[0].expectedDeclarationHash, breakthrough.bindings[0].expectedDeclarationHash);
  assert.notEqual(train.id, breakthrough.id, 'shared pay implementation does not force one-to-one semantic mapping');
});

test('active mining requires a later live request and preserves finite budget, incomplete work and independent cancel', () => {
  const id = 'mining-queue-progress';
  assert.equal(edge(id, 'mine-enqueue', 'mine-active').basis, 'request-boundary');
  assert.match(proof('review-mine-active'), /now-state\["seen"\] <= 10/);
  assert.match(proof('review-mine-active'), /min\(5, elapsed\)/);
  assert.match(proof('review-mine-active'), /min\(5, elapsed\)\*\(1\+\.3\*\(state\["facilities"\]\[1\]-1\)\)/);
  const active = step(id, 'mine-active');
  assert.match(active.purpose, /至多5秒经过时间.*乘矿务堂效率/);
  assert.ok(active.processing.some(text => text.includes('min(5,elapsed)') && text.includes('0.3')),
    'elapsed cap and workshop efficiency multiplication must remain distinct');
  assert.doesNotMatch(JSON.stringify([flow(id), semantic(id)]), /最多5秒(?:工作)?预算/,
    'the budget is scaled work, not a five-work-unit cap');
  assert.match(proof('review-mine-work'), /while budget > 0 and state\["queue"\]/);
  assert.match(proof('review-mine-work'), /tile\["work"\].*duration/);
  assert.match(proof('review-mine-work'), /break/);
  assert.match(edge(id, 'mine-work', 'mine-open').condition ?? '', /没有break/);
  assert.equal(edge(id, 'mine-enqueue', 'mine-cancel').basis, 'request-boundary');
  assert.match(proof('review-dig-cancel'), /state\["queue"\] = \[\]/);
  assert.doesNotMatch(proof('review-dig-cancel'), /\["work"\] =/);
  assert.match(proof('review-dig-check'), /tile\["kind"\] != "guard"/);
  assert.match(proof('review-map-frontier'), /tile\["kind"\] = "unknown"/);
});

test('transaction explanation preserves early replay/conflict responses, settled rollback and conditional persistence', () => {
  const id = 'state-transaction-persistence';
  const guards = proof('review-request-guards');
  assert.match(guards, /if prior:/); assert.match(guards, /return self\.response_state/); assert.match(guards, /revision_conflict/);
  assert.match(edge(id, 'state-request-guards', 'state-settled-copy').condition ?? '', /没有重放或冲突提前返回/);
  const branch = proof('review-transaction-command');
  assert.match(branch, /except RuleError/); assert.match(branch, /state = settled/);
  assert.match(proof('review-account-write'), /if data is not None and ok: state\['revision'\] \+= 1/);
  assert.match(proof('review-account-write'), /if encode\(state\) != row\['state'\]/);
  assert.match(proof('review-request-receipt'), /if payload is not None:/);
  assert.equal(edge(id, 'state-response-shape', 'state-public-snapshot').basis, 'narrative');
  assert.ok(step(id, 'state-response-shape').controls.some(c => c.description.includes('互斥')));
});

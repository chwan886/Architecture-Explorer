import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SemanticStore } from '../apps/server/src/semantic-store.ts';
import { mergeGroups, splitGroup, editSemanticText, generateCandidateFlow } from '../packages/semantic-content/src/index.ts';
import { validateDefinitions, semanticRevision } from '../packages/semantic-model/src/validation.ts';
import type { SemanticDefinitions, SemanticOverlay } from '../packages/semantic-model/src/types.ts';
import type { ArchitectureModel } from '../packages/architecture-model/src/types.ts';
import type { LoadedConfig } from '../packages/indexer/src/config.ts';
import { canonical } from '../packages/indexer/src/security.ts';
import { contentHash } from '../packages/schema/src/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seed: unknown = JSON.parse(await readFile(path.join(root, 'architecture/semantics/game-demo-02/definitions.json'), 'utf8'));
validateDefinitions(seed);
const definitions: SemanticDefinitions = seed;
const architecture: ArchitectureModel = JSON.parse(await readFile(path.join(root, 'architecture/models/game-demo-02/model.json'), 'utf8'));
const original = definitions.flows[0];
const clone = <T>(value: T): T => structuredClone(value);

test('curated two-flow seed covers all 35 original steps with six/seven summary groups and precise implementation bindings', () => {
  assert.deepEqual(definitions.flows.map(flow => flow.groups.length), [6, 7]);
  assert.equal(definitions.flows.flatMap(flow => flow.steps).length, 35);
  const anchors = new Set(architecture.anchors.map(anchor => anchor.id));
  for (const flow of definitions.flows) {
    const source = architecture.flows.find(item => item.id === flow.sourceFlowId)!;
    assert.ok(source);
    assert.deepEqual(flow.steps.flatMap(step => step.sourceStepIds).sort(), source.steps.map(step => step.id).sort());
    for (const node of [...flow.groups, ...flow.steps]) {
      assert.equal(node.origin, 'curated');
      assert.ok(node.purpose && node.summary && node.detail && node.processing.length);
    }
    for (const step of flow.steps) {
      const sourceStep = source.steps.find(item => item.id === step.sourceStepIds[0])!;
      assert.equal(step.bindings.length, 1);
      const binding = step.bindings[0];
      assert.equal(binding.role, 'implementation');
      assert.equal(binding.selector?.qualifiedName, sourceStep.selector?.qualifiedName);
      assert.ok(binding.selector?.filePath);
      assert.equal(binding.selector?.qualifiedNamePrefix, undefined);
      assert.equal(binding.selector?.filePathPrefix, undefined);
      assert.match(binding.expectedDeclarationHash ?? '', /^[a-f0-9]{64}$/);
      assert.ok(binding.anchorIds.every(id => anchors.has(id)));
      assert.ok(step.controls.every(control => control.anchorIds.every(id => anchors.has(id))));
    }
  }
});

test('merge/split preserve every detailed implementation and control while changing only summary grouping', () => {
  const before = clone(original);
  const merged = mergeGroups(original, original.groups.slice(0, 2).map(group => group.id), '请求意图与传输');
  assert.deepEqual(original, before);
  assert.equal(merged.groups.length, original.groups.length - 1);
  assert.deepEqual(merged.steps, before.steps);
  const mergedGroup = merged.groups[0];
  assert.equal(mergedGroup.origin, 'human-edited');
  const divided = splitGroup(merged, mergedGroup.id, [mergedGroup.childIds[0]], '单独的用户入口');
  validateDefinitions({ ...definitions, flows: [divided] });
  assert.deepEqual(divided.steps, before.steps);
  assert.deepEqual(divided.groups.flatMap(group => group.childIds).sort(), original.steps.map(step => step.id).sort());
  assert.throws(() => mergeGroups(original, [original.groups[0].id, original.groups[0].id]));
  assert.throws(() => splitGroup(original, original.groups[0].id, original.groups[0].childIds));
  assert.throws(() => splitGroup(original, original.groups[0].id, ['unknown']));
});

test('offline rule candidate is explicit, repeatable and preserves source mapping rather than creating relationships', () => {
  const before = clone(original);
  const proposed = generateCandidateFlow(original);
  assert.deepEqual(original, before);
  assert.ok([...proposed.groups, ...proposed.steps].every(node => node.origin === 'rule-generated'));
  assert.deepEqual(generateCandidateFlow(proposed), proposed);
  for (let i = 0; i < proposed.steps.length; i++) {
    assert.deepEqual(proposed.steps[i].bindings, original.steps[i].bindings);
    assert.deepEqual(proposed.steps[i].sourceStepIds, original.steps[i].sourceStepIds);
    assert.deepEqual(proposed.steps[i].controls, original.steps[i].controls);
  }
  proposed.steps[0].bindings[0].anchorIds.push('draft-only');
  assert.deepEqual(original, before, 'editing a proposal cannot mutate the source definition');
});

test('text edits cannot rewrite bindings, identities or asynchronous boundaries', () => {
  const edited = editSemanticText(original, original.steps[0].id, { purpose: '人工补充的目的' });
  assert.equal(edited.steps[0].purpose, '人工补充的目的');
  assert.equal(edited.steps[0].origin, 'human-edited');
  assert.deepEqual(edited.steps[0].bindings, original.steps[0].bindings);
  assert.deepEqual(edited.steps[0].controls, original.steps[0].controls);
  assert.throws(() => editSemanticText(original, original.steps[0].id, { bindings: [] } as never));
  assert.throws(() => editSemanticText(original, 'missing', { title: '不存在' }));
});

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(root, '.cache/semantic-store-test-'));
  assert.ok(directory.startsWith(path.join(root, '.cache') + path.sep));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const toolRoot = path.join(directory, 'tool');
  const projectRoot = path.join(directory, 'project');
  const worktreeRoot = path.join(directory, 'feature');
  await Promise.all([mkdir(toolRoot), mkdir(projectRoot), mkdir(worktreeRoot)]);
  const config: LoadedConfig = { toolRoot, cacheDir: path.join(toolRoot, '.cache'), configPath: path.join(toolRoot, 'config.json'), fingerprint: 'fixture', port: 4310,
    projects: [{ id: 'fixture', name: 'Fixture', root: projectRoot, worktrees: [worktreeRoot], include: ['src'], exclude: [] }] };
  const store = new SemanticStore(config);
  const definitionRoot = path.join(toolRoot, 'architecture/semantics/fixture');
  const scope = 'fixture:primary';
  const feature = `fixture:wt-${contentHash(canonical(worktreeRoot)).slice(0, 12)}`;
  const writeSeed = async () => { await mkdir(definitionRoot, { recursive: true }); await writeFile(path.join(definitionRoot, 'definitions.json'), JSON.stringify({ ...definitions, projectId: 'fixture' })); };
  return { directory, toolRoot, projectRoot, worktreeRoot, definitionRoot, config, store, scope, feature, writeSeed };
}

test('missing semantic files return empty candidates without creating directories; authorization rejects foreign scopes', async t => {
  const f = await fixture(t);
  const envelope = await f.store.read('fixture', f.scope);
  assert.deepEqual(envelope.effectiveFlows, []);
  assert.deepEqual(envelope.overlay.reviews, []);
  assert.deepEqual(await readdir(f.toolRoot), []);
  await assert.rejects(f.store.read('../foreign', '../foreign:primary'), { statusCode: 403 });
  await assert.rejects(f.store.read('fixture', 'fixture:wt-unlisted'), { statusCode: 403 });
  await assert.rejects(f.store.save('fixture', 'other:primary', envelope.overlayRevision, overlay => overlay), { statusCode: 403 });
});

test('scoped overlays preserve source seeds, separate Worktrees and maintain store-owned audit history', async t => {
  const f = await fixture(t); await f.writeSeed();
  const current = await f.store.read('fixture', f.scope);
  const draft = editSemanticText(current.effectiveFlows[0], current.effectiveFlows[0].steps[0].id, { title: '当前分支人工说明' });
  const saved = await f.store.save('fixture', f.scope, current.overlayRevision, overlay => {
    overlay.flowOverrides = [draft];
    overlay.reviews = [{ flowId: draft.id, targetType: 'node', targetId: draft.steps[0].id, fingerprint: 'a'.repeat(64), decision: 'confirmed', reviewedAt: new Date().toISOString() }];
    overlay.history = [{ id: 'forged', at: new Date().toISOString(), operation: 'forged', flowId: draft.id, previousRevision: 'b'.repeat(64), supersededIds: [] }];
    return overlay;
  });
  assert.equal(saved.effectiveFlows[0].steps[0].title, '当前分支人工说明');
  assert.equal(saved.definitions.flows[0].steps[0].title, original.steps[0].title);
  assert.equal(saved.overlay.reviews[0].decision, 'confirmed');
  assert.equal(saved.overlay.history.length, 1);
  assert.notEqual(saved.overlay.history[0].id, 'forged');
  assert.equal(saved.overlay.history[0].previousRevision, current.overlayRevision);
  const other = await f.store.read('fixture', f.feature);
  assert.equal(other.effectiveFlows[0].steps[0].title, original.steps[0].title);
  assert.deepEqual(other.overlay.reviews, []);
  assert.deepEqual(await readdir(f.projectRoot), [], 'target fixture remains untouched');
  assert.deepEqual(await readdir(f.worktreeRoot), []);
});

test('two store instances cannot both save an old revision; failed transform leaves last valid overlay intact', async t => {
  const f = await fixture(t); await f.writeSeed();
  const current = await f.store.read('fixture', f.scope);
  const second = new SemanticStore(f.config);
  const save = (store: SemanticStore, title: string) => store.save('fixture', f.scope, current.overlayRevision, overlay => {
    overlay.flowOverrides = [{ ...original, title }]; return overlay;
  });
  const results = await Promise.allSettled([save(f.store, '窗口一'), save(second, '窗口二')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.some(result => result.status === 'rejected' && result.reason.statusCode === 409));
  const saved = await f.store.read('fixture', f.scope);
  const file = path.join(f.definitionRoot, 'worktrees/primary.json');
  const bytes = await readFile(file, 'utf8');
  await assert.rejects(f.store.save('fixture', f.scope, current.overlayRevision, overlay => overlay), { statusCode: 409 });
  await assert.rejects(f.store.save('fixture', f.scope, saved.overlayRevision, () => { throw new Error('draft failed'); }), /draft failed/);
  await assert.rejects(f.store.save('fixture', f.scope, saved.overlayRevision, overlay => ({ ...overlay, scopeId: f.feature })), { statusCode: 403 });
  await assert.rejects(f.store.save('fixture', f.scope, saved.overlayRevision, overlay => ({ ...overlay, unexpected: true })), /Schema/);
  assert.equal(await readFile(file, 'utf8'), bytes);
  assert.deepEqual((await readdir(path.dirname(file))).sort(), ['primary.json']);
});

test('audit history is bounded and seed refresh does not overwrite human overrides or reviews', async t => {
  const f = await fixture(t); await f.writeSeed();
  const current = await f.store.read('fixture', f.scope);
  const historical: SemanticOverlay = { ...current.overlay, flowOverrides: [{ ...original, title: '保留人工标题' }],
    history: Array.from({ length: 100 }, (_, i) => ({ id: `old-${i}`, at: '2026-10-20T12:00:00Z', operation: 'edit-flow', flowId: original.id, previousRevision: 'a'.repeat(64), supersededIds: [] })) };
  await mkdir(path.join(f.definitionRoot, 'worktrees'), { recursive: true });
  await writeFile(path.join(f.definitionRoot, 'worktrees/primary.json'), JSON.stringify(historical));
  await writeFile(path.join(f.definitionRoot, 'definitions.json'), JSON.stringify({ ...definitions, projectId: 'fixture', flows: definitions.flows.map(flow => ({ ...flow, title: '新版候选标题' })) }));
  const read = await f.store.read('fixture', f.scope);
  assert.equal(read.effectiveFlows[0].title, '保留人工标题');
  assert.notEqual(read.definitionRevision, read.overlay.baseDefinitionRevision);
  const saved = await f.store.save('fixture', f.scope, semanticRevision(historical), overlay => overlay);
  assert.equal(saved.overlay.history.length, 100);
  assert.equal(saved.overlay.history[0].id, 'old-1');
  assert.equal(saved.effectiveFlows[0].title, '保留人工标题');
});

test('before-commit guard and concurrent seed changes preserve the last valid overlay', async t => {
  const f = await fixture(t); await f.writeSeed();
  const initial = await f.store.read('fixture', f.scope);
  const saved = await f.store.save('fixture', f.scope, initial.overlayRevision, overlay => ({ ...overlay, flowOverrides: [clone(original)] }));
  const file = path.join(f.definitionRoot, 'worktrees/primary.json');
  const bytes = await readFile(file, 'utf8');
  await assert.rejects(f.store.save('fixture', f.scope, saved.overlayRevision, overlay => overlay,
    async () => { throw Object.assign(new Error('source changed before commit'), { statusCode: 409 }); }), { statusCode: 409 });
  assert.equal(await readFile(file, 'utf8'), bytes);
  await assert.rejects(f.store.save('fixture', f.scope, saved.overlayRevision, overlay => overlay, async () => {
    await writeFile(path.join(f.definitionRoot, 'definitions.json'), JSON.stringify({ ...definitions, projectId: 'fixture', flows: definitions.flows.map(flow => ({ ...flow, title: '并发基础变更' })) }));
  }), { statusCode: 409 });
  assert.equal(await readFile(file, 'utf8'), bytes);
  assert.deepEqual(await readdir(path.dirname(file)), ['primary.json']);
});

test('semantic storage rejects junction ancestors', async t => {
  const f = await fixture(t); await f.writeSeed();
  const outside = path.join(f.directory, 'outside'); await mkdir(outside);
  const linkedDirectory = path.join(f.definitionRoot, 'worktrees');
  try { await symlink(outside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('当前沙箱无法创建测试目录联接'); return; } throw error; }
  await assert.rejects(f.store.read('fixture', f.scope), /符号链接|目录联接/);
  await assert.rejects(f.store.save('fixture', f.scope, 'a'.repeat(64), overlay => overlay), /符号链接|目录联接/);
  assert.deepEqual(await readdir(outside), []);
});

test('semantic storage rejects a linked overlay file instead of reading or replacing its target', async t => {
  const f = await fixture(t); await f.writeSeed();
  const current = await f.store.read('fixture', f.scope);
  const outside = path.join(f.directory, 'unrelated.json');
  const text = JSON.stringify(current.overlay); await writeFile(outside, text);
  await mkdir(path.join(f.definitionRoot, 'worktrees'));
  const link = path.join(f.definitionRoot, 'worktrees/primary.json');
  try { await symlink(outside, link, 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('当前沙箱无法创建测试文件符号链接'); return; } throw error; }
  await assert.rejects(f.store.read('fixture', f.scope), /符号链接|目录联接/);
  await assert.rejects(f.store.save('fixture', f.scope, current.overlayRevision, overlay => overlay), /符号链接|目录联接/);
  assert.equal(await readFile(outside, 'utf8'), text);
});

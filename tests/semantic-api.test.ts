import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from '../apps/server/src/server.ts';
import { IndexManager, loadConfig, TOOL_ROOT } from '../packages/indexer/src/index.ts';
import { runWorker } from '../packages/indexer/src/workers.ts';
import { declarationHash } from '../packages/semantic-model/src/index.ts';
import { ArchitectureService } from '../apps/server/src/architecture.ts';
import { SemanticService } from '../apps/server/src/semantics.ts';
import type { SemanticBundle, SemanticEditorEnvelope, SemanticFlowDefinition } from '../packages/semantic-model/src/types.ts';
import type { ArchitectureModel } from '../packages/architecture-model/src/types.ts';

const source = 'def apply(amount):\n    return reward(amount)\n\ndef reward(value):\n    return value\n';
const headers = { host: '127.0.0.1:4310' };
const writeHeaders = { ...headers, origin: 'http://127.0.0.1:4310', 'content-type': 'application/json' };
const text = (title: string) => ({ title, summary: title, purpose: title, detail: title, inputs: [], processing: [], outputs: [], changes: [] });
async function fixture() {
  const temp = path.join(TOOL_ROOT, '.tmp'); await mkdir(temp, { recursive: true });
  const directory = await mkdtemp(path.join(temp, 'semantic-api-'));
  const tool = path.join(directory, 'tool'), target = path.join(directory, 'target'), feature = path.join(directory, 'feature');
  await mkdir(tool);
  for (const root of [target, feature]) { await mkdir(path.join(root, 'src'), { recursive: true }); await writeFile(path.join(root, 'src/actions.py'), source); }
  const configPath = path.join(directory, 'projects.json');
  await writeFile(configPath, JSON.stringify({ projects: [{ id: 'semantic-fixture', name: 'Semantic fixture', root: './target', worktrees: ['./feature'], include: ['src'], exclude: [] }], cacheDir: './tool/cache', port: 4310 }));
  const config = { ...await loadConfig(configPath), toolRoot: tool };
  const manager = new IndexManager(config, { worker: (language, input, settings) => runWorker(language, input, { ...settings, toolRoot: TOOL_ROOT }) });
  await manager.initialize(); for (const scope of manager.scopes.values()) await manager.requestScan(scope.id);
  const primary = 'semantic-fixture:primary', other = [...manager.scopes.keys()].find(id => id !== primary)!;
  const index = manager.scope(primary).index!;
  assert.ok(index, JSON.stringify(manager.scope(primary).status));
  const nodes = ['apply', 'reward'].map(name => index.nodes.find(node => node.qualifiedName === `src.actions.${name}`)!);
  const model: ArchitectureModel = { schemaVersion: '1.0.0', projectId: 'semantic-fixture', name: 'Fixture', systems: [], modules: [], memberships: [], anchors: [], reviews: [], flows: [{ id: 'action-flow', name: 'Action', description: 'Real Python call', trigger: 'Explicit function call', systemIds: [], lanes: [{ id: 'python', name: 'Python' }], steps: nodes.map((node, i) => ({ id: `source-${i}`, laneId: 'python', phase: i, name: node.label, description: node.label, selector: { qualifiedName: node.qualifiedName }, anchorIds: [], reads: [], writes: [] })), transitions: [{ id: 'invoke', source: 'source-0', target: 'source-1', basis: 'static-call', anchorIds: [], limitations: [] }], limitations: [] }] };
  const flow: SemanticFlowDefinition = { id: 'action-flow', sourceFlowId: 'action-flow', title: '处理请求', description: '真实函数调用的解释', groups: [{ id: 'summary', childIds: ['apply-step', 'reward-step'], ...text('处理并返回'), origin: 'curated' }], steps: nodes.map((node, i) => ({ id: i ? 'reward-step' : 'apply-step', ...text(i ? '返回数据' : '传递参数'), sourceStepIds: [`source-${i}`], bindings: [{ id: `binding-${i}`, sourceStepId: `source-${i}`, role: 'implementation', anchorIds: [], expectedDeclarationHash: declarationHash(index, node.id, { 'src/actions.py': source }) }], controls: [], origin: 'curated' })) };
  await mkdir(path.join(tool, 'architecture/models/semantic-fixture'), { recursive: true }); await writeFile(path.join(tool, 'architecture/models/semantic-fixture/model.json'), JSON.stringify(model));
  await mkdir(path.join(tool, 'architecture/semantics/semantic-fixture'), { recursive: true }); await writeFile(path.join(tool, 'architecture/semantics/semantic-fixture/definitions.json'), JSON.stringify({ schemaVersion: '1.0.0', projectId: 'semantic-fixture', flows: [flow] }));
  const app = await createServer(manager);
  const url = (route = '', scope = primary, query: Record<string, string> = {}) => '/api/semantics' + route + '?' + new URLSearchParams({ scope, ...query });
  const get = (route = '', scope = primary, query: Record<string, string> = {}) => app.inject({ url: url(route, scope, query), headers });
  const bundle = async (scope = primary) => { const response = await get('', scope); assert.equal(response.statusCode, 200, response.body); return response.json<SemanticBundle>(); };
  const envelope = async (scope = primary) => { const response = await get('/model', scope); assert.equal(response.statusCode, 200, response.body); return response.json<SemanticEditorEnvelope>(); };
  const post = (route: string, payload: Record<string, unknown>, scope = primary) => app.inject({ method: 'POST', url: url(route, scope), headers: writeHeaders, payload });
  const close = async () => { await app.close(); assert.ok(directory.startsWith(path.join(TOOL_ROOT, '.tmp', 'semantic-api-'))); await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); };
  return { directory, tool, target, app, manager, primary, other, nodes, flow, url, get, bundle, envelope, post, close };
}

test('semantic API keeps exact facts, code evidence, optimistic edits and worktree reviews separate', async () => {
  const f = await fixture();
  try {
    const initial = await f.bundle(), envelope = await f.envelope(); const node = initial.flow!.detailNodes[0];
    assert.deepEqual(envelope.metadata, initial.metadata, 'editor GET returns the complete baseline from the same projection');
    assert.equal(node.status, 'current'); assert.equal(initial.flow!.detailEdges[0].verification, 'static-confirmed');
    const reverse = await f.get('/reverse', f.primary, { nodeId: f.nodes[0].id }); assert.equal(reverse.statusCode, 200); assert.deepEqual(reverse.json().matches[0].nodeIds, [node.id]);
    const proof = await f.get('/evidence/' + node.evidenceIds[0], f.primary, { viewRevision: initial.metadata.viewRevision });
    assert.equal(proof.statusCode, 200, proof.body); assert.match(proof.json().content, /def apply/); assert.equal(proof.json().revision, initial.metadata.sourceRevision);
    assert.equal((await f.get('/evidence/' + node.evidenceIds[0], f.other)).statusCode, 404);
    const review = await f.post('/review', { expectedOverlayRevision: envelope.overlayRevision, viewRevision: initial.metadata.viewRevision, flowId: initial.flow!.id, targetType: 'node', targetId: node.id, decision: 'confirmed' });
    assert.equal(review.statusCode, 200, review.body); assert.equal((await f.bundle()).flow!.detailNodes[0].reviewState, 'confirmed'); assert.equal((await f.envelope(f.other)).overlay.reviews.length, 0);
    const current = await f.bundle(), saved = await f.envelope();
    const changed = structuredClone(f.flow); changed.steps[0].title = '人工修订标题';
    const put = (payload: Record<string, unknown>) => f.app.inject({ method: 'PUT', url: f.url('/model'), headers: writeHeaders, payload });
    const payload = { expectedOverlayRevision: saved.overlayRevision, viewRevision: current.metadata.viewRevision, flow: changed };
    const edit = await put(payload); assert.equal(edit.statusCode, 200, edit.body); assert.equal((await f.bundle()).flow!.detailNodes[0].title, '人工修订标题');
    const updated = edit.json<SemanticEditorEnvelope>();
    assert.equal(updated.metadata.overlayRevision, updated.overlayRevision);
    assert.deepEqual(updated.metadata, (await f.bundle()).metadata, 'save response pins the new full version tuple');
    assert.equal((await put(payload)).statusCode, 409); assert.equal((await f.bundle()).flow!.detailNodes[0].reviewState, 'needs-review');
    const next = structuredClone(changed); next.steps[1].detail = '第二次保存无需等待父视图刷新';
    const repeat = await put({ expectedOverlayRevision: updated.overlayRevision, viewRevision: updated.metadata.viewRevision, flow: next });
    assert.equal(repeat.statusCode, 200, repeat.body);
    const newer = await f.bundle(); const beforeGeneration = (await f.envelope()).overlayRevision;
    const generated = await f.post('/generate', { flowId: newer.flow!.id, nodeId: node.id, viewRevision: newer.metadata.viewRevision }); assert.equal(generated.statusCode, 200, generated.body); assert.equal(generated.json().origin, 'rule-generated');
    assert.equal((await f.envelope()).overlayRevision, beforeGeneration, 'candidate generation must not overwrite human edits');
    const rebuilt = await f.post('/rebuild', { flowId: newer.flow!.id, viewRevision: newer.metadata.viewRevision }); assert.equal(rebuilt.statusCode, 200, rebuilt.body); assert.equal(rebuilt.json().flow.detailNodes[0].title, '人工修订标题');
    assert.equal((await f.get('', f.primary, { viewRevision: initial.metadata.viewRevision })).statusCode, 409);
  } finally { await f.close(); }
});

test('semantic API invalidates locally changed declarations, rejects mixed evidence and unauthorized mutations', async () => {
  const f = await fixture();
  try {
    const initial = await f.bundle(), saved = await f.envelope(), node = initial.flow!.detailNodes[0];
    const reviewInput = { expectedOverlayRevision: saved.overlayRevision, viewRevision: initial.metadata.viewRevision, flowId: initial.flow!.id, targetType: 'node', targetId: node.id, decision: 'confirmed' };
    assert.equal((await f.post('/review', reviewInput)).statusCode, 200);
    await writeFile(path.join(f.target, 'src/actions.py'), source + '\ndef unrelated():\n    return 123\n'); await f.manager.requestScan(f.primary);
    const unrelated = await f.bundle(); assert.equal(unrelated.flow!.detailNodes[0].reviewState, 'confirmed');
    await writeFile(path.join(f.target, 'src/actions.py'), source.replace('reward(amount)', 'reward(amount + 1)')); await f.manager.requestScan(f.primary);
    const changed = await f.bundle(); assert.equal(changed.flow!.detailNodes[0].status, 'stale'); assert.equal(changed.flow!.detailNodes[0].reviewState, 'needs-review'); assert.equal(changed.flow!.detailNodes[1].status, 'current');
    assert.equal((await f.post('/review', { ...reviewInput, expectedOverlayRevision: (await f.envelope()).overlayRevision, viewRevision: changed.metadata.viewRevision })).statusCode, 409);
    assert.equal((await f.get('/evidence/' + node.evidenceIds[0], f.primary, { viewRevision: initial.metadata.viewRevision })).statusCode, 409);
    const rebased = structuredClone(f.flow); rebased.steps[0].bindings[0].expectedDeclarationHash = changed.flow!.detailNodes[0].bindings[0].declarationHash;
    const rebase = await f.app.inject({ method: 'PUT', url: f.url('/model'), headers: writeHeaders, payload: { expectedOverlayRevision: (await f.envelope()).overlayRevision, viewRevision: changed.metadata.viewRevision, flow: rebased } });
    assert.equal(rebase.statusCode, 200, rebase.body); assert.equal((await f.bundle()).flow!.detailNodes[0].status, 'current'); assert.equal((await f.bundle()).flow!.detailNodes[0].reviewState, 'needs-review', 'adopting a new code baseline must not silently confirm the explanation');
    const evidence = changed.flow!.detailNodes[1].evidenceIds[0], runtime = f.manager.scope(f.primary), previous = runtime.index!, read = f.manager.evidence.bind(f.manager);
    f.manager.evidence = async (...args) => { const result = await read(...args); runtime.index = { ...previous, metadata: { ...previous.metadata, revision: 'changed-during-read' } }; return result; };
    assert.equal((await f.get('/evidence/' + evidence)).statusCode, 409); runtime.index = previous;
    assert.equal((await f.get('', 'unconfigured:primary')).statusCode, 403);
    assert.equal((await f.get('/evidence/../../outside.py')).statusCode, 404);
    assert.equal((await f.app.inject({ url: f.url(), headers: { host: 'attacker.example:4310' } })).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'POST', url: f.url('/review'), headers, payload: reviewInput })).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'PUT', url: f.url('/model'), headers: { ...writeHeaders, origin: 'https://attacker.example' }, payload: {} })).statusCode, 403);
  } finally { await f.close(); }
});

test('semantic maintenance cannot remove control/detail facts or accept a model changed between review and commit', async () => {
  const f = await fixture();
  try {
    const initial = await f.bundle(), saved = await f.envelope();
    const put = (flow: SemanticFlowDefinition) => f.app.inject({ method: 'PUT', url: f.url('/model'), headers: writeHeaders, payload: { expectedOverlayRevision: saved.overlayRevision, viewRevision: initial.metadata.viewRevision, flow } });
    const deleted = structuredClone(f.flow); deleted.steps.pop(); deleted.groups[0].childIds.pop();
    assert.equal((await put(deleted)).statusCode, 400);
    const forged = structuredClone(f.flow); forged.steps[0].bindings[0].expectedDeclarationHash = '0'.repeat(64);
    assert.equal((await put(forged)).statusCode, 400);
    const hiddenBoundary = structuredClone(f.flow); hiddenBoundary.steps[0].controls.push({ kind: 'async', anchorIds: [], description: 'invented async boundary' });
    assert.equal((await put(hiddenBoundary)).statusCode, 400);
    assert.equal((await f.envelope()).overlayRevision, saved.overlayRevision);
    const architecture = new ArchitectureService(f.manager), service = new SemanticService(f.manager, architecture);
    const runtime = f.manager.scope(f.primary), context = await service.current(runtime), save = service.store.save.bind(service.store);
    const modelPath = path.join(f.tool, 'architecture/models/semantic-fixture/model.json');
    service.store.save = async (...args) => { const model = structuredClone(context.model); model.name = 'Changed after live guard'; await writeFile(modelPath, JSON.stringify(model)); return save(...args); };
    await assert.rejects(service.review(runtime, { expectedOverlayRevision: context.envelope.overlayRevision, viewRevision: context.projection.metadata.viewRevision, flowId: f.flow.id, targetType: 'node', targetId: initial.flow!.detailNodes[0].id, decision: 'confirmed' }), (error: unknown) => (error as { statusCode: number }).statusCode === 409);
    assert.equal((await f.envelope()).overlay.reviews.length, 0, 'mixed model fingerprint must never be committed');
  } finally { await f.close(); }
});

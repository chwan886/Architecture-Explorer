import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from '../apps/server/src/server.ts';
import { IndexManager, loadConfig, TOOL_ROOT } from '../packages/indexer/src/index.ts';
import { runWorker } from '../packages/indexer/src/workers.ts';
import { contentHash } from '../packages/schema/src/index.ts';
import type { ArchitectureModel, ArchitectureView, ModelEnvelope, OwnershipResult } from '../packages/architecture-model/src/types.ts';

// Explicit API fixtures are confined to the tool's .tmp directory. These tests
// exercise real Fastify routes, persistence, IndexManager and the Python parser.
const source = 'def apply(amount):\n    return reward(amount)\n\ndef reward(value):\n    return value\n';
const headers = { host: '127.0.0.1:4310' };
const writeHeaders = { ...headers, origin: 'http://127.0.0.1:4310', 'content-type': 'application/json' };
const copy = <T>(value: T): T => structuredClone(value);

async function fixture() {
  const temp = path.join(TOOL_ROOT, '.tmp'); await mkdir(temp, { recursive: true });
  const directory = await mkdtemp(path.join(temp, 'architecture-api-'));
  const tool = path.join(directory, 'tool'); const target = path.join(directory, 'target'); const feature = path.join(directory, 'feature');
  await mkdir(tool);
  for (const root of [target, feature]) {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src/combat.py'), source);
    await writeFile(path.join(root, 'src/unclassified.py'), 'def untouched():\n    return True\n');
  }
  await writeFile(path.join(target, 'outside.py'), 'not_authorized = True\n');
  const configPath = path.join(directory, 'projects.json');
  await writeFile(configPath, JSON.stringify({ projects: [{ id: 'api-fixture', name: 'API fixture', root: './target', worktrees: ['./feature'], include: ['src'], exclude: [] }], cacheDir: './tool/cache', port: 4310 }));
  const config = { ...await loadConfig(configPath), toolRoot: tool };
  let workerCalls = 0;
  const worker = async (...args: Parameters<typeof runWorker>) => { workerCalls++; return runWorker(args[0], args[1], { ...args[2], toolRoot: TOOL_ROOT }); };
  const manager = new IndexManager(config, { worker }); await manager.initialize();
  for (const scope of manager.scopes.values()) await manager.requestScan(scope.id);
  const primary = 'api-fixture:primary'; const other = [...manager.scopes.keys()].find(id => id !== primary)!;
  assert.ok(other);
  assert.ok([...manager.scopes.values()].every(scope => scope.status.state === 'synced'));
  const app = await createServer(manager);
  const url = (route: string, scope = primary, query: Record<string, string> = {}) => '/api/architecture' + route + '?' + new URLSearchParams({ scope, ...query });
  const get = (route = '', scope = primary, query: Record<string, string> = {}) => app.inject({ url: url(route, scope, query), headers });
  const envelope = async () => { const result = await get('/model'); assert.equal(result.statusCode, 200, result.body); return result.json<ModelEnvelope>(); };
  const view = async (scope = primary, query: Record<string, string> = {}) => { const result = await get('', scope, query); assert.equal(result.statusCode, 200, result.body); return result.json<ArchitectureView>(); };
  const put = async (model: ArchitectureModel, expectedRevision?: string, scope = primary) => app.inject({ method: 'PUT', url: url('/model', scope), headers: writeHeaders,
    payload: { expectedRevision: expectedRevision ?? (await envelope()).modelRevision, model } });
  const review = async (targetType: 'system' | 'membership' | 'flow', targetId: string, decision: 'confirmed' | 'rejected' | 'pending', scope = primary) => {
    const current = await view(scope); const saved = await envelope();
    return app.inject({ method: 'POST', url: url('/review', scope), headers: writeHeaders,
      payload: { expectedModelRevision: saved.modelRevision, viewRevision: current.metadata.viewRevision, targetType, targetId, decision } });
  };
  const index = manager.scope(primary).index!;
  const model: ArchitectureModel = { schemaVersion: '1.0.0', projectId: 'api-fixture', name: 'API business architecture',
    systems: ['combat', 'rewards'].map(id => ({ id, name: id, responsibility: id + ' responsibility', features: [], inputs: [], outputs: [], keyData: [], kind: 'business', anchorIds: id === 'combat' ? ['apply-source'] : [] })),
    modules: [{ id: 'actor', systemId: 'combat', name: 'Actor', responsibility: 'Issue intent', inputs: [], outputs: [], anchorIds: [] },
      { id: 'rules', systemId: 'rewards', name: 'Rules', responsibility: 'Resolve request', inputs: [], outputs: [], anchorIds: [] }],
    memberships: [{ id: 'apply-owner', systemId: 'combat', moduleId: 'actor', selector: { qualifiedName: 'src.combat.apply' }, role: 'owner', origin: 'curated', anchorIds: [] },
      { id: 'reward-owner', systemId: 'rewards', moduleId: 'rules', selector: { qualifiedName: 'src.combat.reward' }, role: 'owner', origin: 'curated', anchorIds: [] }],
    anchors: [{ id: 'apply-source', filePath: 'src/combat.py', startLine: 1, endLine: 1, expectedFileHash: index.files.find(f => f.path === 'src/combat.py')!.hash,
      quote: 'def apply(amount):', description: 'Verified current function declaration' }], flows: [], reviews: [] };
  const install = async () => { const result = await put(model); assert.equal(result.statusCode, 200, result.body); return result.json<ModelEnvelope>(); };
  const close = async () => {
    await app.close(); assert.ok(directory.startsWith(path.join(TOOL_ROOT, '.tmp', 'architecture-api-')));
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  };
  return { directory, tool, target, feature, config, manager, app, primary, other, model, url, get, put, view, envelope, review, install, close, calls: () => workerCalls };
}

test('architecture API reads an independent empty model, saves atomically and rejects stale optimistic revisions', async () => {
  const f = await fixture();
  try {
    const empty = await f.envelope(); assert.equal(empty.model.systems.length, 0);
    const before = f.calls(); const sourceRevision = f.manager.scope(f.primary).index!.metadata.revision;
    const saved = await f.install(); assert.notEqual(saved.modelRevision, empty.modelRevision);
    assert.equal(f.calls(), before, 'model save must not scan or parse source');
    assert.equal(f.manager.scope(f.primary).index!.metadata.revision, sourceRevision);
    const disk = JSON.parse(await readFile(path.join(f.tool, 'architecture/models/api-fixture/model.json'), 'utf8'));
    assert.equal(disk.name, f.model.name);
    const stale = await f.put({ ...f.model, name: 'stale overwrite' }, empty.modelRevision);
    assert.equal(stale.statusCode, 409); assert.equal((await f.envelope()).model.name, f.model.name);
    const wrongProject = await f.put({ ...f.model, projectId: 'another' }); assert.equal(wrongProject.statusCode, 400);
    const graph = await f.view(); assert.equal(graph.graph.nodes.length, 2); assert.ok(graph.unclassifiedCount > 0);
    assert.equal(graph.relations.length, 1); assert.equal(graph.relations[0].membershipPending, true);
  } finally { await f.close(); }
});

test('architecture API enforces authorized Scope, Host and Origin on GET/PUT/review', async () => {
  const f = await fixture();
  try {
    const saved = await f.install();
    assert.equal((await f.get('', 'unconfigured:primary')).statusCode, 403);
    assert.equal((await f.app.inject({ url: f.url('/model'), headers: { host: 'attacker.example:4310' } })).statusCode, 403);
    assert.equal((await f.app.inject({ url: f.url('/model'), headers: { ...headers, origin: 'https://attacker.example' } })).statusCode, 403);
    const payload = { expectedRevision: saved.modelRevision, model: f.model };
    assert.equal((await f.app.inject({ method: 'PUT', url: f.url('/model'), headers, payload })).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'PUT', url: f.url('/model'), headers: { ...writeHeaders, origin: 'https://attacker.example' }, payload })).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'POST', url: f.url('/review'), headers, payload: {} })).statusCode, 403);
    assert.equal((await f.get('/ownership', f.primary, { nodeId: 'unconfigured-node' })).statusCode, 404);
    assert.equal((await f.get('/evidence/../../outside.py')).statusCode, 404);
  } finally { await f.close(); }
});

test('source anchors require current indexed hashes, real quotes and authorized paths', async () => {
  const f = await fixture();
  try {
    await f.install();
    for (const mutate of [
      (model: ArchitectureModel) => { model.anchors[0].quote = 'forged statement'; },
      (model: ArchitectureModel) => { model.anchors[0].quote = 'apply'; },
      (model: ArchitectureModel) => { model.anchors[0].filePath = 'outside.py'; },
      (model: ArchitectureModel) => { model.anchors[0].filePath = '../outside.py'; },
      (model: ArchitectureModel) => { model.anchors[0].startLine = 999; model.anchors[0].endLine = 999; },
    ]) { const forged = copy(f.model); mutate(forged); assert.equal((await f.put(forged)).statusCode, 400); }
    const oldHash = copy(f.model); oldHash.anchors[0].expectedFileHash = contentHash('different source'); assert.equal((await f.put(oldHash)).statusCode, 409);
    const current = await f.view(); const entity = await f.get('/entities/combat', f.primary, { viewRevision: current.metadata.viewRevision });
    assert.equal(entity.statusCode, 200, entity.body);
    const anchor = entity.json().evidence.find((item: { rule: string }) => item.rule === 'architecture:curated-source-anchor'); assert.ok(anchor);
    const proof = await f.get('/evidence/' + encodeURIComponent(anchor.id), f.primary, { viewRevision: current.metadata.viewRevision });
    assert.equal(proof.statusCode, 200, proof.body); assert.equal(proof.json().stale, false); assert.match(proof.json().content, /def apply/);
    const featureProof = await f.get('/evidence/' + encodeURIComponent(anchor.id), f.other); assert.equal(featureProof.statusCode, 404);
    // A model file edited outside the API is still checked before source claims
    // become a view; valid hashes do not make forged quote text authoritative.
    const forged = copy(f.model); forged.anchors[0].quote = 'forged statement';
    await writeFile(path.join(f.tool, 'architecture/models/api-fixture/model.json'), JSON.stringify(forged));
    assert.equal((await f.get()).statusCode, 400);
  } finally { await f.close(); }
});

test('raw architecture evidence rejects a scan revision change before or during the underlying read', async () => {
  const f = await fixture();
  const scope = f.manager.scope(f.primary); const previous = scope.index!;
  const readEvidence = f.manager.evidence.bind(f.manager);
  try {
    await f.install(); const current = await f.view();
    const proofId = previous.nodes.find(node => node.qualifiedName === 'src.combat.apply')!.evidenceIds[0];
    const next = { ...previous, metadata: { ...previous.metadata, revision: previous.metadata.revision + '-next' } };
    for (const changeBeforeRead of [true, false]) {
      scope.index = previous;
      f.manager.evidence = async (...args) => {
        if (changeBeforeRead) scope.index = next;
        const value = await readEvidence(...args);
        if (!changeBeforeRead) scope.index = next;
        return value;
      };
      const response = await f.get('/evidence/' + encodeURIComponent(proofId), f.primary, { viewRevision: current.metadata.viewRevision });
      assert.equal(response.statusCode, 409, `changed ${changeBeforeRead ? 'before' : 'during'} raw read: ${response.body}`);
    }
  } finally { f.manager.evidence = readEvidence; scope.index = previous; await f.close(); }
});

test('system and membership reviews persist separately and do not carry across authorized Worktrees', async () => {
  const f = await fixture();
  try {
    await f.install();
    assert.equal((await f.review('system', 'combat', 'confirmed')).statusCode, 200);
    let current = await f.view();
    assert.equal(current.entities.find(e => e.id === 'combat')!.reviewState, 'confirmed');
    const node = f.manager.scope(f.primary).index!.nodes.find(n => n.qualifiedName === 'src.combat.apply')!;
    let owner = (await f.get('/ownership', f.primary, { nodeId: node.id })).json<OwnershipResult>();
    assert.equal(owner.owners[0].reviewState, 'pending');
    assert.equal((await f.review('membership', 'apply-owner', 'confirmed')).statusCode, 200);
    owner = (await f.get('/ownership', f.primary, { nodeId: node.id })).json<OwnershipResult>(); assert.equal(owner.owners[0].reviewState, 'confirmed');
    const feature = await f.view(f.other); assert.equal(feature.entities.find(e => e.id === 'combat')!.reviewState, 'pending');
    assert.equal((await f.review('system', 'combat', 'confirmed', f.other)).statusCode, 200);
    const reviews = (await f.envelope()).model.reviews;
    assert.equal(reviews.filter(r => r.targetType === 'system' && r.targetId === 'combat').length, 2);
    assert.equal((await f.review('system', 'combat', 'pending')).statusCode, 200);
    const saved = await f.envelope();
    assert.ok(saved.model.reviews.some(r => r.scopeId === f.other && r.targetType === 'system'));
    assert.ok(!saved.model.reviews.some(r => r.scopeId === f.primary && r.targetType === 'system'));
    assert.ok(saved.model.reviews.some(r => r.scopeId === f.primary && r.targetType === 'membership'));
    const disk = JSON.parse(await readFile(path.join(f.tool, 'architecture/models/api-fixture/model.json'), 'utf8')) as ArchitectureModel;
    assert.deepEqual(disk.reviews, saved.model.reviews);
    assert.equal((await f.get('/ownership', f.other, { nodeId: node.id })).statusCode, 404);
  } finally { await f.close(); }
});

test('incremental source changes invalidate reviews, refresh actual system edges and reject older view revisions', async () => {
  const f = await fixture();
  try {
    await f.install(); assert.equal((await f.review('membership', 'apply-owner', 'confirmed')).statusCode, 200);
    const previous = await f.view(); const relation = previous.relations.find(item => item.kinds.includes('calls')); assert.ok(relation);
    const page = await f.get('/relations/' + encodeURIComponent(relation.id), f.primary, { viewRevision: previous.metadata.viewRevision, limit: '1' });
    assert.equal(page.statusCode, 200, page.body);
    assert.equal(page.json().edges.length, 1);
    assert.ok(relation.memberEdgeIds.includes(page.json().edges[0].id), 'pagination returns an actual member regardless of relation ordering');
    const members = await f.get('/relations/' + encodeURIComponent(relation.id), f.primary, { viewRevision: previous.metadata.viewRevision, limit: '100' });
    assert.equal(members.statusCode, 200, members.body);
    assert.ok(members.json().edges.some((edge: { kind: string }) => edge.kind === 'calls'), 'the removed invocation is present before the edit');
    await writeFile(path.join(f.target, 'src/combat.py'), 'def apply(amount):\n    return amount\n\ndef reward(value):\n    return value\n');
    await f.manager.requestScan(f.primary); assert.equal(f.manager.scope(f.primary).status.state, 'synced');
    const current = await f.view(); assert.notEqual(current.metadata.viewRevision, previous.metadata.viewRevision);
    assert.equal(current.relations.length, 0, 'removed call must remove the derived system edge');
    assert.ok(current.diagnostics.some(d => d.code === 'anchor-needs-review'));
    const node = f.manager.scope(f.primary).index!.nodes.find(n => n.qualifiedName === 'src.combat.apply')!;
    const owner = (await f.get('/ownership', f.primary, { nodeId: node.id })).json<OwnershipResult>();
    assert.equal(owner.owners[0].reviewState, 'needs-review'); assert.ok(current.unclassifiedCount > 0);
    for (const route of ['/entities/combat', '/relations/' + encodeURIComponent(relation.id), '/evidence/old-id']) {
      assert.equal((await f.get(route, f.primary, { viewRevision: previous.metadata.viewRevision })).statusCode, 409, route);
    }
    const staleReview = await f.app.inject({ method: 'POST', url: f.url('/review'), headers: writeHeaders,
      payload: { expectedModelRevision: (await f.envelope()).modelRevision, viewRevision: previous.metadata.viewRevision, targetType: 'membership', targetId: 'apply-owner', decision: 'confirmed' } });
    assert.equal(staleReview.statusCode, 409);
  } finally { await f.close(); }
});

test('model confirmation rejects changed disk content before indexing and cache deletion does not delete the model', async () => {
  const f = await fixture();
  try {
    await f.install(); const previous = await f.view(); const saved = await f.envelope();
    await writeFile(path.join(f.target, 'src/combat.py'), source + '# changed outside last index\n');
    const result = await f.app.inject({ method: 'POST', url: f.url('/review'), headers: writeHeaders,
      payload: { expectedModelRevision: saved.modelRevision, viewRevision: previous.metadata.viewRevision, targetType: 'membership', targetId: 'apply-owner', decision: 'confirmed' } });
    assert.equal(result.statusCode, 409);
    const cachePath = f.manager.scope(f.primary).cachePath;
    assert.ok(cachePath.startsWith(path.join(f.tool, 'cache')));
    await rm(cachePath, { recursive: true, force: true });
    assert.equal((await f.envelope()).modelRevision, saved.modelRevision);
    assert.equal((await f.envelope()).model.systems.length, 2);
  } finally { await f.close(); }
});

test('model persistence refuses a directory junction escaping the fixture tool root', async t => {
  const f = await fixture();
  try {
    const outside = path.join(f.directory, 'outside-models'); await mkdir(path.join(outside, 'api-fixture'), { recursive: true });
    const sentinel = JSON.stringify(f.model); const destination = path.join(outside, 'api-fixture/model.json'); await writeFile(destination, sentinel);
    await mkdir(path.join(f.tool, 'architecture'));
    try { await symlink(outside, path.join(f.tool, 'architecture/models'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('沙箱禁止创建目录链接，需在允许 junction 的环境补验'); return; } throw error; }
    assert.notEqual((await f.get('/model')).statusCode, 200);
    const result = await f.put(f.model, 'not-used'); assert.equal(result.statusCode, 403, result.body);
    assert.equal(await readFile(destination, 'utf8'), sentinel);
  } finally { await f.close(); }
});

test('architecture model SSE events notify only the current project and disconnect removes listeners', { timeout: 10000 }, async () => {
  const f = await fixture();
  let client: ReturnType<typeof httpRequest> | undefined;
  let stream: import('node:http').IncomingMessage | undefined;
  try {
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 }); let text = '';
    const ready = new Promise<void>((resolve, reject) => {
      client = httpRequest(address + '/api/events?scope=' + encodeURIComponent(f.primary), { headers }, response => {
        stream = response; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; if (text.includes('data: ')) resolve(); }); response.on('error', reject);
      }); client.on('error', reject); client.end();
    });
    await ready; assert.equal(f.manager.listenerCount('architecture-model'), 1);
    f.manager.emit('architecture-model', { projectId: 'another-project', modelRevision: 'must-not-appear' });
    assert.ok(!text.includes('must-not-appear'));
    const saved = await f.install();
    for (let attempt = 0; attempt < 100 && !text.includes('event: architecture-model'); attempt++) await new Promise(done => setTimeout(done, 10));
    assert.match(text, /event: architecture-model/); assert.ok(text.includes(saved.modelRevision)); assert.ok(text.includes(f.primary));
    stream!.destroy(); client!.destroy();
    for (let attempt = 0; attempt < 100 && f.manager.listenerCount('architecture-model'); attempt++) await new Promise(done => setTimeout(done, 10));
    assert.equal(f.manager.listenerCount('architecture-model'), 0);
  } finally { stream?.destroy(); client?.destroy(); await f.close(); }
});

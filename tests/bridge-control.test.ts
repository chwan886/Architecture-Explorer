import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import Fastify from 'fastify';
import { registerBridgeRoutes } from '../apps/server/src/bridge-control.ts';
import type { LoadedConfig } from '../packages/indexer/src/config.ts';
import type { IndexManager } from '../packages/indexer/src/indexer.ts';
import { TOOL_ROOT } from '../packages/indexer/src/config.ts';
import type { AnalysisPresentation, BrowserBootstrap, BrowserCurrent, PresentationReceipt, QueryService, ResolvedPresentation, BridgeRuntime, ViewSession } from '../packages/control-protocol/src/types.ts';

const scope = 'fixture:primary';
const presentation = (id = 'fixture-presentation'): AnalysisPresentation => ({ schemaVersion: '1.0', presentationId: id, projectId: 'fixture', worktreeId: 'primary',
  snapshotId: 'fixture-snapshot', indexSnapshotId: 'fixture-index', title: '明确测试夹具', summary: '只用于broker测试，不是产品代码关系。',
  targetView: 'code', viewMode: 'code', semanticGranularity: 'simple', focusNodeId: { layer: 'code', id: 'symbol:fixture' }, highlightedNodeIds: [{ layer: 'code', id: 'symbol:fixture' }],
  highlightedEdgeIds: [], orderedSteps: [], evidenceIds: ['proof:fixture'], warnings: [], createdAt: new Date().toISOString() });
async function fixture(t: test.TestContext, existing?: string) {
  const base = path.join(TOOL_ROOT, '.tmp'); await mkdir(base, { recursive: true });
  const directory = existing ?? await mkdtemp(path.join(base, 'bridge-control-'));
  assert.ok(directory.startsWith(base + path.sep));
  if (!existing) t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }));
  const toolRoot = path.join(directory, 'tool'), target = path.join(directory, 'target');
  await mkdir(toolRoot, { recursive: true }); await mkdir(target, { recursive: true });
  const config: LoadedConfig = { toolRoot, cacheDir: path.join(toolRoot, '.cache'), configPath: path.join(toolRoot, 'config.json'), fingerprint: 'fixture', port: 4310,
    projects: [{ id: 'fixture', name: 'Fixture', root: target, include: ['src'], exclude: [], worktrees: [] }] };
  const manager = { config, scope(id: string) { if (id !== scope) throw Object.assign(new Error('scope not authorized'), { statusCode: 403 }); return { id }; } } as unknown as IndexManager;
  let stale = false;
  const calls: string[] = [];
  const resolved = (p: AnalysisPresentation): ResolvedPresentation => ({ presentation: p,
    snapshot: { snapshotId: p.snapshotId, indexSnapshotId: p.indexSnapshotId, projectId: 'fixture', worktreeId: 'primary', scopeId: scope,
      architectureRevision: 'fixture-architecture', semanticViewRevision: 'fixture-semantic', expiresAt: new Date(Date.now() + 600000).toISOString(), indexState: 'synced' },
    codeGraph: { nodes: [{ id: 'symbol:fixture', kind: 'function', label: 'fixture', qualifiedName: 'fixture.real', language: 'python', evidenceIds: [] }], edges: [], totalNodes: 1, truncated: false, revision: p.indexSnapshotId },
    highlights: { codeNodeIds: ['symbol:fixture'], codeEdgeIds: [], semanticNodeIds: [], semanticEdgeIds: [], architectureNodeIds: [], architectureEdgeIds: [] }, warnings: [],
    evidence: { evidence: { id: 'proof:fixture', filePath: 'src/fixture.py', startLine: 1, endLine: 1, startColumn: 1, endColumn: 2, fileHash: 'a'.repeat(64), rule: 'test' }, content: 'x', stale: false, revision: p.indexSnapshotId } });
  const query: QueryService = { async dispatch(operation, args) { calls.push(operation); return { operation, args }; }, async resolve(p) { calls.push('resolve'); if (stale) throw Object.assign(new Error('snapshot changed'), { code: 'STALE_SNAPSHOT', statusCode: 409 }); return resolved(p); } };
  const app = Fastify({ forceCloseConnections: true });
  app.setErrorHandler((error, _request, reply) => { const value = error as Error & { code?: string; statusCode?: number }; reply.code(value.statusCode ?? 500).send({ code: value.code, error: value.message }); });
  const broker = await registerBridgeRoutes(app, manager, query);
  t.after(() => app.close());
  const privatePost = (operation: string, args: Record<string, unknown> = {}, token = broker.identity.token) => app.inject({ method: 'POST', url: '/api/bridge/private/control', headers: { authorization: `Bearer ${token}` }, payload: { operation, arguments: args } });
  const browser = async (cookie?: string) => {
    const response = await app.inject({ url: '/api/bridge/browser/bootstrap', headers: cookie ? { cookie } : {} }); assert.equal(response.statusCode, 200, response.body);
    const bootstrap = response.json<BrowserBootstrap>(); const setCookie = response.headers['set-cookie'];
    const owner = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
    const post = (route: string, body: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/bridge/browser/${route}`, headers: { cookie: owner }, payload: { sessionId: bootstrap.sessionId, csrf: bootstrap.csrf, ...body } });
    const state = (patch: Record<string, unknown> = {}) => post('state', { state: { ...bootstrap.state, userRevision: 1, allowControl: true, scopeId: scope, ...patch } });
    const current = () => app.inject({ url: `/api/bridge/browser/current?sessionId=${bootstrap.sessionId}`, headers: { cookie: owner } });
    return { bootstrap, cookie: owner, post, state, current };
  };
  const attach = async (sessionId: string) => { const response = await privatePost('attach_view_session', { sessionId }); assert.equal(response.statusCode, 200, response.body); return response.json<{ bindingId: string; session: ViewSession }>(); };
  return { app, broker, query, resolved, directory, config, target, browser, privatePost, attach, calls, setStale(value: boolean) { stale = value; } };
}

test('private bearer authentication is independent of spoofed Origin and hello proves the exact server epoch', async t => {
  const f = await fixture(t);
  const denied = await f.app.inject({ method: 'POST', url: '/api/bridge/private/query', headers: { origin: 'http://127.0.0.1:4310' }, payload: { operation: 'list_projects', arguments: {} } });
  assert.equal(denied.statusCode, 401); assert.deepEqual(f.calls, []);
  assert.equal((await f.privatePost('list_view_sessions', {}, 'wrong')).statusCode, 401);
  const nonce = randomBytes(32).toString('hex'); const answer = await f.app.inject({ url: `/api/bridge/hello?nonce=${nonce}` });
  assert.equal(answer.json().proof, createHmac('sha256', f.broker.identity.token).update(nonce + '|' + f.broker.identity.serverEpoch).digest('hex'));
  assert.equal((await f.app.inject({ url: '/api/bridge/hello?nonce=bad' })).statusCode, 400);
  const ok = await f.app.inject({ method: 'POST', url: '/api/bridge/private/query', headers: { authorization: `Bearer ${f.broker.identity.token}` }, payload: { operation: 'list_projects', arguments: {} } });
  assert.equal(ok.statusCode, 200); assert.deepEqual(f.calls, ['list_projects']);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/bridge/private/query', headers: { authorization: `Bearer ${f.broker.identity.token}` }, payload: { operation: 'list_projects', arguments: null } })).statusCode, 400);
});

test('cookie owner supports multiple document sessions, CSRF and explicit opt-in while rejecting session hijack or lease stealing', async t => {
  const f = await fixture(t), one = await f.browser(), two = await f.browser(one.cookie), attacker = await f.browser();
  assert.notEqual(one.bootstrap.sessionId, two.bootstrap.sessionId); assert.equal(one.cookie, two.cookie);
  assert.equal(one.bootstrap.state.allowControl, false);
  assert.equal((await f.privatePost('attach_view_session', { sessionId: one.bootstrap.sessionId })).statusCode, 409);
  assert.equal((await attacker.post('state', { sessionId: one.bootstrap.sessionId, state: one.bootstrap.state })).statusCode, 403);
  assert.equal((await one.post('state', { csrf: 'bad', state: one.bootstrap.state })).statusCode, 403);
  assert.equal((await one.state()).statusCode, 200); assert.equal((await two.state()).statusCode, 200);
  assert.equal((await f.privatePost('submit', { presentation: presentation() })).json().code, 'AMBIGUOUS_SESSION');
  const attached = await f.attach(one.bootstrap.sessionId);
  assert.ok(attached.bindingId);
  assert.equal((await f.privatePost('attach_view_session', { sessionId: one.bootstrap.sessionId })).json().code, 'SESSION_BUSY');
  const listed = await f.privatePost('list_view_sessions');
  assert.equal(listed.json().sessions.length, 2); assert.ok(listed.json().sessions.every((session: ViewSession) => !session.bindingId));
});

test('submit, received and presented are distinct; final ACK must prove actual source and visible focus at matching versions', async t => {
  const f = await fixture(t), browser = await f.browser(); await browser.state(); const attached = await f.attach(browser.bootstrap.sessionId);
  const args = { presentation: presentation(), commandId: 'command-proof', bindingId: attached.bindingId };
  const submitted = await f.privatePost('submit', args); assert.equal(submitted.statusCode, 200, submitted.body); assert.equal(submitted.json().status, 'pending');
  assert.deepEqual((await f.privatePost('submit', args)).json(), submitted.json(), 'same command and payload is idempotent');
  assert.equal((await f.privatePost('submit', { ...args, presentation: presentation('different') })).statusCode, 409);
  const current = (await browser.current()).json<BrowserCurrent>(); assert.equal(current.command?.resolved.presentation.presentationId, args.presentation.presentationId);
  const common = { commandId: args.commandId, userRevision: 1, controlRevision: 0 };
  assert.equal((await browser.post('ack', { ...common, status: 'received' })).json().status, 'received');
  const actual = { scopeId: scope, indexSnapshotId: 'fixture-index', focusNodeId: args.presentation.focusNodeId, visibleNodeIds: ['symbol:fixture'], visibleEdgeIds: [], evidenceId: 'proof:fixture' };
  assert.equal((await browser.post('ack', { ...common, controlRevision: 1, status: 'presented', actual: { ...actual, evidenceId: 'other-proof' } })).statusCode, 409);
  assert.equal((await browser.post('ack', { ...common, controlRevision: 1, status: 'presented', actual: { ...actual, visibleNodeIds: [] } })).statusCode, 409);
  const applied = await browser.post('ack', { ...common, controlRevision: 1, status: 'presented', actual });
  assert.equal(applied.statusCode, 200, applied.body); assert.equal(applied.json().status, 'presented');
  assert.equal((await browser.post('ack', { ...common, controlRevision: 1, status: 'presented', actual })).statusCode, 200);
  assert.equal((await browser.post('ack', { ...common, controlRevision: 1, status: 'presented', actual: { ...actual, scopeId: 'other:primary' } })).statusCode, 409);
  assert.equal((await f.privatePost('submit', { presentation: presentation('new'), bindingId: attached.bindingId })).json().code, 'REVISION_REQUIRED');
});

test('manual revision wins pending races; clear has its own explicit notification and leaving cannot be undone by old heartbeats', async t => {
  const f = await fixture(t), browser = await f.browser(); await browser.state(); const attached = await f.attach(browser.bootstrap.sessionId);
  await f.privatePost('submit', { presentation: presentation(), commandId: 'race', bindingId: attached.bindingId });
  await browser.state({ userRevision: 2 });
  assert.equal((await f.privatePost('status', { commandId: 'race' })).json().status, 'conflict');
  assert.equal((await browser.post('ack', { commandId: 'race', status: 'presented', userRevision: 1, controlRevision: 1, actual: {} })).statusCode, 409);
  const clearArgs = { bindingId: attached.bindingId, expectedUserRevision: 2, expectedControlRevision: 0, commandId: 'clear-race' };
  const cleared = await f.privatePost('clear', clearArgs); assert.equal(cleared.statusCode, 200, cleared.body); assert.equal(cleared.json().action, 'clear');
  assert.equal((await f.privatePost('clear', clearArgs)).statusCode, 200, 'idempotent clear precedes old CAS check');
  const current = (await browser.current()).json<BrowserCurrent>(); assert.equal(current.command, undefined); assert.equal(current.pending?.action, 'clear');
  await browser.post('leave', {});
  assert.equal((await browser.state({ userRevision: 2, controlRevision: 1 })).statusCode, 409, 'late opt-in heartbeat cannot reopen control');
  assert.equal((await browser.state({ userRevision: 3, controlRevision: 1 })).statusCode, 200, 'new explicit user authorization may reopen');
  assert.equal((await f.privatePost('submit', { presentation: presentation(), bindingId: attached.bindingId, expectedUserRevision: 3, expectedControlRevision: 1 })).statusCode, 409, 'old lease is revoked');
});

test('offline latest-only pending is persisted and delivered only on explicit opt-in plus attach, with fresh resolve', async t => {
  const f = await fixture(t);
  const first = await f.privatePost('submit', { presentation: presentation('first'), commandId: 'offline-one' });
  assert.equal(first.json().status, 'pending'); assert.match(first.json().openUrl, /^http:\/\/127\.0\.0\.1:4310\/\?bridge=/);
  await f.privatePost('submit', { presentation: presentation('second'), commandId: 'offline-two' });
  assert.equal((await f.privatePost('status', { commandId: 'offline-one' })).json().status, 'superseded');
  const browser = await f.browser(); await browser.state();
  assert.equal((await browser.current()).json<BrowserCurrent>().command, undefined, 'opt-in alone does not steal a pending command');
  assert.equal((await f.privatePost('submit', { presentation: presentation('late') })).json().code, 'SESSION_REQUIRED');
  await f.attach(browser.bootstrap.sessionId);
  assert.equal((await browser.current()).json<BrowserCurrent>().command?.commandId, 'offline-two');
  assert.ok(f.calls.filter(call => call === 'resolve').length >= 4);
  assert.deepEqual(await readdir(f.target), [], 'target remains read-only');
});

test('restart does not restore browser identities or replay stale snapshots; runtime cleanup only removes its own epoch', async t => {
  const f = await fixture(t); await f.privatePost('submit', { presentation: presentation(), commandId: 'restart-pending' });
  const originalEpoch = f.broker.identity.serverEpoch;
  await f.app.close(); const restarted = await fixture(t, f.directory); restarted.setStale(true);
  assert.notEqual(restarted.broker.identity.serverEpoch, originalEpoch);
  const browser = await restarted.browser(); await browser.state(); await restarted.attach(browser.bootstrap.sessionId);
  assert.equal((await restarted.privatePost('status', { commandId: 'restart-pending' })).json().status, 'failed');
  assert.equal((await browser.current()).json<BrowserCurrent>().command, undefined);
  await restarted.broker.files.write('runtime.json', { schemaVersion: '1.0', port: 4310, token: 'fixture-only', serverEpoch: 'later-instance' });
  await restarted.app.close();
  const remaining = JSON.parse((await restarted.broker.files.read('runtime.json'))!.toString('utf8'));
  assert.equal(remaining.serverEpoch, 'later-instance');
});

test('a persisted clear receipt survives restart without inventing a presentation or browser session', async t => {
  const first = await fixture(t), browser = await first.browser(); await browser.state(); const attached = await first.attach(browser.bootstrap.sessionId);
  const result = await first.privatePost('clear', { bindingId: attached.bindingId, commandId: 'durable-clear', expectedUserRevision: 1, expectedControlRevision: 0 });
  assert.equal(result.statusCode, 200, result.body); await first.app.close();
  const second = await fixture(t, first.directory);
  const status = await second.privatePost('status', { commandId: 'durable-clear' });
  assert.equal(status.statusCode, 200, status.body); assert.equal(status.json().action, 'clear'); assert.equal(status.json().status, 'superseded');
  const fresh = await second.browser(); assert.equal((await fresh.current()).json<BrowserCurrent>().command, undefined);
});

test('TTL and stale source snapshots reject successful presentation instead of applying current source as old analysis', async t => {
  const f = await fixture(t), browser = await f.browser(); await browser.state(); const attached = await f.attach(browser.bootstrap.sessionId);
  await f.privatePost('submit', { presentation: presentation(), bindingId: attached.bindingId, commandId: 'stale-source' });
  f.setStale(true);
  const current = await browser.current(); assert.equal(current.json<BrowserCurrent>().command, undefined); assert.equal(current.json<BrowserCurrent>().pending?.status, 'expired');
  f.setStale(false);
  const clock = Date.now; Date.now = () => clock() + 6 * 60_000;
  try { assert.equal((await f.privatePost('status', { commandId: 'stale-source' })).json().status, 'expired'); assert.equal((await browser.current()).statusCode, 409); }
  finally { Date.now = clock; }
});

test('architecture ACK uses rendered IDs and ordered-step evidence can be the selected source', async t => {
  const f = await fixture(t), browser = await f.browser(); await browser.state(); const attached = await f.attach(browser.bootstrap.sessionId);
  const item = presentation('architecture-proof'); item.targetView = 'systems'; item.viewMode = 'explanation';
  item.focusNodeId = { layer: 'architecture', id: 'logical-system' }; item.highlightedNodeIds = [item.focusNodeId]; item.evidenceIds = [];
  item.orderedSteps = [{ id: 'read-proof', name: '阅读证据', codeNodeIds: [], codeEdgeIds: [], inputs: [], outputs: [], evidenceIds: ['proof:fixture'], verification: 'unverified', orderBasis: 'reading-order' }];
  f.query.resolve = async p => {
    const result = f.resolved(p);
    const graph = { nodes: [{ id: 'architecture:rendered', kind: 'system' as const, label: '系统', qualifiedName: '系统', language: 'unknown' as const, evidenceIds: [] }], edges: [], totalNodes: 1, truncated: false, revision: p.indexSnapshotId };
    result.architecture = { graph, entities: [{ id: 'logical-system', nodeId: 'architecture:rendered' }] } as unknown as NonNullable<ResolvedPresentation['architecture']>;
    result.highlights.architectureNodeIds = ['architecture:rendered']; return result;
  };
  assert.equal((await f.privatePost('submit', { presentation: item, bindingId: attached.bindingId, commandId: 'architecture-command' })).statusCode, 200);
  const actual = { scopeId: scope, indexSnapshotId: item.indexSnapshotId, focusNodeId: item.focusNodeId, visibleNodeIds: ['architecture:rendered'], visibleEdgeIds: [], evidenceId: 'proof:fixture' };
  const ack = await browser.post('ack', { commandId: 'architecture-command', userRevision: 1, controlRevision: 1, status: 'presented', actual });
  assert.equal(ack.statusCode, 200, ack.body);
});

test('linked bridge directories are refused before any credential or queue write', async t => {
  const f = await fixture(t); const outside = path.join(f.directory, 'outside'); await mkdir(outside);
  const cache = path.join(f.config.cacheDir, 'bridge'); await mkdir(path.dirname(cache), { recursive: true });
  try { await symlink(outside, cache, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('沙箱不能创建测试目录联接'); return; } throw error; }
  await assert.rejects(f.broker.publishRuntime(), /符号链接|目录联接/);
  assert.deepEqual(await readdir(outside), []);
});

test('runtime is explicitly published with protected permissions and SSE only sends replayable hints with graceful close', async t => {
  const f = await fixture(t);
  await f.app.listen({ host: '127.0.0.1', port: 0 });
  const address = f.app.server.address(); assert.ok(address && typeof address !== 'string');
  await f.broker.publishRuntime(address.port);
  const runtime = JSON.parse((await f.broker.files.read('runtime.json'))!.toString('utf8')) as BridgeRuntime;
  assert.equal(runtime.port, address.port); assert.equal(runtime.serverEpoch, f.broker.identity.serverEpoch);
  const browser = await f.browser(); const abort = new AbortController();
  const stream = await fetch(`http://127.0.0.1:${address.port}/api/bridge/browser/events?sessionId=${browser.bootstrap.sessionId}`, { headers: { cookie: browser.cookie }, signal: abort.signal });
  const reader = stream.body!.getReader(); const first = await reader.read(); const chunk = new TextDecoder().decode(first.value);
  assert.match(chunk, /event: control/); assert.match(chunk, /id: \d+/); assert.ok(!chunk.includes('resolved'));
  await f.app.close(); const ended = await reader.read(); assert.equal(ended.done, true); abort.abort();
  assert.equal(await f.broker.files.read('runtime.json'), undefined);
});

test('runtime publication is serialized across server instances and cannot replace a live instance on another port', async t => {
  const first = await fixture(t), second = await fixture(t, first.directory);
  await first.app.listen({ host: '127.0.0.1', port: 0 }); await second.app.listen({ host: '127.0.0.1', port: 0 });
  const addressOne = first.app.server.address(), addressTwo = second.app.server.address();
  assert.ok(addressOne && typeof addressOne !== 'string' && addressTwo && typeof addressTwo !== 'string');
  const results = await Promise.allSettled([first.broker.publishRuntime(addressOne.port), second.broker.publishRuntime(addressTwo.port)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.some(result => result.status === 'rejected' && ['RUNTIME_LOCKED', 'RUNTIME_IN_USE'].includes(result.reason.code)));
  const runtime = JSON.parse((await first.broker.files.read('runtime.json'))!.toString('utf8')) as BridgeRuntime;
  const winner = runtime.serverEpoch === first.broker.identity.serverEpoch ? first : second, loser = winner === first ? second : first;
  const loserAddress = loser.app.server.address(); assert.ok(loserAddress && typeof loserAddress !== 'string');
  await assert.rejects(loser.broker.publishRuntime(loserAddress.port), { code: 'RUNTIME_IN_USE' });
  await loser.app.close();
  assert.equal(JSON.parse((await winner.broker.files.read('runtime.json'))!.toString('utf8')).serverEpoch, winner.broker.identity.serverEpoch);
});

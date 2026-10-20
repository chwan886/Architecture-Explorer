import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import Fastify from 'fastify';
import { registerBridgeRoutes } from '../apps/server/src/bridge-control.ts';
import { QUERY_ACTIVITY_LIMIT, queryActivityCompleted, queryActivityFailed, queryActivityTitle } from '../apps/server/src/bridge-activity.ts';
import { TOOL_ROOT, type LoadedConfig } from '../packages/indexer/src/config.ts';
import type { IndexManager } from '../packages/indexer/src/indexer.ts';
import type { AnalysisPresentation, BrowserBootstrap, BrowserCurrent, QueryService, ResolvedPresentation, ViewSession } from '../packages/control-protocol/src/types.ts';

const scope = 'fixture:primary', snapshot = 'snapshot:fixture';
function presentation(id: string, scopeId = scope, snapshotId = snapshot): AnalysisPresentation {
  const [projectId, worktreeId] = scopeId.split(':');
  return { schemaVersion: '1.0', presentationId: id, projectId, worktreeId, snapshotId, indexSnapshotId: 'index:fixture',
    title: '真实路由的明确测试夹具', summary: '非游戏业务数据', targetView: 'code', viewMode: 'code', semanticGranularity: 'simple',
    focusNodeId: { layer: 'code', id: 'symbol:fixture' }, highlightedNodeIds: [{ layer: 'code', id: 'symbol:fixture' }],
    highlightedEdgeIds: [], orderedSteps: [], evidenceIds: [], warnings: [], createdAt: new Date().toISOString() };
}
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t: test.TestContext) {
  const base = path.join(TOOL_ROOT, '.tmp'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'bridge-activity-'));
  assert.ok(directory.startsWith(base + path.sep));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }));
  const toolRoot = path.join(directory, 'tool'), target = path.join(directory, 'target');
  await mkdir(toolRoot); await mkdir(target);
  const config: LoadedConfig = { toolRoot, cacheDir: path.join(toolRoot, '.cache'), configPath: path.join(toolRoot, 'config.json'), fingerprint: 'fixture', port: 4310,
    projects: [{ id: 'fixture', name: '明确测试夹具', root: target, include: ['src'], exclude: [], worktrees: [] }] };
  const manager = { config, scope(id: string) { if (![scope, 'other:primary'].includes(id)) throw new Error('Not an authorized fixture'); return { id }; } } as unknown as IndexManager;
  const calls: Array<{ operation: string; args: Record<string, unknown> }> = [];
  let dispatch = async (_operation: string, _args: Record<string, unknown>): Promise<unknown> => ({ matches: [], truncated: false });
  const query: QueryService = { async dispatch(operation, args) { calls.push({ operation, args }); return dispatch(operation, args); }, async resolve(p) {
    return { presentation: p, snapshot: { snapshotId: p.snapshotId, projectId: p.projectId, worktreeId: p.worktreeId, scopeId: `${p.projectId}:${p.worktreeId}`,
      indexSnapshotId: p.indexSnapshotId, architectureRevision: 'fixture-architecture', semanticViewRevision: 'fixture-semantic',
      expiresAt: new Date(Date.now() + 600000).toISOString(), indexState: 'synced' },
      codeGraph: { nodes: [{ id: 'symbol:fixture', label: 'fixture', qualifiedName: 'fixture', kind: 'function', language: 'python', evidenceIds: [] }], edges: [], totalNodes: 1, revision: p.indexSnapshotId, truncated: false },
      highlights: { codeNodeIds: ['symbol:fixture'], codeEdgeIds: [], semanticNodeIds: [], semanticEdgeIds: [], architectureNodeIds: [], architectureEdgeIds: [] }, warnings: [] } satisfies ResolvedPresentation;
  } };
  const app = Fastify({ forceCloseConnections: true });
  app.setErrorHandler((error, _request, reply) => { const value = error as Error & { code?: string; statusCode?: number }; reply.code(value.statusCode ?? 500).send({ code: value.code, error: value.message }); });
  const broker = await registerBridgeRoutes(app, manager, query); t.after(() => app.close());
  const privatePost = (route: 'query' | 'control', operation: string, args: Record<string, unknown> = {}, token = broker.identity.token) => app.inject({ method: 'POST', url: `/api/bridge/private/${route}`, headers: { authorization: `Bearer ${token}` }, payload: { operation, arguments: args } });
  const control = (operation: string, args: Record<string, unknown> = {}) => privatePost('control', operation, args);
  const queryPost = (operation = 'search_architecture', args: Record<string, unknown> = { snapshotId: snapshot, query: 'fixture' }, token?: string) => privatePost('query', operation, args, token);
  const browser = async () => {
    const response = await app.inject({ url: '/api/bridge/browser/bootstrap' }); assert.equal(response.statusCode, 200, response.body);
    const bootstrap = response.json<BrowserBootstrap>(), cookie = String(response.headers['set-cookie']).split(';')[0];
    const post = (route: string, input: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/bridge/browser/${route}`, headers: { cookie }, payload: { sessionId: bootstrap.sessionId, csrf: bootstrap.csrf, ...input } });
    const state = (patch: Record<string, unknown> = {}) => post('state', { state: { ...bootstrap.state, userRevision: 1, allowControl: true, scopeId: scope, ...patch } });
    const current = () => app.inject({ url: `/api/bridge/browser/current?sessionId=${bootstrap.sessionId}`, headers: { cookie } });
    return { bootstrap, cookie, post, state, current };
  };
  const linked = async (scopeId = scope, snapshotId = snapshot) => {
    const page = await browser(); assert.equal((await page.state({ scopeId })).statusCode, 200);
    const attached = await control('attach_view_session', { sessionId: page.bootstrap.sessionId }); assert.equal(attached.statusCode, 200, attached.body);
    const binding = attached.json<{ bindingId: string; session: ViewSession }>();
    const p = presentation('presentation-' + page.bootstrap.sessionId, scopeId, snapshotId);
    const submitted = await control('submit', { presentation: p, bindingId: binding.bindingId }); assert.equal(submitted.statusCode, 200, submitted.body);
    return { ...page, binding, presentation: p, commandId: submitted.json().commandId as string };
  };
  return { app, broker, browser, linked, control, queryPost, directory, target, calls, config,
    setDispatch(value: typeof dispatch) { dispatch = value; } };
}

test('public summaries have fixed operation names and bounded counts without raw values or exception text', () => {
  assert.equal(queryActivityTitle('__proto__'), undefined); assert.equal(queryActivityTitle('status'), undefined);
  assert.equal(queryActivityTitle('get_call_paths'), '追踪静态调用路径');
  assert.match(queryActivityCompleted('search_architecture', { matches: new Array(20000), truncated: true }), /10,000\+ 项匹配.*截断/);
  assert.match(queryActivityCompleted('get_related_graph', { graph: { nodes: [1, 2], edges: [3], truncated: true } }), /2 个节点、1 条关系.*截断/);
  assert.match(queryActivityCompleted('get_flow', { bundle: { flow: { detailNodes: [1, 2, 3] } } }), /3 个详细步骤/);
  assert.match(queryActivityCompleted('get_call_paths', { paths: [1] }), /1 条静态可达路径（不证明运行顺序）/);
  assert.match(queryActivityFailed({ code: 'STALE_SNAPSHOT', message: 'private token source text' }), /快照已失效/);
  assert.ok(!queryActivityFailed(new Error('private token source text')).includes('private'));
});

test('private query route authenticates before dispatch and unbound, unopted or not-yet-presented snapshots do not broadcast', async t => {
  const f = await fixture(t), page = await f.browser();
  assert.equal((await f.queryPost(undefined, undefined, 'not-the-token')).statusCode, 401); assert.equal(f.calls.length, 0);
  assert.equal((await f.queryPost()).statusCode, 200); assert.deepEqual((await page.current()).json<BrowserCurrent>().activities, []);
  await page.state(); await f.queryPost(); assert.deepEqual((await page.current()).json<BrowserCurrent>().activities, []);
  assert.equal((await f.control('attach_view_session', { sessionId: page.bootstrap.sessionId })).statusCode, 200);
  await f.queryPost(); assert.deepEqual((await page.current()).json<BrowserCurrent>().activities, [], 'attach without a displayed snapshot is insufficient');
  assert.equal((await f.queryPost('get_capabilities', {})).statusCode, 200);
  assert.equal((await f.queryPost('search_architecture', { query: 'no snapshot' })).statusCode, 200);
  assert.deepEqual((await page.current()).json<BrowserCurrent>().activities, []);
});

test('real query route publishes running then completed without changing its exact result or command receipt', async t => {
  const f = await fixture(t), page = await f.linked(), started = deferred<void>(), finish = deferred<unknown>();
  const original = { graph: { nodes: [1, 2], edges: [3], truncated: true }, opaque: { source: 'source-secret', token: 'token-secret' } };
  f.setDispatch(async () => { started.resolve(); return finish.promise; });
  const pending = f.queryPost('get_related_graph', { snapshotId: snapshot, nodeId: 'symbol:fixture', query: 'raw-argument-secret' }).then(value => value);
  await started.promise;
  const running = (await page.current()).json<BrowserCurrent>(); assert.equal(running.activities?.length, 1);
  const activity = running.activities![0]; assert.equal(activity.status, 'running'); assert.equal(activity.title, '查询代码关系');
  assert.equal(activity.scopeId, scope); assert.equal(activity.snapshotId, snapshot); assert.equal(activity.commandId, page.commandId);
  assert.equal(running.pending?.status, 'pending', 'query completion is never a presentation ACK');
  finish.resolve(original); const response = await pending; assert.deepEqual(response.json(), original);
  const completed = (await page.current()).json<BrowserCurrent>(); assert.equal(completed.activities![0].id, activity.id);
  assert.equal(completed.activities![0].status, 'completed'); assert.match(completed.activities![0].message, /2 个节点、1 条关系.*截断/);
  assert.equal(completed.pending?.status, 'pending');
  assert.ok(!JSON.stringify(completed.activities).match(/raw-argument-secret|source-secret|token-secret/));
  assert.deepEqual(f.calls[0].args, { snapshotId: snapshot, nodeId: 'symbol:fixture', query: 'raw-argument-secret' });
});

test('query failure preserves the real error and records only a safe failure summary', async t => {
  const f = await fixture(t), page = await f.linked();
  const error = Object.assign(new Error('private-source-token-must-not-broadcast'), { code: 'UNKNOWN_REFERENCE', statusCode: 404 });
  f.setDispatch(async () => { throw error; });
  const response = await f.queryPost('get_node_details', { snapshotId: snapshot, ref: { layer: 'code', id: 'absent' } });
  assert.equal(response.statusCode, 404); assert.equal(response.json().error, error.message);
  const current = (await page.current()).json<BrowserCurrent>(); assert.equal(current.activities![0].status, 'failed');
  assert.match(current.activities![0].message, /未找到请求的实体/); assert.ok(!JSON.stringify(current.activities).includes('private-source'));
  await assert.rejects(f.broker.executeQuery('get_node_details', { snapshotId: snapshot }), value => value === error);
  assert.equal(current.pending?.status, 'pending');
});

test('only one explicitly bound page for the same current snapshot and scope can receive query activity', async t => {
  const f = await fixture(t), correct = await f.linked(), otherScope = await f.linked('other:primary', 'snapshot:other');
  await f.queryPost(); assert.equal((await correct.current()).json<BrowserCurrent>().activities?.length, 1);
  assert.deepEqual((await otherScope.current()).json<BrowserCurrent>().activities, []);
  await f.queryPost(undefined, { snapshotId: 'new-not-displayed-snapshot', query: 'fixture' });
  assert.equal((await correct.current()).json<BrowserCurrent>().activities?.length, 1, 'new snapshot queries are not sent to the older page');
  const duplicate = await f.linked(); await f.queryPost();
  assert.equal((await correct.current()).json<BrowserCurrent>().activities?.length, 1, 'ambiguous same-snapshot tabs do not guess a target');
  assert.deepEqual((await duplicate.current()).json<BrowserCurrent>().activities, []);
  await duplicate.post('leave', {});
  await correct.state({ scopeId: 'other:primary', userRevision: 2 });
  await f.queryPost(); assert.deepEqual((await correct.current()).json<BrowserCurrent>().activities, [], 'manual scope change hides and stops the older snapshot activity');
});

test('cookie ownership protects activity reads and leaving prevents an in-flight query from publishing later', async t => {
  const f = await fixture(t), page = await f.linked(), attacker = await f.browser(), started = deferred<void>(), finish = deferred<unknown>();
  f.setDispatch(async () => { started.resolve(); return finish.promise; });
  const pending = f.queryPost().then(value => value); await started.promise;
  const stolen = await f.app.inject({ url: `/api/bridge/browser/current?sessionId=${page.bootstrap.sessionId}`, headers: { cookie: attacker.cookie } });
  assert.equal(stolen.statusCode, 403); assert.ok(!stolen.body.includes('搜索架构实体'));
  const missingCookie = await f.app.inject({ url: `/api/bridge/browser/current?sessionId=${page.bootstrap.sessionId}` }); assert.equal(missingCookie.statusCode, 403);
  await page.post('leave', {}); finish.resolve({ matches: [1] }); assert.equal((await pending).statusCode, 200);
  assert.deepEqual((await page.current()).json<BrowserCurrent>().activities, []);
});

test('snapshot replacement during a query does not attach its eventual completion to the new context', async t => {
  const f = await fixture(t), page = await f.linked(), started = deferred<void>(), finish = deferred<unknown>();
  f.setDispatch(async () => { started.resolve(); return finish.promise; });
  const pending = f.queryPost().then(value => value); await started.promise;
  const submitted = await f.control('submit', { presentation: presentation('replacement', scope, 'snapshot:new'), bindingId: page.binding.bindingId, expectedUserRevision: 1, expectedControlRevision: 0 });
  assert.equal(submitted.statusCode, 200, submitted.body); finish.resolve({ matches: [1] }); await pending;
  assert.deepEqual((await page.current()).json<BrowserCurrent>().activities, []);
});

test('activity is bounded per session, absent from durable state, and does not write the target', async t => {
  const f = await fixture(t), page = await f.linked();
  for (let i = 0; i < QUERY_ACTIVITY_LIMIT + 5; i++) assert.equal((await f.queryPost()).statusCode, 200);
  const activities = (await page.current()).json<BrowserCurrent>().activities!;
  assert.equal(activities.length, QUERY_ACTIVITY_LIMIT); assert.equal(activities[0].sequence, 6);
  assert.equal(activities.at(-1)!.sequence, QUERY_ACTIVITY_LIMIT + 5);
  assert.equal(new Set(activities.map(item => item.id)).size, QUERY_ACTIVITY_LIMIT);
  const durable = await readFile(path.join(f.config.cacheDir, 'bridge', 'state.json'), 'utf8');
  assert.ok(!durable.includes('搜索架构实体')); assert.ok(!durable.includes('activities')); assert.deepEqual(await readdir(f.target), []);
});

test('lease expiry stops activity even with a live page heartbeat', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date() });
  const f = await fixture(t), page = await f.linked(); await f.queryPost();
  assert.equal((await page.current()).json<BrowserCurrent>().activities!.length, 1);
  t.mock.timers.tick(60_000); assert.equal((await page.state()).statusCode, 200);
  t.mock.timers.tick(61_000); assert.equal((await f.queryPost()).statusCode, 200);
  const response = await page.current(); assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json<BrowserCurrent>().activities, []); assert.equal(response.json<BrowserCurrent>().session.bindingId, undefined);
});

test('SSE stays a payload-free hint while current provides the authorized activity log', async t => {
  const f = await fixture(t), page = await f.linked(); await f.app.listen({ host: '127.0.0.1', port: 0 });
  const address = f.app.server.address(); assert.ok(address && typeof address !== 'string');
  const abort = new AbortController(); t.after(() => abort.abort());
  const response = await fetch(`http://127.0.0.1:${address.port}/api/bridge/browser/events?sessionId=${page.bootstrap.sessionId}`, { headers: { cookie: page.cookie }, signal: abort.signal });
  assert.equal(response.status, 200); const reader = response.body!.getReader(); await reader.read();
  await f.queryPost(); const event = new TextDecoder().decode((await reader.read()).value);
  assert.match(event, /event: control/); assert.ok(!event.match(/搜索架构实体|snapshot:fixture|activities|completed|fixture:primary/));
  assert.equal((await page.current()).json<BrowserCurrent>().activities![0].status, 'completed');
  abort.abort();
});

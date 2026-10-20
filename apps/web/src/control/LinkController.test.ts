import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { BrowserBootstrap, BrowserCurrent, BrowserState, ControlCommand, PresentationReceipt, ViewSession } from '../../../../packages/control-protocol/src/types';
import { commandConflict } from './browser';
import useLinkController from './useLinkController';

// Explicit test-only transport records; no product data or browser adapter is
// mocked. The mounted hook receives real SSE notifications and DOM actions.
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const state = (): BrowserState => ({ userRevision: 0, controlRevision: 0, allowControl: false, scopeId: 'fixture:main', label: 'Fixture', visible: true });
function makeCommand(session: ViewSession, id = 'command-1'): ControlCommand {
  return { commandId: id, serverEpoch: session.serverEpoch, sessionId: session.sessionId, bindingId: 'binding-fixture', sequence: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), expectedUserRevision: session.userRevision, expectedControlRevision: session.controlRevision, resolved: { presentation: { schemaVersion: '1.0', presentationId: `presentation:${id}`, projectId: 'fixture', worktreeId: 'main', indexSnapshotId: 'source-1', snapshotId: 'snapshot-1', title: '测试分析', summary: '明确测试夹具', targetView: 'code', viewMode: 'code', semanticGranularity: 'simple', highlightedNodeIds: [], highlightedEdgeIds: [], orderedSteps: [], evidenceIds: [], warnings: [], createdAt: new Date().toISOString() }, snapshot: { snapshotId: 'snapshot-1', projectId: 'fixture', worktreeId: 'main', scopeId: 'fixture:main', indexSnapshotId: 'source-1', architectureRevision: 'arch-1', semanticViewRevision: '', expiresAt: new Date(Date.now() + 60000).toISOString(), indexState: 'synced' }, codeGraph: { nodes: [], edges: [], totalNodes: 0, truncated: false, revision: 'source-1' }, highlights: { codeNodeIds: [], codeEdgeIds: [], semanticNodeIds: [], semanticEdgeIds: [], architectureNodeIds: [], architectureEdgeIds: [] }, warnings: [] } };
}
async function mount({ holdApply = false }: { holdApply?: boolean } = {}) {
  const browser = new Window({ url: 'http://127.0.0.1:4311' }), descriptors = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => { descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'sessionStorage', 'localStorage'] as const) install(key, key === 'window' ? browser : browser[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const streams = new Set<FixtureStream>();
  class FixtureStream {
    onmessage: (() => void) | null = null; onopen: (() => void) | null = null; onerror: (() => void) | null = null; callbacks = new Set<() => void>();
    constructor(public url: string) { streams.add(this); }
    addEventListener(_name: string, callback: () => void) { this.callbacks.add(callback); }
    close() { streams.delete(this); }
    emit() { for (const callback of this.callbacks) callback(); }
  }
  install('EventSource', FixtureStream);
  let serverEpoch = 'server-1', session: ViewSession = { ...state(), sessionId: 'document-1', serverEpoch, lastSeenAt: new Date().toISOString() }, bootstrapCount = 0, command: ControlCommand | undefined, receipt: PresentationReceipt | undefined, expireNext = '';
  const acknowledgments: Record<string, unknown>[] = [], applied: string[] = [], cleared: string[] = [], requests: string[] = [];
  let release!: () => void; const pendingApply = new Promise<void>(done => { release = done; });
  const api = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), browser.location.origin), body = init?.body ? JSON.parse(String(init.body)) : undefined; requests.push(url.pathname);
    if (url.pathname.endsWith('/bootstrap')) { bootstrapCount++; if (bootstrapCount > 1) session = { ...state(), sessionId: `document-${bootstrapCount}`, serverEpoch, lastSeenAt: new Date().toISOString() }; return json({ sessionId: session.sessionId, csrf: 'fixture-csrf', serverEpoch: session.serverEpoch, state: session } satisfies BrowserBootstrap); }
    if (url.pathname.endsWith('/state')) { session = { ...session, ...body.state, lastSeenAt: new Date().toISOString() }; return json(session); }
    if (url.pathname.endsWith('/current')) { if (expireNext) { const code = expireNext; expireNext = ''; return json({ error: { code, message: 'fixture expired' } }, code === 'SESSION_FORBIDDEN' ? 403 : 409); } return json({ session, ...(command ? { command } : {}), ...(receipt ? { pending: receipt } : {}) } satisfies BrowserCurrent); }
    if (url.pathname.endsWith('/ack')) { acknowledgments.push(body); if (body.status === 'presented') session.controlRevision = body.controlRevision; receipt = { commandId: body.commandId, presentationId: command?.resolved.presentation.presentationId || '', sessionId: session.sessionId, status: body.status, action: 'present', message: body.message || '', userRevision: body.userRevision, controlRevision: body.controlRevision, updatedAt: new Date().toISOString(), actual: body.actual }; return json(receipt); }
    if (url.pathname.endsWith('/leave')) { session.allowControl = false; command = undefined; return json(session); }
    throw new Error(`Unexpected fixture browser API ${url}`);
  };
  install('fetch', api); browser.fetch = api as unknown as typeof browser.fetch;
  const { createRoot } = await import('react-dom/client'); const container = browser.document.createElement('div'); browser.document.body.append(container); const root = createRoot(container as unknown as Element);
  let controller!: ReturnType<typeof useLinkController>;
  function Harness() {
    controller = useLinkController({ scopeId: 'fixture:main', label: 'Fixture', async onApply(value, isCurrent) { if (holdApply) await pendingApply; if (isCurrent()) applied.push(value.commandId); }, onClear(message) { cleared.push(message); } });
    return React.createElement('div', { 'data-user-revision': controller.state.userRevision, 'data-control-revision': controller.state.controlRevision, 'data-allowed': String(controller.state.allowControl), 'data-session': controller.bootstrap?.sessionId }, React.createElement('button', { onClick: () => void controller.enable() }, '允许'), React.createElement('button', { onClick: controller.markUserAction }, '人工选择'), React.createElement('button', { onClick: () => void controller.leave() }, '退出'), React.createElement('button', { onClick: () => void controller.presented(command!.commandId, { scopeId: 'fixture:main', indexSnapshotId: 'source-1', visibleNodeIds: [], visibleEdgeIds: [] }) }, '画布完成'), React.createElement('button', { onClick: controller.reconnect }, '拉取当前'));
  }
  await act(async () => root.render(React.createElement(Harness)));
  const waitFor = async (check: () => void, label: string) => { let last: unknown; for (let i = 0; i < 100; i++) { try { check(); return; } catch (failure) { last = failure; } await act(async () => { await new Promise(done => setTimeout(done, 10)); }); } throw new Error(`${label}: ${last}`); };
  const click = async (label: string) => { const button = Array.from(container.querySelectorAll('button')).find(button => button.textContent === label); assert.ok(button); await act(async () => button.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }))); };
  const emit = async () => { await act(async () => { for (const stream of streams) stream.emit(); }); };
  const send = async (id = 'command-1') => { command = makeCommand(session, id); await emit(); return command; };
  const dispose = async () => { await act(async () => root.unmount()); await browser.happyDOM.close(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } };
  await waitFor(() => assert.ok(controller.bootstrap), 'browser bootstrapped');
  return { container, click, waitFor, send, emit, acknowledgments, applied, cleared, requests, dispose, release: async () => { await act(async () => release()); }, expire: (code = 'SESSION_EXPIRED') => { expireNext = code; }, expirePresentation: async () => { command = undefined; receipt = { ...receipt!, status: 'expired', message: 'fixture source snapshot expired' }; await emit(); }, restart: () => { serverEpoch = 'server-2'; session.serverEpoch = serverEpoch; command = undefined; }, clearOnServer: async () => { command = undefined; session.controlRevision++; receipt = { commandId: 'clear-command', presentationId: '', status: 'superseded', action: 'clear', message: 'fixture clear', updatedAt: new Date().toISOString() }; await emit(); }, get session() { return session; }, get controller() { return controller; } };
}

test('browser command CAS rejects a stale user revision and mismatched snapshot before applying', () => {
  const session: ViewSession = { ...state(), allowControl: true, sessionId: 's', serverEpoch: 'e', lastSeenAt: '' }, command = makeCommand(session), bootstrap = { sessionId: 's', csrf: 'csrf', serverEpoch: 'e', state: session };
  assert.equal(commandConflict(command, bootstrap, session), ''); assert.match(commandConflict(command, bootstrap, { ...session, userRevision: 1 }), /人工操作/);
  command.resolved.presentation.indexSnapshotId = 'another'; assert.match(commandConflict(command, bootstrap, session), /快照不一致/);
});
test('real link controller requires opt-in and acknowledges presented only after a separate canvas settlement', async () => {
  const app = await mount(); try { assert.equal(app.session.allowControl, false); await app.click('允许'); await app.waitFor(() => assert.equal(app.session.allowControl, true), 'opt in'); const command = await app.send(); await app.waitFor(() => assert.deepEqual(app.applied, [command.commandId]), 'navigation applied'); assert.deepEqual(app.acknowledgments.map(value => value.status), ['received']); await app.click('画布完成'); await app.waitFor(() => assert.equal(app.acknowledgments.at(-1)?.status, 'presented'), 'presentation ack'); assert.equal(app.acknowledgments.at(-1)?.controlRevision, command.expectedControlRevision + 1); await app.emit(); assert.deepEqual(app.applied, [command.commandId]); } finally { await app.dispose(); }
});
test('real link controller cancels an asynchronous command when a human selection starts', async () => {
  const app = await mount({ holdApply: true }); try { await app.click('允许'); await app.send(); await app.waitFor(() => assert.equal(app.acknowledgments[0]?.status, 'received'), 'received while waiting'); await app.click('人工选择'); await app.release(); await app.waitFor(() => assert.ok(app.acknowledgments.some(value => value.status === 'conflict')), 'manual conflict'); assert.deepEqual(app.applied, []); assert.equal(app.acknowledgments.some(value => value.status === 'presented'), false); } finally { await app.dispose(); }
});
test('real link controller clears only remote highlights and keeps opt-out until explicit enable', async () => {
  const app = await mount(); try { await app.click('允许'); await app.send(); await app.waitFor(() => assert.equal(app.applied.length, 1), 'applied'); await app.click('画布完成'); await app.clearOnServer(); await app.waitFor(() => assert.ok(app.cleared.some(message => message.includes('高亮已清除'))), 'private clear reaches browser'); assert.equal(app.session.allowControl, true); await app.click('退出'); await app.waitFor(() => assert.equal(app.session.allowControl, false), 'left'); await app.emit(); assert.equal(app.controller.state.allowControl, false); await app.click('允许'); await app.waitFor(() => assert.equal(app.session.allowControl, true), 'explicit opt in again'); } finally { await app.dispose(); }
});
test('real link controller recovers an expired document with a fresh opt-out session', async () => {
  const app = await mount(); try { await app.click('允许'); app.expire(); await app.click('拉取当前'); await app.waitFor(() => assert.equal(app.controller.bootstrap?.sessionId, 'document-2'), 'new session'); assert.equal(app.controller.state.allowControl, false); assert.equal(app.applied.length, 0); } finally { await app.dispose(); }
});
test('real link controller reboots after a server epoch change or forbidden old session and requires fresh opt-in', async () => {
  const app = await mount(); try { await app.click('允许'); app.restart(); await app.click('拉取当前'); await app.waitFor(() => assert.equal(app.controller.bootstrap?.serverEpoch, 'server-2'), 'new server epoch'); assert.equal(app.controller.state.allowControl, false); await app.click('允许'); app.expire('SESSION_FORBIDDEN'); await app.click('拉取当前'); await app.waitFor(() => assert.equal(app.controller.bootstrap?.sessionId, 'document-3'), 'forbidden session replaced'); assert.equal(app.controller.state.allowControl, false); assert.equal(app.applied.length, 0); } finally { await app.dispose(); }
});
test('a server-invalidated presentation clears stale highlights even without a new source revision event', async () => {
  const app = await mount(); try { await app.click('允许'); await app.send(); await app.waitFor(() => assert.equal(app.applied.length, 1), 'applied'); await app.click('画布完成'); await app.expirePresentation(); await app.waitFor(() => assert.ok(app.cleared.includes('fixture source snapshot expired')), 'server snapshot invalidation'); assert.equal(app.controller.receipt?.status, 'expired'); const count = app.cleared.length; await app.emit(); assert.equal(app.cleared.length, count, 'terminal receipts must not repeatedly reset manual context'); assert.equal(app.session.allowControl, true); } finally { await app.dispose(); }
});

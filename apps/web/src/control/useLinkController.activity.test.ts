import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { BridgeActivity, BrowserBootstrap, BrowserCurrent, BrowserState, ControlCommand, PresentationReceipt, ViewSession } from '../../../../packages/control-protocol/src/types';
import useLinkController from './useLinkController';
import { mergeActivities } from './activity';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const now = () => new Date().toISOString();
const initialState = (): BrowserState => ({ userRevision: 0, controlRevision: 0, allowControl: false, scopeId: 'fixture:main', label: 'Fixture', visible: true });
const query = (id: string, status: BridgeActivity['status'] = 'running', scopeId = 'fixture:main'): BridgeActivity => ({ id, sequence: Number(id.replace(/\D/g, '')) || 1, kind: 'query', operation: 'get_flow', title: '读取飞剑命中流程', message: status === 'running' ? '正在读取现有索引。' : '已读取流程与源码证据引用。', status, startedAt: now(), updatedAt: now(), scopeId, snapshotId: 'snapshot-1', indexSnapshotId: 'source-1' });
function makeCommand(session: ViewSession, id = 'command-1'): ControlCommand {
  return { commandId: id, serverEpoch: session.serverEpoch, sessionId: session.sessionId, bindingId: 'binding-fixture', sequence: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), expectedUserRevision: session.userRevision, expectedControlRevision: session.controlRevision, resolved: { presentation: { schemaVersion: '1.0', presentationId: `presentation:${id}`, projectId: 'fixture', worktreeId: 'main', indexSnapshotId: 'source-1', snapshotId: 'snapshot-1', title: '飞剑命中演示（测试夹具）', summary: '仅测试公开活动状态，不是游戏分析结果。', targetView: 'code', viewMode: 'code', semanticGranularity: 'simple', highlightedNodeIds: [], highlightedEdgeIds: [], orderedSteps: [], evidenceIds: [], warnings: [], createdAt: now() }, snapshot: { snapshotId: 'snapshot-1', projectId: 'fixture', worktreeId: 'main', scopeId: 'fixture:main', indexSnapshotId: 'source-1', architectureRevision: 'arch-1', semanticViewRevision: '', expiresAt: new Date(Date.now() + 60000).toISOString(), indexState: 'synced' }, highlights: { codeNodeIds: [], codeEdgeIds: [], semanticNodeIds: [], semanticEdgeIds: [], architectureNodeIds: [], architectureEdgeIds: [] }, warnings: [] } };
}
async function mount({ holdApply = false, holdPresentedAck = false }: { holdApply?: boolean; holdPresentedAck?: boolean } = {}) {
  const browser = new Window({ url: 'http://127.0.0.1:4311' }), descriptors = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => { descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'sessionStorage', 'localStorage'] as const) install(key, key === 'window' ? browser : browser[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  let heartbeat: (() => void) | undefined;
  const nativeInterval = globalThis.setInterval, nativeClear = globalThis.clearInterval;
  install('setInterval', (callback: () => void, delay: number, ...args: unknown[]) => delay === 15000 ? (heartbeat = callback, -15000) : nativeInterval(callback, delay, ...args));
  install('clearInterval', (id: ReturnType<typeof setInterval>) => Number(id) === -15000 ? (heartbeat = undefined) : nativeClear(id));
  const streams = new Set<FixtureStream>();
  class FixtureStream {
    onmessage: (() => void) | null = null; onopen: (() => void) | null = null; onerror: (() => void) | null = null; callbacks = new Set<() => void>();
    constructor(public url: string) { streams.add(this); }
    addEventListener(_name: string, callback: () => void) { this.callbacks.add(callback); }
    close() { streams.delete(this); }
    emit() { for (const callback of this.callbacks) callback(); }
  }
  install('EventSource', FixtureStream);
  let session: ViewSession = { ...initialState(), sessionId: 'document-1', serverEpoch: 'server-1', lastSeenAt: now() }, bootstrapCount = 0, command: ControlCommand | undefined, receipt: PresentationReceipt | undefined, expireNext = false, activities: BridgeActivity[] | undefined;
  const acknowledgments: Record<string, unknown>[] = [], applied: string[] = [], cleared: string[] = [];
  let release!: () => void; const pendingApply = new Promise<void>(done => { release = done; });
  let releaseAck!: () => void; const pendingAck = new Promise<void>(done => { releaseAck = done; });
  const api = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), browser.location.origin), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname.endsWith('/bootstrap')) { bootstrapCount++; if (bootstrapCount > 1) { session = { ...initialState(), sessionId: `document-${bootstrapCount}`, serverEpoch: 'server-1', lastSeenAt: now() }; activities = undefined; command = undefined; receipt = undefined; } return json({ sessionId: session.sessionId, csrf: 'fixture-csrf', serverEpoch: session.serverEpoch, state: session } satisfies BrowserBootstrap); }
    if (url.pathname.endsWith('/state')) { session = { ...session, ...body.state, lastSeenAt: now() }; return json(session); }
    if (url.pathname.endsWith('/current')) { if (expireNext) { expireNext = false; return json({ error: { code: 'SESSION_EXPIRED', message: 'fixture expired' } }, 409); } return json({ session, command, pending: receipt, ...(activities ? { activities } : {}) } satisfies BrowserCurrent); }
    if (url.pathname.endsWith('/ack')) { acknowledgments.push(body); if (holdPresentedAck && body.status === 'presented') await pendingAck; if (body.status === 'presented') session.controlRevision = body.controlRevision; receipt = { commandId: body.commandId, presentationId: command?.resolved.presentation.presentationId || '', sessionId: session.sessionId, status: body.status, action: 'present', message: body.message || '', updatedAt: now() }; return json(receipt); }
    if (url.pathname.endsWith('/leave')) { session.allowControl = false; command = undefined; return json(session); }
    throw new Error(`Unexpected fixture browser API ${url}`);
  };
  install('fetch', api); browser.fetch = api as unknown as typeof browser.fetch;
  const { createRoot } = await import('react-dom/client'); const container = browser.document.createElement('div'); browser.document.body.append(container); const root = createRoot(container as unknown as Element);
  let controller!: ReturnType<typeof useLinkController>;
  function Harness({ scopeId = 'fixture:main' }: { scopeId?: string }) {
    const [sourceContext, setSourceContext] = React.useState<string>();
    controller = useLinkController({ scopeId, label: 'Fixture', async onApply(value, isCurrent) { if (holdApply) await pendingApply; if (isCurrent()) { applied.push(value.commandId); setSourceContext(`${value.sessionId}:${value.commandId}`); } }, onClear(message) { cleared.push(message); setSourceContext(undefined); } });
    return React.createElement('div', { 'data-allowed': String(controller.state.allowControl), 'data-session': controller.bootstrap?.sessionId, 'data-source-context': sourceContext || '', 'data-command-context': controller.command?.commandId || '', 'data-receipt-context': controller.receipt?.commandId || '' },
      React.createElement('button', { onClick: () => void controller.enable() }, '允许'), React.createElement('button', { onClick: controller.markUserAction }, '人工选择'), React.createElement('button', { onClick: controller.clear }, '清除'), React.createElement('button', { onClick: () => void controller.leave() }, '退出'),
      React.createElement('button', { onClick: () => void controller.presented(command!.commandId, { scopeId: 'fixture:main', indexSnapshotId: 'source-1', visibleNodeIds: [], visibleEdgeIds: [] }) }, '画布完成'),
      React.createElement('ul', null, controller.activities.map(value => React.createElement('li', { key: value.id, 'data-id': value.id, 'data-status': value.status, 'data-updated': value.updatedAt }, value.message))));
  }
  const render = async (scopeId = 'fixture:main') => { await act(async () => root.render(React.createElement(Harness, { scopeId }))); };
  const waitFor = async (check: () => void, label: string) => { let last: unknown; for (let i = 0; i < 100; i++) { try { check(); return; } catch (failure) { last = failure; } await act(async () => { await new Promise(done => setTimeout(done, 10)); }); } throw new Error(`${label}: ${last}`); };
  const click = async (label: string) => { const button = Array.from(container.querySelectorAll('button')).find(button => button.textContent === label); assert.ok(button); await act(async () => button.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }))); };
  const emit = async () => { await act(async () => { for (const stream of streams) stream.emit(); }); };
  const send = async () => { command = makeCommand(session); await emit(); return command; };
  const dispose = async () => { await act(async () => root.unmount()); await browser.happyDOM.close(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } };
  await render(); await waitFor(() => assert.ok(controller.bootstrap), 'bootstrap');
  return { container, click, emit, send, waitFor, render, dispose, acknowledgments, applied, cleared, get controller() { return controller; }, get session() { return session; }, setActivities(value: BridgeActivity[] | undefined) { activities = value; }, async tick() { await act(async () => heartbeat?.()); }, async release() { await act(async () => release()); }, async releaseAck() { await act(async () => releaseAck()); }, expire() { expireNext = true; }, async disconnect() { await act(async () => { for (const stream of streams) stream.onerror?.(); }); }, async stalePresentedReceipt() { receipt = { ...receipt!, status: 'presented' }; await emit(); } };
}

test('public query activity updates in place and never completes a separate presentation', async () => {
  const app = await mount(); try {
    await app.click('允许'); const activity = query('query-1'); app.setActivities([activity]); await app.emit();
    await app.waitFor(() => assert.equal(app.container.querySelector('[data-id="query-1"]')?.getAttribute('data-status'), 'running'), 'query running');
    await app.send(); await app.waitFor(() => assert.equal(app.applied.length, 1), 'presentation applied');
    app.setActivities([{ ...activity, status: 'completed', message: '已读取流程与源码证据引用。', updatedAt: now() }]); await app.emit();
    assert.equal(app.container.querySelectorAll('[data-id="query-1"]').length, 1);
    assert.equal(app.container.querySelector('[data-id="query-1"]')?.getAttribute('data-status'), 'completed');
    assert.equal(app.container.querySelector('[data-id="ui:command:command-1"]')?.getAttribute('data-status'), 'running');
    assert.deepEqual(app.acknowledgments.map(value => value.status), ['received']);
  } finally { await app.dispose(); }
});

test('presentation activity completes only after canvas settlement ACK and repeated current pulls stay quiet', async () => {
  const app = await mount(); try {
    await app.click('允许'); await app.send(); await app.waitFor(() => assert.equal(app.applied.length, 1), 'presentation applied');
    assert.equal(app.controller.activities.find(value => value.commandId === 'command-1')?.status, 'running');
    await app.click('画布完成'); await app.waitFor(() => assert.equal(app.controller.activities.find(value => value.commandId === 'command-1')?.status, 'completed'), 'presentation completed');
    const before = app.controller.activities; for (let i = 0; i < 3; i++) await app.tick();
    assert.equal(app.controller.activities, before, 'heartbeat/report/current do not create or refresh summaries');
    assert.deepEqual(app.acknowledgments.map(value => value.status), ['received', 'presented']);
  } finally { await app.dispose(); }
});

test('a valid new snapshot presentation stops tracking running queries from the replaced snapshot', async () => {
  const app = await mount(); try {
    await app.click('允许');
    const previous = { ...query('previous-1'), snapshotId: 'replaced-snapshot' }, current = query('current-2'), completed = { ...query('done-3', 'completed'), snapshotId: 'replaced-snapshot' };
    app.setActivities([previous, current, completed]); await app.emit(); assert.equal(app.controller.activities.find(value => value.id === 'previous-1')?.status, 'running');
    await app.send(); await app.waitFor(() => assert.equal(app.applied.length, 1), 'new snapshot presented');
    const paused = app.controller.activities.find(value => value.id === 'previous-1'); assert.equal(paused?.status, 'paused'); assert.match(paused!.message, /已切换分析快照/); assert.match(paused!.message, /不表示后端读取已取消/);
    assert.equal(app.controller.activities.find(value => value.id === 'current-2')?.status, 'running'); assert.equal(app.controller.activities.find(value => value.id === 'done-3')?.status, 'completed');
    await app.tick(); assert.equal(app.controller.activities.find(value => value.id === 'previous-1'), paused, 'an unchanged old running poll cannot revive tracking');
    assert.equal(app.controller.state.allowControl, true); assert.deepEqual(app.acknowledgments.map(value => value.status), ['received']);
  } finally { await app.dispose(); }
});

test('manual takeover pauses a pending presentation without revoking permission and stale receipts cannot undo it', async () => {
  const app = await mount({ holdApply: true }); try {
    await app.click('允许'); await app.send(); await app.waitFor(() => assert.equal(app.acknowledgments[0]?.status, 'received'), 'received');
    await app.click('人工选择'); await app.release();
    await app.waitFor(() => assert.equal(app.controller.activities.find(value => value.commandId === 'command-1')?.status, 'paused'), 'manual pause');
    const paused = app.controller.activities.find(value => value.commandId === 'command-1'); await app.stalePresentedReceipt(); await app.tick();
    assert.equal(app.controller.activities.find(value => value.commandId === 'command-1'), paused); assert.match(paused!.message, /人工操作/);
    assert.equal(app.controller.state.allowControl, true); assert.deepEqual(app.applied, []); assert.equal(app.acknowledgments.some(value => value.status === 'presented'), false);
  } finally { await app.dispose(); }
});

test('scope changes clear previous summaries and reject activities from another worktree', async () => {
  const app = await mount(); try {
    await app.click('允许'); app.setActivities([query('old-1')]); await app.emit(); assert.ok(app.container.querySelector('[data-id="old-1"]'));
    await app.render('fixture:branch'); app.setActivities([query('old-1'), query('new-2', 'completed', 'fixture:branch')]); await app.emit();
    await app.waitFor(() => assert.ok(app.container.querySelector('[data-id="new-2"]')), 'new scope activity');
    assert.equal(app.container.querySelector('[data-id="old-1"]'), null); assert.equal(app.controller.activities.some(value => value.scopeId === 'fixture:main'), false);
  } finally { await app.dispose(); }
});

test('an ACK already in flight cannot replace a later manual pause with completion', async () => {
  const app = await mount({ holdPresentedAck: true }); try {
    await app.click('允许'); await app.send(); await app.waitFor(() => assert.equal(app.applied.length, 1), 'presentation applied');
    await app.click('画布完成'); await app.waitFor(() => assert.ok(app.acknowledgments.some(value => value.status === 'presented')), 'presented ACK in flight');
    await app.click('人工选择'); await app.releaseAck(); await app.tick();
    assert.equal(app.controller.activities.find(value => value.commandId === 'command-1')?.status, 'paused');
    assert.match(app.controller.activities.find(value => value.commandId === 'command-1')!.message, /人工操作/); assert.equal(app.controller.state.allowControl, true);
  } finally { await app.dispose(); }
});

test('session rebuilding isolates previous activity and requires fresh opt-in', async () => {
  const app = await mount(); try {
    await app.click('允许'); app.setActivities([query('old-1')]); await app.emit(); assert.ok(app.container.querySelector('[data-id="old-1"]'));
    app.expire(); await app.emit(); await app.waitFor(() => assert.equal(app.controller.bootstrap?.sessionId, 'document-2'), 'fresh session');
    assert.equal(app.controller.state.allowControl, false); assert.equal(app.container.querySelector('[data-id="old-1"]'), null);
    app.setActivities([query('fresh-2')]); await app.emit(); assert.equal(app.container.querySelector('[data-id="fresh-2"]'), null, 'fresh opt-out cannot receive query summaries');
    await app.click('允许'); await app.waitFor(() => assert.ok(app.container.querySelector('[data-id="fresh-2"]')), 'fresh query after opt in');
  } finally { await app.dispose(); }
});

test('a rebuilt session clears the previous presentation and source context before enabling again', async () => {
  const app = await mount(); try {
    assert.equal(app.cleared.length, 0, 'first bootstrap does not clear a manual page');
    await app.click('允许'); await app.send(); await app.waitFor(() => assert.equal(app.applied.length, 1), 'old presentation applied'); await app.click('画布完成');
    assert.equal(app.container.firstElementChild?.getAttribute('data-source-context'), 'document-1:command-1'); assert.equal(app.controller.command?.commandId, 'command-1'); assert.equal(app.controller.receipt?.commandId, 'command-1');
    app.expire(); await app.emit(); await app.waitFor(() => assert.equal(app.controller.bootstrap?.sessionId, 'document-2'), 'fresh session');
    assert.equal(app.controller.command, undefined); assert.equal(app.controller.receipt, undefined); assert.equal(app.container.firstElementChild?.getAttribute('data-source-context'), ''); assert.ok(app.cleared.some(value => value.includes('旧展示及源码上下文已失效')));
    await app.click('允许'); await app.tick(); assert.equal(app.controller.state.allowControl, true); assert.equal(app.controller.command, undefined); assert.equal(app.controller.receipt, undefined); assert.equal(app.container.firstElementChild?.getAttribute('data-source-context'), ''); assert.deepEqual(app.applied, ['command-1']);
    await app.send(); await app.waitFor(() => assert.equal(app.applied.length, 2), 'only a new valid command can display again'); assert.equal(app.container.firstElementChild?.getAttribute('data-source-context'), 'document-2:command-1');
  } finally { await app.dispose(); }
});

test('a late old-session ACK cannot resurrect presentation history or source context in the new session', async () => {
  const app = await mount({ holdPresentedAck: true }); try {
    await app.click('允许'); await app.send(); await app.waitFor(() => assert.equal(app.applied.length, 1), 'old presentation applied'); await app.click('画布完成'); await app.waitFor(() => assert.ok(app.acknowledgments.some(value => value.status === 'presented')), 'old ACK in flight');
    app.expire(); await app.emit(); await app.waitFor(() => assert.equal(app.controller.bootstrap?.sessionId, 'document-2'), 'fresh session'); await app.releaseAck();
    assert.equal(app.controller.command, undefined); assert.equal(app.controller.receipt, undefined); assert.equal(app.controller.activities.some(value => value.commandId === 'command-1'), false); assert.equal(app.container.firstElementChild?.getAttribute('data-source-context'), '');
    await app.click('允许'); assert.equal(app.controller.command, undefined); assert.equal(app.container.firstElementChild?.getAttribute('data-source-context'), '');
  } finally { await app.dispose(); }
});

test('clear and leave preserve readable history while opt-out stops new remote summaries', async () => {
  const app = await mount(); try {
    await app.click('允许'); app.setActivities([query('query-1', 'completed'), query('pending-3')]); await app.emit();
    await app.click('清除'); assert.ok(app.container.querySelector('[data-id="query-1"]')); assert.ok(app.container.querySelector('[data-id="ui:clear"]'));
    await app.click('退出'); app.setActivities([query('query-2')]); await app.emit();
    assert.ok(app.container.querySelector('[data-id="query-1"]')); assert.equal(app.container.querySelector('[data-id="query-2"]'), null); assert.equal(app.controller.state.allowControl, false);
    assert.equal(app.container.querySelector('[data-id="ui:permission"]')?.getAttribute('data-status'), 'paused');
    assert.equal(app.controller.activities.find(value => value.id === 'pending-3')?.status, 'paused'); assert.match(app.controller.activities.find(value => value.id === 'pending-3')!.message, /不表示后端读取已取消/);
  } finally { await app.dispose(); }
});

test('connection failures update one public summary and recover without heartbeat noise', async () => {
  const app = await mount(); try {
    await app.disconnect(); await app.disconnect(); assert.equal(app.container.querySelectorAll('[data-id="ui:connection"]').length, 1);
    assert.equal(app.controller.activities.find(value => value.id === 'ui:connection')?.status, 'failed');
    await app.emit(); assert.equal(app.controller.activities.find(value => value.id === 'ui:connection')?.status, 'completed');
    const before = app.controller.activities; await app.tick(); assert.equal(app.controller.activities, before);
  } finally { await app.dispose(); }
});

test('summary upsert is scope-bound, bounded and does not regress a completed query from a stale running poll', () => {
  const activities = Array.from({ length: 60 }, (_, i) => ({ ...query(`query-${i}`, 'completed'), startedAt: new Date(1000 + i).toISOString(), updatedAt: new Date(2000 + i).toISOString() }));
  const result = mergeActivities([], [...activities, query('foreign', 'running', 'fixture:other')], 'fixture:main');
  assert.equal(result.length, 40); assert.equal(result[0].id, 'query-20'); assert.equal(result.at(-1)?.id, 'query-59');
  const stale = { ...result[0], status: 'running' as const, updatedAt: now() }; assert.equal(mergeActivities(result, [stale], 'fixture:main')[0].status, 'completed');
});

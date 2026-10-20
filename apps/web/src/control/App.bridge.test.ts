import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { BrowserState, ControlCommand } from '../../../../packages/control-protocol/src/types';

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
async function mount(holdTarget = false) {
  const browser = new Window({ url: 'http://127.0.0.1:4311' }), descriptors = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => { descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'sessionStorage', 'localStorage'] as const) install(key, key === 'window' ? browser : browser[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true); install('requestAnimationFrame', browser.requestAnimationFrame.bind(browser)); install('cancelAnimationFrame', browser.cancelAnimationFrame.bind(browser));
  let state: BrowserState = { allowControl: false, userRevision: 0, controlRevision: 0, visible: true, label: 'Fixture' }, command: ControlCommand | undefined;
  const requests: URL[] = [], acks: Record<string, unknown>[] = [], streams = new Set<Stream>();
  class Stream { onmessage: ((event: { data: string }) => void) | null = null; onopen: (() => void) | null = null; onerror: (() => void) | null = null; callbacks = new Set<() => void>(); constructor(public url: string) { streams.add(this); } addEventListener(_name: string, callback: () => void) { this.callbacks.add(callback); } close() { streams.delete(this); } }
  install('EventSource', Stream);
  let resolveTarget!: (value: Response) => void, targetRequested = false; const targetResponse = new Promise<Response>(done => { resolveTarget = done; });
  const worktrees = { one: [{ id: 'main', path: 'C:/Fixture/one', branch: 'main', head: 'h', authorized: true }], two: [{ id: 'first', path: 'C:/Fixture/two-first', branch: 'first', head: 'h', authorized: true }, { id: 'selected', path: 'C:/Fixture/two-selected', branch: 'selected', head: 'h', authorized: true }] };
  const graph = { nodes: [], edges: [], totalNodes: 0, truncated: false, revision: 'source-1' };
  const api = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), browser.location.origin), path = url.pathname, scope = url.searchParams.get('scope') || 'one:main', body = init?.body ? JSON.parse(String(init.body)) : undefined; requests.push(url);
    if (path === '/api/projects') return json({ projects: [{ id: 'one', name: '项目甲', root: 'C:/Fixture/one' }, { id: 'two', name: '项目乙', root: 'C:/Fixture/two' }] });
    if (path === '/api/projects/one/worktrees') return json({ worktrees: worktrees.one });
    if (path === '/api/projects/two/worktrees') { targetRequested = true; return holdTarget ? targetResponse : json({ worktrees: worktrees.two }); }
    if (path === '/api/status') return json({ scopeId: scope, state: 'synced', revision: 'source-1', message: 'test fixture' });
    if (path === '/api/summary') return json({ rootId: 'root', counts: { files: 0, nodes: 0, edges: 0 }, diagnostics: [], metadata: { scopeId: scope, revision: 'source-1', rootPath: 'C:/Fixture', gitBranch: 'fixture', projectName: 'Fixture' } });
    if (path === '/api/graph') return json(graph);
    if (path === '/api/architecture') return json({ metadata: { scopeId: scope, projectId: scope.split(':')[0], sourceRevision: 'source-1', modelRevision: 'arch-1', viewRevision: 'arch-view', projectionVersion: '1' }, perspective: 'business', graph, entities: [], relations: [], breadcrumbs: [], diagnostics: [], unclassifiedCount: 0, available: false });
    if (path.endsWith('/bootstrap')) return json({ sessionId: 'tab', csrf: 'csrf', serverEpoch: 'server', state });
    if (path.endsWith('/state')) { state = body.state; return json({ ...state, sessionId: 'tab', serverEpoch: 'server', lastSeenAt: new Date().toISOString() }); }
    if (path.endsWith('/current')) return json({ session: { ...state, sessionId: 'tab', serverEpoch: 'server', lastSeenAt: new Date().toISOString() }, ...(command ? { command } : {}) });
    if (path.endsWith('/ack')) { acks.push(body); return json({ commandId: body.commandId, presentationId: 'p', status: body.status, action: 'present', message: '', updatedAt: new Date().toISOString() }); }
    throw new Error(`Unexpected App bridge fixture ${url}`);
  };
  install('fetch', api); browser.fetch = api as unknown as typeof browser.fetch;
  const { createRoot } = await import('react-dom/client'), { default: App } = await import('../App'); const container = browser.document.createElement('div'); browser.document.body.append(container); const root = createRoot(container as unknown as Element); await act(async () => root.render(React.createElement(App)));
  const waitFor = async (check: () => void, label: string) => { let last: unknown; for (let i = 0; i < 120; i++) { try { check(); return; } catch (failure) { last = failure; } await act(async () => { await new Promise(done => setTimeout(done, 10)); }); } throw new Error(`${label}: ${last}`); };
  const click = async (text: string) => { const button = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.trim() === text); assert.ok(button, text); await act(async () => button.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }))); };
  const send = async () => {
    const expiresAt = new Date(Date.now() + 60000).toISOString(); command = { commandId: 'atomic-command', serverEpoch: 'server', sessionId: 'tab', bindingId: 'binding', sequence: 1, expiresAt, expectedUserRevision: state.userRevision, expectedControlRevision: state.controlRevision, resolved: { presentation: { schemaVersion: '1.0', presentationId: 'p', projectId: 'two', worktreeId: 'selected', indexSnapshotId: 'source-1', snapshotId: 'snapshot', title: '指定工作区', summary: '测试原子切换', targetView: 'code', viewMode: 'code', semanticGranularity: 'simple', highlightedNodeIds: [], highlightedEdgeIds: [], orderedSteps: [], evidenceIds: [], warnings: [], createdAt: new Date().toISOString() }, snapshot: { snapshotId: 'snapshot', projectId: 'two', worktreeId: 'selected', scopeId: 'two:selected', indexSnapshotId: 'source-1', architectureRevision: 'arch-1', semanticViewRevision: '', expiresAt, indexState: 'synced' }, codeGraph: graph, highlights: { codeNodeIds: [], codeEdgeIds: [], semanticNodeIds: [], semanticEdgeIds: [], architectureNodeIds: [], architectureEdgeIds: [] }, warnings: [] } };
    await act(async () => { for (const stream of streams) if (stream.url.includes('/bridge/')) for (const callback of stream.callbacks) callback(); });
  };
  const dispose = async () => { await act(async () => root.unmount()); await browser.happyDOM.close(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } };
  await waitFor(() => { assert.equal((container.querySelector('[aria-label="选择 Worktree"]') as unknown as HTMLSelectElement).value, 'main'); assert.equal((Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('允许 Codex 联动')) as unknown as HTMLButtonElement).disabled, false); }, 'App initialized');
  await click('允许 Codex 联动'); await waitFor(() => assert.equal(state.allowControl, true), 'opted in');
  return { browser, container, requests, acks, click, send, waitFor, dispose, userRevision: () => state.userRevision, targetRequested: () => targetRequested, release: async () => { await act(async () => resolveTarget(json({ worktrees: worktrees.two }))); } };
}
test('real App switches the requested project/worktree atomically without visiting its default first worktree', async () => {
  const app = await mount(); try { await app.send(); await app.waitFor(() => assert.equal((app.container.querySelector('[aria-label="选择 Worktree"]') as unknown as HTMLSelectElement).value, 'selected'), 'target worktree'); assert.equal((app.container.querySelector('[aria-label="选择项目"]') as unknown as HTMLSelectElement).value, 'two'); assert.equal(app.requests.some(url => url.searchParams.get('scope') === 'two:first'), false); assert.ok(app.requests.some(url => url.searchParams.get('scope') === 'two:selected')); } finally { await app.dispose(); }
});
test('real App refuses a late project preparation after manual navigation changes the user revision', async () => {
  const app = await mount(true); try { await app.send(); await app.waitFor(() => assert.equal(app.targetRequested(), true), 'target preparation'); await app.click('技术架构'); await app.release(); await app.waitFor(() => assert.ok(app.acks.some(ack => ack.status === 'conflict')), 'manual navigation conflict'); assert.equal((app.container.querySelector('[aria-label="选择项目"]') as unknown as HTMLSelectElement).value, 'one'); assert.equal(app.container.querySelector('.control-workspace'), null); assert.equal(app.acks.some(ack => ack.status === 'presented'), false); } finally { await app.dispose(); }
});

test('opening, moving and hiding the progress bubble does not interrupt a pending MCP navigation', async () => {
  const app = await mount(true);
  try {
    await app.send(); await app.waitFor(() => assert.equal(app.targetRequested(), true), 'target preparation');
    const before = app.userRevision();
    await app.click('演示进度');
    const bubble = app.container.querySelector('[aria-label="Codex 演示进度"]'); assert.ok(bubble);
    const handle = bubble.querySelector('[aria-label="移动演示气泡"]'); assert.ok(handle);
    await act(async () => {
      handle.dispatchEvent(new app.browser.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      handle.dispatchEvent(new app.browser.WheelEvent('wheel', { deltaY: 50, bubbles: true }));
      handle.dispatchEvent(new app.browser.MouseEvent('pointerdown', { buttons: 1, bubbles: true }));
      handle.dispatchEvent(new app.browser.MouseEvent('pointermove', { buttons: 1, clientX: 20, clientY: 20, bubbles: true }));
      handle.dispatchEvent(new app.browser.MouseEvent('pointerup', { bubbles: true }));
    });
    const hide = bubble.querySelector('[aria-label="隐藏演示气泡"]'); assert.ok(hide);
    await act(async () => hide.dispatchEvent(new app.browser.MouseEvent('click', { bubbles: true })));
    assert.equal(app.userRevision(), before, 'bubble gestures are UI preferences, not architecture navigation');
    await app.release();
    await app.waitFor(() => assert.equal((app.container.querySelector('[aria-label="选择 Worktree"]') as unknown as HTMLSelectElement).value, 'selected'), 'target navigation preserved');
    assert.equal(app.acks.some(ack => ack.status === 'conflict'), false);
  } finally { await app.dispose(); }
});

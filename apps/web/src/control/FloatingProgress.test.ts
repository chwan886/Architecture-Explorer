import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { BridgeActivity, ControlCommand, PresentationReceipt } from '../../../../packages/control-protocol/src/types';
import type { SemanticNode } from '../../../../packages/semantic-model/src/types';
import FloatingProgress, { type FloatingProgressProps } from './FloatingProgress';
import { BUBBLE_STORAGE_KEY, clampBubble, presentationIsCurrent, progressStatus, readBubblePreferences, recentActivities } from './progress';

const activity = (sequence: number, status: BridgeActivity['status'] = 'completed'): BridgeActivity => ({ id: `activity-${sequence}`, sequence, kind: 'query', operation: 'get_flow', title: `读取流程 ${sequence}`, message: '已读取当前源码快照中的流程；尚未代表网页呈现。', status, startedAt: '2026-10-20T18:00:00Z', updatedAt: '2026-10-20T18:00:01Z', scopeId: 'fixture:main' });
function command(): ControlCommand {
  const future = new Date(Date.now() + 60000).toISOString();
  return { commandId: 'command-1', sessionId: 'session-1', bindingId: 'binding-secret', serverEpoch: 'epoch-1', sequence: 1, expectedControlRevision: 0, expectedUserRevision: 1, expiresAt: future, resolved: { presentation: { schemaVersion: '1.0', presentationId: 'presentation-1', projectId: 'fixture', worktreeId: 'main', snapshotId: 'snapshot-1', indexSnapshotId: 'index-1', title: '流程演示', summary: '测试专用流程，不是实际游戏数据。', targetView: 'code', viewMode: 'code', semanticGranularity: 'simple', focusNodeId: { layer: 'code', id: 'method-1' }, highlightedNodeIds: [], highlightedEdgeIds: [], orderedSteps: [{ id: 'step-1', name: '处理命中数据', codeNodeIds: ['method-1'], codeEdgeIds: [], inputs: [], outputs: [], evidenceIds: ['wrong-step-evidence'], verification: 'source-supported', orderBasis: 'reading-order' }], evidenceIds: [], warnings: [], createdAt: new Date().toISOString() }, snapshot: { snapshotId: 'snapshot-1', projectId: 'fixture', worktreeId: 'main', scopeId: 'fixture:main', indexSnapshotId: 'index-1', architectureRevision: 'architecture-1', semanticViewRevision: 'semantic-1', expiresAt: future, indexState: 'synced' }, codeGraph: { revision: 'index-1', nodes: [{ id: 'method-1', kind: 'method', label: 'ApplyHit', qualifiedName: 'Fixture.ApplyHit', language: 'csharp', evidenceIds: ['real-node-evidence'] }], edges: [], totalNodes: 1, truncated: false }, highlights: { codeNodeIds: [], codeEdgeIds: [], semanticNodeIds: [], semanticEdgeIds: [], architectureNodeIds: [], architectureEdgeIds: [] }, warnings: [] } };
}
const receipt = (status: PresentationReceipt['status'] = 'presented'): PresentationReceipt => ({ commandId: 'command-1', presentationId: 'presentation-1', status, message: '测试回执', updatedAt: new Date().toISOString() });

test('progress preferences persist only finite position and collapsed UI state; bounds handle small viewports', () => {
  assert.deepEqual(readBubblePreferences('{"version":1,"x":12,"y":22,"collapsed":true,"token":"secret","history":[1]}'), { version: 1, x: 12, y: 22, collapsed: true });
  assert.equal(readBubblePreferences('{"version":1,"x":"12","y":22,"collapsed":true}'), undefined);
  assert.equal(readBubblePreferences('broken'), undefined);
  assert.deepEqual(clampBubble({ x: 9999, y: -99 }, { width: 800, height: 600 }, { width: 330, height: 420 }), { x: 458, y: 12 });
  assert.deepEqual(clampBubble({ x: 100, y: 100 }, { width: 320, height: 200 }, { width: 330, height: 420 }), { x: 0, y: 0 });
});
test('activity view is scoped, newest first, and bounded without mutating shared history', () => {
  const activities = Array.from({ length: 60 }, (_, i) => activity(i)); activities.push({ ...activity(99), scopeId: 'other:main' });
  const visible = recentActivities(activities, 'fixture:main');
  assert.equal(visible.length, 40); assert.equal(visible[0].sequence, 59); assert.equal(visible.at(-1)?.sequence, 20); assert.equal(activities[0].sequence, 0);
  assert.deepEqual(recentActivities([{ ...activity(900), startedAt: '2026-10-20T18:01:00Z' }, { ...activity(1), startedAt: '2026-10-20T18:02:00Z' }], 'fixture:main').map(item => item.sequence), [1, 900], 'browser and server sequence numbers never determine cross-domain recency');
  assert.equal(recentActivities([{ ...activity(900, 'paused'), startedAt: '2026-10-20T18:00:00Z', updatedAt: '2026-10-20T18:03:00Z' }, { ...activity(1), startedAt: '2026-10-20T18:01:00Z', updatedAt: '2026-10-20T18:02:00Z' }], 'fixture:main')[0].status, 'paused', 'pausing an existing command remains newer than a query which started later');
});
test('query completion, browser presentation, pause and failure remain distinct real statuses', () => {
  const base = { connected: true, allowControl: true, staleMessage: '', error: '', activity: activity(1) };
  assert.equal(progressStatus(base).label, '查询完成 · 等待展示');
  assert.equal(progressStatus({ ...base, command: command(), receipt: receipt('received') }).label, '网页正在呈现');
  assert.equal(progressStatus({ ...base, command: command(), receipt: receipt() }).label, '网页已呈现');
  assert.equal(progressStatus({ ...base, command: command(), receipt: receipt(), activity: activity(2, 'running') }).label, '正在查询架构');
  assert.equal(progressStatus({ ...base, allowControl: false, receipt: receipt() }).tone, 'paused');
  assert.equal(progressStatus({ ...base, connected: false }).tone, 'paused');
  assert.equal(progressStatus({ ...base, staleMessage: '旧快照' }).label, '快照已过期');
  assert.equal(progressStatus({ ...base, command: command(), receipt: receipt('failed') }).tone, 'failed');
  const olderReceipt = { ...receipt(), updatedAt: '2026-10-20T18:00:00Z' };
  assert.equal(progressStatus({ ...base, command: command(), receipt: olderReceipt, activity: activity(2, 'paused') }).tone, 'paused', 'manual pause is not masked by an older presented receipt');
  assert.equal(progressStatus({ ...base, command: command(), receipt: olderReceipt, activity: activity(2, 'failed') }).tone, 'failed', 'failed query is not shown as successfully presented');
  assert.equal(progressStatus({ ...base, command: command(), receipt: olderReceipt }).label, '查询完成 · 当前图保留', 'query completion does not assert a new presentation');
  const nextCommand = command(); nextCommand.commandId = 'new-command';
  for (const status of ['failed', 'expired', 'conflict'] as const) assert.equal(progressStatus({ ...base, command: nextCommand, receipt: receipt(status), activity: activity(5, 'running') }).label, '正在查询架构', `old ${status} receipt never overrides new work`);
  assert.equal(progressStatus({ ...base, command: command(), receipt: { ...receipt('received'), commandId: 'incoming-command' }, activity: { ...activity(5, 'running'), kind: 'presentation', commandId: 'incoming-command' } }).tone, 'running', 'incoming presentation can report progress before onApply replaces command');
});
test('source navigation requires presented command, matching scope, source revision and unexpired snapshot', () => {
  const value = command(); assert.equal(presentationIsCurrent(value, receipt(), 'fixture:main', ''), true);
  assert.equal(presentationIsCurrent(value, receipt('received'), 'fixture:main', ''), false);
  assert.equal(presentationIsCurrent(value, { ...receipt(), commandId: 'older' }, 'fixture:main', ''), false);
  assert.equal(presentationIsCurrent(value, receipt(), 'other:main', ''), false);
  assert.equal(presentationIsCurrent(value, receipt(), 'fixture:main', '已失效'), false);
  assert.equal(presentationIsCurrent(value, receipt(), 'fixture:main', '', Date.now() + 120000), false);
  value.resolved.codeGraph!.revision = 'index-2'; assert.equal(presentationIsCurrent(value, receipt(), 'fixture:main', ''), false);
});
test('command-specific paused or failed presentation blocks source even while permission and old receipt remain valid', () => {
  const value = command(), paused: BridgeActivity = { ...activity(1, 'paused'), kind: 'presentation', commandId: value.commandId };
  assert.equal(presentationIsCurrent(value, receipt(), 'fixture:main', '', Date.now(), [paused]), false);
  assert.equal(presentationIsCurrent(value, receipt(), 'fixture:main', '', Date.now(), [{ ...paused, status: 'failed' }]), false);
  assert.equal(presentationIsCurrent(value, receipt(), 'fixture:main', '', Date.now(), [{ ...paused, kind: 'query' }]), true, 'unrelated query status does not revoke the presented command');
  assert.equal(presentationIsCurrent(value, receipt(), 'fixture:main', '', Date.now(), [{ ...paused, commandId: 'older-command' }]), true, 'older command pause does not block a new command');
  assert.equal(presentationIsCurrent(value, receipt(), 'fixture:main', '', Date.now(), [], 2), false, 'user revision prevents revival after paused activity is evicted');
  assert.equal(presentationIsCurrent(value, receipt(), 'fixture:main', '', Date.now(), [], 1), true);
});

async function mount(initial: Partial<FloatingProgressProps> = {}) {
  const browser = new Window({ url: 'http://127.0.0.1:4311' }), descriptors = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => { descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'ResizeObserver'] as const) install(key, key === 'window' ? browser : browser[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const { createRoot } = await import('react-dom/client'); const container = browser.document.createElement('div'); browser.document.body.append(container); const root = createRoot(container as unknown as Element);
  const opened: [string, string | undefined][] = [], callbacks = { left: 0, reconnected: 0 };
  let props: FloatingProgressProps = { activities: [], connected: true, allowControl: false, scopeId: 'fixture:main', staleMessage: '', error: '', openToken: 0, onOpenCode: (id, evidenceId) => opened.push([id, evidenceId]), onLeave: () => callbacks.left++, onReconnect: () => callbacks.reconnected++, ...initial };
  const render = async (next: Partial<FloatingProgressProps> = {}) => { props = { ...props, ...next }; await act(async () => root.render(React.createElement(FloatingProgress, props))); };
  const click = async (label: string) => { const button = container.querySelector(`[aria-label="${label}"]`); assert.ok(button, label); await act(async () => button.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }))); };
  const dispose = async () => { await act(async () => root.unmount()); await browser.happyDOM.close(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } };
  await render(); return { browser, container, render, click, dispose, opened, callbacks };
}
test('bubble shows on first actual activity, respects manual hiding, and reopens explicitly', async () => {
  const app = await mount(); try {
    assert.equal(app.container.querySelector('.floating-progress'), null);
    await app.render({ activities: [activity(1)] }); assert.ok(app.container.querySelector('.floating-progress.is-collapsed'));
    await app.click('展开演示进度'); assert.ok(app.container.textContent?.includes('已读取当前源码快照中的流程'));
    await app.click('隐藏演示气泡'); assert.equal(app.container.querySelector('.floating-progress'), null);
    await app.render({ activities: [activity(1), activity(2)], allowControl: true }); assert.equal(app.container.querySelector('.floating-progress'), null, 'new operations do not undo user hiding');
    await app.render({ openToken: 1 }); assert.ok(app.container.querySelector('.floating-progress.is-expanded'));
    assert.equal(app.container.querySelector('.floating-progress')?.getAttribute('data-control-automatic'), 'true');
    await act(async () => app.container.querySelector('.floating-progress')!.dispatchEvent(new app.browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.ok(app.container.querySelector('.floating-progress.is-collapsed'));
    const saved = JSON.parse(app.browser.localStorage.getItem(BUBBLE_STORAGE_KEY)!); assert.deepEqual(Object.keys(saved).sort(), ['collapsed', 'version', 'x', 'y']);
  } finally { await app.dispose(); }
});
test('handle supports pointer drag and keyboard bounds; activity text is never rendered as markup', async () => {
  const app = await mount({ allowControl: true, activities: [{ ...activity(1), message: '<img src=x onerror=alert(1)>' }] }); try {
    const handle = app.container.querySelector('.floating-progress-handle')!;
    const before = Number.parseFloat((app.container.querySelector('.floating-progress') as unknown as HTMLElement).style.left);
    await act(async () => handle.dispatchEvent(new app.browser.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    assert.equal(Number.parseFloat((app.container.querySelector('.floating-progress') as unknown as HTMLElement).style.left), before - 12);
    await act(async () => {
      handle.dispatchEvent(new app.browser.PointerEvent('pointerdown', { pointerId: 3, button: 0, clientX: 100, clientY: 100, bubbles: true }));
      handle.dispatchEvent(new app.browser.PointerEvent('pointermove', { pointerId: 3, clientX: -10000, clientY: -10000, bubbles: true }));
      handle.dispatchEvent(new app.browser.PointerEvent('pointerup', { pointerId: 3, bubbles: true }));
    });
    assert.equal((app.container.querySelector('.floating-progress') as unknown as HTMLElement).style.left, '12px');
    assert.equal((app.container.querySelector('.floating-progress') as unknown as HTMLElement).style.top, '12px');
    await app.click('展开演示进度'); assert.equal(app.container.querySelector('img'), null); assert.ok(app.container.textContent?.includes('<img src=x onerror=alert(1)>'));
    Object.defineProperty(app.browser, 'innerWidth', { configurable: true, value: 360 }); Object.defineProperty(app.browser, 'innerHeight', { configurable: true, value: 240 });
    await act(async () => app.browser.dispatchEvent(new app.browser.Event('resize')));
    const resized = (app.container.querySelector('.floating-progress') as unknown as HTMLElement).style;
    assert.ok(Number.parseFloat(resized.left) <= 18); assert.ok(Number.parseFloat(resized.top) <= 12, 'expanded bubble is clamped inside resized viewport');
  } finally { await app.dispose(); }
});
test('semantic focus explains public purpose and preserves multiple real implementation mappings', async () => {
  const value = command(), one = value.resolved.codeGraph!.nodes[0], two = { ...one, id: 'method-2', label: 'WriteState', evidenceIds: ['second-node-evidence'] };
  const semanticNode: SemanticNode = { id: 'semantic-step', title: '更新命中状态', summary: '测试语义说明', purpose: '测试业务目的', detail: '', limitations: [], inputs: ['测试输入'], processing: [], outputs: ['测试输出'], changes: ['测试状态变化'], codeNodeIds: ['method-1', 'method-2'], contextNodeIds: [], evidenceIds: ['wrong-semantic-evidence'], fragments: [], bindings: [], childIds: [], sourceStepIds: [], controls: [{ kind: 'condition', description: '测试分支条件保留', anchorIds: [] }], origin: 'curated', status: 'current', level: 'summary', reviewState: 'pending', fingerprint: 'fixture' };
  value.resolved.presentation.focusNodeId = { layer: 'semantic', id: 'semantic-step', flowId: 'flow-1' }; value.resolved.presentation.flowId = 'flow-1';
  value.resolved.semantic = { metadata: { scopeId: 'fixture:main', projectId: 'fixture', sourceRevision: 'index-1', architectureRevision: 'architecture-1', definitionRevision: 'definition-1', overlayRevision: 'overlay-1', viewRevision: 'semantic-1', generatorVersion: 'fixture', projectionVersion: '1' }, flows: [], flow: { id: 'flow-1', sourceFlowId: 'flow-1', title: '测试流程', description: '', summaryNodes: [semanticNode], detailNodes: [], summaryEdges: [], detailEdges: [], codeGraph: { ...value.resolved.codeGraph!, nodes: [one, two], totalNodes: 2 }, codeNodes: [one, two], codeEdges: [], evidence: [], reviewState: 'pending', fingerprint: 'fixture', diagnostics: [], limitations: [], reverseNodes: { 'method-1': ['semantic-step'], 'method-2': ['semantic-step'] }, reverseEdges: {}, changes: { unchangedNodeIds: [], changedNodeIds: [], removedNodeIds: [], unchangedEdgeIds: [], changedEdgeIds: [], removedEdgeIds: [] } } };
  const app = await mount({ command: value, receipt: receipt(), allowControl: true }); try {
    await app.click('展开演示进度');
    for (const expected of ['测试语义说明', '测试业务目的', '测试输入', '测试输出', '测试状态变化', '测试分支条件保留', '待人工确认']) assert.ok(app.container.textContent?.includes(expected), expected);
    assert.equal(app.container.querySelectorAll('[data-progress-code-id]').length, 2);
    await act(async () => app.container.querySelector('[data-progress-code-id="method-2"]')!.dispatchEvent(new app.browser.MouseEvent('click', { bubbles: true })));
    assert.deepEqual(app.opened, [['method-2', 'second-node-evidence']]);
    const stale = structuredClone(value); stale.resolved.semantic!.metadata.viewRevision = 'new-semantic-version'; await app.render({ command: stale });
    assert.equal(Array.from(app.container.querySelectorAll('[data-progress-code-id]')).every(button => (button as unknown as HTMLButtonElement).disabled), true, 'mixed-version semantic mappings cannot navigate');
  } finally { await app.dispose(); }
});
test('implementation navigation uses indexed node evidence and is blocked after stale or manual pause', async () => {
  const app = await mount({ command: command(), receipt: receipt(), allowControl: true }); try {
    await app.click('展开演示进度');
    const jump = () => app.container.querySelector('[data-progress-code-id="method-1"]')!;
    await act(async () => jump().dispatchEvent(new app.browser.MouseEvent('click', { bubbles: true })));
    assert.deepEqual(app.opened, [['method-1', 'real-node-evidence']], 'does not reuse an unrelated analysis step evidence ID');
    await app.render({ staleMessage: '源码已更新' }); assert.equal((jump() as unknown as HTMLButtonElement).disabled, true);
    await app.render({ staleMessage: '', allowControl: false }); assert.equal((jump() as unknown as HTMLButtonElement).disabled, true);
    assert.ok(app.container.textContent?.includes('联动已暂停'));
    await app.render({ allowControl: true, connected: false }); assert.ok(app.container.textContent?.includes('重连'));
    const reconnect = Array.from(app.container.querySelectorAll('button')).find(button => button.textContent?.trim() === '重连')!;
    await act(async () => reconnect.dispatchEvent(new app.browser.MouseEvent('click', { bubbles: true }))); assert.equal(app.callbacks.reconnected, 1);
    const leave = Array.from(app.container.querySelectorAll('button')).find(button => button.textContent?.includes('恢复手动浏览'))!;
    await act(async () => leave.dispatchEvent(new app.browser.MouseEvent('click', { bubbles: true }))); assert.equal(app.callbacks.left, 1);
  } finally { await app.dispose(); }
});
test('manual canvas pause disables source with allowControl=true; a newly presented command restores valid navigation', async () => {
  const value = command(), paused: BridgeActivity = { ...activity(1, 'paused'), kind: 'presentation', commandId: value.commandId, id: `ui:command:${value.commandId}` };
  const app = await mount({ command: value, receipt: receipt(), allowControl: true, activities: [paused, activity(2)] }); try {
    await app.click('展开演示进度');
    assert.equal((app.container.querySelector('[data-progress-code-id="method-1"]') as unknown as HTMLButtonElement).disabled, true, 'old presented receipt cannot revive a manually paused command');
    const next = command(); next.commandId = 'command-2'; next.resolved.presentation.presentationId = 'presentation-2';
    await app.render({ command: next, receipt: { ...receipt(), commandId: next.commandId, presentationId: 'presentation-2' } });
    const button = app.container.querySelector('[data-progress-code-id="method-1"]')!;
    assert.equal((button as unknown as HTMLButtonElement).disabled, false);
    await act(async () => button.dispatchEvent(new app.browser.MouseEvent('click', { bubbles: true })));
    assert.deepEqual(app.opened, [['method-1', 'real-node-evidence']]);
  } finally { await app.dispose(); }
});
test('user revision keeps source paused after activity eviction without claiming snapshot expiry', async () => {
  const app = await mount({ command: command(), receipt: receipt(), allowControl: true, userRevision: 2, activities: [] }); try {
    await app.click('展开演示进度');
    assert.equal((app.container.querySelector('[data-progress-code-id="method-1"]') as unknown as HTMLButtonElement).disabled, true);
    assert.ok(app.container.textContent?.includes('人工操作已优先 · 演示暂停'));
    assert.equal(app.container.textContent?.includes('快照已过期'), false);
    const next = command(); next.commandId = 'new-after-manual'; next.expectedUserRevision = 2;
    await app.render({ command: next, receipt: { ...receipt(), commandId: next.commandId } });
    assert.equal((app.container.querySelector('[data-progress-code-id="method-1"]') as unknown as HTMLButtonElement).disabled, false);
  } finally { await app.dispose(); }
});

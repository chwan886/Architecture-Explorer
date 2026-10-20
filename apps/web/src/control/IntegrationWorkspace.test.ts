import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { ControlCommand } from '../../../../packages/control-protocol/src/types';
import type { ArchitectureNode, Evidence } from '../../../../packages/schema/src/index';
import type { ResolvedSemanticFlow, SemanticNode } from '../../../../packages/semantic-model/src/types';
import IntegrationWorkspace, { requestedExpandedGroups, semanticFocusTargets } from './IntegrationWorkspace';

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const evidence = (id: string): Evidence => ({ id, filePath: `Fixture/${id}.cs`, startLine: 4, startColumn: 1, endLine: 4, endColumn: 20, fileHash: 'fixture-hash', rule: `fixture:${id}` });
const nodes: ArchitectureNode[] = ['one', 'two'].map(id => ({ id, kind: 'method', label: `Method_${id}`, qualifiedName: `Fixture.${id}`, language: 'csharp', evidenceIds: [`e:${id}`] }));
const source = (id: string, revision = 'source-1') => ({ evidence: evidence(id), content: `SOURCE_${id}`, contextStartLine: 4, revision, stale: false });
function fixture(id = 'command-1'): ControlCommand {
  return { commandId: id, serverEpoch: 'server-1', sessionId: 'session-1', bindingId: 'binding-1', sequence: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), expectedUserRevision: 1, expectedControlRevision: 0, resolved: { presentation: { schemaVersion: '1.0', presentationId: `p:${id}`, projectId: 'fixture', worktreeId: 'main', indexSnapshotId: 'source-1', snapshotId: 'snapshot-1', title: '夹具分析', summary: '仅测试数据', targetView: 'code', viewMode: 'code', semanticGranularity: 'simple', focusNodeId: { layer: 'code', id: 'one' }, highlightedNodeIds: [{ layer: 'code', id: 'one' }], highlightedEdgeIds: [], orderedSteps: nodes.map(node => ({ id: `step:${node.id}`, name: node.label, codeNodeIds: [node.id], codeEdgeIds: [], inputs: [], outputs: [], evidenceIds: node.evidenceIds, verification: 'source-supported', orderBasis: 'reading-order' })), evidenceIds: ['e:one'], warnings: [], createdAt: new Date().toISOString() }, snapshot: { snapshotId: 'snapshot-1', projectId: 'fixture', worktreeId: 'main', scopeId: 'fixture:main', indexSnapshotId: 'source-1', architectureRevision: 'arch-1', semanticViewRevision: '', expiresAt: new Date(Date.now() + 60000).toISOString(), indexState: 'synced' }, codeGraph: { nodes, edges: [], totalNodes: 2, truncated: false, revision: 'source-1' }, evidence: source('e:one'), highlights: { codeNodeIds: ['one'], codeEdgeIds: [], semanticNodeIds: [], semanticEdgeIds: [], architectureNodeIds: [], architectureEdgeIds: [] }, warnings: [] } };
}
async function mount() {
  const browser = new Window({ url: 'http://127.0.0.1:4311' }), descriptors = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => { descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'ResizeObserver', 'DOMMatrixReadOnly', 'sessionStorage', 'localStorage'] as const) install(key, key === 'window' ? browser : browser[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true); install('requestAnimationFrame', browser.requestAnimationFrame.bind(browser)); install('cancelAnimationFrame', browser.cancelAnimationFrame.bind(browser)); install('getComputedStyle', browser.getComputedStyle.bind(browser));
  const held = new Map<string, { promise: Promise<Response>; resolve: (value: Response) => void; requested: boolean }>(), requests: string[] = [], openedCode: string[] = [], openedArchitecture: string[] = [];
  const api = async (input: RequestInfo | URL) => { const url = new URL(String(input), browser.location.origin), id = decodeURIComponent(url.pathname.slice('/api/evidence/'.length)), delay = held.get(id); requests.push(url.pathname); if (delay && !delay.requested) { delay.requested = true; return delay.promise; } return json(source(id)); };
  install('fetch', api); browser.fetch = api as unknown as typeof browser.fetch;
  const { createRoot } = await import('react-dom/client'); const container = browser.document.createElement('div'); browser.document.body.append(container); const root = createRoot(container as unknown as Element);
  const failed: string[] = [], presented: string[] = [];
  const render = async (command: ControlCommand) => { await act(async () => root.render(React.createElement(IntegrationWorkspace, { command, highlightsEnabled: true, staleMessage: '', rootPath: 'C:/fixture', onPresented(id) { presented.push(id); }, onFailed(_id, message) { failed.push(message); }, onReturn() {}, onOpenCode(id) { openedCode.push(id); }, onOpenArchitecture(id) { openedArchitecture.push(id); } }))); };
  const waitFor = async (check: () => void, label: string) => { let last: unknown; for (let i = 0; i < 100; i++) { try { check(); return; } catch (failure) { last = failure; } await act(async () => { await new Promise(done => setTimeout(done, 10)); }); } throw new Error(`${label}: ${last}`); };
  const click = async (selector: string) => { const button = container.querySelector(selector); assert.ok(button); await act(async () => button.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }))); };
  const stamp = async (nodeId: string, evidenceId: string) => waitFor(() => { assert.equal(container.querySelector('.control-workspace')?.getAttribute('data-selection-id'), nodeId); assert.equal(container.querySelector('.control-source [data-evidence-id]')?.getAttribute('data-evidence-id'), evidenceId); }, `source ${nodeId}/${evidenceId}`);
  const dispose = async () => { await act(async () => root.unmount()); await browser.happyDOM.close(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } };
  await render(fixture()); return { container, browser, render, click, waitFor, stamp, held, failed, presented, requests, openedCode, openedArchitecture, dispose };
}
test('integration workspace keeps its canvas, manual focus and history for a same-graph highlight-only command', async () => {
  const app = await mount(); try {
    await app.stamp('one', 'e:one'); await app.click('.control-reading > button:nth-of-type(2)'); await app.stamp('two', 'e:two');
    const canvas = app.container.querySelector('.canvas-surface'), viewport = app.container.querySelector('.react-flow__viewport')?.getAttribute('style');
    const next = fixture('command-2'); delete next.resolved.presentation.focusNodeId; delete next.resolved.evidence; next.resolved.highlights.codeNodeIds = ['two']; next.resolved.presentation.highlightedNodeIds = [{ layer: 'code', id: 'two' }];
    await app.render(next); assert.equal(app.container.querySelector('.canvas-surface'), canvas, 'same graph does not remount the canvas'); assert.equal(app.container.querySelector('.control-workspace')?.getAttribute('data-selection-id'), 'two'); assert.equal(app.container.querySelector('.react-flow__viewport')?.getAttribute('style'), viewport); assert.equal((app.container.querySelector('[aria-label="返回上一联动上下文"]') as unknown as HTMLButtonElement).disabled, false);
    await app.click('[aria-label="返回上一联动上下文"]'); await app.stamp('one', 'e:one');
  } finally { await app.dispose(); }
});
test('integration workspace rejects a late source response after the reader selects another step', async () => {
  const app = await mount(); try {
    let resolve!: (value: Response) => void; const delayed = { promise: new Promise<Response>(done => { resolve = done; }), resolve: (value: Response) => resolve(value), requested: false }; app.held.set('e:two', delayed);
    await app.click('.control-reading > button:nth-of-type(2)'); await app.waitFor(() => assert.equal(delayed.requested, true), 'delayed second source'); await app.click('.control-reading > button:nth-of-type(1)'); await app.stamp('one', 'e:one'); await act(async () => delayed.resolve(json(source('e:two')))); await app.stamp('one', 'e:one');
  } finally { await app.dispose(); }
});
test('a new external focus command restores its resolved source after the previous evidence effect is replaced', async () => {
  const app = await mount(); try {
    await app.stamp('one', 'e:one');
    const next = fixture('focus-two'); next.resolved.presentation.focusNodeId = { layer: 'code', id: 'two' }; next.resolved.presentation.highlightedNodeIds = [{ layer: 'code', id: 'two' }]; next.resolved.highlights.codeNodeIds = ['two'];
    next.resolved.presentation.evidenceIds = ['e:one', 'e:two']; next.resolved.evidence = source('e:two');
    await app.render(next); await app.stamp('two', 'e:two');
    await app.waitFor(() => assert.ok(app.container.querySelector('.react-flow__node.selected[data-id="two"]')), 'new command canvas selection');
    assert.equal(app.container.querySelector('.control-source [data-node-id]')?.getAttribute('data-node-id'), 'two');
    assert.equal(app.container.querySelector('.control-inspector h2')?.textContent, 'Method_two');
    assert.ok(app.container.querySelector('.control-source')?.textContent?.includes('SOURCE_e:two'));
    assert.equal(app.container.querySelector('.control-source')?.textContent?.includes('正在核验'), false);
    assert.deepEqual(app.failed, []);
  } finally { await app.dispose(); }
});

test('integration workspace fails mixed-version evidence instead of displaying it under the analysis snapshot', async () => {
  const app = await mount(); try {
    let resolve!: (value: Response) => void; const delayed = { promise: new Promise<Response>(done => { resolve = done; }), resolve: (value: Response) => resolve(value), requested: false }; app.held.set('e:two', delayed); await app.click('.control-reading > button:nth-of-type(2)'); await app.waitFor(() => assert.equal(delayed.requested, true), 'evidence requested'); await act(async () => delayed.resolve(json(source('e:two', 'source-2')))); await app.waitFor(() => assert.ok(app.failed.some(message => message.includes('版本'))), 'snapshot evidence rejected'); assert.equal(app.container.querySelector('.control-source .source-code'), null);
  } finally { await app.dispose(); }
});
test('detailed semantic presentation expands a focused summary locally and preserves explicit detail IDs in simple mode', () => {
  const groups = [{ id: 'summary-a', childIds: ['detail-a1', 'detail-a2'] }, { id: 'summary-b', childIds: ['detail-b'] }];
  assert.deepEqual(requestedExpandedGroups(groups, new Set(['summary-b']), true), ['summary-b']);
  assert.deepEqual(requestedExpandedGroups(groups, new Set(['summary-b']), false), []);
  assert.deepEqual(requestedExpandedGroups(groups, new Set(['detail-b']), false), ['summary-b']);
  assert.deepEqual(requestedExpandedGroups(groups, new Set(), true), ['summary-a']);
});
test('integration workspace resets expanded groups on detailed to code to simple to detailed commands', async () => {
  const app = await mount();
  const semanticNode = (id: string, level: 'summary' | 'detail', childIds: string[], parentId?: string): SemanticNode => ({ id, level, parentId, childIds, title: id, summary: 'fixture', purpose: '', detail: '', inputs: [], processing: [], outputs: [], changes: [], sourceStepIds: [], codeNodeIds: id === 'detail-b' ? ['two'] : ['one'], contextNodeIds: [], evidenceIds: [], fragments: [], bindings: [], controls: [], origin: 'curated', status: 'current', reviewState: 'pending', fingerprint: id, limitations: [] });
  const flow: ResolvedSemanticFlow = { id: 'battle', sourceFlowId: 'source-battle', title: 'Battle fixture', description: 'Explicit regression fixture', summaryNodes: [semanticNode('battle-resolve', 'summary', ['detail-a', 'detail-b']), semanticNode('battle-sync', 'summary', ['detail-c'])], detailNodes: [semanticNode('detail-a', 'detail', [], 'battle-resolve'), semanticNode('detail-b', 'detail', [], 'battle-resolve'), semanticNode('detail-c', 'detail', [], 'battle-sync')], summaryEdges: [], detailEdges: [], codeGraph: fixture().resolved.codeGraph!, codeNodes: nodes, codeEdges: [], evidence: [], reviewState: 'pending', fingerprint: 'flow-fixture', diagnostics: [], limitations: [], reverseNodes: { one: ['detail-a'], two: ['detail-b'] }, reverseEdges: {}, changes: { unchangedNodeIds: [], changedNodeIds: [], removedNodeIds: [], unchangedEdgeIds: [], changedEdgeIds: [], removedEdgeIds: [] } };
  const command = (id: string, mode: 'compare' | 'code' | 'explanation', granularity: 'simple' | 'detailed', layer: 'code' | 'semantic', focusId: string) => {
    const value = fixture(id); value.resolved.presentation.targetView = 'flow'; value.resolved.presentation.flowId = 'battle'; value.resolved.presentation.viewMode = mode; value.resolved.presentation.semanticGranularity = granularity; value.resolved.presentation.focusNodeId = { layer, id: focusId, ...(layer === 'semantic' ? { flowId: 'battle' } : {}) }; value.resolved.presentation.highlightedNodeIds = [value.resolved.presentation.focusNodeId]; value.resolved.highlights.semanticNodeIds = layer === 'semantic' ? [focusId] : [];
    value.resolved.semantic = { metadata: { scopeId: 'fixture:main', projectId: 'fixture', sourceRevision: 'source-1', architectureRevision: 'arch-1', definitionRevision: 'd1', overlayRevision: 'o1', viewRevision: 'v1', generatorVersion: 'fixture', projectionVersion: '1' }, flows: [{ id: 'battle', title: 'Battle fixture', description: '', steps: 3, groups: 2, reviewState: 'pending' }], flow }; return value;
  };
  const levelSelected = (text: string) => Array.from(app.container.querySelectorAll('.control-modes button')).find(button => button.textContent === text)?.getAttribute('aria-pressed');
  try {
    assert.deepEqual(semanticFocusTargets({ ...flow, reverseNodes: { one: ['detail-a', 'detail-b'] } }, { layer: 'code', id: 'one' }, new Set(['detail-a', 'detail-b'])), ['detail-a', 'detail-b'], 'code reverse focus includes every visible semantic match');
    await app.render(command('detailed-compare', 'compare', 'detailed', 'semantic', 'detail-a')); await app.waitFor(() => assert.equal(levelSelected('详细'), 'true'), 'detailed compare');
    assert.equal(app.container.querySelector('.semantic-canvas')?.getAttribute('data-focus-request-ids'), 'detail-a');
    await app.render(command('code-detailed', 'code', 'detailed', 'code', 'one')); assert.equal(levelSelected('详细'), 'true');
    await app.render(command('simple-explanation', 'explanation', 'simple', 'semantic', 'battle-resolve')); await app.waitFor(() => { assert.equal(levelSelected('简洁'), 'true'); assert.ok(app.container.querySelector('.control-semantic-map .control-map-foot')?.textContent?.includes('2 节点')); }, 'simple resets old expanded groups');
    assert.equal(app.container.querySelector('.semantic-canvas')?.getAttribute('data-focus-request-ids'), 'battle-resolve');
    await app.render(command('detailed-explanation', 'explanation', 'detailed', 'semantic', 'battle-resolve')); await app.waitFor(() => { assert.equal(levelSelected('详细'), 'true'); assert.ok(app.container.querySelector('.control-semantic-map .control-map-foot')?.textContent?.includes('4 节点')); }, 'detailed expands requested group again');
    assert.equal(app.container.querySelector('.semantic-canvas')?.getAttribute('data-focus-request-ids'), 'battle-resolve');
    const focusToken = app.container.querySelector('.semantic-canvas')?.getAttribute('data-focus-request-token');
    const highlightOnly = command('highlight-only', 'explanation', 'detailed', 'semantic', 'battle-resolve'); delete highlightOnly.resolved.presentation.focusNodeId; highlightOnly.resolved.highlights.semanticNodeIds = ['battle-resolve', 'detail-b']; await app.render(highlightOnly); assert.equal(app.container.querySelector('.semantic-canvas')?.getAttribute('data-focus-request-token'), focusToken, 'same graph highlight-only command does not move semantic camera');
  } finally { await app.dispose(); }
});
test('integration system entry opens its logical architecture ID instead of requesting a raw code symbol', async () => {
  const app = await mount();
  const command = fixture('architecture-entry'); command.resolved.presentation.targetView = 'systems'; command.resolved.presentation.viewMode = 'explanation'; command.resolved.presentation.focusNodeId = { layer: 'architecture', id: 'logical-battle' }; command.resolved.presentation.highlightedNodeIds = [command.resolved.presentation.focusNodeId]; command.resolved.highlights.codeNodeIds = []; command.resolved.highlights.architectureNodeIds = ['projected-battle'];
  command.resolved.architecture = { metadata: { scopeId: 'fixture:main', projectId: 'fixture', sourceRevision: 'source-1', modelRevision: 'arch-1', viewRevision: 'arch-view', projectionVersion: '1' }, perspective: 'business', graph: { nodes: [{ id: 'projected-battle', kind: 'system', label: '战斗系统', qualifiedName: 'logical-battle', language: 'unknown', evidenceIds: ['e:one'] }], edges: [], totalNodes: 1, truncated: false, revision: 'source-1' }, entities: [{ id: 'logical-battle', nodeId: 'projected-battle', entityKind: 'system', systemKind: 'business', name: '战斗系统', responsibility: '测试职责', inputs: [], outputs: [], features: [], keyData: [], memberNodeIds: [], membershipIds: [], evidenceIds: ['e:one'], flowIds: [], reviewState: 'pending', resolution: 'resolved', fingerprint: 'fixture' }], relations: [], breadcrumbs: [], diagnostics: [], unclassifiedCount: 0, available: true };
  try {
    await app.render(command); await app.click('[data-open-architecture="logical-battle"]'); assert.deepEqual(app.openedArchitecture, ['logical-battle']); assert.deepEqual(app.openedCode, []);
    await app.waitFor(() => assert.ok(app.container.querySelector('.react-flow__node[data-id="projected-battle"]')), 'projected node rendered');
    await act(async () => app.container.querySelector('.react-flow__node[data-id="projected-battle"]')!.dispatchEvent(new app.browser.MouseEvent('dblclick', { bubbles: true })));
    assert.deepEqual(app.openedArchitecture, ['logical-battle', 'logical-battle']); assert.deepEqual(app.openedCode, []); assert.equal(app.requests.some(path => path.startsWith('/api/nodes/')), false);
  } finally { await app.dispose(); }
});

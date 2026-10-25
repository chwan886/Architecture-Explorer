import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act, useState } from 'react';
import { Window } from 'happy-dom';
import type { ArchitectureNode, Evidence } from '../../../../packages/schema/src/index';
import type { OpenCodeRequest } from '../../../../packages/architecture-model/src/types';
import type { ResolvedSemanticFlow, SemanticBundle, SemanticDefinitionEnvelope, SemanticFlowDefinition, SemanticLocation, SemanticMetadata, SemanticNode, SemanticText } from '../../../../packages/semantic-model/src/types';
import { codeMapping, semanticEdgeShortLabel, visibleSemanticGraph, visibleSemanticMatches } from './graph';

// Explicit, small API fixtures exercise real React components and events. These
// records never enter application data; DOM tests make no visual-layout claim.
const text = (title: string): SemanticText => ({ title, summary: `${title}摘要`, purpose: `${title}目的`, detail: `${title}处理说明`, inputs: ['输入'], processing: ['处理'], outputs: ['输出'], changes: ['变化'] });
const definition = (): SemanticFlowDefinition => ({ id: 'flow-1', sourceFlowId: 'original-flow', title: '测试领取流程', description: '测试专用双层语义图', groups: [{ ...text('阶段甲'), id: 'group-a', childIds: ['a', 'b'], origin: 'curated' }, { ...text('阶段乙'), id: 'group-b', childIds: ['c'], origin: 'curated' }], steps: ['a', 'b', 'c'].map(id => ({ ...text(`步骤${id}`), id, sourceStepIds: [`source:${id}`], bindings: [{ id: `binding:${id}`, sourceStepId: `source:${id}`, role: 'implementation', anchorIds: [`anchor:${id}`], expectedDeclarationHash: `old-hash:${id}` }], controls: [{ kind: 'condition', description: `真实夹具条件${id}`, anchorIds: [`anchor:${id}`] }], origin: 'curated' })) });
const codeNode = (id: string): ArchitectureNode => ({ id, kind: 'method', label: `Method_${id}`, qualifiedName: `Fixture.${id}`, language: 'csharp', filePath: `Fixture/${id}.cs`, evidenceIds: [`e:code-${id}`] });
const codeNodes = ['one', 'two', 'three'].map(codeNode);
const evidence = (id: string): Evidence => ({ id, filePath: `Fixture/${id}.cs`, fileHash: `hash:${id}`, startLine: 7, startColumn: 1, endLine: 7, endColumn: 25, rule: `fixture:${id}` });
const semanticNode = (id: string, level: 'summary' | 'detail', childIds: string[], codeIds: string[], parentId?: string): SemanticNode => ({ ...text(level === 'summary' ? id === 'group-a' ? '阶段甲' : '阶段乙' : `步骤${id}`), id, level, parentId, childIds, sourceStepIds: [`source:${id}`], codeNodeIds: codeIds, contextNodeIds: [], evidenceIds: [`e:${id}`, ...(id === 'a' ? ['e:a-extra'] : [])], fragments: [codeIds], bindings: [{ id: `binding:${id}`, sourceStepId: `source:${id}`, role: 'implementation', anchorIds: [], codeNodeIds: codeIds, evidenceIds: [`e:${id}`], status: 'stale', anchorsValid: id !== 'c', declarationHash: `new-hash:${id}` }], controls: [], origin: 'curated', status: 'current', reviewState: 'pending', fingerprint: `fingerprint:${id}`, limitations: [] });
const resolvedFlow = (): ResolvedSemanticFlow => ({ id: 'flow-1', sourceFlowId: 'original-flow', title: '测试领取流程', description: '测试专用双层语义图', summaryNodes: [semanticNode('group-a', 'summary', ['a', 'b'], ['one', 'two']), semanticNode('group-b', 'summary', ['c'], ['three'])], detailNodes: [semanticNode('a', 'detail', [], ['one'], 'group-a'), semanticNode('b', 'detail', [], ['one', 'two'], 'group-a'), semanticNode('c', 'detail', [], ['three'], 'group-b')], summaryEdges: [{ id: 'summary-edge', level: 'summary', source: 'group-a', target: 'group-b', title: '跨请求关联', description: '夹具不宣称运行时顺序', kinds: ['request-boundary'], sourceTransitionIds: [], codeEdgeIds: [], paths: [], evidenceIds: ['e:edge'], conditions: [], boundaries: ['不同请求'], verification: 'unverified', status: 'current', reviewState: 'pending', fingerprint: 'edge-fingerprint', limitations: ['顺序未验证'] }], detailEdges: [{ id: 'detail-edge', level: 'detail', source: 'a', target: 'b', title: '静态调用', description: '夹具静态直接调用', kinds: ['direct-call'], sourceTransitionIds: [], codeEdgeIds: ['call:one-two'], paths: [{ nodeIds: ['one', 'two'], edgeIds: ['call:one-two'], kind: 'call-path', verification: 'static-confirmed' }], evidenceIds: ['e:edge'], conditions: [], boundaries: [], verification: 'static-confirmed', status: 'current', reviewState: 'pending', fingerprint: 'detail-edge-fingerprint', limitations: [] }], codeGraph: { nodes: [], edges: [], revision: 'source-1', totalNodes: 3, truncated: true }, codeNodes, codeEdges: [{ id: 'call:one-two', source: 'one', target: 'two', kind: 'calls', confidence: 'static-confirmed', evidenceIds: ['e:edge'], rule: 'fixture:static-call' }], evidence: ['group-a', 'group-b', 'a', 'a-extra', 'b', 'c', 'edge', 'code-one', 'code-two', 'code-three'].map(id => evidence(`e:${id}`)), reviewState: 'pending', fingerprint: 'flow-fingerprint', diagnostics: [], limitations: ['无运行时采集'], reverseNodes: { one: ['a', 'b'], two: ['b'], three: ['c'] }, reverseEdges: { 'call:one-two': ['detail-edge'] }, changes: { unchangedNodeIds: [], changedNodeIds: [], removedNodeIds: [], unchangedEdgeIds: [], changedEdgeIds: [], removedEdgeIds: [] } });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function deferred() { let resolve!: (value: Response) => void; return { promise: new Promise<Response>(done => { resolve = done; }), resolve: (value: Response) => resolve(value), requested: false }; }
let sequence = 0;

async function environment() {
  const browser = new Window({ url: 'http://127.0.0.1:4311' }), descriptors = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => { descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'sessionStorage', 'localStorage', 'ResizeObserver', 'DOMMatrixReadOnly'] as const) install(key, key === 'window' ? browser : browser[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true); install('requestAnimationFrame', browser.requestAnimationFrame.bind(browser)); install('cancelAnimationFrame', browser.cancelAnimationFrame.bind(browser)); install('getComputedStyle', browser.getComputedStyle.bind(browser));
  Object.defineProperty(browser.HTMLElement.prototype, 'scrollIntoView', { value() {}, configurable: true });
  const container = browser.document.createElement('div'); browser.document.body.append(container);
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  const waitFor = async (check: () => void, label: string) => { let last: unknown; for (let i = 0; i < 120; i++) { try { check(); return; } catch (error) { last = error; } await act(async () => { await new Promise(done => setTimeout(done, 10)); }); } throw new Error(`${label}: ${last instanceof Error ? last.message : last}`); };
  const clickElement = async (target: Element | null | undefined) => { assert.ok(target, 'Expected real UI control'); assert.notEqual((target as HTMLButtonElement).disabled, true, target.textContent || 'control'); await act(async () => target.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true }) as unknown as MouseEvent)); };
  const click = (text: string) => clickElement(Array.from(container.querySelectorAll('button')).find(button => button.textContent?.trim() === text) as unknown as Element);
  const input = async (target: HTMLInputElement | HTMLTextAreaElement, value: string) => { await act(async () => { const prototype = target.tagName === 'TEXTAREA' ? browser.HTMLTextAreaElement.prototype : browser.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(target, value); target.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event); }); };
  const dispose = async () => { await act(async () => root.unmount()); await browser.happyDOM.close(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } };
  return { browser, container, root, install, waitFor, clickElement, click, input, dispose };
}
async function mountWorkspace(initialLocation: SemanticLocation = { flowId: 'flow-1' }) {
  const env = await environment(), scope = `semantic-fixture-${++sequence}`; let currentScope = scope;
  const metadata = (targetScope = currentScope): SemanticMetadata => ({ scopeId: targetScope, projectId: 'fixture', sourceRevision: 'source-1', architectureRevision: 'architecture-1', definitionRevision: 'definition-1', overlayRevision: 'overlay-1', viewRevision: `view:${targetScope}`, projectionVersion: '1', generatorVersion: 'fixture' });
  const bundle = (targetScope = currentScope): SemanticBundle => ({ metadata: metadata(targetScope), flows: [{ id: 'flow-1', title: '测试领取流程', description: '夹具', steps: 3, groups: 2, reviewState: 'pending' }], flow: resolvedFlow() });
  const source = (id: string, revision = 'source-1') => ({ evidence: evidence(id), content: `SOURCE_${id}`, contextStartLine: 7, revision, stale: false });
  const heldSources = new Map<string, ReturnType<typeof deferred>>(), requests: { pathname: string; scope: string; body?: Record<string, unknown> }[] = [], opened: OpenCodeRequest[] = [];
  const api = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), env.browser.location.origin), targetScope = url.searchParams.get('scope')!; requests.push({ pathname: url.pathname, scope: targetScope, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.pathname === '/api/summary') return json({ metadata: { rootPath: 'C:/read-only-fixture' } });
    if (url.pathname === '/api/semantics') return json(bundle(targetScope));
    if (url.pathname.startsWith('/api/semantics/evidence/')) { const id = decodeURIComponent(url.pathname.slice('/api/semantics/evidence/'.length)), held = heldSources.get(id); if (held && !held.requested) { held.requested = true; return held.promise; } return json(source(id)); }
    if (url.pathname === '/api/semantics/review') return json({ overlay: { scopeId: targetScope } });
    throw new Error(`Unexpected semantic fixture API ${url}`);
  };
  env.install('fetch', api); env.browser.fetch = api as unknown as typeof env.browser.fetch;
  const { default: Workspace } = await import('./SemanticWorkspace');
  let visible = true, selectedLocation = initialLocation, changeLocation!: (value: SemanticLocation) => void;
  function Harness({ targetScope }: { targetScope: string }) { const [location, setLocation] = useState(selectedLocation); changeLocation = setLocation; return visible ? React.createElement(Workspace, { scope: targetScope, location, onLocationChange: (value: SemanticLocation) => { selectedLocation = value; setLocation(value); }, onOpenCode: (request: OpenCodeRequest) => opened.push(request) }) : null; }
  const render = async (targetScope = currentScope, mounted = true) => { currentScope = targetScope; visible = mounted; await act(async () => env.root.render(React.createElement(Harness, { targetScope }))); };
  await render(); await env.waitFor(() => assert.equal(env.container.querySelector('.semantic-workspace')?.getAttribute('data-view-revision'), metadata().viewRevision), 'semantic bundle ready');
  const selectNode = async (id: string) => { if (['a', 'b'].includes(id) && !env.container.querySelector(`[aria-label="折叠 阶段甲"]`)) await env.clickElement(env.container.querySelector('[aria-label="展开 阶段甲"]') as unknown as Element); const title = id === 'group-a' ? '阶段甲' : id === 'group-b' ? '阶段乙' : `步骤${id}`; await env.clickElement(Array.from(env.container.querySelectorAll('.semantic-navigation nav button')).find(button => button.textContent?.startsWith(title)) as unknown as Element); };
  const sourceSnapshot = async (id: string, evidenceId: string) => { if (!env.container.querySelector('.semantic-source')) await env.clickElement(env.container.querySelector('[aria-label="展开语义源码证据"]') as unknown as Element); await env.waitFor(() => { assert.equal(env.container.querySelector('.semantic-workspace')?.getAttribute('data-selection-id'), id); assert.equal(env.container.querySelector('.semantic-source [data-evidence-id]')?.getAttribute('data-evidence-id'), evidenceId); assert.ok(env.container.querySelector('.semantic-source .source-code')?.textContent?.includes(`SOURCE_${evidenceId}`)); assert.equal(env.container.querySelector('.semantic-inspector')?.getAttribute('data-node-id'), id); }, `source stamp ${id}/${evidenceId}`); };
  const navigate = async (value: SemanticLocation) => { selectedLocation = value; await act(async () => changeLocation(value)); };
  return { ...env, scope, render, navigate, requests, opened, heldSources, source, selectNode, sourceSnapshot };
}

test('semantic mixed-granularity graph preserves originals without inventing collapsed links', () => {
  const flow = resolvedFlow(), graph = visibleSemanticGraph(flow, new Set(['group-a']));
  assert.deepEqual(graph.nodes.map(node => node.id), ['a', 'b', 'group-b']); assert.deepEqual(graph.edges.map(edge => edge.id), ['detail-edge']); assert.equal(graph.hiddenEdges, 1);
  assert.deepEqual([...visibleSemanticMatches(flow, ['a', 'b'], new Set(['group-a', 'group-b']))], ['group-a']);
  const mapping = codeMapping(flow, undefined, flow.detailEdges[0]); assert.deepEqual([...mapping.nodeIds], ['one', 'two']); assert.deepEqual([...mapping.edgeIds], ['call:one-two']);
  assert.equal(semanticEdgeShortLabel(flow.summaryEdges[0]), '请求'); assert.equal(semanticEdgeShortLabel(flow.detailEdges[0]), '调用');
});

test('semantic workspace rejects a late source after rapidly selecting another detail', async () => {
  const app = await mountWorkspace(); try { const late = deferred(); app.heldSources.set('e:a', late); await app.selectNode('a'); await app.waitFor(() => assert.equal(late.requested, true), 'delayed A evidence'); await app.selectNode('b'); await app.sourceSnapshot('b', 'e:b'); await act(async () => late.resolve(json(app.source('e:a')))); await app.sourceSnapshot('b', 'e:b'); } finally { await app.dispose(); }
});

test('semantic workspace mode, detail expansion, source and history survive code-page unmount', async () => {
  const app = await mountWorkspace(); try { await app.selectNode('a'); await app.sourceSnapshot('a', 'e:a'); await app.click('双层对照'); await app.selectNode('b'); await app.sourceSnapshot('b', 'e:b'); await app.clickElement(app.container.querySelector('[aria-label="返回上一语义上下文"]') as unknown as Element); await app.sourceSnapshot('a', 'e:a'); assert.equal(app.container.querySelector('.semantic-workspace')?.getAttribute('data-mode'), 'compare'); assert.equal(app.container.querySelector('.semantic-workspace')?.getAttribute('data-level'), 'detailed'); await app.render(app.scope, false); await app.render(app.scope, true); await app.sourceSnapshot('a', 'e:a'); assert.equal(app.container.querySelector('.semantic-workspace')?.getAttribute('data-expanded'), 'group-a'); assert.equal(app.container.querySelector('.semantic-workspace')?.getAttribute('data-mode'), 'compare'); } finally { await app.dispose(); }
});

test('semantic workspace reverse code selection exposes every many-to-many explanation', async () => {
  const app = await mountWorkspace(); try { await app.selectNode('group-a'); await app.clickElement(Array.from(app.container.querySelectorAll('.semantic-code-list button')).find(button => button.textContent?.startsWith('Method_one')) as unknown as Element); await app.sourceSnapshot('one', 'e:code-one'); const related = Array.from(app.container.querySelectorAll('.semantic-inspector .semantic-related')).map(button => button.textContent); assert.ok(related.includes('步骤a')); assert.ok(related.includes('步骤b')); await app.click('代码实现'); assert.equal(app.container.querySelector('.semantic-workspace')?.getAttribute('data-selection-id'), 'one'); await app.click('业务解释'); assert.equal(app.container.querySelector('.semantic-workspace')?.getAttribute('data-selection-id'), 'one'); await app.sourceSnapshot('one', 'e:code-one'); } finally { await app.dispose(); }
});

test('detailed external locations reveal their semantic target and every reverse-mapped group', async () => {
  const app = await mountWorkspace({ flowId: 'flow-1', mode: 'compare', level: 'detailed', nodeId: 'b' });
  try {
    await app.waitFor(() => assert.ok(app.container.querySelector('.semantic-explanation-pane .react-flow__node[data-id="b"]')), 'direct detail target visible');
    assert.equal(app.container.querySelector('.semantic-workspace')?.getAttribute('data-expanded'), 'group-a');
    await app.input(app.container.querySelector('[aria-label="筛选业务解释"]') as unknown as HTMLInputElement, 'no matching target');
    assert.equal(app.container.querySelectorAll('.semantic-explanation-pane .react-flow__node').length, 0);
    await app.navigate({ flowId: 'flow-1', mode: 'compare', level: 'detailed', codeNodeId: 'three' });
    await app.waitFor(() => assert.ok(app.container.querySelector('.semantic-explanation-pane .react-flow__node[data-id="c"]')), 'reverse target in the other group visible');
    assert.equal(app.container.querySelector('.semantic-workspace')?.getAttribute('data-selection-id'), 'three');
    await app.navigate({ flowId: 'flow-1', mode: 'compare', level: 'detailed', codeEdgeId: 'call:one-two' });
    await app.waitFor(() => { for (const id of ['a', 'b']) assert.ok(app.container.querySelector(`.semantic-explanation-pane .react-flow__node[data-id="${id}"]`)); }, 'reverse edge endpoints visible');
    await app.navigate({ flowId: 'flow-1', mode: 'explanation', level: 'simple', nodeId: 'group-a' });
    await app.waitFor(() => assert.equal(app.container.querySelector('.semantic-workspace')?.getAttribute('data-expanded'), ''), 'explicit simple location collapses detail groups');
  } finally { await app.dispose(); }
});

test('semantic workspace rejects cross-version evidence with an explicit reload boundary', async () => {
  const app = await mountWorkspace(); try { const late = deferred(); app.heldSources.set('e:a', late); await app.selectNode('a'); await app.waitFor(() => assert.equal(late.requested, true), 'old source request'); await act(async () => late.resolve(json(app.source('e:a', 'source-2')))); await app.waitFor(() => assert.ok(app.container.textContent?.includes('视图版本已变化')), '409 banner'); assert.equal(app.container.querySelector('.semantic-source .source-code'), null); assert.ok(app.container.textContent?.includes('重新载入')); } finally { await app.dispose(); }
});

test('semantic workspace repeated same evidence activation remains loadable and cannot override a newer anchor', async () => {
  const app = await mountWorkspace(); try { await app.selectNode('a'); await app.sourceSnapshot('a', 'e:a'); const delayed = deferred(); app.heldSources.set('e:a-extra', delayed); await app.clickElement(app.container.querySelector('.semantic-evidence-list [data-evidence-id="e:a-extra"]') as unknown as Element); await app.waitFor(() => assert.equal(delayed.requested, true), 'delayed extra source'); await app.clickElement(app.container.querySelector('.semantic-evidence-list [data-evidence-id="e:a"]') as unknown as Element); await app.sourceSnapshot('a', 'e:a'); await act(async () => delayed.resolve(json(app.source('e:a-extra')))); await app.sourceSnapshot('a', 'e:a'); await app.clickElement(app.container.querySelector('.semantic-evidence-list [data-evidence-id="e:a"]') as unknown as Element); await app.sourceSnapshot('a', 'e:a'); } finally { await app.dispose(); }
});

test('semantic workspace scope changes discard old evidence and confirmation targets only the selected explanation', async () => {
  const app = await mountWorkspace(); try { const delayed = deferred(); app.heldSources.set('e:a', delayed); await app.selectNode('a'); await app.waitFor(() => assert.equal(delayed.requested, true), 'source A requested'); await app.render(`${app.scope}:other`); await app.waitFor(() => assert.equal(app.container.querySelector('.semantic-workspace')?.getAttribute('data-view-revision'), `view:${app.scope}:other`), 'new scope bundle'); await app.selectNode('group-b'); await app.sourceSnapshot('group-b', 'e:group-b'); await act(async () => delayed.resolve(json(app.source('e:a')))); await app.sourceSnapshot('group-b', 'e:group-b'); await app.click('确认'); const review = app.requests.find(request => request.pathname === '/api/semantics/review'); assert.equal(review?.body?.targetType, 'node'); assert.equal(review?.body?.targetId, 'group-b'); assert.equal(review?.scope, `${app.scope}:other`); } finally { await app.dispose(); }
});

test('semantic editor reloads the complete version tuple without SSE and retains it across consecutive saves', async () => {
  const env = await environment(), scope = `editor-fixture-${++sequence}`; let version = 1, flow = definition(); const writes: { expectedOverlayRevision: string; viewRevision: string; flow: SemanticFlowDefinition }[] = [];
  const envelope = (): SemanticDefinitionEnvelope & { metadata: SemanticMetadata } => ({ definitions: { schemaVersion: '1.0.0', projectId: 'fixture', flows: [definition()] }, overlay: { schemaVersion: '1.0.0', scopeId: scope, baseDefinitionRevision: 'definition-1', flowOverrides: [flow], reviews: [], history: [] }, definitionRevision: 'definition-1', overlayRevision: `overlay-${version}`, effectiveFlows: [flow], metadata: { scopeId: scope, projectId: 'fixture', sourceRevision: 'source-1', architectureRevision: 'architecture-1', definitionRevision: 'definition-1', overlayRevision: `overlay-${version}`, viewRevision: `view-${version}`, projectionVersion: '1', generatorVersion: 'fixture' } });
  const api = async (_input: RequestInfo | URL, init?: RequestInit) => { if (init?.method === 'PUT') { const body = JSON.parse(String(init.body)); writes.push(body); if (body.expectedOverlayRevision !== `overlay-${version}` || body.viewRevision !== `view-${version}`) return json({ error: 'fixture conflict preserves draft' }, 409); flow = body.flow; version++; return json(envelope()); } return json(envelope()); };
  env.install('fetch', api); env.browser.fetch = api as unknown as typeof env.browser.fetch;
  const { default: Editor } = await import('./SemanticEditor'); await act(async () => env.root.render(React.createElement(Editor, { scope, flowId: 'flow-1', viewRevision: 'view-1', resolvedFlow: resolvedFlow(), onClose() {}, onSaved() {} })));
  try {
    await env.waitFor(() => assert.ok(env.container.querySelector('[aria-label="解释名称"]')), 'editor form'); await env.input(env.container.querySelector('[aria-label="解释名称"]') as unknown as HTMLInputElement, '保留人工草稿'); version = 2; await env.click('保存解释'); await env.waitFor(() => assert.ok(env.container.textContent?.includes('fixture conflict')), 'editor conflict'); assert.equal((env.container.querySelector('[aria-label="解释名称"]') as unknown as HTMLInputElement).value, '保留人工草稿'); assert.equal(env.container.querySelector('.semantic-editor')?.getAttribute('data-base-revision'), 'overlay-1'); await env.click('载入服务器版本'); await env.waitFor(() => assert.equal(env.container.querySelector('.semantic-editor')?.getAttribute('data-base-revision'), 'overlay-2'), 'fresh baseline GET'); assert.equal((env.container.querySelector('[aria-label="解释名称"]') as unknown as HTMLInputElement).value, '阶段甲');
    await env.click('步骤a'); await env.input(env.container.querySelector('[aria-label="解释详细解释"]') as unknown as HTMLTextAreaElement, '人工解释保留'); await env.click('采用当前源码基准（仍待审）'); await env.click('保存解释'); await env.waitFor(() => assert.equal(writes.length, 2), 'saved rebased declaration'); assert.equal(writes[1].expectedOverlayRevision, 'overlay-2'); assert.equal(writes[1].viewRevision, 'view-2'); assert.equal(writes[1].flow.steps[0].detail, '人工解释保留'); assert.equal(writes[1].flow.steps[0].bindings[0].expectedDeclarationHash, 'new-hash:a'); assert.deepEqual(writes[1].flow.steps[0].controls, definition().steps[0].controls); await env.waitFor(() => assert.equal(env.container.querySelector('.semantic-editor')?.getAttribute('data-base-revision'), 'overlay-3'), 'save settled');
    await env.input(env.container.querySelector('[aria-label="解释详细解释"]') as unknown as HTMLTextAreaElement, '再次修订'); await env.click('保存解释'); await env.waitFor(() => assert.equal(env.container.querySelector('.semantic-editor')?.getAttribute('data-base-revision'), 'overlay-4'), 'second save without parent refresh'); assert.equal(writes[2].viewRevision, 'view-3');
    await env.click('步骤c'); assert.equal(Array.from(env.container.querySelectorAll('button')).some(button => button.textContent === '采用当前源码基准（仍待审）'), false); assert.ok(env.container.textContent?.includes('源码锚点失效'));
  } finally { await env.dispose(); }
});

test('semantic editor explicitly replaces a restored session draft with a candidate, while server reload always uses fresh server content', async () => {
  const env = await environment(), scope = `candidate-fixture-${++sequence}`;
  const server = definition(), existing = definition(), candidate = definition(); server.groups[0].title = 'SERVER_GROUP'; existing.groups[0].title = 'SESSION_GROUP'; candidate.groups[0].title = 'CANDIDATE_GROUP';
  const envelope: SemanticDefinitionEnvelope & { metadata: SemanticMetadata } = { definitions: { schemaVersion: '1.0.0', projectId: 'fixture', flows: [server] }, overlay: { schemaVersion: '1.0.0', scopeId: scope, baseDefinitionRevision: 'definition-1', flowOverrides: [], reviews: [], history: [] }, definitionRevision: 'definition-1', overlayRevision: 'overlay-2', effectiveFlows: [server], metadata: { scopeId: scope, projectId: 'fixture', sourceRevision: 'source-1', architectureRevision: 'architecture-1', definitionRevision: 'definition-1', overlayRevision: 'overlay-2', viewRevision: 'view-2', projectionVersion: '1', generatorVersion: 'fixture' } };
  const requests: string[] = []; const api = async (_input: RequestInfo | URL, init?: RequestInit) => { requests.push(init?.method || 'GET'); return json(envelope); };
  env.install('fetch', api); env.browser.fetch = api as unknown as typeof env.browser.fetch;
  env.browser.sessionStorage.setItem(`architecture-explorer:semantic-draft:${scope}:flow-1`, JSON.stringify({ flow: existing, baseRevision: 'overlay-1' }));
  const { default: Editor } = await import('./SemanticEditor'); await act(async () => env.root.render(React.createElement(Editor, { scope, flowId: 'flow-1', viewRevision: 'view-1', candidate, onClose() {}, onSaved() {} })));
  const targetTitle = () => (env.container.querySelector('[aria-label="解释名称"]') as unknown as HTMLInputElement)?.value;
  try {
    await env.waitFor(() => assert.equal(targetTitle(), 'SESSION_GROUP'), 'session draft restored'); assert.ok(env.container.textContent?.includes('已恢复未保存草稿，规则候选尚未应用')); assert.ok(env.container.textContent?.includes('旧草稿缺少完整视图基线')); assert.equal(Array.from(env.container.querySelectorAll('button')).find(button => button.textContent === '保存解释')?.disabled, true);
    await env.click('用规则候选替换草稿'); assert.equal(targetTitle(), 'CANDIDATE_GROUP'); assert.equal(env.container.querySelector('.semantic-editor')?.getAttribute('data-base-revision'), 'overlay-2'); assert.deepEqual(requests, ['GET']);
    await env.click('载入服务器版本'); await env.waitFor(() => assert.equal(targetTitle(), 'SERVER_GROUP'), 'fresh server content replaces candidate'); assert.deepEqual(requests, ['GET', 'GET']); assert.equal(env.container.textContent?.includes('已恢复未保存草稿，规则候选尚未应用'), false); assert.equal(Array.from(env.container.querySelectorAll('button')).find(button => button.textContent === '保存解释')?.disabled, true);
  } finally { await env.dispose(); }
});

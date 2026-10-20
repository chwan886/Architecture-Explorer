import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { ArchitectureNode, Evidence } from '../packages/schema/src/index.ts';
import type { ResolvedSemanticFlow, SemanticBundle, SemanticMetadata, SemanticNode } from '../packages/semantic-model/src/types.ts';

// Explicit in-memory API fixture; mount the real App and SemanticWorkspace.
// Browser geometry observers are polyfilled, while navigation and React events
// remain real. This test checks state/evidence routing, not visual layout.
const scope = 'semantic-navigation-fixture:primary';
const revision = 'semantic-navigation-source-1';
const project: ArchitectureNode = { id: 'project:semantic-navigation', kind: 'project', label: '语义导航测试项目', qualifiedName: 'Semantic navigation fixture', language: 'unknown', evidenceIds: [] };
const file: ArchitectureNode = { id: 'file:semantic-navigation', kind: 'file', label: 'actions.py', qualifiedName: 'src.actions', language: 'python', filePath: 'src/actions.py', parentId: project.id, evidenceIds: [] };
const declaration: Evidence = { id: 'evidence:semantic-declaration', filePath: 'src/actions.py', fileHash: 'a'.repeat(64), startLine: 1, startColumn: 1, endLine: 3, endColumn: 20, rule: 'fixture:declaration', excerpt: 'def claim():\n    # CLAIM_DECLARATION\n    return reserve' };
const branch: Evidence = { ...declaration, id: 'evidence:semantic-branch', startLine: 3, endLine: 3, rule: 'fixture:branch', excerpt: 'return reserve  # SELECTED_CLAIM_BRANCH' };
const method: ArchitectureNode = { id: 'function:semantic-claim', kind: 'function', label: 'claim', qualifiedName: 'src.actions.claim', filePath: file.filePath, language: 'python', parentId: file.id, evidenceIds: [declaration.id, branch.id] };
const nodes = [project, file, method];
const evidence = [declaration, branch];
const metadata: SemanticMetadata = { scopeId: scope, projectId: 'semantic-navigation-fixture', sourceRevision: revision,
  architectureRevision: 'b'.repeat(64), definitionRevision: 'c'.repeat(64), overlayRevision: 'd'.repeat(64), viewRevision: 'e'.repeat(64), generatorVersion: 'evidence-template-1', projectionVersion: '1.0.0' };
const text = { title: '领取储量', summary: '明确测试夹具：领取资源', purpose: '检验解释与代码双向定位', detail: '此说明仅用于 DOM 导航回归。', inputs: ['reserve'], processing: ['读取储量'], outputs: ['资源'], changes: [] };
const detail: SemanticNode = { ...text, id: 'claim-detail', level: 'detail', parentId: 'claim-summary', childIds: [], sourceStepIds: ['source-claim'],
  codeNodeIds: [method.id], contextNodeIds: [], evidenceIds: [declaration.id, branch.id], fragments: [[method.id]], bindings: [], controls: [], origin: 'curated', status: 'current', reviewState: 'pending', fingerprint: 'f'.repeat(64), limitations: ['显式测试夹具，不是产品示例数据。'] };
const summary: SemanticNode = { ...detail, id: 'claim-summary', title: '领取测试阶段', level: 'summary', parentId: undefined, childIds: [detail.id] };
const flow: ResolvedSemanticFlow = { id: 'fixture-claim-flow', sourceFlowId: 'fixture-source-flow', title: '领取测试流程', description: '真实 App 的显式内存夹具',
  summaryNodes: [summary], detailNodes: [detail], summaryEdges: [], detailEdges: [], codeNodes: [method], codeEdges: [],
  codeGraph: { nodes: [method], edges: [], totalNodes: 1, truncated: false, revision }, evidence, reviewState: 'pending', fingerprint: '1'.repeat(64), diagnostics: [], limitations: ['没有运行时执行证明。'],
  reverseNodes: { [method.id]: [detail.id] }, reverseEdges: {}, changes: { unchangedNodeIds: [], changedNodeIds: [summary.id, detail.id], removedNodeIds: [], unchangedEdgeIds: [], changedEdgeIds: [], removedEdgeIds: [] } };
const unrelated: ResolvedSemanticFlow = { ...flow, id: 'fixture-unrelated-default', title: '其他默认流程', summaryNodes: [], detailNodes: [],
  codeGraph: { ...flow.codeGraph, nodes: [], totalNodes: 0 }, codeNodes: [], evidence: [], reverseNodes: {} };
const bundle: SemanticBundle = { metadata, flows: [unrelated, flow].map(item => ({ id: item.id, title: item.title, description: item.description,
  steps: item.detailNodes.length, groups: item.summaryNodes.length, reviewState: item.reviewState })), flow };
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

test('real App enters related semantic flow and returns with matching scope, code selection and explicit source evidence', async () => {
  const browser = new Window({ url: 'http://127.0.0.1:4310/?page=code' });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLDivElement', 'SVGElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'localStorage'] as const)
    install(key, key === 'window' ? browser : browser[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('requestAnimationFrame', browser.requestAnimationFrame.bind(browser));
  install('cancelAnimationFrame', browser.cancelAnimationFrame.bind(browser));
  install('getComputedStyle', browser.getComputedStyle.bind(browser));
  class GeometryObserver { observe() {} unobserve() {} disconnect() {} }
  install('ResizeObserver', GeometryObserver);
  Object.defineProperty(browser.HTMLElement.prototype, 'scrollIntoView', { value() {}, configurable: true });
  class EventStream { onopen = null; onmessage = null; onerror = null; addEventListener() {} close() {} }
  install('EventSource', EventStream);
  const requests: { path: string; scope: string | null; flowId: string | null; viewRevision: string | null }[] = [];
  const fetchFixture = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input), browser.location.origin), route = decodeURIComponent(url.pathname);
    requests.push({ path: route, scope: url.searchParams.get('scope'), flowId: url.searchParams.get('flowId'), viewRevision: url.searchParams.get('viewRevision') });
    if (route === '/api/projects') return response({ projects: [{ id: 'semantic-navigation-fixture', name: project.label, root: 'C:/in-memory-read-only-fixture' }] });
    if (route === '/api/projects/semantic-navigation-fixture/worktrees') return response({ worktrees: [{ id: 'primary', path: 'C:/in-memory-read-only-fixture', branch: 'fixture-main', head: 'abc', authorized: true }] });
    assert.equal(url.searchParams.get('scope'), scope, `request scope: ${route}`);
    if (route === '/api/status') return response({ scopeId: scope, state: 'synced', message: '测试夹具已同步', revision });
    if (route === '/api/summary') return response({ rootId: project.id, counts: { files: 1, nodes: nodes.length, edges: 0 }, diagnostics: [], metadata: {
      scopeId: scope, projectId: 'semantic-navigation-fixture', projectName: project.label, worktreeId: 'primary', rootPath: 'C:/in-memory-read-only-fixture', gitBranch: 'fixture-main', gitHead: 'abc', gitDirty: false,
      generatedAt: '2026-10-20T12:00:00Z', revision, coverage: { languages: ['python'], limitations: ['显式导航测试夹具'] } } });
    if (route === '/api/graph') return response({ nodes: [], edges: [], totalNodes: 0, rootId: url.searchParams.get('rootId') || project.id, truncated: false, revision });
    if (route === '/api/search') return response({ nodes: [method], revision });
    if (route === '/api/architecture/ownership') return response({ metadata: { scopeId: scope, sourceRevision: revision }, nodeId: method.id, owners: [], flowIds: [] });
    if (route === '/api/semantics/reverse') {
      assert.equal(url.searchParams.get('nodeId'), method.id);
      return response({ metadata, matches: [{ flowId: flow.id, flowTitle: flow.title, nodeIds: [detail.id], edgeIds: [] }] });
    }
    if (route === '/api/semantics') {
      assert.ok(!url.searchParams.get('flowId') || [flow.id, unrelated.id].includes(url.searchParams.get('flowId')!));
      return response({ ...bundle, flow: url.searchParams.get('flowId') === flow.id ? flow : unrelated });
    }
    if (route.startsWith('/api/nodes/')) {
      const id = route.slice('/api/nodes/'.length), node = nodes.find(node => node.id === id);
      assert.ok(node, `unknown fixture node: ${id}`);
      return response({ node, revision, parents: id === method.id ? [project, file] : id === file.id ? [project] : [], incoming: [], outgoing: [], relatedNodes: [], evidence: id === method.id ? evidence : [] });
    }
    if (route.startsWith('/api/evidence/') || route.startsWith('/api/semantics/evidence/')) {
      const item = evidence.find(item => route.endsWith('/' + item.id)); assert.ok(item, `unknown fixture evidence: ${route}`);
      if (route.startsWith('/api/semantics/')) assert.equal(url.searchParams.get('viewRevision'), metadata.viewRevision);
      return response({ evidence: item, content: item.excerpt, contextStartLine: item.startLine, stale: false, revision });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  };
  install('fetch', fetchFixture); browser.fetch = fetchFixture as unknown as typeof browser.fetch;
  const { createRoot } = await import('react-dom/client');
  const { default: App } = await import('../apps/web/src/App.tsx');
  const container = browser.document.createElement('div'); browser.document.body.append(container);
  const mounted = createRoot(container as unknown as Element);
  const waitFor = async (check: () => void, name: string) => {
    let last: unknown;
    for (let i = 0; i < 130; i++) {
      try { check(); return; } catch (error) { last = error; }
      await act(async () => { await new Promise(done => setTimeout(done, 15)); });
    }
    throw new Error(`${name}: ${last instanceof Error ? last.message : String(last)}`);
  };
  const click = async (element: Element | null | undefined) => {
    assert.ok(element, 'Expected an actual interactive control');
    await act(async () => { element.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true }) as unknown as MouseEvent); });
  };
  const button = (name: string) => Array.from(container.querySelectorAll('button')).find(element => element.textContent?.trim() === name) as unknown as Element;
  const assertCode = async (view: string, context: string) => waitFor(() => {
    assert.equal(container.querySelector('.primary-navigation [aria-current="page"]')?.textContent?.trim(), '代码地图');
    assert.equal(container.querySelector('[data-context-node-id]')?.getAttribute('data-context-node-id'), context);
    assert.equal(container.querySelector('[data-view]')?.getAttribute('data-view'), view);
    assert.equal(container.querySelector('.inspector')?.getAttribute('data-node-id'), method.id);
    assert.equal(container.querySelector('.workbench .source-location')?.getAttribute('data-evidence-id'), branch.id);
    assert.equal(container.querySelector('.workbench .source-location')?.getAttribute('data-node-id'), method.id);
    assert.ok(container.querySelector('.workbench .source-code')?.textContent?.includes('SELECTED_CLAIM_BRANCH'));
    assert.equal((container.querySelector('select[aria-label="选择 Worktree"]') as unknown as HTMLSelectElement)?.value, 'primary');
  }, 'code selection/context/source match');
  const assertFlow = async (withSource = false) => waitFor(() => {
    const workspace = container.querySelector('.semantic-workspace');
    assert.equal(container.querySelector('.primary-navigation [aria-current="page"]')?.textContent?.trim(), '业务流程');
    assert.equal(workspace?.getAttribute('data-scope'), scope);
    assert.equal(workspace?.getAttribute('data-view-revision'), metadata.viewRevision);
    assert.equal(workspace?.getAttribute('data-selection-type'), 'code-node');
    assert.equal(workspace?.getAttribute('data-selection-id'), method.id);
    assert.equal((container.querySelector('select[aria-label="选择语义流程"]') as unknown as HTMLSelectElement)?.value, flow.id);
    assert.ok(container.querySelector('.semantic-inspector')?.textContent?.includes(method.qualifiedName));
    assert.ok(container.querySelector('.semantic-related')?.textContent?.includes(detail.title));
    if (withSource) {
      assert.equal(container.querySelector('.semantic-source .source-location')?.getAttribute('data-evidence-id'), branch.id);
      assert.equal(container.querySelector('.semantic-source .source-location')?.getAttribute('data-node-id'), method.id);
      assert.ok(container.querySelector('.semantic-source .source-code')?.textContent?.includes('SELECTED_CLAIM_BRANCH'));
    }
  }, 'semantic flow/scope/code selection/source match');
  try {
    await act(async () => { mounted.render(React.createElement(App)); });
    await waitFor(() => assert.ok(requests.some(request => request.path === '/api/graph')), 'initial code request');
    const search = container.querySelector('input[role="combobox"]') as unknown as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!.call(search, 'claim');
      search.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event);
    });
    await waitFor(() => assert.equal(container.querySelectorAll('[role="option"]').length, 1), 'real App search result');
    await click(container.querySelector('[role="option"]') as unknown as Element);
    await waitFor(() => assert.equal(container.querySelector('.source-location')?.getAttribute('data-evidence-id'), declaration.id), 'declaration source');
    await click(Array.from(container.querySelectorAll('button.evidence-item')).find(element => element.textContent?.includes(branch.rule)) as unknown as Element);
    await assertCode('architecture', file.id);
    const openRelated = async () => {
      await waitFor(() => assert.ok(container.querySelector('.semantic-ownership .ownership-link')), 'related business explanation entrance');
      await click(container.querySelector('.semantic-ownership .ownership-link') as unknown as Element);
      await assertFlow();
    };
    await openRelated();
    await click(container.querySelector(`.semantic-evidence-list button[data-evidence-id="${branch.id}"]`) as unknown as Element);
    await assertFlow(true);
    await click(button('代码地图'));
    await assertCode('architecture', file.id);
    await openRelated();
    await assertFlow(true);
    await click(button('在代码地图继续探索'));
    await assertCode('calls', method.id);
    await click(button('返回系统架构'));
    await assertFlow(true);
    assert.ok(requests.filter(request => request.path === '/api/semantics').length >= 2, 'semantic view really loaded after remount');
    assert.ok(requests.filter(request => request.path === '/api/semantics').every(request => request.flowId === flow.id), 'reverse entrance must request its matching non-default flow');
    assert.ok(requests.some(request => request.path === '/api/semantics/reverse'), 'code-page reverse API used');
    assert.ok(requests.some(request => request.path === '/api/semantics/evidence/' + branch.id && request.viewRevision === metadata.viewRevision), 'semantic source uses matching view revision');
  } finally {
    await act(async () => { mounted.unmount(); });
    await browser.happyDOM.close();
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act, useState } from 'react';
import { Window } from 'happy-dom';
import type { ArchitectureNode, Evidence } from '../../../../packages/schema/src/index';
import type { ArchitectureEntityDetail, ArchitectureRoute, ArchitectureView, OpenCodeRequest, ProjectionMetadata, ResolvedEntity } from '../../../../packages/architecture-model/src/types';

// Explicit API fixtures exercise the real workspace. Empty canvas nodes avoid
// pretending a DOM emulator can verify browser layout or ELK measurements.
let fixtureSequence = 0;
const entity = (id: string, name: string, entityKind: 'system' | 'module' = 'system'): ResolvedEntity => ({ id, nodeId: `node:${id}`, entityKind, name, responsibility: `${name}职责说明`, ...(entityKind === 'module' ? { systemId: 'a' } : { systemKind: 'business' as const }), inputs: ['测试输入'], outputs: ['测试输出'], features: ['测试功能'], keyData: ['测试状态'], memberNodeIds: [`code:${id}`], membershipIds: [], evidenceIds: [`e:${id}`], flowIds: [], reviewState: 'pending', resolution: 'resolved', fingerprint: `fingerprint:${id}` });
const entities = [entity('a', '系统甲'), entity('b', '系统乙'), entity('module-a', '甲组件模块', 'module')];
const getEntity = (id: string) => { const item = entities.find(item => item.id === id); assert.ok(item); return item; };
const sourceEvidence = (id: string): Evidence => ({ id, filePath: `${id === 'e:b' ? 'Server/B.py' : 'Client/A.cs'}`, startLine: 12, startColumn: 1, endLine: 12, endColumn: 25, fileHash: `hash:${id}`, rule: `fixture:${id}` });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function deferred() { let resolve!: (value: Response) => void; return { promise: new Promise<Response>(done => { resolve = done; }), resolve: (value: Response) => resolve(value), requested: false }; }

async function mountWorkspace() {
  const scope = `architecture-test-${++fixtureSequence}:main`;
  const browser = new Window({ url: 'http://127.0.0.1:4311' });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => { descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'localStorage', 'sessionStorage'] as const) install(key, key === 'window' ? browser : browser[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true); install('requestAnimationFrame', browser.requestAnimationFrame.bind(browser)); install('cancelAnimationFrame', browser.cancelAnimationFrame.bind(browser));
  Object.defineProperty(browser.HTMLElement.prototype, 'scrollIntoView', { value() {}, configurable: true });
  let version = 1;
  const metadata = (number = version): ProjectionMetadata => ({ scopeId: scope, projectId: 'test', sourceRevision: `source-${number}`, modelRevision: `model-${number}`, viewRevision: `view-${number}`, projectionVersion: '1' });
  const detail = (id: string, number = version): ArchitectureEntityDetail => ({ metadata: metadata(number), entity: getEntity(id), modules: id === 'a' ? [getEntity('module-a')] : [], components: [{ id: `code:${id}`, kind: 'class', label: `Component_${id}`, qualifiedName: `Test.Component_${id}`, language: 'csharp', evidenceIds: [] }], totalComponents: 1, memberships: [], relations: [], evidence: [sourceEvidence(`e:${id}`), ...(id === 'a' ? [sourceEvidence('e:a-extra')] : [])], flows: [] });
  const source = (id: string, number = version) => ({ evidence: sourceEvidence(id), content: `SOURCE_${id}_V${number}`, contextStartLine: 12, stale: false, revision: `source-${number}` });
  const heldDetails = new Map<string, ReturnType<typeof deferred>>(), heldSources = new Map<string, ReturnType<typeof deferred>>();
  const queries: URL[] = [], openedCode: OpenCodeRequest[] = [];
  const api = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input), browser.location.origin); queries.push(url);
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === '/api/summary') return json({ metadata: { ...metadata(), rootPath: 'C:/read-only-fixture' } });
    if (pathname === '/api/architecture') {
      const rootId = url.searchParams.get('rootId') || undefined;
      const payload: ArchitectureView = { metadata: metadata(), perspective: 'business', rootId, graph: { nodes: [], edges: [], rootId, totalNodes: 0, truncated: false, revision: `source-${version}` }, entities: rootId === 'a' ? [getEntity('module-a')] : rootId ? [] : entities.slice(0, 2), relations: [], breadcrumbs: [{ name: '系统全景' }, ...(rootId === 'a' ? [{ id: 'a', name: '系统甲' }] : rootId ? [{ id: 'a', name: '系统甲' }, { id: rootId, name: getEntity(rootId).name }] : [])], diagnostics: [], unclassifiedCount: 61, available: true };
      return json(payload);
    }
    if (pathname.startsWith('/api/architecture/entities/')) {
      const id = pathname.slice('/api/architecture/entities/'.length), held = heldDetails.get(id);
      if (held && !held.requested) { held.requested = true; return held.promise; }
      if (url.searchParams.get('viewRevision') !== metadata().viewRevision) return json({ error: 'fixture view revision conflict' }, 409);
      return json(detail(id));
    }
    if (pathname.startsWith('/api/architecture/evidence/')) {
      const id = pathname.slice('/api/architecture/evidence/'.length), held = heldSources.get(id);
      if (held && !held.requested) { held.requested = true; return held.promise; }
      if (url.searchParams.get('viewRevision') !== metadata().viewRevision) return json({ error: 'fixture evidence revision conflict' }, 409);
      return json(source(id));
    }
    if (pathname === '/api/architecture/unclassified') {
      const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 30);
      const nodes: ArchitectureNode[] = Array.from({ length: Math.min(limit, 61 - offset) }, (_, index) => ({ id: `unclassified:${offset + index + 1}`, kind: 'class', label: `Unclassified_${offset + index + 1}`, qualifiedName: `Test.Unclassified_${offset + index + 1}`, language: 'csharp', evidenceIds: [] }));
      return json({ metadata: metadata(), nodes, offset, total: 61, truncated: offset + nodes.length < 61 });
    }
    throw new Error(`Unexpected architecture fixture request ${url}`);
  };
  install('fetch', api); browser.fetch = api as unknown as typeof browser.fetch;
  const { createRoot } = await import('react-dom/client');
  const { default: Workspace } = await import('./ArchitectureWorkspace');
  function Harness() { const [route, setRoute] = useState<ArchitectureRoute>({ perspective: 'business' }); return React.createElement(Workspace, { scope, route, onRouteChange: setRoute, onOpenCode: (request: OpenCodeRequest) => openedCode.push(request) }); }
  const container = browser.document.createElement('div'); browser.document.body.append(container);
  const root = createRoot(container as unknown as Element); await act(async () => root.render(React.createElement(Harness)));
  const waitFor = async (check: () => void, label: string) => { let last: unknown; for (let i = 0; i < 100; i++) { try { check(); return; } catch (error) { last = error; } await act(async () => { await new Promise(done => setTimeout(done, 12)); }); } throw new Error(`${label}: ${last instanceof Error ? last.message : last}`); };
  const click = async (target: Element | null | undefined) => { assert.ok(target, 'Expected workspace control'); await act(async () => { target.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true }) as unknown as MouseEvent); }); };
  const choose = (id: 'a' | 'b') => click(Array.from(container.querySelectorAll('.arch-navigation nav button')).find(button => button.textContent?.startsWith(getEntity(id).name)) as unknown as Element);
  const sourceSnapshot = async (id: string, evidenceId: string, rootId = '', number = version) => {
    if (!container.querySelector('.arch-source-panel')) await click(container.querySelector('[aria-label="展开架构源码证据"]') as unknown as Element);
    await waitFor(() => {
    assert.equal(container.querySelector('.architecture-workspace')?.getAttribute('data-selection-id'), id);
    assert.equal(container.querySelector('.architecture-workspace')?.getAttribute('data-architecture-root'), rootId);
    assert.equal(container.querySelector('.architecture-workspace')?.getAttribute('data-view-revision'), `view-${number}`);
    assert.equal(container.querySelector('.arch-source-content [data-evidence-id]')?.getAttribute('data-evidence-id'), evidenceId);
    assert.ok(container.querySelector('.arch-source-content .source-code')?.textContent?.includes(`SOURCE_${evidenceId}_V${number}`));
    assert.ok(container.querySelector('.arch-inspector-overview h2')?.textContent?.includes(getEntity(id).name));
    }, `workspace selection/source ${id}/${evidenceId}`);
  };
  const evidenceButton = (id: string) => Array.from(container.querySelectorAll('.arch-evidence-list button')).find(button => button.textContent?.includes(`fixture:${id}`));
  const back = () => click(container.querySelector('[aria-label="返回上一架构视图"]') as unknown as Element);
  const dispose = async () => { await act(async () => root.unmount()); await browser.happyDOM.close(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } };
  await waitFor(() => assert.equal(container.querySelector('.architecture-workspace')?.getAttribute('data-view-revision'), 'view-1'), 'architecture view loaded');
  return { container, choose, click, sourceSnapshot, evidenceButton, back, waitFor, dispose, heldDetails, heldSources, detail, source, queries, openedCode, setVersion: (value: number) => { version = value; } };
}

test('architecture workspace rapid node selection rejects a late entity detail response', async () => {
  const app = await mountWorkspace();
  try {
    const late = deferred(); app.heldDetails.set('a', late);
    await app.choose('a'); await app.waitFor(() => assert.equal(late.requested, true), 'held detail A');
    await app.choose('b'); await app.sourceSnapshot('b', 'e:b');
    await act(async () => late.resolve(json(app.detail('a', 1))));
    await app.sourceSnapshot('b', 'e:b');
    assert.ok(!app.container.querySelector('.arch-inspector-overview')?.textContent?.includes('系统甲职责说明'));
  } finally { await app.dispose(); }
});

test('architecture workspace late source response cannot replace a newer selected entity', async () => {
  const app = await mountWorkspace();
  try {
    const late = deferred(); app.heldSources.set('e:a', late);
    await app.choose('a'); await app.waitFor(() => assert.equal(late.requested, true), 'held source A');
    await app.choose('b'); await app.sourceSnapshot('b', 'e:b');
    await act(async () => late.resolve(json(app.source('e:a', 1))));
    await app.sourceSnapshot('b', 'e:b');
  } finally { await app.dispose(); }
});

test('architecture workspace returns from module to system and overview with matching saved evidence', async () => {
  const app = await mountWorkspace();
  try {
    await app.choose('a'); await app.sourceSnapshot('a', 'e:a');
    await app.click(app.evidenceButton('e:a-extra') as unknown as Element); await app.sourceSnapshot('a', 'e:a-extra');
    await app.click(app.container.querySelector('.arch-inspector-enter') as unknown as Element); await app.sourceSnapshot('a', 'e:a', 'a');
    await app.click(app.evidenceButton('e:a-extra') as unknown as Element); await app.sourceSnapshot('a', 'e:a-extra', 'a');
    await app.click(Array.from(app.container.querySelectorAll('.arch-module-link')).find(button => button.textContent?.includes('甲组件模块')) as unknown as Element);
    await app.sourceSnapshot('module-a', 'e:module-a', 'module-a');
    await app.back(); await app.sourceSnapshot('a', 'e:a-extra', 'a');
    await app.back(); await app.sourceSnapshot('a', 'e:a-extra');
  } finally { await app.dispose(); }
});

test('architecture workspace isolates a 409 view conflict and reloads all detail/evidence against the new version', async () => {
  const app = await mountWorkspace();
  try {
    await app.choose('a'); await app.sourceSnapshot('a', 'e:a');
    app.setVersion(2); await app.choose('b');
    await app.waitFor(() => {
      assert.ok(app.container.querySelector('.arch-work-grid.is-stale'));
      assert.ok(app.container.textContent?.includes('当前架构视图已过期'));
      assert.equal(app.container.querySelector('.arch-source-content [data-evidence-id]'), null);
      assert.equal(app.container.querySelector('.arch-inspector-overview'), null);
    }, '409 clears old detail and source');
    await app.click(app.container.querySelector('[aria-label="重新载入架构模型"]') as unknown as Element);
    await app.sourceSnapshot('b', 'e:b', '', 2);
    const latestEvidence = app.queries.filter(url => url.pathname.includes('/architecture/evidence/')).at(-1);
    assert.equal(latestEvidence?.searchParams.get('viewRevision'), 'view-2');
    assert.equal(app.container.querySelector('.arch-work-grid.is-stale'), null);
  } finally { await app.dispose(); }
});

test('architecture workspace unclassified entities are paged and open real code identities', async () => {
  const app = await mountWorkspace();
  try {
    await app.click(Array.from(app.container.querySelectorAll('.arch-view-foot button')).find(button => button.textContent?.includes('尚未归类')) as unknown as Element);
    await app.waitFor(() => assert.equal(app.container.querySelectorAll('.arch-inspector .arch-code-link').length, 30), 'first unclassified page');
    await app.click(Array.from(app.container.querySelectorAll('.arch-pagination button')).find(button => button.textContent?.includes('下一页')) as unknown as Element);
    await app.waitFor(() => assert.ok(app.container.querySelector('.arch-inspector .arch-code-link')?.textContent?.includes('Unclassified_31')), 'second unclassified page');
    await app.click(app.container.querySelector('.arch-inspector .arch-code-link') as unknown as Element);
    assert.deepEqual(app.openedCode.at(-1), { nodeId: 'unclassified:31', mode: 'structure' });
    const request = app.queries.filter(url => url.pathname.endsWith('/unclassified')).at(-1);
    assert.equal(request?.searchParams.get('offset'), '30'); assert.equal(request?.searchParams.get('limit'), '30'); assert.equal(request?.searchParams.get('viewRevision'), 'view-1');
  } finally { await app.dispose(); }
});

test('architecture workspace refuses a newer source revision returned for an older architecture view', async () => {
  const app = await mountWorkspace();
  try {
    const late = deferred(); app.heldSources.set('e:a', late);
    await app.choose('a'); await app.waitFor(() => assert.equal(late.requested, true), 'pending current architecture evidence');
    await app.click(app.container.querySelector('[aria-label="展开架构源码证据"]') as unknown as Element);
    await act(async () => late.resolve(json(app.source('e:a', 2))));
    await app.waitFor(() => {
      assert.ok(app.container.querySelector('.arch-work-grid.is-stale'), 'mixed revisions force view reload');
      assert.equal(app.container.querySelector('.arch-source-content [data-evidence-id]'), null);
      assert.ok(!app.container.querySelector('.arch-source-content')?.textContent?.includes('SOURCE_e:a_V2'));
      assert.ok(app.container.textContent?.includes('当前架构视图已过期'));
    }, 'newer source cannot appear under older architecture metadata');
  } finally { await app.dispose(); }
});

test('architecture workspace refuses a response for a different evidence identity', async () => {
  const app = await mountWorkspace();
  try {
    const late = deferred(); app.heldSources.set('e:a', late);
    await app.choose('a'); await app.waitFor(() => assert.equal(late.requested, true), 'pending requested evidence A');
    await act(async () => late.resolve(json(app.source('e:b', 1))));
    await app.waitFor(() => {
      assert.ok(app.container.querySelector('.arch-work-grid.is-stale'));
      assert.equal(app.container.querySelector('.arch-source-content [data-evidence-id]'), null);
      assert.ok(!app.container.textContent?.includes('SOURCE_e:b_V1'));
    }, 'mismatched evidence identity is rejected');
  } finally { await app.dispose(); }
});

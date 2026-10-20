import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { ArchitectureEdge, ArchitectureNode, Evidence } from '../../../packages/schema/src/index';

// These are explicit test fixtures, never application/demo architecture data.
// Mount the real App and drive its React events; no production component is mocked.
const fixture = {
  project: 'project:fixture', clientFile: 'file:client', serverFile: 'file:server',
  hp: 'field:client-hp', damage: 'function:damage', dictionaryHp: 'data:dictionary-hp', hud: 'method:hud',
  hpEvidence: 'evidence:hp', hudEvidence: 'evidence:hud', hudEvidenceR2: 'evidence:hud-r2', damageEvidence: 'evidence:damage', dictionaryEvidence: 'evidence:dictionary',
};
const node = (id: string, kind: ArchitectureNode['kind'], label: string, qualifiedName: string, parentId?: string): ArchitectureNode => ({ id, kind, label, qualifiedName, parentId, language: id === fixture.hp || id === fixture.hud ? 'csharp' : 'python', evidenceIds: [] });
const entities = [
  node(fixture.project, 'project', '测试项目', 'Navigation fixture'),
  node(fixture.clientFile, 'file', 'SectContracts.cs', 'Assets/SectContracts.cs', fixture.project),
  node(fixture.serverFile, 'file', 'sect_combat.py', 'Server/sect_combat.py', fixture.project),
  node(fixture.hp, 'field', 'hp', 'SectBattleActor.hp', fixture.clientFile),
  node(fixture.damage, 'function', 'damage', 'Server.sect_combat.damage', fixture.serverFile),
  node(fixture.dictionaryHp, 'data', 'hp', 'Server.sect_combat.damage[hp]', fixture.damage),
  node(fixture.hud, 'method', 'RenderHp', 'SectBattleView.RenderHp', fixture.clientFile),
];
const byId = new Map(entities.map(entity => [entity.id, entity]));
const evidence = (id: string, filePath: string, startLine: number, marker: string): Evidence => ({ id, filePath, startLine, startColumn: 1, endLine: startLine, endColumn: marker.length + 1, fileHash: 'fixture-file-hash', rule: `fixture:${marker}`, excerpt: marker });
const evidenceList = [
  evidence(fixture.hpEvidence, 'Assets/SectContracts.cs', 10, 'CLIENT_HP_DECLARATION'),
  evidence(fixture.hudEvidence, 'Assets/HUD.cs', 131, 'HUD_READS_CLIENT_HP'),
  evidence(fixture.hudEvidenceR2, 'Assets/HUD.cs', 146, 'HUD_R2_READS_CLIENT_HP'),
  evidence(fixture.damageEvidence, 'Server/sect_combat.py', 20, 'PYTHON_DAMAGE_FUNCTION'),
  evidence(fixture.dictionaryEvidence, 'Server/sect_combat.py', 30, 'DICTIONARY_HP_ACCESS'),
];
const evidenceById = new Map(evidenceList.map(item => [item.id, item]));
const readEdge: ArchitectureEdge = { id: 'edge:hud-reads-hp', source: fixture.hud, target: fixture.hp, kind: 'reads', confidence: 'static-confirmed', evidenceIds: [fixture.hudEvidence], rule: 'fixture:hud-reads-client-hp' };
const readEdgeR2: ArchitectureEdge = { ...readEdge, evidenceIds: [fixture.hudEvidenceR2], rule: 'fixture:r2-updated-hud-read', condition: 'fixture-new-hud-path' };
const revision = 'fixture-revision-1';
const revisionR2 = 'fixture-revision-2';
const scope = 'fixture:main';
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Deferred { resolve: (value: Response) => void; promise: Promise<Response>; requested: boolean }
function deferred(): Deferred {
  let resolve!: (value: Response) => void;
  return { resolve: value => resolve(value), promise: new Promise<Response>(done => { resolve = done; }), requested: false };
}
function detailPayload(id: string, currentRevision = revision, currentEdge = readEdge) {
  const entity = byId.get(id);
  assert.ok(entity, `Unknown fixture node ${id}`);
  const parents: ArchitectureNode[] = [];
  let parent = entity.parentId ? byId.get(entity.parentId) : undefined;
  while (parent) { parents.unshift(parent); parent = parent.parentId ? byId.get(parent.parentId) : undefined; }
  return {
    node: entity, parents, revision: currentRevision,
    incoming: id === fixture.hp ? [currentEdge] : [], outgoing: id === fixture.hud ? [currentEdge] : [],
    relatedNodes: id === fixture.hp ? [byId.get(fixture.hud)!] : [],
    evidence: id === fixture.hp ? [evidenceById.get(fixture.hpEvidence)!, evidenceById.get(currentEdge.evidenceIds[0])!]
      : id === fixture.damage ? [evidenceById.get(fixture.damageEvidence)!]
        : id === fixture.dictionaryHp ? [evidenceById.get(fixture.dictionaryEvidence)!] : [],
  };
}
function sourcePayload(id: string, currentRevision = revision) {
  const item = evidenceById.get(id);
  assert.ok(item, `Unknown fixture evidence ${id}`);
  return { evidence: item, content: item.excerpt, contextStartLine: item.startLine, stale: false, revision: currentRevision };
}

async function mountApp() {
  const browser = new Window({ url: 'http://127.0.0.1:4310' });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'localStorage'] as const) {
    install(key, key === 'window' ? browser : browser[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('requestAnimationFrame', browser.requestAnimationFrame.bind(browser));
  install('cancelAnimationFrame', browser.cancelAnimationFrame.bind(browser));
  Object.defineProperty(browser.HTMLElement.prototype, 'scrollIntoView', { value() {}, configurable: true });
  const eventStreams = new Set<FixtureEventSource>();
  class FixtureEventSource {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { eventStreams.add(this); }
    close() { eventStreams.delete(this); }
  }
  install('EventSource', FixtureEventSource);
  const heldDetails = new Map<string, Deferred>();
  const heldSources = new Map<string, Deferred>();
  let currentRevision = revision;
  let currentEdge = readEdge;
  const graphRequests: { rootId: string; view: string }[] = [];
  const fetchFixture = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input), browser.location.origin);
    const path = decodeURIComponent(url.pathname);
    if (path === '/api/projects') return response({ projects: [{ id: 'fixture', name: '测试项目', root: 'C:/read-only-fixture' }] });
    if (path === '/api/projects/fixture/worktrees') return response({ worktrees: [{ id: 'main', path: 'C:/read-only-fixture', branch: 'main', head: 'abc123', authorized: true }] });
    if (path === '/api/status') return response({ scopeId: scope, state: 'synced', message: '测试夹具已同步', revision: currentRevision });
    if (path === '/api/summary') return response({ rootId: fixture.project, counts: { files: 3, nodes: entities.length, edges: 1 }, diagnostics: [], metadata: { scopeId: scope, projectId: 'fixture', projectName: '测试项目', worktreeId: 'main', rootPath: 'C:/read-only-fixture', gitBranch: 'main', gitHead: 'abc123', gitDirty: false, generatedAt: '2026-10-20T12:00:00Z', revision: currentRevision, coverage: { languages: ['csharp', 'python'], limitations: ['显式导航测试夹具'] } } });
    if (path === '/api/graph') {
      const rootId = url.searchParams.get('rootId') || fixture.project;
      const view = url.searchParams.get('view') || 'architecture';
      graphRequests.push({ rootId, view });
      // Empty graph avoids exercising layout/measurement in a DOM emulator.
      // The real request, route context, inspector, and source still execute.
      return response({ nodes: [], edges: [], rootId, totalNodes: 0, truncated: false, revision: currentRevision });
    }
    if (path === '/api/search') {
      const query = url.searchParams.get('q');
      return response({ nodes: [byId.get(query === 'client-hp' ? fixture.hp : query === 'damage' ? fixture.damage : fixture.dictionaryHp)!], revision: currentRevision });
    }
    if (path.startsWith('/api/nodes/')) {
      const id = path.slice('/api/nodes/'.length);
      const held = heldDetails.get(id);
      if (held && !held.requested) { held.requested = true; return held.promise; }
      return response(detailPayload(id, currentRevision, currentEdge));
    }
    if (path.startsWith('/api/evidence/')) {
      const id = path.slice('/api/evidence/'.length);
      const held = heldSources.get(id);
      if (held && !held.requested) { held.requested = true; return held.promise; }
      if (currentRevision === revisionR2 && id === fixture.hudEvidence) return response({ error: 'R1 的 HUD 证据已从 R2 测试索引移除' }, 404);
      return response(sourcePayload(id, currentRevision));
    }
    throw new Error(`Unexpected fixture request ${url}`);
  };
  install('fetch', fetchFixture);
  browser.fetch = fetchFixture as unknown as typeof browser.fetch;
  const { createRoot } = await import('react-dom/client');
  const { default: App } = await import('./App');
  const container = browser.document.createElement('div');
  browser.document.body.append(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => { root.render(React.createElement(App)); });

  const waitFor = async (check: () => void, message: string) => {
    let last: unknown;
    for (let attempt = 0; attempt < 110; attempt++) {
      try { check(); return; } catch (error) { last = error; }
      await act(async () => { await new Promise(done => setTimeout(done, 15)); });
    }
    throw new Error(`${message}: ${last instanceof Error ? last.message : last}`);
  };
  const click = async (button: Element | null | undefined) => {
    assert.ok(button, 'Expected an interactive element');
    await act(async () => { button.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true }) as unknown as MouseEvent); });
  };
  const buttonNamed = (text: string) => Array.from(container.querySelectorAll('button')).find(button => button.textContent?.trim() === text);
  const search = async (query: 'client-hp' | 'damage' | 'dictionary-hp') => {
    await act(async () => { browser.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'k', ctrlKey: true })); });
    const input = container.querySelector('input[role="combobox"]') as unknown as HTMLInputElement;
    assert.ok(input, 'Real App search input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!.call(input, query);
      input.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event);
    });
    await waitFor(() => assert.equal(container.querySelectorAll('[role="option"]').length, 1), 'search result');
    await act(async () => { input.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }) as unknown as KeyboardEvent); });
  };
  const snapshot = async (expected: { context: string; view: string; selected?: string; evidence?: string }) => {
    await waitFor(() => {
      assert.equal(container.querySelector('[data-context-node-id]')?.getAttribute('data-context-node-id'), expected.context, 'canvas context');
      assert.equal(container.querySelector('[data-view]')?.getAttribute('data-view'), expected.view, 'canvas view');
      assert.equal(container.querySelector('[data-selected-node-id]')?.getAttribute('data-selected-node-id') || '', expected.selected || '', 'canvas selected entity');
      assert.equal(container.querySelector('.inspector')?.getAttribute('data-node-id') || '', expected.selected || '', 'inspector entity');
      assert.equal(container.querySelector('[data-evidence-id]')?.getAttribute('data-evidence-id') || '', expected.evidence || '', 'source evidence');
      assert.deepEqual(graphRequests.at(-1), { rootId: expected.context, view: expected.view }, 'actual graph query');
      if (expected.evidence) assert.ok(container.querySelector('.source-code')?.textContent?.includes(evidenceById.get(expected.evidence)!.excerpt!), 'source marker from matching fixture');
    }, `snapshot ${JSON.stringify(expected)}`);
  };
  const back = () => click(container.querySelector('button[aria-label="返回上一视图"]') as unknown as Element);
  const chooseHudEvidence = () => click(Array.from(container.querySelectorAll('button.evidence-item')).find(button => button.textContent?.includes('HUD.cs')) as unknown as Element);
  const publishRevisionR2 = async () => {
    currentRevision = revisionR2; currentEdge = readEdgeR2;
    await act(async () => {
      for (const stream of eventStreams) stream.onmessage?.({ data: JSON.stringify({ scopeId: scope, state: 'synced', message: '测试夹具切换到 R2', revision: currentRevision }) });
    });
    await waitFor(() => assert.equal(container.querySelector('.index-revision')?.getAttribute('title'), revisionR2), 'SSE revision R2 reached real App');
  };
  const dispose = async () => {
    await act(async () => { root.unmount(); });
    await browser.happyDOM.close();
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  };
  await waitFor(() => assert.ok(graphRequests.length), 'initial real App graph request');
  return { container, search, snapshot, click, buttonNamed, back, chooseHudEvidence, heldDetails, heldSources, waitFor, publishRevisionR2, dispose };
}

test('real App restores HP/HUD, damage, dictionary hp and the unselected project on consecutive returns', async () => {
  const app = await mountApp();
  try {
    await app.snapshot({ context: fixture.project, view: 'architecture' });
    await app.search('client-hp');
    await app.snapshot({ context: fixture.clientFile, view: 'architecture', selected: fixture.hp, evidence: fixture.hpEvidence });
    await app.click(app.buttonNamed('数据读写') as unknown as Element);
    await app.snapshot({ context: fixture.hp, view: 'data', selected: fixture.hp, evidence: fixture.hpEvidence });
    await app.chooseHudEvidence();
    await app.snapshot({ context: fixture.hp, view: 'data', selected: fixture.hp, evidence: fixture.hudEvidence });
    await app.search('damage');
    await app.snapshot({ context: fixture.serverFile, view: 'architecture', selected: fixture.damage, evidence: fixture.damageEvidence });
    await app.click(app.buttonNamed('调用链') as unknown as Element);
    await app.snapshot({ context: fixture.damage, view: 'calls', selected: fixture.damage, evidence: fixture.damageEvidence });
    await app.search('dictionary-hp');
    await app.snapshot({ context: fixture.damage, view: 'architecture', selected: fixture.dictionaryHp, evidence: fixture.dictionaryEvidence });
    await app.click(app.buttonNamed('数据读写') as unknown as Element);
    await app.snapshot({ context: fixture.dictionaryHp, view: 'data', selected: fixture.dictionaryHp, evidence: fixture.dictionaryEvidence });
    for (const expected of [
      { context: fixture.damage, view: 'architecture', selected: fixture.dictionaryHp, evidence: fixture.dictionaryEvidence },
      { context: fixture.damage, view: 'calls', selected: fixture.damage, evidence: fixture.damageEvidence },
      { context: fixture.serverFile, view: 'architecture', selected: fixture.damage, evidence: fixture.damageEvidence },
      { context: fixture.hp, view: 'data', selected: fixture.hp, evidence: fixture.hudEvidence },
      { context: fixture.clientFile, view: 'architecture', selected: fixture.hp, evidence: fixture.hpEvidence },
      { context: fixture.project, view: 'architecture' },
    ]) { await app.back(); await app.snapshot(expected); }
    assert.ok(app.container.textContent?.includes('从一个节点开始'));
    assert.ok(!app.container.textContent?.includes('HUD_READS_CLIENT_HP'));
  } finally { await app.dispose(); }
});

test('real App rejects a late detail response after choosing another node', async () => {
  const app = await mountApp();
  try {
    const lateHp = deferred(); app.heldDetails.set(fixture.hp, lateHp);
    await app.search('client-hp');
    await app.waitFor(() => assert.equal(lateHp.requested, true), 'held HP details request');
    await app.search('damage');
    await app.snapshot({ context: fixture.serverFile, view: 'architecture', selected: fixture.damage, evidence: fixture.damageEvidence });
    await act(async () => { lateHp.resolve(response(detailPayload(fixture.hp))); });
    await app.snapshot({ context: fixture.serverFile, view: 'architecture', selected: fixture.damage, evidence: fixture.damageEvidence });
    assert.ok(!app.container.querySelector('.inspector')?.textContent?.includes('SectBattleActor.hp'));
  } finally { await app.dispose(); }
});

test('real App rejects a late source response after choosing another node', async () => {
  const app = await mountApp();
  try {
    const lateSource = deferred(); app.heldSources.set(fixture.hpEvidence, lateSource);
    await app.search('client-hp');
    await app.waitFor(() => assert.equal(lateSource.requested, true), 'held HP source request');
    await app.search('damage');
    await app.snapshot({ context: fixture.serverFile, view: 'architecture', selected: fixture.damage, evidence: fixture.damageEvidence });
    await act(async () => { lateSource.resolve(response(sourcePayload(fixture.hpEvidence))); });
    await app.snapshot({ context: fixture.serverFile, view: 'architecture', selected: fixture.damage, evidence: fixture.damageEvidence });
    assert.ok(!app.container.textContent?.includes('CLIENT_HP_DECLARATION'));
  } finally { await app.dispose(); }
});

test('real App restores the selected relation and its source evidence when returning', async () => {
  const app = await mountApp();
  try {
    await app.search('client-hp');
    await app.snapshot({ context: fixture.clientFile, view: 'architecture', selected: fixture.hp, evidence: fixture.hpEvidence });
    await app.click(app.buttonNamed('数据读写') as unknown as Element);
    await app.click(Array.from(app.container.querySelectorAll('button')).find(button => button.textContent?.startsWith('关系详情')) as unknown as Element);
    await app.click(app.container.querySelector('button.relation-table-row') as unknown as Element);
    await app.snapshot({ context: fixture.hp, view: 'data', selected: fixture.hp, evidence: fixture.hudEvidence });
    assert.ok(app.container.querySelector('.relation-context')?.textContent?.includes(readEdge.rule));
    await app.search('damage');
    await app.snapshot({ context: fixture.serverFile, view: 'architecture', selected: fixture.damage, evidence: fixture.damageEvidence });
    await app.back();
    await app.snapshot({ context: fixture.hp, view: 'data', selected: fixture.hp, evidence: fixture.hudEvidence });
    assert.ok(app.container.querySelector('.relation-context')?.textContent?.includes(readEdge.rule), 'restored relation rule');
    assert.ok(app.container.querySelector('.relation-context')?.textContent?.includes('静态确认'), 'restored relation confidence');
  } finally { await app.dispose(); }
});

test('real App rejects late HUD evidence after choosing declaration evidence on the same HP node', async () => {
  const app = await mountApp();
  try {
    await app.search('client-hp');
    await app.snapshot({ context: fixture.clientFile, view: 'architecture', selected: fixture.hp, evidence: fixture.hpEvidence });
    const lateHud = deferred(); app.heldSources.set(fixture.hudEvidence, lateHud);
    await app.chooseHudEvidence();
    await app.waitFor(() => assert.equal(lateHud.requested, true), 'held HUD evidence request on HP');
    await app.click(Array.from(app.container.querySelectorAll('button.evidence-item')).find(button => button.textContent?.includes('SectContracts.cs')) as unknown as Element);
    await app.snapshot({ context: fixture.clientFile, view: 'architecture', selected: fixture.hp, evidence: fixture.hpEvidence });
    await act(async () => { lateHud.resolve(response(sourcePayload(fixture.hudEvidence))); });
    await app.snapshot({ context: fixture.clientFile, view: 'architecture', selected: fixture.hp, evidence: fixture.hpEvidence });
    assert.ok(!app.container.querySelector('.source-code')?.textContent?.includes('HUD_READS_CLIENT_HP'), 'late evidence must not overwrite the newer evidence on the same selected node');
  } finally { await app.dispose(); }
});

test('real App rejects late search-parent navigation after returning to the unselected project', async () => {
  const app = await mountApp();
  try {
    const lateParent = deferred(); app.heldDetails.set(fixture.clientFile, lateParent);
    await app.search('client-hp');
    await app.waitFor(() => assert.equal(lateParent.requested, true), 'held parent location request');
    await app.snapshot({ context: fixture.project, view: 'architecture', selected: fixture.hp, evidence: fixture.hpEvidence });
    await app.click(app.container.querySelector('button.project-tree-root') as unknown as Element);
    await app.snapshot({ context: fixture.project, view: 'architecture' });
    await act(async () => { lateParent.resolve(response(detailPayload(fixture.clientFile))); });
    await app.snapshot({ context: fixture.project, view: 'architecture' });
    assert.ok(app.container.textContent?.includes('从一个节点开始'));
    assert.ok(!app.container.textContent?.includes('CLIENT_HP_DECLARATION'), 'late parent location must not repopulate cleared source evidence');
  } finally { await app.dispose(); }
});

test('real App reloads repeated HUD evidence and repeated relation selections without getting stuck loading', async () => {
  const app = await mountApp();
  try {
    await app.search('client-hp');
    await app.snapshot({ context: fixture.clientFile, view: 'architecture', selected: fixture.hp, evidence: fixture.hpEvidence });
    await app.chooseHudEvidence();
    await app.snapshot({ context: fixture.clientFile, view: 'architecture', selected: fixture.hp, evidence: fixture.hudEvidence });
    await app.chooseHudEvidence();
    await app.snapshot({ context: fixture.clientFile, view: 'architecture', selected: fixture.hp, evidence: fixture.hudEvidence });
    assert.ok(!app.container.querySelector('.bottom-content')?.textContent?.includes('读取源码证据'), 'repeated evidence activation must finish loading');

    for (let repetition = 0; repetition < 2; repetition++) {
      await app.click(Array.from(app.container.querySelectorAll('button')).find(button => button.textContent?.startsWith('关系详情')) as unknown as Element);
      await app.click(app.container.querySelector('button.relation-table-row') as unknown as Element);
      await app.snapshot({ context: fixture.clientFile, view: 'architecture', selected: fixture.hp, evidence: fixture.hudEvidence });
      assert.ok(app.container.querySelector('.relation-context')?.textContent?.includes(readEdge.rule), 'same relation retains its rule');
      assert.ok(app.container.querySelector('.relation-context')?.textContent?.includes('静态确认'), 'same relation retains its confidence');
      assert.ok(!app.container.querySelector('.bottom-content')?.textContent?.includes('读取源码证据'), 'repeated relation activation must finish loading');
    }
  } finally { await app.dispose(); }
});

test('real App restores the current R2 relation and evidence after an SSE revision changes the saved R1 relationship', async () => {
  const app = await mountApp();
  try {
    await app.search('client-hp');
    await app.snapshot({ context: fixture.clientFile, view: 'architecture', selected: fixture.hp, evidence: fixture.hpEvidence });
    await app.click(app.buttonNamed('数据读写') as unknown as Element);
    await app.click(Array.from(app.container.querySelectorAll('button')).find(button => button.textContent?.startsWith('关系详情')) as unknown as Element);
    await app.click(app.container.querySelector('button.relation-table-row') as unknown as Element);
    await app.snapshot({ context: fixture.hp, view: 'data', selected: fixture.hp, evidence: fixture.hudEvidence });
    assert.ok(app.container.querySelector('.relation-context')?.textContent?.includes(readEdge.rule));
    await app.search('damage');
    await app.snapshot({ context: fixture.serverFile, view: 'architecture', selected: fixture.damage, evidence: fixture.damageEvidence });

    await app.publishRevisionR2();
    await app.snapshot({ context: fixture.serverFile, view: 'architecture', selected: fixture.damage, evidence: fixture.damageEvidence });
    await app.back();
    await app.snapshot({ context: fixture.hp, view: 'data', selected: fixture.hp, evidence: fixture.hudEvidenceR2 });
    const relationText = app.container.querySelector('.relation-context')?.textContent || '';
    assert.ok(relationText.includes(readEdgeR2.rule), 'same stable edge ID must use the current revision object');
    assert.ok(relationText.includes(readEdgeR2.condition!), 'current relation condition');
    assert.ok(!relationText.includes(readEdge.rule), 'old R1 relationship description must not return');
    assert.ok(!app.container.querySelector('.source-code')?.textContent?.includes('HUD_READS_CLIENT_HP'), 'old removed evidence must not be displayed');
    assert.ok(app.container.querySelector('.source-code')?.textContent?.includes('HUD_R2_READS_CLIENT_HP'));
  } finally { await app.dispose(); }
});

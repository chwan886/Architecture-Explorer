import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { ArchitectureModel, ModelEnvelope } from '../../../../packages/architecture-model/src/types';

const model = (name: string): ArchitectureModel => ({ schemaVersion: '1.0.0', projectId: 'fixture', name, systems: [], modules: [], memberships: [], anchors: [], flows: [], reviews: [] });
const envelope = (scope: string, revision: number, name = `${scope}_SERVER_R${revision}`): ModelEnvelope => ({ model: model(name), modelRevision: `${scope}:R${revision}` });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function deferred() { let resolve!: (value: Response) => void; return { promise: new Promise<Response>(done => { resolve = done; }), resolve: (value: Response) => resolve(value), requested: false }; }

async function mountEditor({ delayFirstGet = false }: { delayFirstGet?: boolean } = {}) {
  const browser = new Window({ url: 'http://127.0.0.1:4311' });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => { descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'sessionStorage'] as const) install(key, key === 'window' ? browser : browser[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const stores = new Map([['scope-a', envelope('scope-a', 1)], ['scope-b', envelope('scope-b', 1)]]);
  const heldGet = delayFirstGet ? deferred() : undefined;
  const heldPuts = new Map<string, ReturnType<typeof deferred>>();
  let failNextGet = false;
  const requests: { scope: string; method: string; expectedRevision?: string; model?: ArchitectureModel }[] = [];
  const saved: ModelEnvelope[] = [];
  const api = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), browser.location.origin), scope = url.searchParams.get('scope')!, method = init?.method || 'GET';
    assert.equal(url.pathname, '/api/architecture/model');
    const payload = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ scope, method, ...payload });
    if (method === 'GET') {
      if (heldGet && scope === 'scope-a' && !heldGet.requested) { heldGet.requested = true; return heldGet.promise; }
      if (failNextGet) { failNextGet = false; return json({ error: 'fixture temporary model failure' }, 503); }
      return json(stores.get(scope));
    }
    const held = heldPuts.get(scope);
    if (held && !held.requested) { held.requested = true; return held.promise; }
    const current = stores.get(scope)!;
    if (payload.expectedRevision !== current.modelRevision) return json({ error: 'fixture model revision conflict' }, 409);
    const value = { model: payload.model, modelRevision: `${scope}:R3` }; stores.set(scope, value); return json(value);
  };
  install('fetch', api); browser.fetch = api as unknown as typeof browser.fetch;
  const { createRoot } = await import('react-dom/client');
  const { default: ModelEditor } = await import('./ModelEditor');
  const container = browser.document.createElement('div'); browser.document.body.append(container);
  const root = createRoot(container as unknown as Element);
  const render = async (scope: string) => { await act(async () => root.render(React.createElement(ModelEditor, { scope, onClose() {}, onSaved(value) { saved.push(value); } }))); };
  const waitFor = async (check: () => void, label: string) => { let last: unknown; for (let i = 0; i < 100; i++) { try { check(); return; } catch (error) { last = error; } await act(async () => { await new Promise(done => setTimeout(done, 12)); }); } throw new Error(`${label}: ${last instanceof Error ? last.message : last}`); };
  const textarea = () => container.querySelector('textarea') as unknown as HTMLTextAreaElement;
  const baseline = () => container.querySelector('footer > span')?.getAttribute('title');
  const click = async (name: string) => { const button = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes(name)); assert.ok(button, name); assert.equal(button.disabled, false, `${name} must be usable`); await act(async () => button.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true }))); };
  const editName = async (name: string) => {
    await waitFor(() => assert.equal(textarea().disabled, false), 'editor unlocked');
    const value = { ...JSON.parse(textarea().value), name };
    await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), JSON.stringify(value, null, 2)); textarea().dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event); });
  };
  const expectModel = async (scope: string, name: string, expectedRevision: string) => waitFor(() => { assert.equal(JSON.parse(textarea().value).name, name); assert.equal(baseline(), expectedRevision); assert.equal(textarea().disabled, false); }, `editor ${scope}/${expectedRevision}`);
  const dispose = async () => { await act(async () => root.unmount()); await browser.happyDOM.close(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } };
  await render('scope-a');
  if (!delayFirstGet) await expectModel('scope-a', 'scope-a_SERVER_R1', 'scope-a:R1');
  return { container, requests, saved, heldGet, heldPuts, click, editName, expectModel, render, waitFor, dispose, advance(scope: string, revision: number) { stores.set(scope, envelope(scope, revision)); }, failNextGet() { failNextGet = true; } };
}

test('model editor keeps the draft after 409, GETs current R2, and saves merged content using the R2 baseline', async () => {
  const app = await mountEditor();
  try {
    await app.editName('LOCAL_UNSAVED_DRAFT'); app.advance('scope-a', 2);
    await app.click('校验并保存');
    await app.waitFor(() => assert.ok(app.container.textContent?.includes('409')), '409 error is visible');
    await app.expectModel('scope-a', 'LOCAL_UNSAVED_DRAFT', 'scope-a:R1');
    assert.ok(app.container.textContent?.includes('未保存草稿'));
    const getsBefore = app.requests.filter(request => request.method === 'GET').length;
    await app.click('载入服务器版本');
    await app.expectModel('scope-a', 'scope-a_SERVER_R2', 'scope-a:R2');
    assert.equal(app.requests.filter(request => request.method === 'GET').length, getsBefore + 1, 'reload actually fetches current server version');
    await app.editName('MERGED_AGAINST_R2'); await app.click('校验并保存');
    await app.expectModel('scope-a', 'MERGED_AGAINST_R2', 'scope-a:R3');
    assert.equal(app.requests.filter(request => request.method === 'PUT').at(-1)?.expectedRevision, 'scope-a:R2');
    assert.equal(app.saved.length, 1); assert.equal(app.saved[0].model.name, 'MERGED_AGAINST_R2');
  } finally { await app.dispose(); }
});

test('model editor failed server reload preserves the unsaved draft and its original baseline', async () => {
  const app = await mountEditor();
  try {
    await app.editName('KEEP_THIS_DRAFT'); app.failNextGet();
    await app.click('载入服务器版本');
    await app.waitFor(() => assert.ok(app.container.textContent?.includes('503')), 'reload failure is visible');
    await app.expectModel('scope-a', 'KEEP_THIS_DRAFT', 'scope-a:R1');
    assert.ok(app.container.textContent?.includes('未保存草稿')); assert.equal(app.saved.length, 0);
  } finally { await app.dispose(); }
});

test('model editor ignores a late initial GET from the previous scope', async () => {
  const app = await mountEditor({ delayFirstGet: true });
  try {
    await app.waitFor(() => assert.equal(app.heldGet?.requested, true), 'held scope A GET');
    await app.render('scope-b'); await app.expectModel('scope-b', 'scope-b_SERVER_R1', 'scope-b:R1');
    await act(async () => app.heldGet!.resolve(json(envelope('scope-a', 2))));
    await app.expectModel('scope-b', 'scope-b_SERVER_R1', 'scope-b:R1');
  } finally { await app.dispose(); }
});

test('model editor ignores a late save result from the previous scope', async () => {
  const app = await mountEditor();
  try {
    await app.editName('SCOPE_A_PENDING'); const lateSave = deferred(); app.heldPuts.set('scope-a', lateSave);
    await app.click('校验并保存'); await app.waitFor(() => assert.equal(lateSave.requested, true), 'held scope A PUT');
    await app.render('scope-b'); await app.expectModel('scope-b', 'scope-b_SERVER_R1', 'scope-b:R1');
    await act(async () => lateSave.resolve(json(envelope('scope-a', 2, 'SCOPE_A_PENDING'))));
    await app.expectModel('scope-b', 'scope-b_SERVER_R1', 'scope-b:R1');
    assert.equal(app.saved.length, 0, 'old-scope completion must not refresh the new workspace');
  } finally { await app.dispose(); }
});

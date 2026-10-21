import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import DeliveryWorkspace, { GitHubLink } from './delivery/DeliveryWorkspace';
import { activationOrder, deliveryStages, safeGitHubUrl } from './delivery/model';

test('delivery description includes every gate, accountable inputs/outputs and the conditional approval branch', () => {
  assert.deepEqual(deliveryStages.map(stage => stage.id), ['scope', 'feature', 'checks-review', 'approval', 'merge', 'main-checks', 'dispatch', 'tool-build', 'scan', 'artifacts']);
  for (const stage of deliveryStages) {
    for (const field of ['actor', 'input', 'output', 'trigger', 'pass', 'blocked', 'failure'] as const) assert.ok(stage[field].trim(), `${stage.id}.${field} must be described`);
    assert.ok(stage.steps.length >= 3);
    assert.ok(stage.links.length >= 2);
    for (const value of stage.links) assert.equal(safeGitHubUrl(value.url), value.url);
  }
  const byId = Object.fromEntries(deliveryStages.map(stage => [stage.id, stage]));
  assert.match(byId['checks-review'].pass, /成功且独立 Review/);
  assert.match(byId.approval.trigger, /普通低风险变更直接/);
  assert.match(byId['main-checks'].trigger, /PR 打开、未合并关闭均不进入/);
  assert.match(byId.dispatch.failure, /请求成功不等于目标构建成功/);
  assert.match(byId.scan.pass, /metadata.gitHead 精确相等且非空/);
  assert.match(byId.scan.steps.join(' '), /待复核/);
  assert.match(byId.scope.steps.join(' '), /日常游戏 Full 仅横屏/);
  assert.match(byId.artifacts.steps.join(' '), /不能覆盖 .cache/);
  assert.match(activationOrder[0], /Fast 报告、CODEOWNERS/);
  assert.match(activationOrder[2], /main 合入并手动验收/);
  assert.match(activationOrder[3], /初始保持关闭/);
  assert.match(activationOrder[4], /用户审核/);
});

test('GitHub links reject dangerous schemes, hosts, credentials, repository escapes and invented path shapes', () => {
  for (const value of [
    'javascript:alert(1)', 'data:text/html,hello', '//github.com/chwan886/GameDemo02/pulls',
    'http://github.com/chwan886/GameDemo02/actions', 'https://github.com.evil.test/chwan886/GameDemo02/actions',
    'https://github.com@evil.test/chwan886/GameDemo02/actions', 'https://user:secret@github.com/chwan886/GameDemo02/actions',
    'https://github.com:444/chwan886/GameDemo02/actions', 'https://github.com/chwan886/OtherGame/actions',
    'https://github.com/chwan886/GameDemo02/../OtherGame/actions',
    'https://github.com/chwan886/GameDemo02/%2e%2e/OtherGame/actions',
    'https://github.com/chwan886/GameDemo02/%2e%2e%2fOtherGame/actions',
    'https://github.com/chwan886/GameDemo02/actions?redirect=https://evil.test',
    'https://github.com/chwan886/GameDemo02/actions#javascript:alert(1)',
    'https://github.com/chwan886/GameDemo02/actions\n',
    'https://github.com/chwan886/GameDemo02/actions\\evil',
    'https://github.com/chwan886/GameDemo02/issues/new',
  ]) assert.equal(safeGitHubUrl(value), undefined, value);
  assert.equal(safeGitHubUrl('https://github.com/chwan886/Architecture-Explorer/actions/runs/123/artifacts/456'), 'https://github.com/chwan886/Architecture-Explorer/actions/runs/123/artifacts/456');
});

test('external link renderer escapes text, isolates the new tab and removes rejected hrefs', () => {
  const safe = renderToStaticMarkup(React.createElement(GitHubLink, { value: { label: '<img src=x onerror=alert(1)>', url: 'https://github.com/chwan886/GameDemo02/pulls' } }));
  assert.match(safe, /&lt;img/);
  assert.match(safe, /rel="noopener noreferrer"/);
  assert.match(safe, /target="_blank"/);
  assert.ok(!safe.includes('<img '));
  const unsafe = renderToStaticMarkup(React.createElement(GitHubLink, { value: { label: 'bad', url: 'javascript:alert(1)' } }));
  assert.ok(!unsafe.includes('href='));
  assert.match(unsafe, /链接不可用/);
});

async function mount(fullApp = false) {
  const browser = new Window({ url: 'http://127.0.0.1:4310/?page=delivery' });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => { descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'sessionStorage', 'localStorage', 'ResizeObserver', 'DOMMatrixReadOnly'] as const) install(key, key === 'window' ? browser : browser[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('requestAnimationFrame', browser.requestAnimationFrame.bind(browser)); install('cancelAnimationFrame', browser.cancelAnimationFrame.bind(browser)); install('getComputedStyle', browser.getComputedStyle.bind(browser));
  let requests = 0; install('fetch', () => { requests++; throw new Error('description must not read live GitHub state'); });
  const { createRoot } = await import('react-dom/client');
  const container = browser.document.createElement('div'); browser.document.body.append(container); const root = createRoot(container as unknown as Element);
  const Component = fullApp ? (await import('./App')).default : DeliveryWorkspace;
  await act(async () => root.render(React.createElement(Component)));
  const click = async (selector: string) => { const value = container.querySelector(selector); assert.ok(value, selector); await act(async () => { value.dispatchEvent(new browser.MouseEvent('click', { bubbles: true })); }); };
  const dispose = async () => { await act(async () => root.unmount()); await browser.happyDOM.close(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } };
  const waitFor = async (check: () => void) => { let failure: unknown; for (let attempt = 0; attempt < 100; attempt++) { try { check(); return; } catch (error) { failure = error; } await act(async () => { await new Promise(done => setTimeout(done, 10)); }); } throw failure; };
  return { container, click, dispose, waitFor, requestCount: () => requests };
}

test('delivery workspace switches overview/details, expands a phase and preserves navigation without live requests', async () => {
  const app = await mount();
  try {
    assert.equal(app.container.querySelector('.delivery-workspace')?.getAttribute('data-delivery-mode'), 'overview');
    assert.match(app.container.textContent || '', /人工维护的交付流程说明/);
    assert.match(app.container.textContent || '', /不读取 GitHub 实时状态/);
    assert.equal(app.container.querySelectorAll('.delivery-node').length, 10);
    await app.click('.react-flow__node[data-id="dispatch"] .delivery-node button');
    assert.equal(app.container.querySelector('.delivery-workspace')?.getAttribute('data-delivery-mode'), 'details');
    assert.equal(app.container.querySelector('.delivery-inspector h2')?.textContent, '跨仓库触发');
    assert.ok(app.container.querySelector('.delivery-detail-stage.selected[open]'));
    assert.equal(app.container.querySelectorAll('.delivery-detail-stage').length, 10);
    assert.match(app.container.querySelector('.delivery-inspector')?.textContent || '', /待配置 \/ 待核实/);
    await app.click('[aria-label="返回上一交付阶段"]');
    assert.equal(app.container.querySelector('.delivery-inspector h2')?.textContent, '任务范围 / 变更分级');
    await app.click('.delivery-mode-switch button:first-child');
    assert.equal(app.container.querySelector('.delivery-workspace')?.getAttribute('data-delivery-mode'), 'overview');
    assert.equal(app.requestCount(), 0);
    for (const value of app.container.querySelectorAll('a')) { assert.equal(safeGitHubUrl(value.href), value.href); assert.equal(value.rel, 'noopener noreferrer'); }
  } finally { await app.dispose(); }
});

test('the real App exposes delivery navigation even when project bootstrap and indexing are unavailable', async () => {
  const app = await mount(true);
  try {
    await app.waitFor(() => assert.ok(app.container.querySelector('.delivery-workspace')));
    const nav = app.container.querySelector('.primary-navigation');
    assert.ok(nav);
    assert.deepEqual(Array.from(nav.querySelectorAll('button')).map(value => value.textContent), ['系统总览', '技术架构', '业务流程', '代码地图', '开发交付流程']);
    assert.equal(nav.querySelector('[aria-current="page"]')?.textContent, '开发交付流程');
    await app.click('.primary-navigation button:nth-child(4)');
    await app.waitFor(() => assert.match(app.container.querySelector('.state-card')?.textContent || '', /无法连接项目/));
    await app.click('.primary-navigation button:nth-child(5)');
    await app.waitFor(() => assert.ok(app.container.querySelector('.delivery-workspace')));
    assert.equal(nav.querySelector('[aria-current="page"]')?.textContent, '开发交付流程');
    assert.ok(app.requestCount() > 0, 'the App actually attempted project bootstrap');
  } finally { await app.dispose(); }
});

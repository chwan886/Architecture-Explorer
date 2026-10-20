import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ArchitectureEdge } from '../../../../packages/schema/src/index';
import type { SemanticEdge } from '../../../../packages/semantic-model/src/types';
import { canvasResizeTargets, observeCanvasResize, refreshCodeEdgeMetadata } from '../GraphCanvas';
import { refreshSemanticEdgeMetadata } from './SemanticCanvas';

test('same-ID code metadata refreshes current confidence, condition, labels and colors while preserving layout data', () => {
  const first: ArchitectureEdge = { id: 'edge:same', source: 'a', target: 'b', kind: 'reads', confidence: 'static-confirmed', evidenceIds: ['old'], rule: 'OLD_RULE' };
  const activate = () => {}, original = { id: first.id, source: first.source, target: first.target, type: 'parallel', data: { offset: 44, activate }, style: { opacity: .22 } };
  const oldRendered = refreshCodeEdgeMetadata(original, first);
  const changed: ArchitectureEdge = { ...first, kind: 'writes', confidence: 'inferred', condition: 'CURRENT_CONDITION', dispatch: 'virtual', rule: 'CURRENT_RULE', evidenceIds: ['current'] };
  const current = refreshCodeEdgeMetadata(oldRendered, changed, { label: '当前写入 · 3', highlightActive: true, highlighted: true });
  assert.equal(current.id, oldRendered.id); assert.equal(current.type, 'parallel'); assert.equal(current.data?.offset, 44); assert.equal(current.data?.activate, activate);
  assert.equal(current.label, '当前写入 · 3'); assert.match(current.ariaLabel!, /CURRENT_RULE/); assert.match(current.ariaLabel!, /CURRENT_CONDITION/); assert.doesNotMatch(current.ariaLabel!, /OLD_RULE/); assert.match(String(current.data?.description), /有据推断/);
  assert.equal(current.style?.stroke, '#b89155'); assert.equal(current.style?.strokeDasharray, '5 4'); assert.equal(current.style?.strokeWidth, 2.6); assert.equal(current.style?.opacity, 1);
  const confirmed = refreshCodeEdgeMetadata(current, { ...changed, confidence: 'static-confirmed' });
  assert.equal(confirmed.style?.stroke, '#b78386'); assert.equal(confirmed.style?.strokeDasharray, undefined); assert.equal(confirmed.style?.strokeWidth, 1.3);
});

test('same-ID semantic metadata refreshes full meaning, verification, line style and aria without losing activation', () => {
  const first: SemanticEdge = { id: 'semantic:same', source: 'group-a', target: 'group-b', level: 'summary', title: 'OLD_TITLE', description: 'OLD_DESCRIPTION', kinds: ['request-boundary'], sourceTransitionIds: [], codeEdgeIds: [], paths: [], evidenceIds: [], conditions: [], boundaries: [], verification: 'unverified', status: 'current', reviewState: 'pending', fingerprint: 'old', limitations: [] };
  const activate = () => {}, original = refreshSemanticEdgeMetadata({ id: first.id, source: first.source, target: first.target, type: 'semantic', data: { value: first, activate } }, first);
  const changed: SemanticEdge = { ...first, title: 'CURRENT_TITLE', description: 'CURRENT_DESCRIPTION', verification: 'static-confirmed', kinds: ['direct-call'], fingerprint: 'new' };
  const current = refreshSemanticEdgeMetadata(original, changed, { highlightActive: true, highlighted: true });
  assert.equal(current.id, original.id); assert.equal(current.type, original.type); assert.equal(current.data?.value, changed); assert.equal(current.data?.activate, activate);
  assert.match(current.ariaLabel!, /CURRENT_TITLE/); assert.match(current.ariaLabel!, /CURRENT_DESCRIPTION/); assert.match(current.ariaLabel!, /静态确认/); assert.doesNotMatch(current.ariaLabel!, /OLD_/);
  assert.equal(current.style?.stroke, '#6f8f9e'); assert.equal(current.style?.strokeDasharray, undefined); assert.equal(current.style?.strokeWidth, 2.6);
  const unverified = refreshSemanticEdgeMetadata(current, { ...changed, verification: 'unverified' }, { highlightActive: true, highlighted: false });
  assert.equal(unverified.style?.stroke, '#b89a65'); assert.equal(unverified.style?.strokeDasharray, '5 4'); assert.equal(unverified.style?.opacity, .2);
});

test('resize focus chooses only current selected/mapped nodes and fits all when none remain visible', () => {
  const nodes = [{ id: 'selected' }, { id: 'mapped-a' }, { id: 'mapped-b' }, { id: 'other' }];
  assert.deepEqual(canvasResizeTargets(nodes, 'selected', new Set(['mapped-a', 'mapped-b', 'hidden'])), [{ id: 'selected' }, { id: 'mapped-a' }, { id: 'mapped-b' }]);
  assert.equal(canvasResizeTargets(nodes, 'removed', new Set(['hidden'])), undefined);
});

test('resize observer skips initial viewport, debounces changes, waits for layout and cancels on cleanup', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  const element = {} as HTMLElement; let callback!: ResizeObserverCallback, disconnected = false, ready = true, calls = 0;
  class FixtureResizeObserver {
    constructor(value: ResizeObserverCallback) { callback = value; }
    observe(target: Element) { assert.equal(target, element); }
    disconnect() { disconnected = true; }
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, writable: true, value: FixtureResizeObserver });
  const emit = (width: number, height: number) => callback([{ target: element, contentRect: { width, height } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
  const pause = (duration: number) => new Promise(done => setTimeout(done, duration));
  let stop: (() => void) | undefined;
  try {
    stop = observeCanvasResize(element, () => ready, () => calls++, 8);
    emit(1000, 600); await pause(15); assert.equal(calls, 0, 'initial measurement preserves restored viewport');
    emit(850, 450); emit(800, 400); await pause(20); assert.equal(calls, 1, 'multiple resize notifications cause one camera update');
    ready = false; emit(800, 160); await pause(20); assert.equal(calls, 1, 'source panel resize waits for active layout');
    ready = true; await pause(45); assert.equal(calls, 2);
    emit(700, 160); stop(); await pause(20); assert.equal(calls, 2); assert.equal(disconnected, true);
  } finally { stop?.(); if (descriptor) Object.defineProperty(globalThis, 'ResizeObserver', descriptor); else Reflect.deleteProperty(globalThis, 'ResizeObserver'); }
});

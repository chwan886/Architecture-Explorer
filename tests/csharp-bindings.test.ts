import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { contentHash, type AnalyzerResult } from '../packages/schema/src/index.ts';

function analyze(content: string): AnalyzerResult {
  const local = resolve('.tools/dotnet/dotnet.exe');
  return JSON.parse(execFileSync(process.env.EXPLORER_DOTNET ?? (existsSync(local) ? local : 'dotnet'), [resolve('analyzers/csharp/bin/Release/net10.0/ArchitectureExplorer.Analyzers.dll')], {
    input: JSON.stringify({ scopeId: 'bindings:fixture', assemblyName: 'Bindings', files: [{ path: 'Bindings.cs', content, hash: contentHash(content) }] }), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  }));
}
const method = (r: AnalyzerResult, label: string) => r.nodes.find(n => n.kind === 'method' && n.label === label)!;
const parameter = (r: AnalyzerResult, owner: string, label: string) => r.nodes.find(n => n.kind === 'parameter' && n.parentId === method(r, owner).id && n.label === label)!;

test('Roslyn binds named value and callback arguments to exact source declaration parameters', () => {
  const r = analyze(`using System;
class Bindings {
  static void Route(int amount, Action done) { done?.Invoke(); }
  void Run(int value, Action callback) { Route(done: callback, amount: value); }
}`);
  for (const [actual, formal] of [['value', 'amount'], ['callback', 'done']]) {
    const edge = r.edges.find(e => e.kind === 'passes' && e.source === parameter(r, 'Run', actual).id && e.target === parameter(r, 'Route', formal).id);
    assert.equal(edge?.confidence, 'static-confirmed'); assert.ok(edge?.limitations?.some(item => item.includes('回调执行')));
    assert.ok(edge.evidenceIds.every(id => r.evidence.some(e => e.id === id && e.filePath === 'Bindings.cs' && e.excerpt?.includes(actual))));
  }
  assert.ok(r.edges.some(e => e.kind === 'references' && e.rule === 'csharp.delegate-invocation' && e.source === method(r, 'Route').id && e.target === parameter(r, 'Route', 'done').id));
  assert.ok(r.diagnostics.some(d => d.code === 'CS_DELEGATE_TARGETS'));
  assert.ok(!r.edges.some(e => e.kind === 'calls' && e.source === method(r, 'Route').id), 'the delegate invocation must not invent its runtime handler');
});

test('Roslyn retains callback lambda and method-group argument evidence without inventing invocation edges', () => {
  const r = analyze(`using System;
class Bindings {
  int Health;
  void Handle() { Health++; }
  static void Accept(Action callback) { callback(); }
  void Run() { Accept(Handle); Accept(() => Health--); }
}`);
  const formal = parameter(r, 'Accept', 'callback');
  const lambda = r.nodes.find(n => n.label === 'λ 回调')!;
  const handler = method(r, 'Handle');
  for (const actual of [lambda, handler]) assert.ok(r.edges.some(e => e.kind === 'passes' && e.source === actual.id && e.target === formal.id));
  assert.ok(!r.edges.some(e => e.kind === 'calls' && e.source === method(r, 'Accept').id && [lambda.id, handler.id].includes(e.target)));
  assert.ok(r.edges.filter(e => e.kind === 'passes').every(e => e.evidenceIds.length > 0));
});

test('Roslyn skips ambiguous data propagation through ref/out, expanded params, virtual calls and user conversions', () => {
  const r = analyze(`using System;
class Wrapped { public static implicit operator int(Wrapped value) => 1; }
class Bindings {
  static void Ref(ref int value) { value++; }
  static void Many(params int[] values) { }
  public virtual void Virtual(int value) { }
  static void Consume(int value) { }
  void Run(int value, Wrapped wrapped) { Ref(ref value); Many(value, value); Virtual(value); Consume(wrapped); Console.WriteLine(value); }
}`);
  assert.equal(r.edges.filter(e => e.kind === 'passes').length, 0);
  assert.ok(r.edges.some(e => e.kind === 'calls' && e.dispatch === 'virtual-declaration'));
});

test('Roslyn preserves event publication and represents delegate storage separately from unresolved syntax', () => {
  const r = analyze(`using System;
class Bindings {
  event Action Changed;
  Action Storage;
  void Fire(Action callback) { Action local = callback; callback(); local?.Invoke(); Storage?.Invoke(); Changed?.Invoke(); }
}`);
  assert.ok(r.edges.some(e => e.kind === 'publishes' && e.target === r.nodes.find(n => n.kind === 'event' && n.label === 'Changed')!.id));
  const storage = r.edges.filter(e => e.rule === 'csharp.delegate-invocation');
  assert.equal(storage.length, 3);
  assert.ok(storage.every(e => e.kind === 'references' && e.confidence === 'static-confirmed' && e.limitations?.length));
  const ids = new Set(r.nodes.map(n => n.id)), evidence = new Set(r.evidence.map(e => e.id));
  assert.ok(storage.every(e => ids.has(e.source) && ids.has(e.target) && e.evidenceIds.every(id => evidence.has(id))));
  assert.ok(!r.diagnostics.some(d => d.code === 'CS_UNRESOLVED_CALLS'));
});

test('Roslyn keeps a delegate returned by a factory unresolved instead of claiming a known storage binding', () => {
  const r = analyze(`using System;
class Bindings {
  Action Factory() => () => { };
  void Run() { Factory()(); }
}`);
  assert.ok(r.diagnostics.some(d => d.code === 'CS_UNRESOLVED_CALLS'));
  assert.ok(!r.edges.some(e => e.rule === 'csharp.delegate-invocation'));
  assert.ok(!r.edges.some(e => e.kind === 'calls' && e.target === r.nodes.find(n => n.label === 'λ 回调')?.id));
});

test('Roslyn isolates same-named local callback slots by procedure and lexical declaration', () => {
  const content = `using System;
class Bindings {
  static void Accept(Action callback) { callback(); }
  void One(Action first) { Action local=first; local(); Accept(local); }
  void Two(Action second) { Action local=second; local(); Accept(local); }
  void Blocks(Action third) { { Action local=third; local(); Accept(local); } { Action local=third; local(); Accept(local); } }
}`;
  const r = analyze(content), locals = r.nodes.filter(n => n.label === 'local');
  assert.equal(locals.length, 4);
  assert.equal(new Set(locals.map(n => n.id)).size, 4);
  for (const local of locals) {
    assert.ok(local.evidenceIds.length);
    assert.ok(r.edges.some(e => e.rule === 'csharp.delegate-invocation' && e.source === local.parentId && e.target === local.id));
    assert.ok(r.edges.some(e => e.kind === 'passes' && e.source === local.id && e.target === parameter(r, 'Accept', 'callback').id));
  }
  assert.equal(locals.filter(n => n.parentId === method(r, 'Blocks').id).length, 2);
  const shifted = analyze('\n\n' + content.replace('Action local=first;', 'int unrelated=0; Action local=first;'));
  assert.deepEqual(shifted.nodes.filter(n => n.label === 'local').map(n => n.id).sort(), locals.map(n => n.id).sort());
});

test('Roslyn leaves extension receiver and argument propagation outside the supported binding subset', () => {
  const r = analyze(`using System;
static class Extensions { public static void Accept(this int value, Action callback) { callback(); } }
class Bindings { void Run(int value, Action callback) { value.Accept(callback); Extensions.Accept(value, callback); } }`);
  assert.equal(r.edges.filter(e => e.kind === 'passes').length, 0);
  assert.ok(r.edges.some(e => e.kind === 'calls' && e.target === method(r, 'Accept').id));
});

test('Roslyn distinguishes normal and pattern locals with the same name in disjoint blocks', () => {
  const r = analyze(`using System;
class Bindings {
  void Run(Action third, object other) { { Action local=third; local(); } { if (other is Action local) local(); } }
}`);
  const locals = r.nodes.filter(n => n.label === 'local');
  assert.equal(locals.length, 2);
  assert.equal(r.edges.filter(e => e.rule === 'csharp.delegate-invocation').length, 2);
  assert.ok(locals.every(n => n.evidenceIds.length === 1));
});

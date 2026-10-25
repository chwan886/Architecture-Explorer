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

test('Roslyn isolates same-signature local functions across sibling and nested lexical blocks', () => {
  const content = `class Bindings {
  static void First(int value) { }
  static void Second(int value) { }
  static void Third(int value) { }
  void Run(bool first) {
    if (first) { void Local(int value) { First(value); } Local(1); }
    else {
      { void Local(int value) { Second(value); } Local(2); }
      { { void Local(int value) { Third(value); } Local(3); } }
    }
  }
}`;
  const identities = (r: AnalyzerResult) => {
    assert.ok(!r.diagnostics.some(d => /^CS_(?:SYNTAX_)?CS/.test(d.code)), JSON.stringify(r.diagnostics));
    const locals = r.nodes.filter(n => n.kind === 'function' && n.label === 'Local');
    assert.equal(locals.length, 3, 'separate lexical declarations must not become one procedure');
    const result = new Map<string, string>();
    for (const name of ['First', 'Second', 'Third']) {
      const calls = r.edges.filter(e => e.kind === 'calls' && e.target === method(r, name).id && locals.some(n => n.id === e.source));
      assert.equal(calls.length, 1);
      const local = locals.find(n => n.id === calls[0].source)!;
      assert.equal(local.evidenceIds.length, 1);
      assert.equal(r.edges.filter(e => e.kind === 'calls' && e.source === local.id).length, 1, 'local bodies must not share outgoing calls');
      assert.equal(r.nodes.filter(n => n.kind === 'parameter' && n.parentId === local.id).length, 1);
      assert.ok(r.edges.some(e => e.kind === 'calls' && e.source === method(r, 'Run').id && e.target === local.id));
      result.set(name, local.id);
    }
    assert.equal(new Set(result.values()).size, 3);
    return [...result].sort();
  };
  const before = identities(analyze(content));
  const shifted = '\n// A source-only line shift must not change identities.\n' + content.replace('    if (first)', '    int unrelated = 0;\n    void Other() { }\n    if (first)');
  assert.deepEqual(identities(analyze(shifted)), before);
});

test('Roslyn preserves direct and virtual dispatch to one declaration regardless of call order', () => {
  const analyzeCalls = (body: string) => analyze(`class BaseBinding { public virtual void Virtual() { } }
class Bindings : BaseBinding { void Run() { ${body} } }`);
  const facts = (r: AnalyzerResult) => {
    const calls = r.edges.filter(e => e.kind === 'calls' && e.source === method(r, 'Run').id && e.target === method(r, 'Virtual').id);
    assert.equal(calls.length, 2, 'direct base calls and virtual dispatch carry different facts');
    assert.deepEqual(new Set(calls.map(e => e.dispatch)), new Set(['direct', 'virtual-declaration']));
    for (const call of calls) {
      assert.equal(call.evidenceIds.length, 2, 'equivalent call sites may still share one edge');
      const excerpts = r.evidence.filter(e => call.evidenceIds.includes(e.id)).map(e => e.excerpt);
      assert.ok(excerpts.every(text => text === (call.dispatch === 'direct' ? 'base.Virtual()' : 'Virtual()')));
      if (call.dispatch === 'virtual-declaration') assert.ok(call.limitations?.some(text => text.includes('未确认')));
    }
    return calls.map(({ id, dispatch, confidence, limitations }) => ({ id, dispatch, confidence, limitations })).sort((a, b) => a.id.localeCompare(b.id));
  };
  assert.deepEqual(facts(analyzeCalls('base.Virtual(); base.Virtual(); Virtual(); Virtual();')),
    facts(analyzeCalls('Virtual(); Virtual(); base.Virtual(); base.Virtual();')));
});

test('Roslyn keeps confirmed writes separate from inferred ref writes regardless of statement order', () => {
  const analyzeWrites = (body: string) => analyze(`class Bindings {
  int Field;
  static void Mutate(ref int value) { }
  void Run() { ${body} }
}`);
  const facts = (r: AnalyzerResult) => {
    const field = r.nodes.find(n => n.kind === 'field' && n.label === 'Field')!;
    const writes = r.edges.filter(e => e.kind === 'writes' && e.source === method(r, 'Run').id && e.target === field.id);
    assert.equal(writes.length, 2, 'potential writes cannot borrow the confidence of direct assignments');
    assert.deepEqual(new Set(writes.map(e => e.confidence)), new Set(['static-confirmed', 'inferred']));
    assert.ok(writes.every(e => e.evidenceIds.length === 1));
    assert.ok(writes.find(e => e.confidence === 'inferred')!.limitations?.some(text => text.includes('未证明')));
    return writes.map(({ id, dispatch, confidence, limitations }) => ({ id, dispatch, confidence, limitations })).sort((a, b) => a.id.localeCompare(b.id));
  };
  assert.deepEqual(facts(analyzeWrites('Field = 1; Mutate(ref Field);')),
    facts(analyzeWrites('Mutate(ref Field); Field = 1;')));
});

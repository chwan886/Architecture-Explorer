import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { contentHash, stableId, type AnalyzerResult, type AnalyzerRequest } from '../packages/schema/src/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function request(paths: string[], scopeId = 'test:main'): AnalyzerRequest {
  return { scopeId, assemblyName: 'GoldenFixture', files: paths.map(path => {
    const content = readFileSync(resolve(root, 'tests/fixtures/analyzers', path), 'utf8');
    return { path, content, hash: contentHash(content) };
  }) };
}
function python(input: AnalyzerRequest): AnalyzerResult {
  return JSON.parse(execFileSync(process.env.EXPLORER_PYTHON ?? 'python', ['-B', resolve(root, 'analyzers/python/analyze.py')], {
    input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  }));
}
function csharp(input: AnalyzerRequest): AnalyzerResult {
  const local = resolve(root, '.tools/dotnet/dotnet.exe');
  const dotnet = process.env.EXPLORER_DOTNET ?? (existsSync(local) ? local : 'dotnet');
  return JSON.parse(execFileSync(dotnet, [resolve(root, 'analyzers/csharp/bin/Release/net10.0/ArchitectureExplorer.Analyzers.dll')], {
    input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  }));
}
function checkIntegrity(result: AnalyzerResult, input: AnalyzerRequest) {
  const nodes = new Map(result.nodes.map(n => [n.id, n]));
  const evidence = new Map(result.evidence.map(e => [e.id, e]));
  assert.equal(nodes.size, result.nodes.length);
  for (const edge of result.edges) {
    assert.ok(nodes.has(edge.source), `missing source for ${edge.kind}`);
    assert.ok(nodes.has(edge.target), `missing target for ${edge.kind}`);
    assert.ok(edge.evidenceIds.length > 0);
    for (const id of edge.evidenceIds) assert.ok(evidence.has(id));
  }
  for (const item of evidence.values()) {
    const source = input.files.find(f => f.path === item.filePath)!;
    assert.ok(source);
    assert.equal(item.fileHash, source.hash);
    assert.ok(item.startLine >= 1 && item.startColumn >= 1 && item.endLine >= item.startLine);
  }
  for (const file of input.files) assert.ok(nodes.has(stableId(input.scopeId, 'file', file.path)));
}

test('Python parses without executing targets; dictionary keys retain owner identity and UTF-16 evidence', () => {
  const input = request(['combat.py', 'helpers.py']);
  const result = python(input);
  checkIntegrity(result, input);
  assert.equal(process.env.EXPLORER_ANALYZER_EXECUTED_TARGET, undefined);
  const hp = result.nodes.filter(n => n.kind === 'data' && n.label.includes("['hp']"));
  assert.ok(hp.length >= 4);
  assert.equal(new Set(hp.map(n => n.parentId)).size, hp.length);
  const hurt = result.nodes.find(n => n.qualifiedName === 'combat.hurt')!;
  const reads = result.edges.filter(e => e.source === hurt.id && e.kind === 'reads');
  const writes = result.edges.filter(e => e.source === hurt.id && e.kind === 'writes');
  assert.ok(reads.some(r => writes.some(w => w.target === r.target)));
  assert.ok(writes.some(w => w.condition === 'amount > 0'));
  const line = input.files[0].content.split(/\r?\n/).findIndex(l => l.includes("label = '生命🙂'")) + 1;
  const ev = result.evidence.find(e => e.filePath === 'combat.py' && e.startLine === line && e.excerpt === "actor['hp']")!;
  assert.ok(ev);
  assert.equal(ev.startColumn, input.files[0].content.split(/\r?\n/)[line - 1].indexOf("actor['hp']") + 1);
});

test('Python confirms direct bindings, rejects redefinitions and dynamic/parameter calls, separates lambdas', () => {
  const result = python(request(['combat.py', 'helpers.py']));
  const caller = result.nodes.find(n => n.qualifiedName === 'helpers.caller')!;
  const definite = result.nodes.find(n => n.qualifiedName === 'helpers.definite')!;
  assert.ok(result.edges.some(e => e.source === caller.id && e.target === definite.id && e.kind === 'calls' && e.confidence === 'static-confirmed'));
  const health = result.nodes.find(n => n.qualifiedName === 'combat.health')!;
  assert.ok(!result.edges.some(e => e.target === health.id && e.kind === 'calls'));
  assert.ok(result.diagnostics.some(d => d.code === 'PY_DYNAMIC_CALLS'));
  assert.equal(result.nodes.filter(n => n.label.startsWith('lambda(')).length, 2);
});

test('Python syntax errors preserve other valid files; symbol IDs do not depend on line offsets', () => {
  const input = request(['helpers.py']);
  const before = python(input);
  const content = '\n\n' + input.files[0].content;
  const after = python({ ...input, files: [{ ...input.files[0], content, hash: contentHash(content) }, { path: 'broken.py', content: 'def !', hash: contentHash('def !') }] });
  assert.deepEqual(before.nodes.filter(n => n.kind === 'function').map(n => n.id).sort(), after.nodes.filter(n => n.kind === 'function').map(n => n.id).sort());
  assert.ok(after.diagnostics.some(d => d.code === 'PY_PARSE_ERROR'));
});

test('Python indexes functions declared inside conditional blocks and with scopes without executing them', () => {
  const content = 'def outer(value):\n    if value:\n        def inner():\n            return value\n    return inner()\n';
  const input: AnalyzerRequest = { scopeId: 'test:nested', files: [{ path: 'nested.py', content, hash: contentHash(content) }] };
  const result = python(input);
  checkIntegrity(result, input);
  assert.ok(result.nodes.some(n => n.qualifiedName === 'nested.outer.inner'));
});

test('Python import shadows are unresolved and distinct branch evidence is retained', () => {
  const source = `from helpers import definite
def shadow():
    result = definite(1)
    definite = unknown
    return result
def direct():
    return definite(1)
def guards(actor, flag):
    if flag:
        actor['hp'] = 1
    else:
        actor['hp'] = 2
`;
  const input = request(['helpers.py']);
  input.files.push({ path: 'bindings.py', content: source, hash: contentHash(source) });
  const result = python(input);
  checkIntegrity(result, input);
  const shadow = result.nodes.find(n => n.qualifiedName === 'bindings.shadow')!;
  const direct = result.nodes.find(n => n.qualifiedName === 'bindings.direct')!;
  assert.ok(!result.edges.some(e => e.source === shadow.id && e.kind === 'calls'));
  assert.ok(result.edges.some(e => e.source === direct.id && e.kind === 'calls' && e.confidence === 'inferred'));
  const guards = result.nodes.find(n => n.qualifiedName === 'bindings.guards')!;
  const writes = result.edges.filter(e => e.source === guards.id && e.kind === 'writes');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map(e => e.condition).sort(), ['flag', 'not (flag)'].sort());
});

test('Roslyn resolves overloads, partial types, conditional field access, events, lambdas and local functions', () => {
  const input = request(['Combat.cs', 'Combat.Partial.cs']);
  const result = csharp(input);
  checkIntegrity(result, input);
  const compilationIssues = result.diagnostics.filter(d => d.code.startsWith('CS_CS'));
  assert.equal(compilationIssues.length, 0, JSON.stringify(compilationIssues));
  const hero = result.nodes.filter(n => n.qualifiedName === 'Fixture.Hero');
  assert.equal(hero.length, 1);
  assert.equal(hero[0].evidenceIds.length, 2);
  const field = result.nodes.find(n => n.qualifiedName === 'Fixture.Hero.Health')!;
  const damage = result.nodes.find(n => n.qualifiedName === 'Fixture.Hero.Damage(int)')!;
  assert.ok(result.edges.some(e => e.source === damage.id && e.target === field.id && e.kind === 'reads'));
  assert.ok(result.edges.some(e => e.source === damage.id && e.target === field.id && e.kind === 'writes' && e.condition === 'amount > 0'));
  assert.ok(result.edges.some(e => e.kind === 'initializes' && e.target === field.id));
  assert.ok(result.edges.some(e => e.kind === 'publishes'));
  assert.ok(result.edges.some(e => e.kind === 'subscribes'));
  assert.ok(result.edges.some(e => e.kind === 'unsubscribes'));
  assert.ok(result.edges.some(e => e.rule === 'csharp.event-handler-binding'));
  assert.ok(result.nodes.some(n => n.label === 'λ 回调'));
  assert.ok(result.nodes.some(n => n.label === 'Apply'));
  const via = result.nodes.find(n => n.qualifiedName === 'Fixture.Hero.ViaInterface(Fixture.IDamageable)')!;
  assert.ok(result.edges.some(e => e.source === via.id && e.kind === 'calls' && e.dispatch === 'virtual-declaration' && e.limitations?.length));
  assert.ok(result.edges.some(e => e.kind === 'writes' && e.target === field.id && e.confidence === 'inferred'));
  const name = result.nodes.find(n => n.qualifiedName === 'Fixture.Hero.HealthName()')!;
  assert.ok(!result.edges.some(e => e.source === name.id && e.kind === 'reads' && e.target === field.id));
  assert.ok(result.edges.some(e => e.source === name.id && e.kind === 'references' && e.target === field.id));
  assert.ok(result.nodes.every(n => n.label.trim().length > 0));
  const tuple = result.nodes.find(n => n.qualifiedName === 'Fixture.Hero.TupleWrite()')!;
  assert.ok(result.edges.some(e => e.source === tuple.id && e.kind === 'writes' && e.target === field.id));
});

test('Roslyn missing Unity references are diagnosed without inventing a type or a call target', () => {
  const content = 'class Missing : UnityEngine.MonoBehaviour { void Run() { Nonexistent.Do(); } }';
  const input: AnalyzerRequest = { scopeId: 'test:missing', files: [{ path: 'Missing.cs', content, hash: contentHash(content) }] };
  const result = csharp(input);
  checkIntegrity(result, input);
  assert.ok(result.nodes.some(n => n.label === 'Missing'));
  assert.ok(result.diagnostics.some(d => d.code === 'CS_UNRESOLVED_CALLS'));
  assert.ok(result.diagnostics.some(d => d.code.startsWith('CS_CS')));
  assert.ok(!result.diagnostics.some(d => d.severity === 'error'));
  assert.ok(!result.nodes.some(n => n.label === 'MonoBehaviour'));
  assert.ok(!result.edges.some(e => e.kind === 'calls' || e.kind === 'inherits'));
});

test('Roslyn distinguishes actual syntax errors from missing semantic references', () => {
  const content = 'class Syntax { void Broken( { }';
  const input: AnalyzerRequest = { scopeId: 'test:syntax', files: [{ path: 'Syntax.cs', content, hash: contentHash(content) }] };
  const result = csharp(input);
  checkIntegrity(result, input);
  const syntaxErrors = result.diagnostics.filter(d => d.code.startsWith('CS_SYNTAX_'));
  assert.ok(syntaxErrors.length > 0);
  assert.ok(syntaxErrors.every(d => d.severity === 'error'));
  assert.ok(syntaxErrors.some(d => d.filePath === 'Syntax.cs' && d.line === 1));
});

test('Roslyn JSON pipes preserve Chinese source and UTF-16 columns', () => {
  const content = '\uFEFFclass 玩家 { int 生命 = 100; void 受伤() { string 文本 = "🙂"; 生命--; } }';
  const input: AnalyzerRequest = { scopeId: 'test:utf8', files: [{ path: '玩家.cs', content, hash: contentHash(content) }] };
  const result = csharp(input);
  checkIntegrity(result, input);
  assert.ok(result.nodes.some(n => n.label === '生命'));
  assert.equal(result.diagnostics.filter(d => d.code.startsWith('CS_CS')).length, 0);
  const edge = result.edges.find(e => e.kind === 'writes')!;
  const ev = result.evidence.find(e => edge.evidenceIds.includes(e.id))!;
  assert.equal(ev.startColumn, content.indexOf('生命--') + 1);
});

test('same-signature lambdas in different methods keep distinct parameters, owners and event bindings', () => {
  const content = `using System;
    class Lambdas {
      int Left, Right;
      event Action<int> Changed;
      void First() { Action<int> a = x => Left = x; Changed += x => Left = x; }
      void Second() { Action<int> a = x => Right = x; }
    }`;
  const input: AnalyzerRequest = { scopeId: 'test:lambdas', files: [{ path: 'Lambdas.cs', content, hash: contentHash(content) }] };
  const result = csharp(input);
  checkIntegrity(result, input);
  const lambdas = result.nodes.filter(n => n.label === 'λ 回调');
  assert.equal(lambdas.length, 3);
  const parameters = result.nodes.filter(n => n.kind === 'parameter' && n.label === 'x');
  assert.equal(parameters.length, 3);
  assert.equal(new Set(parameters.map(p => p.parentId)).size, 3);
  assert.ok(parameters.every(p => lambdas.some(l => l.id === p.parentId)));
  const second = result.nodes.find(n => n.qualifiedName === 'Lambdas.Second()')!;
  const secondLambda = lambdas.find(n => n.parentId === second.id)!;
  const right = result.nodes.find(n => n.qualifiedName === 'Lambdas.Right')!;
  const left = result.nodes.find(n => n.qualifiedName === 'Lambdas.Left')!;
  assert.ok(result.edges.some(e => e.source === secondLambda.id && e.target === right.id && e.kind === 'writes'));
  assert.ok(!result.edges.some(e => e.source === secondLambda.id && e.target === left.id && e.kind === 'writes'));
  assert.ok(result.edges.some(e => e.rule === 'csharp.event-handler-binding' && lambdas.some(l => l.id === e.target)));
});

test('persistent workers reuse unchanged ASTs and remove deleted files without stale symbols', () => {
  for (const language of ['python', 'csharp'] as const) {
    const initial = request(language === 'python' ? ['combat.py', 'helpers.py'] : ['Combat.cs', 'Combat.Partial.cs']);
    const content = '\n' + initial.files[0].content;
    const changed: AnalyzerRequest = { ...initial, files: [{ ...initial.files[0], content, hash: contentHash(content) }, initial.files[1]] };
    const deleted: AnalyzerRequest = { ...changed, files: [changed.files[0]] };
    const program = language === 'python' ? process.env.EXPLORER_PYTHON ?? 'python' : process.env.EXPLORER_DOTNET ?? resolve(root, '.tools/dotnet/dotnet.exe');
    const args = language === 'python' ? ['-B', resolve(root, 'analyzers/python/analyze.py'), '--persistent']
      : [resolve(root, 'analyzers/csharp/bin/Release/net10.0/ArchitectureExplorer.Analyzers.dll'), '--persistent'];
    const results: AnalyzerResult[] = execFileSync(program, args, {
      input: [initial, changed, deleted].map(r => JSON.stringify(r)).join('\n') + '\n',
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    }).trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(results.length, 3);
    assert.match(results[0].diagnostics.find(d => d.code === 'incremental-parser')!.message, /parsed=2; reused=0; removed=0/);
    assert.match(results[1].diagnostics.find(d => d.code === 'incremental-parser')!.message, /parsed=1; reused=1; removed=0/);
    assert.match(results[2].diagnostics.find(d => d.code === 'incremental-parser')!.message, /parsed=0; reused=1; removed=1/);
    assert.ok(!results[2].nodes.some(n => n.filePath === initial.files[1].path));
    assert.ok(!results[2].evidence.some(e => e.filePath === initial.files[1].path));
    checkIntegrity(results[2], deleted);
  }
});

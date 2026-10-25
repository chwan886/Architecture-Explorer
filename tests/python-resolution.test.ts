import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { contentHash, stableId, type AnalyzerResult, type ArchitectureEdge } from '../packages/schema/src/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function analyze(files: Record<string, string>): AnalyzerResult {
  const input = { scopeId: 'test:python-resolution', files: Object.entries(files).map(([path, content]) => ({ path, content, hash: contentHash(content) })) };
  const result: AnalyzerResult = JSON.parse(execFileSync(process.env.EXPLORER_PYTHON ?? 'python', ['-B', resolve(root, 'analyzers/python/analyze.py')], {
    input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  }));
  assert.ok(!result.diagnostics.some(d => d.severity === 'error'), JSON.stringify(result.diagnostics));
  const ids = new Set(result.nodes.map(n => n.id));
  const evidence = new Map(result.evidence.map(e => [e.id, e]));
  for (const edge of result.edges) {
    assert.ok(ids.has(edge.source) && ids.has(edge.target), `dangling ${edge.rule}`);
    assert.ok(edge.evidenceIds.length > 0);
    for (const id of edge.evidenceIds) {
      const item = evidence.get(id)!;
      assert.ok(item && files[item.filePath] !== undefined);
      assert.equal(item.fileHash, contentHash(files[item.filePath]));
      assert.ok(item.startLine > 0 && item.startColumn > 0);
    }
  }
  return result;
}
function edges(result: AnalyzerResult, kind: ArchitectureEdge['kind']): Array<ArchitectureEdge & { from: string; to: string }> {
  const names = new Map(result.nodes.map(n => [n.id, n.qualifiedName]));
  return result.edges.filter(e => e.kind === kind).map(e => ({ ...e, from: names.get(e.source)!, to: names.get(e.target)! }));
}

test('Python records explicit local/callback argument-to-parameter bindings without inventing callback calls', () => {
  const result = analyze({ 'combat.py': `raise RuntimeError('never execute indexed source')
def contact_step(victim, on_hit):
    if victim:
        return on_hit(victim)
def advance(victim, on_hit):
    contact_step(victim, on_hit)
def step(victim):
    def projectile_hit(value):
        return value
    advance(victim, projectile_hit)
` });
  const passes = edges(result, 'passes');
  const callback = passes.find(e => e.from === 'combat.step.projectile_hit' && e.to === 'combat.advance.on_hit')!;
  assert.equal(callback.confidence, 'static-confirmed');
  assert.equal(callback.dispatch, 'argument:on_hit');
  assert.ok(callback.limitations?.some(text => text.includes('回调已执行')));
  assert.ok(passes.some(e => e.from === 'combat.advance.on_hit' && e.to === 'combat.contact_step.on_hit'));
  const calls = edges(result, 'calls');
  assert.ok(calls.some(e => e.from === 'combat.advance' && e.to === 'combat.contact_step'));
  assert.ok(!calls.some(e => e.to === 'combat.step.projectile_hit'));
  assert.ok(result.diagnostics.some(d => d.code === 'PY_DYNAMIC_CALLS' && d.message.includes('on_hit')));
  const item = result.evidence.find(e => callback.evidenceIds.includes(e.id))!;
  assert.equal(item.startLine, 10);
  assert.equal(item.excerpt, 'projectile_hit');
});

test('Python retains inferred import roots for calls and parameter bindings, including imported callbacks', () => {
  const result = analyze({
    'Server/combat.py': `import projectiles
def step(victim):
    def projectile_hit(value):
        return value
    projectiles.advance(victim, projectile_hit)
`,
    'Server/projectiles.py': 'def advance(victim, on_hit):\n    return on_hit(victim)\n',
  });
  const call = edges(result, 'calls').find(e => e.from === 'Server.combat.step')!;
  assert.equal(call.to, 'Server.projectiles.advance');
  assert.equal(call.confidence, 'inferred');
  const callback = edges(result, 'passes').find(e => e.from.endsWith('.projectile_hit'))!;
  assert.equal(callback.to, 'Server.projectiles.advance.on_hit');
  assert.equal(callback.confidence, 'inferred');
  assert.ok(callback.limitations?.some(text => text.includes('候选')));
  assert.ok(edges(result, 'imports').every(e => e.confidence === 'inferred'));
  assert.ok(!edges(result, 'calls').some(e => e.to.endsWith('.projectile_hit')));
});

test('Python maps positional-only, named keyword, defaults and keyword-only parameters precisely', () => {
  const result = analyze({ 'args.py': `def sink(first, /, second=None, *, handler, optional=None):
    return first
def callback(value):
    return value
def good(value):
    sink(value, handler=callback)
def reordered(value):
    sink(value, handler=callback, second=value)
` });
  const passes = edges(result, 'passes');
  assert.ok(passes.some(e => e.from === 'args.good.value' && e.to === 'args.sink.first'));
  assert.ok(passes.some(e => e.from === 'args.reordered.value' && e.to === 'args.sink.second'));
  assert.ok(passes.some(e => e.from === 'args.callback' && e.to === 'args.sink.handler'));
  assert.ok(!passes.some(e => e.to === 'args.sink.optional'));
});

test('Python rejects unpacked, duplicate, missing and illegal argument bindings instead of guessing positions', () => {
  const result = analyze({ 'invalid.py': `def sink(value, /, second, *, handler):
    return value
def callback(value):
    return value
def caller(value, args, options):
    sink(*args, handler=callback)
    sink(value, value, **options)
    sink(value, value, second=value, handler=callback)
    sink(value=value, second=value, handler=callback)
    sink(value, handler=callback)
    sink(value, value, value, handler=callback)
    sink(value, value, missing=value, handler=callback)
` });
  assert.equal(edges(result, 'passes').length, 0);
  assert.ok(edges(result, 'calls').length > 0, 'call syntax and valid argument binding are separate facts');
});

test('Python does not turn parameter shadows, rebound aliases or multiple callback candidates into function targets', () => {
  const result = analyze({ 'shadows.py': `def callback(value):
    return value
def alternative(value):
    return value
def sink(handler):
    return handler(1)
def parameter(callback):
    sink(callback)
def rebound(flag):
    callback = alternative
    sink(callback)
def selected(flag):
    choice = callback if flag else alternative
    sink(choice)
def rebound_callee(value):
    sink(value)
    sink = callback
` });
  const passes = edges(result, 'passes');
  assert.ok(passes.some(e => e.from === 'shadows.parameter.callback' && e.to === 'shadows.sink.handler'));
  assert.ok(passes.some(e => e.from === 'shadows.selected.choice' && e.to === 'shadows.sink.handler'));
  assert.ok(!passes.some(e => ['shadows.callback', 'shadows.alternative'].includes(e.from)));
  assert.ok(!edges(result, 'calls').some(e => e.from === 'shadows.rebound_callee'));
  assert.ok(!passes.some(e => e.from === 'shadows.rebound_callee.value'));
});

test('Python skips decorated callees and decorated callback values without discarding visible call candidates', () => {
  const result = analyze({ 'decorators.py': `@external
def sink(value):
    return value
@external
def callback(value):
    return value
def plain(handler):
    return handler(1)
def caller(value):
    sink(value)
    plain(callback)
` });
  assert.equal(edges(result, 'passes').length, 0);
  const call = edges(result, 'calls').find(e => e.to === 'decorators.sink')!;
  assert.equal(call.confidence, 'inferred');
  assert.ok(call.limitations?.some(text => text.includes('装饰器')));
});

test('Python dotted imports require the complete attribute path and respect explicit aliases', () => {
  const result = analyze({
    'pkg/__init__.py': 'def run(value):\n    return value\n',
    'pkg/worker.py': 'def run(value):\n    return value\n',
    'plain.py': `import pkg.worker
def good(value):
    pkg.worker.run(value)
def incorrect(value):
    pkg.run(value)
`,
    'alias.py': `import pkg.worker as worker
def good(value):
    worker.run(value)
def incorrect(value):
    worker.worker.run(value)
`,
  });
  const calls = edges(result, 'calls');
  assert.ok(calls.some(e => e.from === 'plain.good' && e.to === 'pkg.worker.run'));
  assert.ok(calls.some(e => e.from === 'alias.good' && e.to === 'pkg.worker.run'));
  assert.ok(!calls.some(e => e.from.endsWith('.incorrect')));
});

test('Python module attribute calls reject later local root assignments and unresolved local imports', () => {
  const result = analyze({
    'worker.py': 'def run(value):\n    return value\n',
    'client.py': `import worker as module
def later_assignment(value):
    module.run(value)
    module = unknown
def parameter(module, value):
    module.run(value)
def local_unresolved_import(value):
    import absent as module
    module.run(value)
def local_unresolved_from(value):
    from absent import worker as module
    module.run(value)
def valid(value):
    module.run(value)
`,
  });
  const calls = edges(result, 'calls');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].from, 'client.valid');
  assert.equal(calls[0].to, 'worker.run');
});

test('Python absolute import roots stay unresolved if more than one indexed module can match', () => {
  const result = analyze({
    'worker.py': 'def run(value):\n    return value\n',
    'Server/worker.py': 'def run(value):\n    return value\n',
    'Server/client.py': 'from worker import run\ndef caller(value):\n    return run(value)\n',
  });
  assert.equal(edges(result, 'calls').length, 0);
  assert.equal(edges(result, 'imports').length, 0);
  assert.equal(edges(result, 'passes').length, 0);
});

test('Python relative imports resolve from __init__ and ancestors, never by unrelated suffix fallback', () => {
  const result = analyze({
    'pkg/__init__.py': 'from .worker import run\ndef caller(value):\n    return run(value)\n',
    'pkg/worker.py': 'def run(value):\n    return value\n',
    'pkg/sub/__init__.py': '',
    'pkg/sub/client.py': 'from ..worker import run\ndef caller(value):\n    return run(value)\n',
    'pkg/sub/failed.py': 'from .worker import run\ndef caller(value):\n    return run(value)\n',
    'other/worker.py': 'def run(value):\n    return value\n',
    'outside.py': 'from ..worker import run\ndef caller(value):\n    return run(value)\n',
  });
  const calls = edges(result, 'calls');
  assert.deepEqual(calls.map(e => e.from).sort(), ['pkg.caller', 'pkg.sub.client.caller']);
  assert.ok(calls.every(e => e.to === 'pkg.worker.run' && e.confidence === 'inferred'));
  assert.ok(edges(result, 'imports').every(e => e.confidence === 'static-confirmed'));
});

test('Python relative from-package child aliases retain module identity without guessing a similarly named callable', () => {
  const result = analyze({
    'pkg/__init__.py': '',
    'pkg/worker.py': 'def run(value):\n    return value\n',
    'pkg/client.py': 'from . import worker as work\ndef caller(value):\n    return work.run(value)\n',
  });
  assert.ok(edges(result, 'calls').some(e => e.from === 'pkg.client.caller' && e.to === 'pkg.worker.run'));
  assert.ok(edges(result, 'passes').some(e => e.from === 'pkg.client.caller.value' && e.to === 'pkg.worker.run.value'));
});

test('Python parameter IDs remain stable across declaration and call-site line shifts', () => {
  const content = 'def sink(value):\n    return value\ndef caller(value):\n    return sink(value)\n';
  const before = analyze({ 'stable.py': content });
  const after = analyze({ 'stable.py': '\n\n' + content });
  const parameter = before.nodes.find(n => n.qualifiedName === 'stable.sink.value')!;
  const expected = stableId('test:python-resolution', 'symbol', `python|${before.nodes.find(n => n.qualifiedName === 'stable.sink')!.id}|parameter|value`);
  assert.equal(parameter.id, expected);
  assert.equal(after.nodes.find(n => n.qualifiedName === 'stable.sink.value')!.id, parameter.id);
  assert.deepEqual(edges(before, 'passes').map(e => e.id), edges(after, 'passes').map(e => e.id));
});

test('Python nested functions and lambdas do not replace captured outer shadows with global targets', () => {
  const result = analyze({ 'closures.py': `def callback(value):
    return value
def sink(handler):
    return handler(1)
def parameter(callback):
    def inner(value):
        callback(value)
        sink(callback)
    return inner
def later_assignment():
    def inner(value):
        callback(value)
        sink(callback)
    pending = lambda value: callback(value)
    callback = unknown
    return inner, pending
def valid(value):
    callback(value)
` });
  assert.deepEqual(edges(result, 'calls').filter(e => e.to === 'closures.callback').map(e => e.from), ['closures.valid']);
  assert.ok(!edges(result, 'passes').some(e => e.from === 'closures.callback'));
});

test('Python exception and pattern captures shadow imported module roots', () => {
  const result = analyze({
    'worker.py': 'def run(value):\n    return value\n',
    'captures.py': `import worker as module
def exception(value):
    try:
        external()
    except Exception as module:
        module.run(value)
def pattern(value):
    match value:
        case {'module': module}:
            module.run(value)
`,
  });
  assert.equal(edges(result, 'calls').length, 0);
  assert.equal(edges(result, 'passes').length, 0);
});

test('Python wildcard imports do not silently preserve unrelated global callable identities', () => {
  const result = analyze({ 'wildcard.py': `def callback(value):
    return value
from absent import *
def caller(value):
    return callback(value)
` });
  assert.equal(edges(result, 'calls').length, 0);
  assert.equal(edges(result, 'passes').length, 0);
});

test('Python imported function rebindings and explicit module-attribute mutation invalidate signature candidates', () => {
  const result = analyze({
    'worker.py': 'def run(value):\n    return value\nrun = external\n',
    'stable.py': 'def run(value):\n    return value\n',
    'client.py': `from worker import run
import worker
import stable
def from_import(value):
    run(value)
def module_import(value):
    worker.run(value)
def attribute_mutation(value):
    stable.run(value)
    stable.run = external
`,
  });
  assert.equal(edges(result, 'calls').length, 0);
  assert.equal(edges(result, 'passes').length, 0);
});

test('Python class headers resolve and evaluate in the containing scope before class members exist', () => {
  const result = analyze({ 'headers.py': `class Base:
    pass

def create_base(value):
    return value

def create_meta(value):
    return type

def decorate(value):
    return value

@decorate(Base)
class Derived(Base, metaclass=create_meta(Base)):
    def Base(self):
        return self

class Factory(create_base(Base)):
    def create_base(self):
        return self

def build(Base):
    class Nested(Base):
        def Base(self):
            return self
    return Nested
` });
  const inheritance = edges(result, 'inherits');
  assert.ok(inheritance.some(edge => edge.from === 'headers.Derived' && edge.to === 'headers.Base' && edge.confidence === 'static-confirmed'));
  assert.ok(!inheritance.some(edge => edge.to === 'headers.Derived.Base' || edge.to === 'headers.build.Nested.Base'));
  assert.ok(!inheritance.some(edge => edge.from === 'headers.Factory'), 'a factory call does not prove the returned base type');
  const calls = edges(result, 'calls');
  for (const target of ['headers.decorate', 'headers.create_meta', 'headers.create_base']) {
    assert.ok(calls.some(edge => edge.from === 'headers' && edge.to === target), `${target} executes as a class header in the file scope`);
  }
  assert.ok(edges(result, 'reads').some(edge => edge.from === 'headers.build' && edge.to === 'headers.build.Base'), 'a nested class header reads the enclosing parameter');
});

test('Python methods and class lambdas skip class imports while retaining module and enclosing-function imports', () => {
  const result = analyze({
    'worker.py': 'def run(value):\n    return value\n',
    'other.py': 'def run(value):\n    return value\n',
    'scopes.py': `import worker as module_alias
from worker import run as module_run
import other as shared

class OnlyClass:
    import worker as class_alias
    from worker import run as class_run
    import worker as shared
    class_alias.run(None)

    def method(value):
        class_alias.run(value)
        class_run(value)
        module_alias.run(value)
        module_run(value)
        shared.run(value)

    def rebound(value):
        module_alias.run(value)
        module_alias = unknown

    shortcut = lambda value: class_alias.run(value)
    def class_callable(value):
        return value
    callable_shortcut = lambda value: class_callable(value)

def enclosing():
    import worker as closure_alias
    from worker import run as closure_run
    class Nested:
        import other as closure_alias
        from other import run as closure_run
        closure_alias.run(None)

        def method(value):
            closure_alias.run(value)
            closure_run(value)

    def direct(value):
        closure_alias.run(value)
        closure_run(value)
    return Nested, direct
`,
  });
  const calls = edges(result, 'calls');
  assert.equal(calls.filter(edge => edge.from === 'scopes.OnlyClass.method' && edge.to === 'worker.run').length, 1, 'only the two module imports may merge into this target');
  assert.ok(calls.some(edge => edge.from === 'scopes.OnlyClass.method' && edge.to === 'other.run'), 'class rebinding does not hide the module alias from methods');
  assert.equal(calls.find(edge => edge.from === 'scopes.OnlyClass.method' && edge.to === 'worker.run')!.evidenceIds.length, 2, 'class-local aliases contribute no method call evidence');
  assert.ok(!calls.some(edge => edge.from === 'scopes.OnlyClass.rebound' || edge.from.includes('.lambda(')));
  assert.ok(calls.some(edge => edge.from === 'scopes.OnlyClass' && edge.to === 'worker.run'), 'class body imports are visible in the class body');
  assert.ok(calls.some(edge => edge.from === 'scopes.enclosing.Nested' && edge.to === 'other.run'));
  for (const owner of ['scopes.enclosing.Nested.method', 'scopes.enclosing.direct']) {
    const call = calls.find(edge => edge.from === owner && edge.to === 'worker.run');
    assert.ok(call, owner);
    assert.equal(call.evidenceIds.length, 2);
    assert.ok(!calls.some(edge => edge.from === owner && edge.to === 'other.run'));
  }
});

test('Python colliding module/package names retain each file and its facts without selecting an import candidate', () => {
  const files = {
    'pkg.py': `def helper(value):
    return value

def same(value):
    value['module'] = value['input']
    return helper(value)
`,
    'pkg/__init__.py': `def helper(value):
    return value

def same(value):
    value['package'] = value['input']
    return helper(value)
`,
    'client.py': 'import pkg\nfrom pkg import same\ndef caller(value):\n    pkg.same(value)\n    same(value)\n',
    'pkg/client.py': 'from . import same\ndef caller(value):\n    return same(value)\n',
  };
  const result = analyze(files);
  const reversed = analyze(Object.fromEntries(Object.entries(files).reverse()));
  assert.deepEqual(result, reversed, 'input order does not change declaration identity, facts or ambiguity');
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'PY_AMBIGUOUS_MODULE' && diagnostic.message.includes('pkg.py') && diagnostic.message.includes('pkg/__init__.py')));
  const nodes = new Map(result.nodes.map(node => [node.id, node]));
  for (const file of ['pkg.py', 'pkg/__init__.py']) {
    const same = result.nodes.filter(node => node.qualifiedName === 'pkg.same' && node.filePath === file);
    assert.equal(same.length, 1, `${file} has its own same declaration`);
    const call = result.edges.find(edge => edge.kind === 'calls' && edge.source === same[0].id);
    assert.ok(call, `${file} AST was visited`);
    assert.equal(nodes.get(call.target)!.qualifiedName, 'pkg.helper');
    assert.equal(nodes.get(call.target)!.filePath, file);
    assert.ok(result.edges.some(edge => edge.kind === 'reads' && edge.source === same[0].id));
    assert.ok(result.edges.some(edge => edge.kind === 'writes' && edge.source === same[0].id));
  }
  assert.equal(result.nodes.filter(node => node.qualifiedName === 'pkg.same').length, 2, 'colliding qualified names do not merge nodes');
  const callers = new Set(result.nodes.filter(node => node.filePath === 'client.py' || node.filePath === 'pkg/client.py').map(node => node.id));
  assert.ok(!result.edges.some(edge => callers.has(edge.source) && ['imports', 'calls', 'passes'].includes(edge.kind)), 'neither absolute nor relative imports choose an ambiguous module');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, symlink, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { IndexManager, loadConfig, TOOL_ROOT, createFilePolicy, readAuthorized, discoverWorktrees, graph, nodeDetail, search } from '../packages/indexer/src/index.ts';
import { contentHash, stableId, type AnalyzerRequest, type AnalyzerResult, type ArchitectureIndex } from '../packages/schema/src/index.ts';
import { createServer } from '../apps/server/src/server.ts';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { IndexStatus } from '../packages/schema/src/index.ts';

const exec = promisify(execFile);
async function fixture() {
  const temporaryRoot = path.join(TOOL_ROOT, '.tmp'); await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(path.join(temporaryRoot, 'indexer-test-')); const root = path.join(directory, 'target');
  await mkdir(root); await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'Library'));
  await writeFile(path.join(root, 'src/a.py'), 'value = 1\n'); await writeFile(path.join(root, 'src/b.py'), 'from a import value\n');
  await writeFile(path.join(root, 'src/Actor.cs'), 'class Actor { public int Health; }\n');
  await writeFile(path.join(root, 'Library/ignored.py'), 'ignored = True\n');
  const configPath = path.join(directory, 'projects.json');
  await writeFile(configPath, JSON.stringify({ projects: [{ id: 'fixture', name: '工具测试夹具', root: './target', include: ['src'], exclude: ['Library'] }], cacheDir: './cache', port: 4310 }));
  const config = await loadConfig(configPath);
  const cleanup = async () => {
    assert.ok(directory.startsWith(path.join(TOOL_ROOT, '.tmp', 'indexer-test-')));
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  };
  return { directory, root, configPath, config, cleanup };
}
const emptyWorker = async (): Promise<AnalyzerResult> => ({ nodes: [], edges: [], evidence: [], diagnostics: [] });

test('目录和 glob include/exclude 只匹配明确扫描范围', () => {
  const policy = createFilePolicy(['Assets/Game', 'Server/**/*.py'], ['**/Tests/**', 'Art']);
  assert.equal(policy.included('Assets/Game/Presentation/Actor.cs'), true);
  assert.equal(policy.included('Server/sect_combat.py'), true);
  assert.equal(policy.included('Server/nested/module.py'), true);
  assert.equal(policy.included('Assets/Game/Tests/X.cs'), false);
  assert.equal(policy.included('Art/source.py'), false);
  assert.equal(policy.ignored('Assets/Game/Library', true), true);
  assert.equal(policy.included('Assets/Elsewhere/Actor.cs'), false);
});

test('只读源码边界阻止绝对路径、父目录和 Windows 路径', async () => {
  const item = await fixture();
  try {
    assert.equal((await readAuthorized(item.root, 'src/a.py')).toString(), 'value = 1\n');
    for (const unsafe of ['../projects.json', '/projects.json', 'C:/Windows/a.py', 'src\\a.py', 'src/../a.py', 'src//a.py']) {
      await assert.rejects(readAuthorized(item.root, unsafe));
    }
  } finally { await item.cleanup(); }
});

test('NTFS junction／符号链接不能绕过源码目录边界', async t => {
  const item = await fixture();
  try {
    const outside = path.join(item.directory, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'secret.py'), 'must_not_read');
    try { await symlink(outside, path.join(item.root, 'junction'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('当前 Windows 沙箱禁止创建 junction；此项必须在允许创建链接的环境补验'); return; }
      throw error;
    }
    await assert.rejects(readAuthorized(item.root, 'junction/secret.py'), /链接|联接/);
    const unsafeCache = path.join(item.root, 'junction', 'unexpected-cache');
    const config = { ...item.config, cacheDir: unsafeCache };
    const manager = new IndexManager(config, { worker: emptyWorker });
    try { await assert.rejects(manager.initialize(), /链接|联接|目标仓库/); }
    finally { await manager.close(); }
    await assert.rejects(access(path.join(outside, 'unexpected-cache')));
  } finally { await item.cleanup(); }
});

test('配置拒绝向目标仓库写缓存，并解析相对可执行文件路径', async () => {
  const item = await fixture();
  try {
    const config = JSON.parse(await readFile(item.configPath, 'utf8'));
    config.dotnet = '../runtime/dotnet.exe'; await writeFile(item.configPath, JSON.stringify(config));
    assert.equal((await loadConfig(item.configPath)).dotnet, path.resolve(item.directory, '../runtime/dotnet.exe'));
    await writeFile(item.configPath, '\uFEFF' + JSON.stringify(config));
    assert.equal((await loadConfig(item.configPath)).projects[0].id, 'fixture');
    config.cacheDir = './target/cache'; await writeFile(item.configPath, JSON.stringify(config));
    await assert.rejects(loadConfig(item.configPath), /缓存不能/);
  } finally { await item.cleanup(); }
});

test('新增、修改、删除、移动触发哈希失效，未变语言复用有效分析结果', async () => {
  const item = await fixture(); const calls = { python: 0, csharp: 0 };
  const manager = new IndexManager(item.config, { worker: async language => { calls[language]++; return emptyWorker(); } });
  try {
    await manager.initialize(); await manager.requestScan('fixture:primary');
    const scope = manager.scope('fixture:primary'); assert.equal(scope.status.state, 'synced'); assert.equal(scope.index?.files.length, 3);
    assert.deepEqual(calls, { python: 1, csharp: 1 });
    const first = scope.index!.metadata.revision; await manager.requestScan(scope.id);
    assert.equal(scope.index!.metadata.revision, first); assert.deepEqual(calls, { python: 1, csharp: 1 });
    await writeFile(path.join(item.root, 'src/a.py'), 'value = 2\n'); await manager.requestScan(scope.id);
    assert.deepEqual(calls, { python: 2, csharp: 1 }); assert.notEqual(scope.index!.metadata.revision, first);
    assert.equal(scope.index!.metadata.changedFiles, 1); assert.equal(scope.index!.metadata.reusedFiles, 2);
    await writeFile(path.join(item.root, 'src/new.py'), 'created = True\n'); await manager.requestScan(scope.id);
    assert.ok(scope.index!.files.some(file => file.path === 'src/new.py'));
    await rename(path.join(item.root, 'src/new.py'), path.join(item.root, 'src/moved.py')); await manager.requestScan(scope.id);
    assert.ok(!scope.index!.files.some(file => file.path === 'src/new.py')); assert.ok(scope.index!.files.some(file => file.path === 'src/moved.py'));
    await rm(path.join(item.root, 'src/moved.py')); await manager.requestScan(scope.id);
    assert.ok(!scope.index!.nodes.some(node => node.filePath === 'src/moved.py'));
    assert.equal((await manager.verify(scope.id)).valid, true);
  } finally { await manager.close(); await item.cleanup(); }
});

test('失败保留内存与磁盘 lastgood，恢复后才发布新 revision', async () => {
  const item = await fixture(); let fail = false;
  const manager = new IndexManager(item.config, { worker: async () => { if (fail) throw new Error('fixture-parser-error'); return emptyWorker(); } });
  try {
    await manager.initialize(); await manager.requestScan('fixture:primary'); const scope = manager.scope('fixture:primary');
    const original = scope.index!; const cached = await readFile(path.join(scope.cachePath, 'lastgood.json'), 'utf8');
    fail = true; await writeFile(path.join(item.root, 'src/a.py'), 'broken = [\n'); await manager.requestScan(scope.id);
    assert.equal(scope.status.state, 'failed'); assert.match(scope.status.message, /fixture-parser-error/); assert.equal(scope.index, original);
    assert.equal(await readFile(path.join(scope.cachePath, 'lastgood.json'), 'utf8'), cached);
    fail = false; await writeFile(path.join(item.root, 'src/a.py'), 'fixed = True\n'); await manager.requestScan(scope.id);
    assert.equal(scope.status.state, 'synced'); assert.notEqual(scope.index!.metadata.revision, original.metadata.revision);
  } finally { await manager.close(); await item.cleanup(); }
});

test('持久分析池只重解析变化文件，删除失效，完整扫描重置解析缓存', { timeout: 60000 }, async () => {
  const item = await fixture();
  const localDotnet = path.join(TOOL_ROOT, '.tools/dotnet/dotnet.exe');
  item.config.dotnet = process.env.EXPLORER_DOTNET ?? (existsSync(localDotnet) ? localDotnet : 'dotnet');
  item.config.python = process.env.EXPLORER_PYTHON ?? 'python';
  await writeFile(path.join(item.root, 'src/Other.cs'), 'class Other { public Actor Owner; }\n');
  const manager = new IndexManager(item.config);
  const stats = (language: string) => manager.scope('fixture:primary').index!.diagnostics.find(d => d.code === 'incremental-parser' && d.message.includes(language))?.message;
  try {
    await manager.initialize(); await manager.requestScan('fixture:primary');
    assert.equal(manager.scope('fixture:primary').status.state, 'synced');
    assert.match(stats('Python') ?? '', /parsed=2; reused=0/); assert.match(stats('C#') ?? '', /parsed=2; reused=0/);
    await writeFile(path.join(item.root, 'src/a.py'), 'value = 3\n');
    await writeFile(path.join(item.root, 'src/Actor.cs'), 'class Actor { public long Health; }\n');
    await manager.requestScan('fixture:primary');
    assert.match(stats('Python') ?? '', /parsed=1; reused=1/); assert.match(stats('C#') ?? '', /parsed=1; reused=1/);
    await rm(path.join(item.root, 'src/b.py')); await rm(path.join(item.root, 'src/Other.cs'));
    await manager.requestScan('fixture:primary');
    assert.match(stats('Python') ?? '', /parsed=0; reused=1; removed=1/); assert.match(stats('C#') ?? '', /parsed=0; reused=1; removed=1/);
    const index = manager.scope('fixture:primary').index!;
    assert.ok(!index.nodes.some(node => node.filePath === 'src/b.py' || node.filePath === 'src/Other.cs'));
    assert.ok(!index.evidence.some(evidence => evidence.filePath === 'src/b.py' || evidence.filePath === 'src/Other.cs'));
    await manager.requestScan('fixture:primary', true);
    assert.match(stats('Python') ?? '', /parsed=1; reused=0/); assert.match(stats('C#') ?? '', /parsed=1; reused=0/);
  } finally { await manager.close(); await item.cleanup(); }
});

test('真实持久 Python／C# Worker 语法错误不能覆盖 lastgood，修复后恢复同步', { timeout: 60000 }, async () => {
  const item = await fixture();
  item.config.dotnet = process.env.EXPLORER_DOTNET ?? (existsSync(path.join(TOOL_ROOT, '.tools/dotnet/dotnet.exe')) ? path.join(TOOL_ROOT, '.tools/dotnet/dotnet.exe') : 'dotnet');
  item.config.python = process.env.EXPLORER_PYTHON ?? 'python';
  const manager = new IndexManager(item.config);
  try {
    await manager.initialize(); await manager.requestScan('fixture:primary'); const scope = manager.scope('fixture:primary');
    assert.equal(scope.status.state, 'synced'); const good = scope.index!;
    const disk = await readFile(path.join(scope.cachePath, 'lastgood.json'), 'utf8');
    await writeFile(path.join(item.root, 'src/a.py'), 'def !\n'); await manager.requestScan(scope.id);
    assert.equal(scope.status.state, 'failed'); assert.match(scope.status.message, /PY_PARSE_ERROR/);
    assert.equal(scope.index, good); assert.equal(scope.status.revision, good.metadata.revision);
    assert.ok(scope.failureDiagnostics.some(diagnostic => diagnostic.code === 'PY_PARSE_ERROR'));
    assert.equal(await readFile(path.join(scope.cachePath, 'lastgood.json'), 'utf8'), disk);
    await writeFile(path.join(item.root, 'src/a.py'), 'value = 42\n'); await manager.requestScan(scope.id);
    assert.equal(scope.status.state, 'synced'); assert.notEqual(scope.index!.metadata.revision, good.metadata.revision);
    assert.equal(scope.failureDiagnostics.length, 0);
    const secondGood = scope.index!; const secondDisk = await readFile(path.join(scope.cachePath, 'lastgood.json'), 'utf8');
    await writeFile(path.join(item.root, 'src/Actor.cs'), 'class {\n'); await manager.requestScan(scope.id);
    assert.equal(scope.status.state, 'failed'); assert.match(scope.status.message, /CS_SYNTAX_/);
    assert.equal(scope.index, secondGood); assert.equal(await readFile(path.join(scope.cachePath, 'lastgood.json'), 'utf8'), secondDisk);
    await writeFile(path.join(item.root, 'src/Actor.cs'), 'class Actor { public int Health = 10; }\n'); await manager.requestScan(scope.id);
    assert.equal(scope.status.state, 'synced'); assert.notEqual(scope.index!.metadata.revision, secondGood.metadata.revision);
    assert.equal(scope.failureDiagnostics.length, 0);
  } finally { await manager.close(); await item.cleanup(); }
});

test('两个独立 manager 同时扫描同 scope 时由缓存文件锁阻止并发写入', async () => {
  const item = await fixture(); let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const first = new IndexManager(item.config, { worker: async () => { entered(); await gate; return emptyWorker(); } });
  const second = new IndexManager(item.config, { worker: emptyWorker });
  try {
    await first.initialize(); await second.initialize();
    const pending = first.requestScan('fixture:primary'); await started;
    await second.requestScan('fixture:primary'); assert.equal(second.scope('fixture:primary').status.state, 'failed');
    assert.match(second.scope('fixture:primary').status.message, /其他扫描进程/);
    release(); await pending; assert.equal(first.scope('fixture:primary').status.state, 'synced');
    await second.requestScan('fixture:primary'); assert.equal(second.scope('fixture:primary').status.state, 'synced');
    const cached = JSON.parse(await readFile(path.join(first.scope('fixture:primary').cachePath, 'lastgood.json'), 'utf8'));
    assert.equal(cached.metadata.revision, second.scope('fixture:primary').index!.metadata.revision);
  } finally { release(); await first.close(); await second.close(); await item.cleanup(); }
});

test('收窄扫描配置后拒绝加载旧授权范围缓存', async () => {
  const item = await fixture(); const first = new IndexManager(item.config, { worker: emptyWorker });
  let second: IndexManager | undefined;
  try {
    await first.initialize(); await first.requestScan('fixture:primary'); await first.close();
    const raw = JSON.parse(await readFile(item.configPath, 'utf8')); raw.projects[0].exclude.push('src/a.py');
    await writeFile(item.configPath, JSON.stringify(raw)); second = new IndexManager(await loadConfig(item.configPath), { worker: emptyWorker });
    await second.initialize(); assert.equal(second.scope('fixture:primary').index, undefined);
    await second.requestScan('fixture:primary'); assert.ok(!second.scope('fixture:primary').index!.files.some(file => file.path === 'src/a.py'));
  } finally { await first.close(); await second?.close(); await item.cleanup(); }
});

test('缓存一致性校验识别磁盘损坏，内存有效索引继续保留', async () => {
  const item = await fixture(); const manager = new IndexManager(item.config, { worker: emptyWorker });
  try {
    await manager.initialize(); await manager.requestScan('fixture:primary'); const scope = manager.scope('fixture:primary');
    const index = scope.index!; await writeFile(path.join(scope.cachePath, 'lastgood.json'), '{corrupt');
    const result = await manager.verify(scope.id); assert.equal(result.valid, false); assert.ok(result.reasons.some(reason => reason.includes('磁盘缓存')));
    assert.equal(scope.index, index); assert.equal(scope.status.state, 'stale');
    await manager.requestScan(scope.id); assert.equal((await manager.verify(scope.id)).valid, true);
  } finally { await manager.close(); await item.cleanup(); }
});

test('并发扫描被串行化，缓存重启后复用且源码变化可验证', async () => {
  const item = await fixture(); let active = 0; let maxActive = 0; let calls = 0;
  const manager = new IndexManager(item.config, { worker: async () => {
    active++; calls++; maxActive = Math.max(active, maxActive); await new Promise(resolve => setTimeout(resolve, 10)); active--; return emptyWorker();
  } });
  let restored: IndexManager | undefined;
  try {
    await manager.initialize(); await Promise.all(Array.from({ length: 8 }, () => manager.requestScan('fixture:primary')));
    assert.equal(maxActive, 1); assert.equal(calls, 2); await manager.close();
    restored = new IndexManager(item.config, { worker: async () => { throw new Error('缓存应当复用'); } });
    await restored.initialize(); assert.equal(restored.scope('fixture:primary').status.state, 'stale');
    await restored.requestScan('fixture:primary'); assert.equal(restored.scope('fixture:primary').status.state, 'synced');
    await writeFile(path.join(item.root, 'src/b.py'), 'modified = True\n');
    assert.equal((await restored.verify('fixture:primary')).valid, false);
  } finally { await manager.close(); await restored?.close(); await item.cleanup(); }
});

test('监听新增和删除，防抖后发布有效索引状态', { timeout: 15000 }, async () => {
  const item = await fixture(); const manager = new IndexManager(item.config, { worker: emptyWorker, debounceMs: 30, pollMs: 100000 });
  try {
    await manager.initialize(); await manager.startWatching('fixture:primary'); await manager.requestScan('fixture:primary');
    const waitFor = (predicate: () => boolean) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { manager.off('status', listener); reject(new Error('监听更新超时')); }, 7000);
      const listener = () => { if (predicate() && manager.scope('fixture:primary').status.state === 'synced') { clearTimeout(timer); manager.off('status', listener); resolve(); } };
      manager.on('status', listener);
    });
    const added = waitFor(() => manager.scope('fixture:primary').index!.files.some(file => file.path === 'src/watched.py'));
    await writeFile(path.join(item.root, 'src/watched.py'), 'first = 1\n'); await writeFile(path.join(item.root, 'src/watched.py'), 'first = 2\n'); await added;
    const removed = waitFor(() => !manager.scope('fixture:primary').index!.files.some(file => file.path === 'src/watched.py'));
    await rm(path.join(item.root, 'src/watched.py')); await removed;
  } finally { await manager.close(); await item.cleanup(); }
});

test('证据按当前 scope 读取，变更和删除后明确过期；没有任意文件 API', async () => {
  const item = await fixture(); const manager = new IndexManager(item.config, { worker: emptyWorker });
  try {
    await manager.initialize(); await manager.requestScan('fixture:primary'); const scope = manager.scope('fixture:primary');
    const evidence = scope.index!.evidence.find(item => item.filePath === 'src/a.py')!;
    const current = await manager.evidence(scope.id, evidence.id); assert.equal(current.stale, false); assert.equal(current.contextStartLine, 1);
    await writeFile(path.join(item.root, 'src/a.py'), 'changed = True\n');
    const stale = await manager.evidence(scope.id, evidence.id); assert.equal(stale.stale, true); assert.equal(stale.content, 'value = 1');
    await rm(path.join(item.root, 'src/a.py')); assert.equal((await manager.evidence(scope.id, evidence.id)).stale, true);
    await assert.rejects(manager.evidence(scope.id, '../projects.json')); assert.throws(() => manager.scope('other:primary'), /未授权/);
  } finally { await manager.close(); await item.cleanup(); }
});

test('Git worktree 发现不等于授权，授权后保持不同工作目录和 scope', async () => {
  const item = await fixture();
  const git = (args: string[]) => exec('git', ['--no-optional-locks', '-c', `safe.directory=${item.root}`, '-C', item.root, ...args], { windowsHide: true });
  try {
    await git(['init', '--initial-branch=main']); await git(['add', '--', 'src/a.py']);
    await git(['-c', 'user.name=ArchitectureExplorerTests', '-c', 'user.email=fixture@invalid', 'commit', '-m', 'fixture']);
    const second = path.join(item.directory, 'branch'); await git(['worktree', 'add', '-b', 'fixture-branch', second]);
    const discovered = await discoverWorktrees(item.config.projects[0]); assert.equal(discovered.length, 2);
    assert.equal(discovered.find(tree => tree.branch === 'fixture-branch')!.authorized, false);
    item.config.projects[0].worktrees = [second];
    const manager = new IndexManager(item.config, { worker: emptyWorker });
    try {
      await manager.initialize(); assert.equal(manager.scopes.size, 2);
      const other = [...manager.scopes.values()].find(scope => scope.worktree.id !== 'primary')!;
      await manager.requestScan('fixture:primary'); await manager.requestScan(other.id);
      assert.notEqual(other.index!.metadata.rootPath, manager.scope('fixture:primary').index!.metadata.rootPath);
      assert.notEqual(other.index!.nodes.find(node => node.filePath === 'src/a.py')!.id, manager.scope('fixture:primary').index!.nodes.find(node => node.filePath === 'src/a.py')!.id);
    } finally { await manager.close(); }
  } finally { await item.cleanup(); }
});

test('HTTP 拒绝远程 Host/Origin、任意 root 和越界 scope；查询返回同 revision', async () => {
  const item = await fixture(); const manager = new IndexManager(item.config, { worker: emptyWorker });
  await manager.initialize(); await manager.requestScan('fixture:primary'); const app = await createServer(manager);
  const host = { host: '127.0.0.1:4310' };
  try {
    assert.equal((await app.inject({ url: '/api/projects', headers: { host: 'attacker.example:4310' } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/projects', headers: { ...host, origin: 'http://attacker.example' } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/summary?scope=unconfigured:primary', headers: host })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/source?path=C:/Windows/file', headers: host })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/api/scan', headers: host, payload: { scope: 'fixture:primary' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/scan', headers: { ...host, origin: 'http://127.0.0.1:4310' }, payload: { scope: 'fixture:primary', root: item.root } })).statusCode, 400);
    const summary = (await app.inject({ url: '/api/summary?scope=fixture:primary', headers: host })).json();
    const graph = (await app.inject({ url: '/api/graph?scope=fixture:primary', headers: host })).json();
    assert.equal(summary.metadata.revision, graph.revision); assert.ok(graph.nodes.length > 0);
    assert.equal((await app.inject({ url: '/api/graph?scope=fixture:primary&depth=10000', headers: host })).statusCode, 400);
  } finally { await app.close(); await item.cleanup(); }
});

test('分层聚合只连接有证据的真实下级关系，调用/数据/影响遍历保持预算与方向', async () => {
  const item = await fixture(); const manager = new IndexManager(item.config, { worker: emptyWorker });
  try {
    await manager.initialize(); await manager.requestScan('fixture:primary');
    const base = manager.scope('fixture:primary').index!;
    const fileA = base.nodes.find(node => node.kind === 'file' && node.filePath === 'src/a.py')!;
    const fileB = base.nodes.find(node => node.kind === 'file' && node.filePath === 'src/b.py')!;
    const source = stableId(base.metadata.scopeId, 'function', 'python|a.run');
    const target = stableId(base.metadata.scopeId, 'function', 'python|b.consume');
    const field = stableId(base.metadata.scopeId, 'field', 'python|a.hp');
    const proof = fileA.evidenceIds;
    const index: ArchitectureIndex = { ...base, nodes: [...base.nodes,
      { id: source, kind: 'function', label: 'run', qualifiedName: 'a.run', language: 'python', parentId: fileA.id, filePath: fileA.filePath, evidenceIds: proof },
      { id: target, kind: 'function', label: 'consume', qualifiedName: 'b.consume', language: 'python', parentId: fileB.id, filePath: fileB.filePath, evidenceIds: fileB.evidenceIds },
      { id: field, kind: 'data', label: '生命', qualifiedName: 'a.hp', language: 'python', parentId: fileA.id, filePath: fileA.filePath, evidenceIds: proof }],
      edges: [...base.edges,
        { id: 'call', source, target, kind: 'calls', confidence: 'static-confirmed', evidenceIds: proof, rule: 'fixture:resolved-call', condition: 'a > 0', dispatch: 'direct' },
        { id: 'call-other', source, target, kind: 'calls', confidence: 'static-confirmed', evidenceIds: proof, rule: 'fixture:resolved-call', condition: 'b > 0', dispatch: 'direct' },
        { id: 'cycle', source: target, target: source, kind: 'calls', confidence: 'static-confirmed', evidenceIds: fileB.evidenceIds, rule: 'fixture:resolved-call' },
        { id: 'read', source, target: field, kind: 'reads', confidence: 'static-confirmed', evidenceIds: proof, rule: 'fixture:read' },
        { id: 'write', source, target: field, kind: 'writes', confidence: 'static-confirmed', evidenceIds: proof, rule: 'fixture:write' }] };
    const aggregate = graph(index, { view: 'architecture', rootId: fileA.parentId });
    assert.equal(aggregate.edges.length, 2); assert.ok(aggregate.edges.every(edge => edge.rule.startsWith('aggregate:') && edge.evidenceIds.length));
    assert.ok(aggregate.edges.every(edge => edge.condition === undefined && edge.dispatch === undefined));
    assert.equal(index.edges.find(edge => edge.id === 'call')!.source, source);
    const bounded = graph(index, { view: 'calls', rootId: source, depth: 5, limit: 1 });
    assert.equal(bounded.nodes.length, 1); assert.equal(bounded.edges.length, 0); assert.equal(bounded.truncated, true);
    const down = graph(index, { view: 'calls', rootId: source, direction: 'down' }); assert.deepEqual(down.edges.map(edge => edge.id), ['call', 'call-other']);
    const data = graph(index, { view: 'data', rootId: field }); assert.deepEqual(new Set(data.edges.map(edge => edge.kind)), new Set(['reads', 'writes']));
    const impact = graph(index, { view: 'impact', rootId: field, depth: 2 });
    assert.equal(impact.nodes.length, 3); assert.ok(impact.edges.every(edge => ['read', 'write', 'cycle'].includes(edge.id)));
    assert.equal(search(index, '生命').nodes[0].id, field);
    assert.equal(nodeDetail(index, source).parents.at(-1)?.id, fileA.id);
  } finally { await manager.close(); await item.cleanup(); }
});

test('SSE 在请求体结束后继续推送扫描状态，服务关闭时释放活动连接', { timeout: 12000 }, async t => {
  const item = await fixture(); const manager = new IndexManager(item.config, { worker: emptyWorker });
  await manager.initialize(); await manager.requestScan('fixture:primary'); const app = await createServer(manager);
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const statuses: IndexStatus[] = []; let buffered = ''; let received!: () => void; let connectionFailed!: (error: Error) => void;
  const connected = new Promise<void>((resolve, reject) => { received = resolve; connectionFailed = reject; });
  const client = httpRequest(`${url}/api/events?scope=fixture:primary`, { headers: { host: '127.0.0.1:4310' } });
  client.on('response', response => {
    if (response.statusCode !== 200) connectionFailed(new Error(`SSE HTTP ${response.statusCode}`));
    response.setEncoding('utf8'); response.on('data', (chunk: string) => {
      buffered += chunk; let delimiter = buffered.indexOf('\n\n');
      while (delimiter >= 0) {
        const frame = buffered.slice(0, delimiter); buffered = buffered.slice(delimiter + 2);
        if (frame.startsWith('data: ')) { statuses.push(JSON.parse(frame.slice(6))); received(); }
        delimiter = buffered.indexOf('\n\n');
      }
    });
  });
  client.on('error', error => connectionFailed(error)); client.end();
  try {
    try { await connected; }
    catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('当前沙箱阻止 Node loopback 请求；SSE socket 生命周期须在允许本机网络的环境补验'); return; }
      throw error;
    }
    const first = statuses[0].revision;
    await writeFile(path.join(item.root, 'src/a.py'), 'value = 99\n'); await manager.requestScan('fixture:primary');
    // Let the socket deliver the final already-written frame, without relying on a fixed sleep.
    if (!statuses.some(status => status.state === 'synced' && status.revision !== first)) await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('没有收到 SSE 更新')), 3000);
      received = () => { if (statuses.some(status => status.state === 'synced' && status.revision !== first)) { clearTimeout(timeout); resolve(); } };
    });
    assert.ok(statuses.some(status => status.state === 'analyzing'));
    assert.ok(statuses.some(status => status.state === 'synced' && status.revision !== first));
    await app.close(); assert.equal(manager.listenerCount('status'), 0);
  } finally { client.destroy(); await app.close(); await item.cleanup(); }
});

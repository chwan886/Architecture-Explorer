import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { BridgeFiles } from '../apps/server/src/bridge-auth.ts';
import { ArchitectureService } from '../apps/server/src/architecture.ts';
import { SemanticStore } from '../apps/server/src/semantic-store.ts';
import { TOOL_ROOT, type LoadedConfig } from '../packages/indexer/src/config.ts';
import { IndexManager, type ScopeRuntime } from '../packages/indexer/src/indexer.ts';
import { withFileLock } from '../packages/indexer/src/file-lock.ts';
import { canonical } from '../packages/indexer/src/security.ts';
import { contentHash } from '../packages/schema/src/index.ts';

for (const kind of ['runtime', 'model', 'semantic', 'scan']) test(`${kind} lock protects a live process and recovers after its abrupt termination`, { timeout: 20000 }, async t => {
  await mkdir(path.join(TOOL_ROOT, '.tmp'), { recursive: true });
  const directory = await mkdtemp(path.join(TOOL_ROOT, '.tmp/crash-lock-'));
  const toolRoot = path.join(directory, 'tool'), target = path.join(directory, 'target');
  await mkdir(toolRoot); await mkdir(target);
  const config: LoadedConfig = { toolRoot, configPath: path.join(directory, 'config.json'), cacheDir: path.join(toolRoot, '.cache'), fingerprint: 'fixture', port: 4310,
    projects: [{ id: 'fixture', name: 'Lock fixture', root: target, include: ['**/*.py'], exclude: [] }] };
  await writeFile(config.configPath, JSON.stringify(config));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/lock-holder.ts', import.meta.url)), kind, config.configPath], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let scanner: IndexManager | undefined;
  let stderr = ''; child.stderr!.on('data', value => { stderr += value; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await scanner?.close();
    assert.ok(directory.startsWith(path.join(TOOL_ROOT, '.tmp') + path.sep));
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  const ready = await Promise.race([once(child, 'message').then(([message]) => message), once(child, 'exit').then(() => { throw new Error(`Lock holder exited: ${stderr}`); })]);
  assert.equal(ready, 'locked');
  const service = new ArchitectureService({ config, emit() {} } as unknown as IndexManager), store = new SemanticStore(config);
  if (kind === 'scan') {
    scanner = new IndexManager(config, { worker: async () => ({ nodes: [], edges: [], evidence: [], diagnostics: [] }) });
    await scanner.initialize();
  }
  const attempt = async () => {
    if (kind === 'runtime') return new BridgeFiles(config).publication(async () => 'ok');
    if (kind === 'model') return service.save({ project: config.projects[0], id: 'fixture:primary' } as ScopeRuntime, (await service.model('fixture')).modelRevision, model => model);
    if (kind === 'scan') {
      await scanner!.requestScan('fixture:primary');
      const status = scanner!.scope('fixture:primary').status;
      if (status.state === 'failed') throw Object.assign(new Error(status.message), { statusCode: 409 });
      assert.equal(status.state, 'synced');
      return;
    }
    return store.save('fixture', 'fixture:primary', (await store.read('fixture', 'fixture:primary')).overlayRevision, overlay => overlay);
  };
  const lockPath = kind === 'runtime' ? path.join(config.cacheDir, 'bridge/runtime.lock') : kind === 'model' ? path.join(toolRoot, 'architecture/models/fixture/model.lock')
    : kind === 'scan' ? path.join(scanner!.scope('fixture:primary').cachePath, 'scan.lock') : path.join(toolRoot, 'architecture/semantics/fixture/worktrees/primary.json.lock');
  const held = await readFile(lockPath, 'utf8');
  await assert.rejects(attempt(), { statusCode: 409 });
  assert.equal(await readFile(lockPath, 'utf8'), held, 'never steal a live lock');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  await attempt();
  await assert.rejects(readFile(lockPath), { code: 'ENOENT' });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function lockFixture(t: test.TestContext) {
  const base = path.join(TOOL_ROOT, '.tmp');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'lock-protocol-'));
  const locks = path.join(directory, 'locks');
  await mkdir(locks);
  t.after(async () => {
    assert.ok(directory.startsWith(base + path.sep));
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  return { directory, locks, options: { toolRoot: directory, lockPath: path.join(locks, 'shared.lock'),
    locked: () => Object.assign(new Error('Lock is held by an unverified or live owner'), { statusCode: 409, code: 'LOCKED' }) } };
}

async function exitedPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.ok(child.pid);
  assert.throws(() => process.kill(child.pid!, 0), { code: 'ESRCH' });
  return child.pid!;
}

const ownerRecord = (pid: number) => ({ version: 1, pid, host: hostname(), token: randomUUID() });

test('competing recoverers admit one critical section and never remove its replacement lock', { timeout: 15000 }, async t => {
  const f = await lockFixture(t), old = ownerRecord(await exitedPid());
  await writeFile(f.options.lockPath, JSON.stringify(old));
  const entered = deferred<void>(), release = deferred<void>(), othersFinished = deferred<void>(), overlap = deferred<never>();
  const competitors = 16;
  let active = 0, entries = 0, settled = 0;
  const attempts = Array.from({ length: competitors }, (_, index) => withFileLock(f.options, async () => {
    active++; entries++;
    if (active > 1) overlap.reject(new Error('Two contenders entered the critical section'));
    entered.resolve();
    try { await release.promise; return index; }
    finally { active--; }
  }).finally(() => { if (++settled === competitors - 1) othersFinished.resolve(); }));
  const results = Promise.allSettled(attempts);
  try {
    await Promise.race([entered.promise, results.then(() => { throw new Error('No contender recovered the dead lock'); })]);
    await Promise.race([othersFinished.promise, overlap.promise]);
    assert.equal(entries, 1);
    assert.equal(active, 1);
    const held = JSON.parse(await readFile(f.options.lockPath, 'utf8'));
    assert.equal(held.pid, process.pid);
    assert.notEqual(held.token, old.token);
    await assert.rejects(withFileLock(f.options, async () => assert.fail('Replacement lock was stolen')), { code: 'LOCKED' });
    assert.deepEqual(JSON.parse(await readFile(f.options.lockPath, 'utf8')), held);
  } finally { release.resolve(); }
  const outcomes = await results;
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of outcomes) if (result.status === 'rejected') assert.equal(result.reason.code, 'LOCKED');
  assert.deepEqual(await readdir(f.locks), [], 'successful and rejected contenders leave no lock or prepared file');
  assert.equal(await withFileLock(f.options, async () => 'next owner'), 'next owner');
});

test('live, foreign, unknown and damaged lock records fail closed without changing their bytes', { timeout: 15000 }, async t => {
  const f = await lockFixture(t), dead = ownerRecord(await exitedPid());
  const records: Array<[string, string]> = [
    ['current live PID', JSON.stringify(ownerRecord(process.pid))],
    ['foreign host', JSON.stringify({ ...dead, host: hostname() + '-another-host' })],
    ['unknown protocol', JSON.stringify({ ...dead, version: 2 })],
    ['missing owner identity', JSON.stringify({ pid: dead.pid, token: dead.token })],
    ['invalid owner token', JSON.stringify({ ...dead, token: 'not-a-uuid' })],
    ['malformed JSON', '{"version":1,"pid":'],
    ['empty record', ''],
    ['null record', 'null'],
    ['ownerless legacy runtime token', 'a'.repeat(48)],
  ];
  for (const [name, record] of records) await t.test(name, async () => {
    await writeFile(f.options.lockPath, record);
    let entered = false;
    await assert.rejects(withFileLock(f.options, async () => { entered = true; }), { code: 'LOCKED' });
    assert.equal(entered, false);
    assert.equal(await readFile(f.options.lockPath, 'utf8'), record);
    assert.deepEqual(await readdir(f.locks), ['shared.lock']);
  });
});

test('a PID probe denied with EPERM never authorizes recovery', { timeout: 10000 }, async t => {
  const f = await lockFixture(t), old = ownerRecord(await exitedPid()), record = JSON.stringify(old);
  await writeFile(f.options.lockPath, record);
  const probe = process.kill;
  let probes = 0;
  process.kill = (pid, signal) => {
    if (pid === old.pid) { probes++; throw Object.assign(new Error('PID probe permission denied'), { code: 'EPERM' }); }
    return probe(pid, signal);
  };
  try {
    await assert.rejects(withFileLock(f.options, async () => assert.fail('EPERM owner was reclaimed')), { code: 'LOCKED' });
    assert.ok(probes > 0, 'the owner was actually checked');
    assert.equal(await readFile(f.options.lockPath, 'utf8'), record);
  } finally { process.kill = probe; }
});

test('legacy pid:UUID records recover only after their local process has exited', { timeout: 10000 }, async t => {
  const f = await lockFixture(t);
  const live = `${process.pid}:${randomUUID()}`;
  await writeFile(f.options.lockPath, live);
  await assert.rejects(withFileLock(f.options, async () => assert.fail('Live legacy owner was stolen')), { code: 'LOCKED' });
  assert.equal(await readFile(f.options.lockPath, 'utf8'), live);
  await writeFile(f.options.lockPath, `${await exitedPid()}:${randomUUID()}`);
  assert.equal(await withFileLock(f.options, async () => 'recovered'), 'recovered');
  assert.deepEqual(await readdir(f.locks), []);
});

test('a live generation recovery guard blocks reclaimers and recovers after its process crashes', { timeout: 20000 }, async t => {
  const f = await lockFixture(t), old = ownerRecord(await exitedPid()), original = JSON.stringify(old);
  await writeFile(f.options.lockPath, original);
  const guard = path.join(f.locks, `.lock-recovery-${contentHash(canonical(f.options.lockPath) + '|' + old.token).slice(0, 32)}.lock`);
  const configPath = path.join(f.directory, 'config.json');
  await writeFile(configPath, JSON.stringify({ toolRoot: f.directory }));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/lock-holder.ts', import.meta.url)), 'file', configPath, guard],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let stderr = ''; child.stderr!.on('data', value => { stderr += value; });
  try {
    const ready = await Promise.race([once(child, 'message').then(([message]) => message), once(child, 'exit').then(() => { throw new Error(`Guard holder exited: ${stderr}`); })]);
    assert.equal(ready, 'locked');
    const guardBytes = await readFile(guard, 'utf8');
    await assert.rejects(withFileLock(f.options, async () => assert.fail('Live recovery guard was stolen')), { code: 'LOCKED' });
    assert.equal(await readFile(f.options.lockPath, 'utf8'), original);
    assert.equal(await readFile(guard, 'utf8'), guardBytes);
    const aliases = [f.locks + path.sep + '.' + path.sep + 'shared.lock'];
    if (process.platform === 'win32') aliases.push(f.options.lockPath.toUpperCase());
    for (const alias of aliases) {
      await assert.rejects(withFileLock({ ...f.options, lockPath: alias }, async () => assert.fail('Equivalent spelling bypassed the live generation guard')), { code: 'LOCKED' });
      assert.equal(await readFile(f.options.lockPath, 'utf8'), original);
      assert.equal(await readFile(guard, 'utf8'), guardBytes);
    }
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    assert.equal(await withFileLock(f.options, async () => 'guard and lock recovered'), 'guard and lock recovered');
    assert.deepEqual(await readdir(f.locks), [], 'recursive recovery cleans the dead guard and the main lock');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  }
});

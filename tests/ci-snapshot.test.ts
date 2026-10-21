import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { snapshotInput, captureReadOnlyState, assertReadOnlyState, assertIndexCommit, prepareReferences, GAME_REPOSITORY } from '../Tools/ci-snapshot.ts';
import { git } from '../packages/indexer/src/git.ts';
import { TOOL_ROOT, IndexManager, loadConfig } from '../packages/indexer/src/index.ts';

const sha = 'a'.repeat(40);
const env = () => ({ CI_CONTRACT_VERSION: '1', CI_SOURCE_REPO: GAME_REPOSITORY, CI_SOURCE_REF: 'refs/heads/main', CI_SOURCE_SHA: sha, CI_SOURCE_RUN_ID: '123', CI_SOURCE_RUN_ATTEMPT: '2',
  CI_SOURCE_RUN_URL: `https://github.com/${GAME_REPOSITORY}/actions/runs/123`, CI_GAME_ROOT: 'target', CI_UNITY_REFERENCES: 'refs.json',
  GITHUB_REPOSITORY: 'chwan886/Architecture-Explorer', GITHUB_SERVER_URL: 'https://github.com', GITHUB_SHA: 'b'.repeat(40), GITHUB_RUN_ID: '456', GITHUB_RUN_ATTEMPT: '1' });
const project = { include: ['src'], exclude: [] };
const execute = promisify(execFile);

test('CI dispatch accepts exact repository/SHA/run provenance and rejects injection or invented provenance', () => {
  const input = snapshotInput(env()); assert.equal(input.gameSha, sha);
  assert.equal(input.contractVersion, '1'); assert.equal(input.sourceRef, 'refs/heads/main'); assert.equal(input.sourceRunAttempt, '2');
  assert.equal(input.runUrl, 'https://github.com/chwan886/Architecture-Explorer/actions/runs/456/attempts/1');
  for (const value of ['other/GameDemo02', 'chwan886/gamedemo02', '../GameDemo02', `${GAME_REPOSITORY}\n`])
    assert.throws(() => snapshotInput({ ...env(), CI_SOURCE_REPO: value }), /source repository/);
  for (const value of ['', 'main', 'a'.repeat(39), 'A'.repeat(40), `${sha}; git status`, `--${sha}`])
    assert.throws(() => snapshotInput({ ...env(), CI_SOURCE_SHA: value }), /CI_SOURCE_SHA|exact lowercase/);
  for (const [key, value] of [['CI_CONTRACT_VERSION', '2'], ['CI_SOURCE_REF', 'refs/heads/feature'], ['CI_SOURCE_RUN_ATTEMPT', '0'], ['CI_SOURCE_RUN_ID', '0'], ['CI_SOURCE_RUN_URL', 'https://evil.invalid/run/123'],
    ['CI_SOURCE_RUN_URL', `https://github.com/${GAME_REPOSITORY}/actions/runs/124`], ['GITHUB_REPOSITORY', GAME_REPOSITORY],
    ['GITHUB_SERVER_URL', 'https://github.com.evil.invalid']])
    assert.throws(() => snapshotInput({ ...env(), [key]: value }));
  const oldContract: NodeJS.ProcessEnv = { ...env(), CI_SOURCE_REPOSITORY: GAME_REPOSITORY, CI_GAME_SHA: sha };
  delete oldContract.CI_CONTRACT_VERSION; delete oldContract.CI_SOURCE_REPO; delete oldContract.CI_SOURCE_REF; delete oldContract.CI_SOURCE_SHA; delete oldContract.CI_SOURCE_RUN_ATTEMPT;
  assert.throws(() => snapshotInput(oldContract), /CI_CONTRACT_VERSION/);
});

async function fixture() {
  await mkdir(path.join(TOOL_ROOT, '.tmp'), { recursive: true });
  const directory = await mkdtemp(path.join(TOOL_ROOT, '.tmp', 'ci-snapshot-test-'));
  const root = path.join(directory, 'game'); await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/sample.py'), 'value = 1\ndef sample():\n    return value\n');
  await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'CI Fixture']);
  await git(root, ['config', 'user.email', 'fixture@example.invalid']); await git(root, ['config', 'core.autocrlf', 'false']);
  await git(root, ['add', '.']); await git(root, ['commit', '-m', 'fixture']);
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
  await git(root, ['remote', 'add', 'origin', `https://github.com/${GAME_REPOSITORY}.git`]);
  await git(root, ['update-ref', 'refs/remotes/origin/main', head]);
  return { directory, root, head, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('strict Git attestation fails closed on unreadable Git, wrong SHA, wrong origin, untracked changes and non-main history', async () => {
  const f = await fixture();
  try {
    const state = await captureReadOnlyState(f.root, f.head, project); assert.equal(state.head, f.head); assert.equal(state.status, '');
    await assert.rejects(captureReadOnlyState(f.directory, f.head, project));
    await assert.rejects(captureReadOnlyState(f.root, sha, project), /HEAD does not match/);
    await writeFile(path.join(f.root, 'untracked.txt'), 'unexpected');
    await assert.rejects(captureReadOnlyState(f.root, f.head, project), /including untracked/);
    await rm(path.join(f.root, 'untracked.txt'));
    await git(f.root, ['remote', 'set-url', 'origin', 'https://github.com/other/GameDemo02.git']);
    await assert.rejects(captureReadOnlyState(f.root, f.head, project), /origin/);
    await git(f.root, ['remote', 'set-url', 'origin', `https://github.com/${GAME_REPOSITORY}.git`]);
    await writeFile(path.join(f.root, 'src/sample.py'), 'value = 2\n'); await git(f.root, ['add', '.']); await git(f.root, ['commit', '-m', 'unmerged feature']);
    const feature = (await git(f.root, ['rev-parse', 'HEAD'])).trim();
    await assert.rejects(captureReadOnlyState(f.root, feature, project), /merge-base|Command failed/);
  } finally { await f.cleanup(); }
});

test('source byte attestation detects changes even when Git status reports clean via assume-unchanged', async () => {
  const f = await fixture();
  try {
    const before = await captureReadOnlyState(f.root, f.head, project);
    await git(f.root, ['update-index', '--assume-unchanged', 'src/sample.py']);
    await writeFile(path.join(f.root, 'src/sample.py'), 'value = 2\n');
    const after = await captureReadOnlyState(f.root, f.head, project);
    assert.equal(after.status, ''); assert.throws(() => assertReadOnlyState(before, after), /source bytes changed/);
  } finally { await f.cleanup(); }
});

test('real fixture Scan and Verify preserve game files; SHA mismatch and empty Git HEAD cannot pass wrapper', async () => {
  const f = await fixture();
  let manager: IndexManager | undefined;
  try {
    const before = await captureReadOnlyState(f.root, f.head, project);
    const configPath = path.join(f.directory, 'config.json');
    await writeFile(configPath, JSON.stringify({ cacheDir: path.join(f.directory, 'cache'), python: 'python',
      projects: [{ id: 'game-demo-02', name: 'CI fixture', root: f.root, ...project }] }));
    manager = new IndexManager(await loadConfig(configPath)); await manager.initialize();
    await manager.requestScan('game-demo-02:primary', true);
    const scope = manager.scope('game-demo-02:primary'); assert.notEqual(scope.status.state, 'failed', scope.status.message);
    assert.ok(scope.index); assertIndexCommit(scope.index, f.head, before);
    assert.deepEqual((await manager.verify('game-demo-02:primary')).reasons, []);
    assertReadOnlyState(before, await captureReadOnlyState(f.root, f.head, project));
    assert.equal(await readFile(path.join(f.root, 'src/sample.py'), 'utf8'), 'value = 1\ndef sample():\n    return value\n');
    const wrong = structuredClone(scope.index); wrong.metadata.gitHead = sha;
    assert.throws(() => assertIndexCommit(wrong, f.head, before), /does not match dispatched/);
    wrong.metadata.gitHead = ''; wrong.metadata.gitDirty = false;
    assert.throws(() => assertIndexCommit(wrong, f.head, before), /nonempty/);
    wrong.metadata.gitHead = f.head; wrong.metadata.gitStatusHash = 'unavailable';
    assert.throws(() => assertIndexCommit(wrong, f.head, before), /confirmed clean/);
  } finally { await manager?.close(); await f.cleanup(); }
});

test('missing Unity references and editor-version mismatches block rather than fabricate Unity types', async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.root, 'ProjectSettings')); await writeFile(path.join(f.root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 6000.6.5f1\n');
    const file = path.join(f.directory, 'refs.json');
    await writeFile(file, JSON.stringify({ unityVersion: '6000.6.5f1', references: [] }));
    await assert.rejects(prepareReferences(file, f.root), /missing references block/);
    await writeFile(file, JSON.stringify({ unityVersion: '6000.6.4f1', references: [] }));
    await assert.rejects(prepareReferences(file, f.root), /version differs/);
    await assert.rejects(prepareReferences(path.join(f.directory, 'missing.json'), f.root), /ENOENT/);
  } finally { await f.cleanup(); }
});

test('actual Scan → Verify → Audit retain stale human explanations and fail visibly on invalid mappings without executing target Python', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'src/sample.py'), 'raise RuntimeError("target Python must never execute")\nvalue = 1\n');
    await git(f.root, ['add', '.']); await git(f.root, ['commit', '-m', 'non-executable scan fixture']);
    const head = (await git(f.root, ['rev-parse', 'HEAD'])).trim(); await git(f.root, ['update-ref', 'refs/remotes/origin/main', head]);
    const before = await captureReadOnlyState(f.root, head, project);
    const humanPaths = ['architecture/models/game-demo-02/model.json', 'architecture/semantics/game-demo-02/definitions.json', 'architecture/semantics/game-demo-02/worktrees/primary.json'];
    const readHuman = (file: string) => readFile(path.join(TOOL_ROOT, file), 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    const humanBefore = await Promise.all(humanPaths.map(readHuman));
    const configPath = path.join(f.directory, 'config.json'), cacheDir = path.join(f.directory, 'cache');
    await writeFile(configPath, JSON.stringify({ cacheDir, python: 'python', projects: [{ id: 'game-demo-02', name: 'CI fixture', root: f.root, ...project }] }));
    const options = ['--config', configPath, '--project', 'game-demo-02', '--worktree', 'primary'];
    for (const command of [['apps/server/src/cli.ts', 'scan', '--full'], ['apps/server/src/cli.ts', 'verify']]) {
      await execute(process.execPath, ['node_modules/tsx/dist/cli.mjs', ...command, ...options], { cwd: TOOL_ROOT, windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    }
    await assert.rejects(execute(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'Tools/audit-evidence.ts', ...options],
      { cwd: TOOL_ROOT, windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 }), (error: unknown) => (error as { code?: number }).code === 1);
    const audit = JSON.parse(await readFile(path.join(cacheDir, 'evidence-audit/game-demo-02-primary.json'), 'utf8'));
    assert.equal(audit.snapshot.gitHead, head); assert.equal(audit.result, 'invalid');
    assert.ok(Object.values(audit.coverage.reviews.architectureFlows).some(value => typeof value === 'number' && value > 0), 'Existing human flows are included in the audit');
    assert.equal(audit.coverage.reviews.architectureFlows.confirmed ?? 0, 0, 'Stale fixture mappings must not inherit confirmation');
    assert.ok((audit.coverage.reviews.architectureFlows['needs-review'] ?? 0) + (audit.coverage.reviews.architectureFlows.pending ?? 0) > 0, 'Stale explanations remain awaiting review');
    assert.deepEqual(await Promise.all(humanPaths.map(readHuman)), humanBefore);
    assertReadOnlyState(before, await captureReadOnlyState(f.root, head, project));
  } finally { await f.cleanup(); }
});

test('actual fixture Scan → Verify → Audit complete successfully with explicit static-analysis gaps and no audit errors', async () => {
  const f = await fixture();
  try {
    const before = await captureReadOnlyState(f.root, f.head, project);
    const configPath = path.join(f.directory, 'config.json'), cacheDir = path.join(f.directory, 'cache');
    await writeFile(configPath, JSON.stringify({ cacheDir, python: 'python', projects: [{ id: 'ci-fixture', name: 'Isolated CI fixture', root: f.root, ...project }] }));
    const options = ['--config', configPath, '--project', 'ci-fixture', '--worktree', 'primary'];
    for (const command of [['apps/server/src/cli.ts', 'scan', '--full'], ['apps/server/src/cli.ts', 'verify'], ['Tools/audit-evidence.ts']])
      await execute(process.execPath, ['node_modules/tsx/dist/cli.mjs', ...command, ...options], { cwd: TOOL_ROOT, windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    const audit = JSON.parse(await readFile(path.join(cacheDir, 'evidence-audit/ci-fixture-primary.json'), 'utf8'));
    assert.equal(audit.snapshot.gitHead, f.head); assert.ok(['consistent', 'gaps'].includes(audit.result)); assert.equal(audit.totals.bySeverity.error ?? 0, 0);
    assertReadOnlyState(before, await captureReadOnlyState(f.root, f.head, project));
  } finally { await f.cleanup(); }
});

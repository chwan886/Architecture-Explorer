import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { IndexManager, loadConfig, TOOL_ROOT } from '../packages/indexer/src/index.ts';
import { validateReleaseEvidence } from '../Tools/ci-release-evidence.ts';
import { releaseEvidenceFixture } from './release-evidence-fixture.ts';

const exec = promisify(execFile);
test('actual IndexManager revision is accepted by release evidence with all fingerprint constraints retained', async () => {
  const base = path.join(TOOL_ROOT, '.tmp'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'release-producer-revision-'));
  const target = path.join(directory, 'target'), configFile = path.join(directory, 'config.json');
  const git = (...args: string[]) => exec('git', ['-c', `safe.directory=${target.replaceAll('\\', '/')}`,
    '-c', `core.hooksPath=${path.join(directory, 'no-hooks')}`, '-C', target, ...args], { windowsHide: true });
  let manager: IndexManager | undefined;
  try {
    await mkdir(path.join(target, 'src'), { recursive: true });
    // The real IndexManager captures and hashes this input; the worker is inert and target code is never executed.
    const source = 'raise RuntimeError("synthetic target must never execute")\nvalue = 1\n';
    await writeFile(path.join(target, 'src/example.py'), source);
    await exec('git', ['init', '--initial-branch=main', target], { windowsHide: true });
    await git('add', '--', 'src/example.py');
    await git('-c', 'user.name=Release Evidence Fixture', '-c', 'user.email=release-fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic read-only revision fixture');
    const beforeHead = (await git('rev-parse', 'HEAD')).stdout.trim();
    await writeFile(configFile, JSON.stringify({ cacheDir: './cache', projects: [{ id: 'game-demo-02', name: 'Synthetic producer fixture',
      root: './target', include: ['src'], exclude: [] }] }));
    manager = new IndexManager(await loadConfig(configFile), { worker: async () => ({ nodes: [], edges: [], evidence: [], diagnostics: [] }) });
    await manager.initialize(); await manager.requestScan('game-demo-02:primary', true);
    const scope = manager.scope('game-demo-02:primary');
    assert.equal(scope.status.state, 'synced'); assert.ok(scope.index);
    const produced = scope.index.metadata;
    assert.equal(produced.gitHead, beforeHead); assert.equal(produced.gitDirty, false); assert.match(produced.revision, /^[a-f0-9]{24}$/);
    assert.match(produced.configFingerprint, /^[a-f0-9]{64}$/); assert.match(produced.compilationFingerprint, /^[a-f0-9]{64}$/);
    const input = releaseEvidenceFixture();
    const docs = input.artifacts.index.documents as Record<string, any>;
    const find = (suffix: string) => Object.entries(docs).find(([name]) => name.endsWith(suffix))![1];
    find('/index.json').metadata.revision = produced.revision;
    find('/manifest.json').index.revision = produced.revision;
    find('/audit.json').snapshot.sourceRevision = produced.revision;
    const plan = validateReleaseEvidence(input);
    assert.equal((plan.releaseManifest as any).evidence.indexRevision, produced.revision);
    assert.equal(await readFile(path.join(target, 'src/example.py'), 'utf8'), source);
    assert.equal((await git('rev-parse', 'HEAD')).stdout.trim(), beforeHead);
    assert.equal((await git('status', '--porcelain=v1', '--untracked-files=all')).stdout, '');
  } finally {
    await manager?.close();
    const absoluteBase = path.resolve(base), absoluteDirectory = path.resolve(directory);
    assert.equal(path.dirname(absoluteDirectory), absoluteBase);
    assert.ok(path.basename(absoluteDirectory).startsWith('release-producer-revision-'));
    await rm(absoluteDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

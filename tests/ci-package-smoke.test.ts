import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { TOOL_ROOT } from '../packages/indexer/src/config.ts';
import { assertPackageSmokeCleanup } from '../Tools/ci-package-smoke.ts';
import { createSmokeDirectory, removeSmokeDirectory } from '../Tools/ci-smoke-directories.ts';

test('post-runtime package audit accepts only removed owned fixtures and preserves normal package files', async () => {
  const owned = await createSmokeDirectory(path.join(TOOL_ROOT, '.tmp'), TOOL_ROOT, 'package-cleanup-test-');
  try {
    const packageRoot = path.join(owned.directory, 'package'), cache = path.join(packageRoot, 'smoke-cache-current'), fixture = path.join(owned.directory, 'fixture');
    await mkdir(packageRoot);
    await writeFile(path.join(packageRoot, 'RUNNING.md'), 'package documentation');
    await assertPackageSmokeCleanup(packageRoot, cache, fixture);
    assert.equal(await readFile(path.join(packageRoot, 'RUNNING.md'), 'utf8'), 'package documentation');
    assert.deepEqual(await readdir(packageRoot), ['RUNNING.md']);
    await assert.rejects(assertPackageSmokeCleanup(packageRoot, path.join(owned.directory, 'outside-cache'), fixture));
    await assert.rejects(assertPackageSmokeCleanup(packageRoot, cache, path.dirname(TOOL_ROOT)));
  } finally { await removeSmokeDirectory(owned); }
});

test('leftover owned cache, another smoke cache, runtime credentials or source fixture cannot pass the final package audit', async () => {
  for (const mode of ['owned-cache', 'other-cache', 'default-cache', 'root-runtime', 'source-fixture']) {
    const owned = await createSmokeDirectory(path.join(TOOL_ROOT, '.tmp'), TOOL_ROOT, 'package-cleanup-test-');
    try {
      const packageRoot = path.join(owned.directory, 'package'), cache = path.join(packageRoot, 'smoke-cache-current'), fixture = path.join(owned.directory, 'fixture');
      await mkdir(packageRoot);
      const retained = mode === 'owned-cache' ? path.join(cache, 'bridge/runtime.json')
        : mode === 'other-cache' ? path.join(packageRoot, 'smoke-cache-earlier', 'keep.txt')
        : mode === 'default-cache' ? path.join(packageRoot, '.cache/bridge/runtime.json')
        : mode === 'root-runtime' ? path.join(packageRoot, 'bridge/runtime.json') : path.join(fixture, 'sample.py');
      await mkdir(path.dirname(retained), { recursive: true });
      await writeFile(retained, 'fixture-only retained content');
      await assert.rejects(assertPackageSmokeCleanup(packageRoot, cache, fixture), /Package retains smoke cache entries|Package smoke cleanup left/, mode);
      assert.equal(await readFile(retained, 'utf8'), 'fixture-only retained content', 'Unexpected files stay intact for diagnosis');
      assert.ok(!(await readdir(packageRoot)).some(name => name.endsWith('.json') && name.startsWith('package-smoke-')), 'The audit cannot produce a passed receipt');
    } finally { await removeSmokeDirectory(owned); }
  }
});

test('a linked leftover cache is rejected without following or deleting its target', async () => {
  const owned = await createSmokeDirectory(path.join(TOOL_ROOT, '.tmp'), TOOL_ROOT, 'package-cleanup-test-');
  try {
    const packageRoot = path.join(owned.directory, 'package'), cache = path.join(packageRoot, 'smoke-cache-current'), fixture = path.join(owned.directory, 'fixture');
    const target = path.join(owned.directory, 'target'), link = path.join(packageRoot, 'smoke-cache-linked');
    await mkdir(packageRoot); await mkdir(target); await writeFile(path.join(target, 'keep.txt'), 'must survive');
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await assert.rejects(assertPackageSmokeCleanup(packageRoot, cache, fixture), /retains smoke cache/);
      assert.equal(await readFile(path.join(target, 'keep.txt'), 'utf8'), 'must survive');
    } finally { await unlink(link); }
  } finally { await removeSmokeDirectory(owned); }
});

test('the CLI records immutable per-package success only after process termination, cleanup and final residual audit', async () => {
  const source = await readFile(new URL('../Tools/ci-package-smoke.ts', import.meta.url), 'utf8');
  const stopCheck = source.indexOf("'Package process did not stop; keep its fixture for diagnosis'");
  const cacheRemoval = source.indexOf('await removeSmokeDirectory(ownedCache)');
  const fixtureRemoval = source.indexOf('await removeSmokeDirectory(ownedFixture)');
  const residualAudit = source.indexOf('await assertPackageSmokeCleanup(packageRoot, cache, fixture)');
  const receiptWrite = source.indexOf('await writeFile(reportPath');
  const successLog = source.indexOf('console.log(`Package runtime');
  assert.ok(stopCheck > 0 && cacheRemoval > stopCheck && fixtureRemoval > cacheRemoval && residualAudit > fixtureRemoval && receiptWrite > residualAudit && successLog > receiptWrite);
  assert.match(source, /test-results\/package-smoke-\$\{packageId\}\.json/);
  assert.match(source.slice(receiptWrite, successLog), /flag: 'wx'/);
  assert.doesNotMatch(source, /test-results\/package-smoke\.json/);
  assert.match(source, /import\.meta\.url === pathToFileURL\(path\.resolve\(process\.argv\[1\]\)\)\.href/);
});

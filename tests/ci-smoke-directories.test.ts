import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { TOOL_ROOT } from '../packages/indexer/src/config.ts';
import { createSmokeDirectory, removeSmokeDirectory } from '../Tools/ci-smoke-directories.ts';

async function fixture() {
  return createSmokeDirectory(path.join(TOOL_ROOT, '.tmp'), TOOL_ROOT, 'smoke-boundary-test-');
}

test('package smoke removes only its freshly owned child directory', async () => {
  const outer = await fixture();
  try {
    const owned = await createSmokeDirectory(outer.directory, TOOL_ROOT, 'runtime-');
    await writeFile(path.join(owned.directory, 'result.txt'), 'owned fixture');
    await removeSmokeDirectory(owned);
    await assert.rejects(access(owned.directory), { code: 'ENOENT' });
    await access(outer.directory);
    await assert.rejects(removeSmokeDirectory({ ...outer, base: outer.directory }), /smoke base/);
  } finally { await removeSmokeDirectory(outer); }
});

test('package smoke rejects a junction ancestor before creating any fixture', async () => {
  const outer = await fixture();
  const elsewhere = path.join(outer.directory, 'elsewhere'), link = path.join(outer.directory, 'linked');
  let linked = false;
  try {
    await mkdir(elsewhere);
    await symlink(elsewhere, link, process.platform === 'win32' ? 'junction' : 'dir');
    linked = true;
    await assert.rejects(createSmokeDirectory(path.join(link, 'not-created'), TOOL_ROOT, 'runtime-'), /符号链接|目录联接/);
    await assert.rejects(access(path.join(elsewhere, 'not-created')), { code: 'ENOENT' });
  } finally { if (linked) await unlink(link); await removeSmokeDirectory(outer); }
});

test('package smoke preserves a directory with a changed owner marker', async () => {
  const outer = await fixture();
  try {
    const owned = await createSmokeDirectory(outer.directory, TOOL_ROOT, 'runtime-');
    const markerPath = path.join(owned.directory, '.package-smoke-owner');
    await writeFile(markerPath, 'replacement');
    await assert.rejects(removeSmokeDirectory(owned), /ownership changed/);
    assert.equal(await readFile(markerPath, 'utf8'), 'replacement');
    await writeFile(markerPath, owned.marker);
    await removeSmokeDirectory(owned);
  } finally { await removeSmokeDirectory(outer); }
});

test('package smoke rechecks links before cleanup and preserves the linked target', async () => {
  const outer = await fixture();
  try {
    const owned = await createSmokeDirectory(outer.directory, TOOL_ROOT, 'runtime-');
    const saved = owned.directory + '-saved', elsewhere = path.join(outer.directory, 'elsewhere');
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, 'keep.txt'), 'must survive');
    await rename(owned.directory, saved);
    await symlink(elsewhere, owned.directory, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await assert.rejects(removeSmokeDirectory(owned), /link or non-directory/);
      assert.equal(await readFile(path.join(elsewhere, 'keep.txt'), 'utf8'), 'must survive');
    } finally { await unlink(owned.directory); await rename(saved, owned.directory); }
    await removeSmokeDirectory(owned);
  } finally { await removeSmokeDirectory(outer); }
});

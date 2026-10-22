import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { TOOL_ROOT, type LoadedConfig } from '../packages/indexer/src/config.ts';
import { BridgeFiles, BridgeIdentity } from '../apps/server/src/bridge-auth.ts';
import { createSmokeDirectory, preparePrivateSmokeBridge, removeSmokeDirectory } from '../Tools/ci-smoke-directories.ts';

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

test('fresh package smoke bridge passes the actual runtime ACL gate and publishes independently protected credentials', async () => {
  const outer = await fixture();
  try {
    const owned = await createSmokeDirectory(outer.directory, TOOL_ROOT, 'smoke-cache-');
    const bridge = await preparePrivateSmokeBridge(owned);
    assert.equal(bridge, path.join(owned.directory, 'bridge'));
    const files = new BridgeFiles({ toolRoot: TOOL_ROOT, cacheDir: owned.directory } as LoadedConfig), identity = new BridgeIdentity(files);
    await identity.publish(4310);
    assert.equal(identity.published, true);
    const runtime = JSON.parse((await files.read('runtime.json'))!.toString('utf8'));
    assert.equal(runtime.serverEpoch, identity.serverEpoch); assert.equal(runtime.token, identity.token);
    assert.deepEqual(await readdir(bridge), ['runtime.json']);
    await files.removeRuntime(identity.serverEpoch);
    assert.deepEqual(await readdir(bridge), []);
    await removeSmokeDirectory(owned);
  } finally { await removeSmokeDirectory(outer); }
});

test('existing smoke bridge ACLs are preserved and an extra Windows grant still prevents credential publication', async () => {
  assert.equal(process.platform, 'win32', 'Package runtime permission regression requires actual Windows ACLs');
  const outer = await fixture();
  try {
    const owned = await createSmokeDirectory(outer.directory, TOOL_ROOT, 'smoke-cache-');
    const bridge = await preparePrivateSmokeBridge(owned);
    await writeFile(path.join(bridge, 'keep.txt'), 'pre-existing runtime data');
    const icacls = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/icacls.exe');
    await promisify(execFile)(icacls, [bridge, '/grant', '*S-1-5-32-544:(OI)(CI)R'], { windowsHide: true, timeout: 10000 });
    await assert.rejects(preparePrivateSmokeBridge(owned), { code: 'EEXIST' }, 'Setup must not reset an existing bridge ACL');
    const files = new BridgeFiles({ toolRoot: TOOL_ROOT, cacheDir: owned.directory } as LoadedConfig), identity = new BridgeIdentity(files);
    await assert.rejects(identity.publish(4310), { code: 'RUNTIME_PERMISSIONS' });
    assert.equal(identity.published, false); assert.equal(await files.read('runtime.json'), undefined);
    assert.equal(await readFile(path.join(bridge, 'keep.txt'), 'utf8'), 'pre-existing runtime data');
    assert.deepEqual(await readdir(bridge), ['keep.txt'], 'No credential, lock or ACL audit remains after rejection');
    await removeSmokeDirectory(owned);
  } finally { await removeSmokeDirectory(outer); }
});

test('private smoke initialization rejects altered owner markers and directory identities before creating a bridge', async () => {
  const outer = await fixture();
  try {
    const owned = await createSmokeDirectory(outer.directory, TOOL_ROOT, 'smoke-cache-');
    const markerPath = path.join(owned.directory, '.package-smoke-owner');
    await writeFile(markerPath, 'changed owner');
    await assert.rejects(preparePrivateSmokeBridge(owned), /ownership changed/);
    await assert.rejects(access(path.join(owned.directory, 'bridge')), { code: 'ENOENT' });
    await writeFile(markerPath, owned.marker);
    await assert.rejects(preparePrivateSmokeBridge({ ...owned }), /not issued by this process/, 'A copied marker/tuple is not an issued cache capability');
    const originalDevice = owned.device;
    owned.device = 'changed device';
    try { await assert.rejects(preparePrivateSmokeBridge(owned), /ownership tuple changed/); }
    finally { owned.device = originalDevice; }
    const saved = owned.directory + '-saved';
    await rename(owned.directory, saved);
    await mkdir(owned.directory);
    await writeFile(markerPath, owned.marker); // Matching marker alone cannot authorize a replacement directory.
    try {
      await assert.rejects(preparePrivateSmokeBridge(owned), /identity changed/);
      await assert.rejects(access(path.join(owned.directory, 'bridge')), { code: 'ENOENT' });
    } finally {
      await rename(owned.directory, owned.directory + '-replacement');
      await rename(saved, owned.directory);
    }
    await removeSmokeDirectory(owned);
  } finally { await removeSmokeDirectory(outer); }
});

test('private smoke initialization rejects cache, marker and bridge links while preserving their targets', async () => {
  const outer = await fixture();
  try {
    const owned = await createSmokeDirectory(outer.directory, TOOL_ROOT, 'smoke-cache-');
    const elsewhere = path.join(outer.directory, 'elsewhere');
    await mkdir(elsewhere);
    const sentinel = path.join(elsewhere, 'keep.txt');
    await writeFile(sentinel, 'must survive');
    const saved = owned.directory + '-saved';
    await rename(owned.directory, saved);
    await symlink(elsewhere, owned.directory, process.platform === 'win32' ? 'junction' : 'dir');
    try { await assert.rejects(preparePrivateSmokeBridge(owned), /link or non-directory/); }
    finally { await unlink(owned.directory); await rename(saved, owned.directory); }
    const marker = path.join(owned.directory, '.package-smoke-owner'), markerSaved = marker + '-saved';
    await rename(marker, markerSaved);
    await symlink(sentinel, marker, 'file');
    try { await assert.rejects(preparePrivateSmokeBridge(owned), /marker is a link/); }
    finally { await unlink(marker); await rename(markerSaved, marker); }
    const bridge = path.join(owned.directory, 'bridge');
    await symlink(elsewhere, bridge, process.platform === 'win32' ? 'junction' : 'dir');
    try { await assert.rejects(preparePrivateSmokeBridge(owned), { code: 'EEXIST' }); }
    finally { await unlink(bridge); }
    assert.equal(await readFile(sentinel, 'utf8'), 'must survive');
    assert.deepEqual(await readdir(elsewhere), ['keep.txt']);
    await removeSmokeDirectory(owned);
  } finally { await removeSmokeDirectory(outer); }
});

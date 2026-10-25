import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { BridgeFiles, BridgeIdentity, windowsRuntimeDaclIsPrivate } from '../apps/server/src/bridge-auth.ts';
import { TOOL_ROOT, type LoadedConfig } from '../packages/indexer/src/config.ts';
import { createPrivateBridgeFixture } from './fixtures/private-bridge.ts';

test('native SDDL aliases permit only the same current SID; other users and administrator groups remain rejected', async () => {
  assert.equal(process.platform, 'win32', 'Runtime permission checks require the actual Windows SID parser');
  const execute = promisify(execFile), system = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32');
  const who = await execute(path.join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
  const current = who.stdout.trim().match(/"(S-1-(?:\d+-)+\d+)"\s*$/)?.[1];
  assert.ok(current);
  const script = "[Security.AccessControl.RawSecurityDescriptor]::new('D:(A;;FA;;;LA)').DiscretionaryAcl[0].SecurityIdentifier.Value";
  const localAdmin = (await execute(path.join(system, 'WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true })).stdout.trim();
  assert.match(localAdmin, /^S-1-(?:\d+-)+500$/);
  assert.equal(await windowsRuntimeDaclIsPrivate('D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;LA)', localAdmin), true,
    'RID 500 alias is the same exact current user, not an additional allowed principal');
  assert.equal(await windowsRuntimeDaclIsPrivate(`bridge\r\nD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;${current})\r\n`, current), true);
  const otherUser = localAdmin.replace(/-500$/, '-1002');
  assert.equal(await windowsRuntimeDaclIsPrivate('D:P(A;;FA;;;SY)(A;;FA;;;LA)', otherUser), false,
    'LA must fail when it is not the exact current account');
  for (const sddl of [
    `D:P(A;;FA;;;SY)(A;;FA;;;${otherUser})`,
    'D:P(A;;FA;;;SY)(A;;FA;;;BA)',
    'D:P(A;;FA;;;SY)(A;;FA;;;BU)',
  ]) assert.equal(await windowsRuntimeDaclIsPrivate(sddl, localAdmin), false, sddl);
  assert.equal(await windowsRuntimeDaclIsPrivate('D:P(A;;FA;;;SY)(A;;FA;;;BA)', localAdmin), false,
    'administrator group is not the current administrator account');
  assert.equal(await windowsRuntimeDaclIsPrivate('D:(A;;FA;;;SY)(AU;SA;FA;;;WD)', current), false,
    'an unexpected DACL ACE type cannot be silently discarded');
  assert.equal(await windowsRuntimeDaclIsPrivate(`D:(D;;FR;;;BU)(A;;FA;;;SY)(A;;FA;;;${current})`, current), true,
    'a known deny entry never adds another allowed principal');
  for (const sddl of ['invalid', 'D:', 'D:(A;;FA;;;not-a-SID)']) assert.equal(await windowsRuntimeDaclIsPrivate(sddl, current), false);
});

test('an actual explicit Administrators grant prevents publishing runtime credentials', async t => {
  assert.equal(process.platform, 'win32', 'Runtime permission checks require actual Windows ACLs');
  const execute = promisify(execFile), system = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32');
  const base = path.join(TOOL_ROOT, '.tmp'); await mkdir(base, { recursive: true });
  const ownedRoot = await mkdtemp(path.join(base, 'bridge-control-'));
  t.after(() => rm(ownedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }));
  const toolRoot = path.join(ownedRoot, 'tool'); await mkdir(toolRoot);
  const config: LoadedConfig = { toolRoot, cacheDir: path.join(toolRoot, '.cache'), configPath: path.join(toolRoot, 'config.json'),
    fingerprint: 'bridge-acl-fixture', port: 4310, projects: [] };
  const files = new BridgeFiles(config);
  const directory = await createPrivateBridgeFixture(ownedRoot, config);
  await assert.rejects(createPrivateBridgeFixture(ownedRoot, config), { code: 'EEXIST' }, 'Fixture setup cannot reset an existing directory');
  await execute(path.join(system, 'icacls.exe'), [directory, '/grant', '*S-1-5-32-544:(OI)(CI)R'], { windowsHide: true, timeout: 10000 });
  const identity = new BridgeIdentity(files);
  await assert.rejects(identity.publish(4310), { code: 'RUNTIME_PERMISSIONS' });
  assert.equal(identity.published, false);
  assert.equal(await files.read('runtime.json'), undefined);
  assert.deepEqual(await readdir(directory), [], 'No credential, lock or audit file remains after rejection');
});

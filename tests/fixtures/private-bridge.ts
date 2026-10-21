import assert from 'node:assert/strict';
import path from 'node:path';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TOOL_ROOT, type LoadedConfig } from '../../packages/indexer/src/config.ts';
import { canonical, ensureCacheDirectory, isWithin } from '../../packages/indexer/src/security.ts';

/** Only prepare a newly created runtime directory inside these tests' owned mkdtemp root. */
export async function createPrivateBridgeFixture(ownedRoot: string, config: Pick<LoadedConfig, 'toolRoot' | 'cacheDir'>) {
  const temporary = path.join(TOOL_ROOT, '.tmp');
  assert.ok(isWithin(temporary, ownedRoot) && canonical(temporary) !== canonical(ownedRoot));
  assert.match(path.basename(ownedRoot), /^(bridge-control|mcp-stdio)-[A-Za-z0-9]+$/);
  assert.equal(canonical(await realpath(ownedRoot)), canonical(ownedRoot));
  assert.ok(!(await lstat(ownedRoot)).isSymbolicLink());
  assert.equal(canonical(config.toolRoot), canonical(path.join(ownedRoot, 'tool')));
  assert.equal(canonical(await realpath(config.toolRoot)), canonical(config.toolRoot));
  assert.ok(!(await lstat(config.toolRoot)).isSymbolicLink());
  const cache = await ensureCacheDirectory(config.cacheDir, config.toolRoot);
  const directory = path.join(cache, 'bridge');
  await mkdir(directory); // EEXIST is intentional: never reset a pre-existing runtime or user ACL.
  if (process.platform !== 'win32') { await chmod(directory, 0o700); return directory; }
  const script = String.raw`
$ErrorActionPreference='Stop'
$directory=[IO.Path]::GetFullPath($env:AE_BRIDGE_FIXTURE_DIRECTORY)
$root=[IO.Path]::GetFullPath($env:AE_BRIDGE_FIXTURE_ROOT).TrimEnd('\')+'\'
if(-not $directory.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'Fixture boundary rejected'}
if(-not [IO.Directory]::Exists($directory) -or ([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint)){throw 'Fixture link rejected'}
$current=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($current)
$acl.SetAccessRuleProtection($true,$false)
foreach($sid in @($current.Value,'S-1-5-18')){
  $principal=[Security.Principal.SecurityIdentifier]::new($sid)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
}
[IO.Directory]::SetAccessControl($directory,$acl)
`;
  const powershell = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 10000, maxBuffer: 8192, env: { ...process.env, AE_BRIDGE_FIXTURE_ROOT: ownedRoot, AE_BRIDGE_FIXTURE_DIRECTORY: directory } });
  return directory;
}

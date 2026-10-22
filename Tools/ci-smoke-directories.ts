import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { canonical, ensureCacheDirectory, isWithin } from '../packages/indexer/src/security.ts';

// Only the package smoke check's freshly created directories may be removed.
export interface SmokeDirectory {
  root: string; base: string; directory: string; marker: string; device: string; inode: string;
}
const issuedDirectories = new WeakMap<SmokeDirectory, Readonly<SmokeDirectory>>();

async function checkExistingDirectory(directory: string, root: string): Promise<void> {
  assert.ok(isWithin(root, directory) && canonical(root) !== canonical(directory), 'Smoke directory escaped its tool root');
  let current = root;
  for (const part of path.relative(root, directory).split(path.sep)) {
    current = path.join(current, part);
    const entry = await lstat(current);
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), 'Smoke directory contains a link or non-directory; preserved for diagnosis');
  }
  assert.equal(canonical(await realpath(directory)), canonical(directory), 'Smoke directory real path changed; preserved for diagnosis');
}

export async function createSmokeDirectory(base: string, root: string, prefix: string): Promise<SmokeDirectory> {
  assert.match(prefix, /^[a-z-]+-$/);
  const resolvedRoot = await realpath(root);
  const resolvedBase = await ensureCacheDirectory(base, resolvedRoot);
  const directory = await mkdtemp(path.join(resolvedBase, prefix));
  await checkExistingDirectory(directory, resolvedRoot);
  const marker = randomUUID();
  await writeFile(path.join(directory, '.package-smoke-owner'), marker, { flag: 'wx' });
  const entry = await lstat(directory, { bigint: true });
  const owned = { root: resolvedRoot, base: resolvedBase, directory, marker, device: String(entry.dev), inode: String(entry.ino) };
  issuedDirectories.set(owned, { ...owned });
  return owned;
}

async function checkOwnedSmokeDirectory(owned: SmokeDirectory): Promise<void> {
  assert.ok(isWithin(owned.base, owned.directory) && canonical(owned.base) !== canonical(owned.directory), 'Refusing to remove the smoke base');
  await checkExistingDirectory(owned.directory, owned.root);
  const entry = await lstat(owned.directory, { bigint: true });
  assert.equal(String(entry.dev), owned.device, 'Smoke directory device changed; preserved for diagnosis');
  assert.equal(String(entry.ino), owned.inode, 'Smoke directory identity changed; preserved for diagnosis');
  const markerPath = path.join(owned.directory, '.package-smoke-owner');
  const markerEntry = await lstat(markerPath);
  assert.ok(markerEntry.isFile() && !markerEntry.isSymbolicLink(), 'Smoke owner marker is a link or non-file; preserved for diagnosis');
  assert.equal(await readFile(markerPath, 'utf8'), owned.marker, 'Smoke ownership changed; preserved for diagnosis');
}

/** Prepare only the package check's new, owned runtime fixture; existing bridge ACLs are never repaired. */
export async function preparePrivateSmokeBridge(owned: SmokeDirectory): Promise<string> {
  const checkIssued = () => {
    const issued = issuedDirectories.get(owned);
    assert.ok(issued, 'Smoke cache was not issued by this process');
    assert.deepEqual(owned, issued, 'Smoke cache ownership tuple changed');
  };
  checkIssued();
  assert.match(path.basename(owned.directory), /^smoke-cache-[A-Za-z0-9]+$/);
  await checkOwnedSmokeDirectory(owned);
  const directory = path.join(owned.directory, 'bridge');
  await mkdir(directory); // EEXIST is intentional: never reset any existing directory or link.
  const entry = await lstat(directory, { bigint: true });
  const checkFreshBridge = async () => {
    checkIssued();
    await checkOwnedSmokeDirectory(owned);
    await checkExistingDirectory(directory, owned.root);
    const observed = await lstat(directory, { bigint: true });
    assert.equal(observed.dev, entry.dev, 'Smoke bridge device changed; preserved for diagnosis');
    assert.equal(observed.ino, entry.ino, 'Smoke bridge identity changed; preserved for diagnosis');
  };
  await checkFreshBridge();
  if (process.platform === 'win32') {
    const script = String.raw`
$ErrorActionPreference='Stop'
$cache=[IO.Path]::GetFullPath($env:AE_SMOKE_CACHE_DIRECTORY)
$directory=[IO.Path]::GetFullPath($env:AE_SMOKE_BRIDGE_DIRECTORY)
$root=[IO.Path]::GetFullPath($env:AE_SMOKE_TOOL_ROOT).TrimEnd('\')+'\'
if(-not $cache.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -or $directory -ne [IO.Path]::Combine($cache,'bridge')){throw 'Smoke bridge boundary rejected'}
$currentPath=$directory
while($currentPath.Length -ge $root.Length){
  if(-not [IO.Directory]::Exists($currentPath) -or ([IO.File]::GetAttributes($currentPath) -band [IO.FileAttributes]::ReparsePoint)){throw 'Smoke bridge link rejected'}
  $currentPath=[IO.Path]::GetDirectoryName($currentPath)
}
$marker=[IO.Path]::Combine($cache,'.package-smoke-owner')
if(([IO.File]::GetAttributes($marker) -band [IO.FileAttributes]::ReparsePoint) -or [IO.File]::ReadAllText($marker) -cne $env:AE_SMOKE_OWNER_MARKER){throw 'Smoke bridge owner changed'}
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
      { windowsHide: true, timeout: 10000, maxBuffer: 8192, env: { ...process.env, AE_SMOKE_TOOL_ROOT: owned.root,
        AE_SMOKE_CACHE_DIRECTORY: owned.directory, AE_SMOKE_BRIDGE_DIRECTORY: directory, AE_SMOKE_OWNER_MARKER: owned.marker } });
  } else await chmod(directory, 0o700);
  await checkFreshBridge();
  return directory;
}

export async function removeSmokeDirectory(owned: SmokeDirectory): Promise<void> {
  await checkOwnedSmokeDirectory(owned);
  await rm(owned.directory, { recursive: true });
}

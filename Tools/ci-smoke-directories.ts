import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { canonical, ensureCacheDirectory, isWithin } from '../packages/indexer/src/security.ts';

// Only the package smoke check's freshly created directories may be removed.
export interface SmokeDirectory {
  root: string; base: string; directory: string; marker: string; device: string; inode: string;
}

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
  return { root: resolvedRoot, base: resolvedBase, directory, marker, device: String(entry.dev), inode: String(entry.ino) };
}

export async function removeSmokeDirectory(owned: SmokeDirectory): Promise<void> {
  assert.ok(isWithin(owned.base, owned.directory) && canonical(owned.base) !== canonical(owned.directory), 'Refusing to remove the smoke base');
  await checkExistingDirectory(owned.directory, owned.root);
  const entry = await lstat(owned.directory, { bigint: true });
  assert.equal(String(entry.dev), owned.device, 'Smoke directory device changed; preserved for diagnosis');
  assert.equal(String(entry.ino), owned.inode, 'Smoke directory identity changed; preserved for diagnosis');
  const markerPath = path.join(owned.directory, '.package-smoke-owner');
  assert.ok(!(await lstat(markerPath)).isSymbolicLink(), 'Smoke owner marker is a link; preserved for diagnosis');
  assert.equal(await readFile(markerPath, 'utf8'), owned.marker, 'Smoke ownership changed; preserved for diagnosis');
  await rm(owned.directory, { recursive: true });
}

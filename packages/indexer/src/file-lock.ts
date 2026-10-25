import path from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { link, open, unlink } from 'node:fs/promises';
import { contentHash } from '../../schema/src/index.ts';
import { canonical, ensureCacheDirectory, readAuthorized } from './security.ts';

interface Owner { version: 1; pid: number; host: string; token: string }
interface LockOptions { toolRoot: string; lockPath: string; locked: () => Error }
const host = hostname();
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function ownerOf(bytes: string): Owner | undefined {
  try {
    const value = JSON.parse(bytes) as Owner;
    if (value.version === 1 && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.host === 'string' && typeof value.token === 'string' && uuid.test(value.token)) return value;
  } catch { /* Older model, overlay and scan locks contained pid:UUID. */ }
  const legacy = bytes.match(/^(\d+):([a-f0-9-]+)$/i);
  const pid = Number(legacy?.[1]);
  if (legacy && Number.isSafeInteger(pid) && pid > 0 && uuid.test(legacy[2])) return { version: 1, pid, host, token: legacy[2] };
  return undefined;
}

function hasExited(owner: Owner): boolean {
  if (owner.host !== host || owner.pid === process.pid) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

/** An initialized inode is linked into place atomically, so a crash cannot leave
 * an ownerless lock between exclusive creation and writing the owner record.
 * Recovery is serialized per dead ownership generation. The recovery guard uses
 * this same protocol, allowing it to recover from a reclaimer crash as well. */
export async function withFileLock<T>(options: LockOptions, action: () => Promise<T>): Promise<T> {
  return locked(options, action, 0);
}

async function locked<T>(options: LockOptions, action: () => Promise<T>, depth: number): Promise<T> {
  if (depth > 16) throw options.locked();
  const { toolRoot } = options;
  const directory = await ensureCacheDirectory(path.dirname(path.resolve(options.lockPath)), toolRoot);
  const lockPath = path.join(directory, path.basename(options.lockPath));
  const relative = path.relative(toolRoot, lockPath).replaceAll('\\', '/');
  const read = async () => {
    try { return (await readAuthorized(toolRoot, relative, 2048)).toString('utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  };
  const owner: Owner = { version: 1, pid: process.pid, host, token: randomUUID() };
  const bytes = JSON.stringify(owner), prepared = `${lockPath}.${owner.token}.tmp`;
  let held = false;
  const file = await open(prepared, 'wx', 0o600);
  try {
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    for (let attempt = 0; attempt < 8 && !held; attempt++) {
      try { await link(prepared, lockPath); held = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const previous = await read();
        if (previous === undefined) continue;
        const oldOwner = ownerOf(previous);
        // Unknown/foreign/live owners (including EPERM when probing a PID) are
        // never reclaimed. No timeout or wall-clock age can prove ownership died.
        if (!oldOwner || !hasExited(oldOwner)) throw options.locked();
        const recoveryPath = path.join(path.dirname(lockPath), `.lock-recovery-${contentHash(canonical(lockPath) + '|' + oldOwner.token).slice(0, 32)}.lock`);
        await locked({ ...options, lockPath: recoveryPath }, async () => {
          // A contender may already have recovered this generation and acquired
          // a new lock. Holding the generation guard makes compare/unlink safe
          // among cooperating reclaimers; never unlink a replacement owner.
          if (await read() !== previous) return;
          if (!hasExited(oldOwner)) throw options.locked();
          await unlink(lockPath);
        }, depth + 1);
      }
    }
    if (!held) throw options.locked();
    await unlink(prepared);
    return await action();
  } finally {
    await file.close().catch(() => {});
    await unlink(prepared).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    if (held && await read() === bytes) await unlink(lockPath);
  }
}

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

export type Item = { name: string; raw?: string; json?: unknown; attributes?: number; declaredBytes?: number };
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const code = 'NATIVE_ZIP_FIXTURE_REJECTED', requestBudget = 60000;
const owned = new Map<string, { dev: bigint; ino: bigint }>();
const folded = (value: string) => path.resolve(value).toLowerCase();
function need(value: unknown): asserts value { if (!value) throw Error(code); }
async function noLinks(absolute: string) {
  let cursor = path.parse(absolute).root;
  for (const part of path.relative(cursor, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part); need(!(await lstat(cursor)).isSymbolicLink());
  }
}
async function fixtureBase() {
  const workspace = await realpath(process.cwd()), base = path.join(workspace, '.tmp');
  await mkdir(base, { recursive: true }); await noLinks(base); need(await realpath(base) === base); return base;
}

/** Creates a fresh test-owned directory without adding files that would change archive assertions. */
export async function createNativeFixtureDirectory(base: string, prefix: string): Promise<string> {
  const allowed = await fixtureBase(), absolute = path.resolve(base);
  need(path.isAbsolute(base) && (folded(absolute) === folded(allowed) || folded(absolute).startsWith(folded(allowed) + path.sep)));
  need(['archive-', 'release-draft-integration-', 'native-zip-factory-case-'].includes(prefix));
  let cursor = allowed;
  for (const part of path.relative(allowed, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { await lstat(cursor); } catch (error) {
      need((error as NodeJS.ErrnoException).code === 'ENOENT'); await mkdir(cursor);
    }
    const current = await lstat(cursor); need(current.isDirectory() && !current.isSymbolicLink());
  }
  await noLinks(absolute);
  const directory = await mkdtemp(path.join(absolute, prefix)), info = await lstat(directory, { bigint: true });
  need(info.isDirectory() && !info.isSymbolicLink()); owned.set(folded(directory), { dev: info.dev, ino: info.ino }); return directory;
}
async function ownedDestination(destination: string) {
  need(typeof destination === 'string' && path.isAbsolute(destination) && /^[A-Za-z]:[\\/]/.test(destination) &&
    !destination.slice(2).includes(':') && !/[\x00-\x1f\x7f]/.test(destination) && /^[A-Za-z0-9_-]+\.zip$/.test(path.basename(destination)));
  const absolute = path.resolve(destination), parent = path.dirname(absolute);
  const match = [...owned.entries()].find(([root]) => folded(parent) === root || folded(parent).startsWith(root + path.sep)); need(match);
  const [root, identity] = match, current = await lstat(root, { bigint: true });
  need(!current.isSymbolicLink() && current.isDirectory() && current.dev === identity.dev && current.ino === identity.ino);
  await noLinks(parent);
  try { await lstat(absolute); throw Error(code); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error(code); }
  return absolute;
}
function normalize(items: Item[], repeatEntries: number) {
  need(Array.isArray(items) && items.length > 0 && items.length <= 1000 && Number.isInteger(repeatEntries) && repeatEntries >= 0 && repeatEntries <= 200000);
  let bytes = 0;
  return items.map(item => {
    need(item !== null && typeof item === 'object' && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 4096);
    need(Object.keys(item).every(key => ['name', 'raw', 'json', 'attributes', 'declaredBytes'].includes(key)));
    need(item.attributes === undefined || Number.isInteger(item.attributes) && item.attributes >= 0 && item.attributes <= 0xffffffff);
    need(item.declaredBytes === undefined || Number.isSafeInteger(item.declaredBytes) && item.declaredBytes >= 0 && item.declaredBytes <= 2147483649);
    const raw = item.raw ?? Buffer.from(item.json === undefined ? '' : JSON.stringify(item.json)).toString('base64');
    need(typeof raw === 'string' && Buffer.from(raw, 'base64').toString('base64') === raw); bytes += raw.length; need(bytes <= 16 * 1024 * 1024);
    return { name: item.name, raw, ...(item.attributes === undefined ? {} : { attributes: item.attributes }),
      ...(item.declaredBytes === undefined ? {} : { declaredBytes: item.declaredBytes }) };
  });
}
// Fixed trusted writer: all hostile names remain ZIP metadata; no extraction or caller-controlled scripts/paths.
const factoryScript = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try {
  Add-Type -AssemblyName System.IO.Compression
  [Console]::WriteLine('{"ready":true}')
  while($null -ne ($line=[Console]::ReadLine())) {
    if($line.Length -gt 16MB){throw 'reject'}
    $request=ConvertFrom-Json $line
    if((@($request.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'id,items,repeatEntries'){throw 'reject'}
    if($request.id -cnotmatch '^case-[0-9]{6}$' -or $request.repeatEntries -lt 0 -or $request.repeatEntries -gt 200000){throw 'reject'}
    $file=$null; $zip=$null
    try {
      $file=[IO.File]::Open((Join-Path $env:ZIP_FIXTURE_ROOT ($request.id+'.zip')),[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
      $zip=[IO.Compression.ZipArchive]::new($file,[IO.Compression.ZipArchiveMode]::Create,$true)
      foreach($item in $request.items){
        $entry=$zip.CreateEntry($item.name,[IO.Compression.CompressionLevel]::Optimal)
        $bytes=[Convert]::FromBase64String($item.raw); $stream=$entry.Open()
        try {$stream.Write($bytes,0,$bytes.Length)} finally {$stream.Dispose()}
        if($null -ne $item.attributes){$entry.ExternalAttributes=[BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]$item.attributes),0)}
        if($null -ne $item.declaredBytes){
          $field=[IO.Compression.ZipArchiveEntry].GetField('_uncompressedSize',[Reflection.BindingFlags]'NonPublic,Instance')
          if(!$field){throw 'reject'}
          $field.SetValue($entry,[long]$item.declaredBytes)
        }
      }
      for($index=0;$index -lt [int]$request.repeatEntries;$index++){$null=$zip.CreateEntry('empty-'+$index)}
    } finally {if($zip){$zip.Dispose()};if($file){$file.Dispose()}}
    [Console]::WriteLine(('{"id":"'+$request.id+'","ok":true}'))
  }
} catch { [Console]::Error.Write('NATIVE_ZIP_FIXTURE_REJECTED'); exit 1 }
`;

let child: ChildProcessWithoutNullStreams | undefined, spool: string | undefined, marker = '', spoolIdentity: { dev: bigint; ino: bigint } | undefined;
let starts = 0, requests = 0, closing = false, closed = false, childExited = false, spoolRemoved = false, broken = false;
let queue: Promise<unknown> = Promise.resolve(), ready: Promise<void> | undefined, exit: Promise<number | null> | undefined;
let active: { id: string; resolve: () => void; reject: () => void; timer: ReturnType<typeof setTimeout> } | undefined;
let rejectReady: (() => void) | undefined;
function fail() { broken = true; rejectReady?.(); if (active) { clearTimeout(active.timer); active.reject(); active = undefined; } if (child && !childExited) child.kill(); }
async function start() {
  if (ready) return ready;
  const base = await fixtureBase(); spool = await mkdtemp(path.join(base, 'native-zip-factory-')); marker = randomUUID();
  await writeFile(path.join(spool, '.factory-owner'), marker, { flag: 'wx' });
  const info = await lstat(spool, { bigint: true }); spoolIdentity = { dev: info.dev, ino: info.ino };
  ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(fail, requestBudget); rejectReady = () => { clearTimeout(timer); reject(Error(code)); };
    child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(factoryScript, 'utf16le').toString('base64')], {
      windowsHide: true, cwd: spool, env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows',
        TEMP: os.tmpdir(), TMP: os.tmpdir(), ZIP_FIXTURE_ROOT: spool }, stdio: ['pipe', 'pipe', 'pipe'],
    }); starts++;
    let initialized = false, errorBytes = 0;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      try {
        need(line.length <= 4096); const message = JSON.parse(line);
        if (!initialized) { need(message.ready === true && Object.keys(message).length === 1); initialized = true; clearTimeout(timer); rejectReady = undefined; resolve(); return; }
        need(active && message.id === active.id && message.ok === true && Object.keys(message).length === 2);
        clearTimeout(active.timer); const finished = active.resolve; active = undefined; finished();
      } catch { fail(); }
    });
    child.stderr.on('data', chunk => { errorBytes += chunk.length; if (errorBytes > 8192) fail(); });
    child.stdin.on('error', fail);
    child.once('error', fail);
    exit = new Promise(done => child!.once('close', code => { childExited = true; lines.close();
      if (!closing || code !== 0 || active || !initialized) fail(); done(code); }));
  });
  return ready;
}

/** Existing fixture API; one serialized native writer is lazily started per test-file worker. */
export async function createNativeFixtureZip(zip: string, items: Item[], repeatEntries = 0): Promise<void> {
  need(!closing && !closed && !broken);
  const normalized = normalize(items, repeatEntries), destination = await ownedDestination(zip);
  const job = queue.then(async () => {
    need(!broken); const began = Date.now(); await start(); need(!broken);
    const remaining = requestBudget - (Date.now() - began); need(remaining > 0);
    const id = `case-${String(++requests).padStart(6, '0')}`; need(requests <= 999999);
    const text = JSON.stringify({ id, items: normalized, repeatEntries }); need(Buffer.byteLength(text) <= 16 * 1024 * 1024);
    await new Promise<void>((resolve, reject) => {
      active = { id, resolve, reject: () => reject(Error(code)), timer: setTimeout(fail, remaining) };
      child!.stdin.write(text + '\n', 'utf8', error => { if (error) fail(); });
    });
    const original = path.join(spool!, id + '.zip'); await noLinks(original); need((await lstat(original)).isFile());
    await ownedDestination(destination); await copyFile(original, destination, constants.COPYFILE_EXCL);
  });
  queue = job.catch(() => {}); await job;
}
export function nativeFixtureFactoryStatus() { return { starts, requests, closed, childExited, spoolRemoved }; }
async function boundedExit(milliseconds: number): Promise<{ ended: boolean; code?: number | null }> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ ended: false }), milliseconds);
    void exit!.then(code => { clearTimeout(timer); resolve({ ended: true, code }); });
  });
}

/** Explicit node:test after-hook cleanup, never a hidden test or an automatic subprocess restart. */
export async function closeNativeFixtureZipFactory(): Promise<void> {
  if (closed) return; closing = true; await queue;
  let failure = broken;
  if (child) {
    child.stdin.end(); let result = await boundedExit(10000);
    if (!result.ended) { failure = true; child.kill(); result = await boundedExit(2000); }
    if (!result.ended) {
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
      throw Error(code); // Preserve the owned spool if the writer's exit could not be proven.
    }
    if (result.code !== 0) failure = true;
  } else childExited = true;
  if (spool) {
    const base = await fixtureBase(), resolved = await realpath(spool), current = await lstat(spool, { bigint: true });
    need(path.dirname(resolved) === base && path.basename(resolved).startsWith('native-zip-factory-') && !current.isSymbolicLink() &&
      current.dev === spoolIdentity!.dev && current.ino === spoolIdentity!.ino && await readFile(path.join(spool, '.factory-owner'), 'utf8') === marker);
    await rm(resolved, { recursive: true }); spoolRemoved = true;
  } else spoolRemoved = true;
  closed = true; need(!failure);
}

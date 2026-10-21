import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { TOOL_ROOT } from '../packages/indexer/src/index.ts';
import { contentHash } from '../packages/schema/src/index.ts';

const execute = promisify(execFile);
interface ZipEntry { name: string; content: string; attributes?: number }
const referenceEntries: ZipEntry[] = [
  { name: 'references.json', content: '{"fixture":"ZIP transport guard only; never used by an analyzer"}' },
  { name: 'UnityEngine.CoreModule.dll', content: 'Test data bytes, not an assembly and not Unity type stubs.' },
];

// Minimal uncompressed ZIP fixture writer permits explicit path and Unix link attributes.
function fixtureZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [], directory: Buffer[] = []; let offset = 0;
  const crc32 = (bytes: Buffer) => {
    let crc = 0xffffffff;
    for (const value of bytes) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  };
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.content), checksum = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entry.attributes ?? 0) >>> 0, 38); central.writeUInt32LE(offset, 42);
    chunks.push(local, name, data); directory.push(central, name); offset += local.length + name.length + data.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, central, end]);
}

async function referencesFixture(entries: ZipEntry[], suppliedHash?: string, download?: { url: string; error: string }) {
  await mkdir(path.join(TOOL_ROOT, '.tmp'), { recursive: true });
  const directory = await mkdtemp(path.join(TOOL_ROOT, '.tmp', 'ci-references-test-'));
  const root = path.join(directory, 'tool'), script = path.join(root, 'Tools/ci-references.ps1');
  await mkdir(path.dirname(script), { recursive: true }); await writeFile(script, await readFile(path.join(TOOL_ROOT, 'Tools/ci-references.ps1')));
  const zip = fixtureZip(entries), archive = path.join(directory, 'fixture.zip'); await writeFile(archive, zip);
  const run = () => execute('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference='Stop'
    function Invoke-WebRequest {
      param([Uri]$Uri,[string]$OutFile,[int]$MaximumRedirection,[int]$TimeoutSec,$ErrorAction)
      if($Uri.AbsoluteUri -cne $env:CI_REFERENCE_FIXTURE_URL -or $MaximumRedirection -ne 0 -or $TimeoutSec -ne 120){throw 'Unexpected network request, redirect or timeout policy'}
      if($env:CI_REFERENCE_DOWNLOAD_ERROR){throw $env:CI_REFERENCE_DOWNLOAD_ERROR}
      Copy-Item -LiteralPath $env:CI_REFERENCE_FIXTURE_ZIP -Destination $OutFile
    }
    & $env:CI_REFERENCE_FIXTURE_SCRIPT
  `], { cwd: root, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
    env: { ...process.env, UNITY_REFERENCES_URL: download?.url ?? 'https://metadata.example.invalid/unity.zip', UNITY_REFERENCES_SHA256: suppliedHash ?? contentHash(zip),
      CI_REFERENCE_FIXTURE_URL: download?.url ?? 'https://metadata.example.invalid/unity.zip', CI_REFERENCE_DOWNLOAD_ERROR: download?.error ?? '',
      CI_REFERENCE_FIXTURE_ZIP: archive, CI_REFERENCE_FIXTURE_SCRIPT: script } });
  return { directory, root, run, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('pinned metadata ZIP transport extracts only allowlisted root files with redirects disabled', async () => {
  const f = await referencesFixture(referenceEntries);
  try {
    await f.run();
    assert.equal(await readFile(path.join(f.root, '.ci-references/references.json'), 'utf8'), referenceEntries[0].content);
    assert.equal(await readFile(path.join(f.root, '.ci-references/UnityEngine.CoreModule.dll'), 'utf8'), referenceEntries[1].content);
    // The bytes deliberately never pass to prepareReferences or any C# worker.
  } finally { await f.cleanup(); }
});

test('metadata ZIP requires an exact lowercase pin and rejects mismatched archive bytes before extraction', async () => {
  for (const [hash, message] of [['A'.repeat(64), /exact Unity metadata ZIP SHA256/], ['0'.repeat(64), /ZIP fingerprint mismatch/]] as const) {
    const f = await referencesFixture(referenceEntries, hash);
    try { await assert.rejects(f.run(), message); await assert.rejects(access(path.join(f.root, '.ci-references/references.json'))); }
    finally { await f.cleanup(); }
  }
});

test('metadata ZIP rejects parent traversal and absolute paths before extracting any references', async () => {
  for (const name of ['../escaped.dll', '..\\escaped.dll', 'C:/escaped.dll']) {
    const f = await referencesFixture([...referenceEntries, { name, content: 'must not escape' }]);
    try {
      await assert.rejects(f.run(), /only accepts root/);
      await assert.rejects(access(path.join(f.root, '.ci-references/references.json')));
      await assert.rejects(access(path.join(f.root, 'escaped.dll')));
    } finally { await f.cleanup(); }
  }
});

test('metadata ZIP rejects Unix symbolic links and duplicate assembly names', async () => {
  for (const entry of [{ name: 'link.dll', content: '../elsewhere.dll', attributes: 0xa1ff0000 }, { name: 'unityengine.coremodule.dll', content: 'duplicate' }]) {
    const f = await referencesFixture([...referenceEntries, entry]);
    try { await assert.rejects(f.run(), /links are prohibited|uniquely named DLLs/); await assert.rejects(access(path.join(f.root, '.ci-references/references.json'))); }
    finally { await f.cleanup(); }
  }
});

test('metadata ZIP rejects slash and backslash directory entries consistently before extraction', async () => {
  for (const name of ['unexpected/', '..\\escaped\\']) {
    const f = await referencesFixture([...referenceEntries, { name, content: '' }]);
    try { await assert.rejects(f.run(), /directory|only accepts root/i); await assert.rejects(access(path.join(f.root, '.ci-references/references.json'))); }
    finally { await f.cleanup(); }
  }
});

test('expired private metadata URLs fail without disclosing URL or signature in diagnostics', async () => {
  const url = 'https://metadata.example.invalid/unity.zip?signature=fixture-secret-token';
  const f = await referencesFixture(referenceEntries, undefined, { url, error: `403 download failed for ${url}` });
  try {
    await assert.rejects(f.run(), error => {
      const diagnostic = `${(error as Error).message}\n${(error as { stderr?: string }).stderr ?? ''}\n${(error as { stdout?: string }).stdout ?? ''}`;
      assert.match(diagnostic, /Unity metadata download failed/);
      assert.ok(!diagnostic.includes('fixture-secret-token') && !diagnostic.includes('https://metadata.example.invalid'));
      return true;
    });
    await assert.rejects(access(path.join(f.root, '.ci-references/references.json')));
  } finally { await f.cleanup(); }
});

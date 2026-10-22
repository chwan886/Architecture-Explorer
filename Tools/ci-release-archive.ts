import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, open } from 'node:fs/promises';

export type ReleaseArchiveKind = 'tool' | 'index' | 'checks';
export interface ReleaseArchiveIdentity { toolSha: string; gameSha: string; runId: string; producerAttempt: string }
export interface ReleaseArchiveEntry { path: string; size: number; externalAttributes: number; isDirectory: boolean }
/** Raw uncompressed bytes of the fixed full index entry, hashed without parsing or buffering it as JSON. */
export interface ReleaseIndexFileObservation { path: string; size: number; sha256: string }
export interface ReleaseArchiveObservation {
  actualZipSha256: string; actualZipBytes: number; entries: ReleaseArchiveEntry[]; documents: Record<string, unknown>;
  indexFile?: ReleaseIndexFileObservation;
}
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const compressedLimit = 512 * 1024 * 1024, expandedLimit = 2 * 1024 * 1024 * 1024;
const documentLimit = 32 * 1024 * 1024, documentsLimit = 64 * 1024 * 1024;
const nativeOutputLimit = 160 * 1024 * 1024, pathBytesLimit = 32 * 1024 * 1024, entryLimit = 200000;
function fail(code: string): never { throw new Error(code); }
function need(value: unknown, code: string): asserts value { if (!value) fail(code); }
function exact(value: unknown, expression: RegExp): value is string {
  return typeof value === 'string' && expression.exec(value)?.[0] === value;
}
function selectedDocuments(kind: ReleaseArchiveKind, identity: ReleaseArchiveIdentity): string[] {
  need(['tool', 'index', 'checks'].includes(kind), 'RELEASE_ARCHIVE_KIND_INVALID');
  need(identity !== null && typeof identity === 'object' && !Array.isArray(identity) &&
    Object.keys(identity).sort().join(',') === 'gameSha,producerAttempt,runId,toolSha' &&
    exact(identity.toolSha, /^[a-f0-9]{40}$/) && exact(identity.gameSha, /^[a-f0-9]{40}$/) &&
    exact(identity.runId, /^[1-9][0-9]{0,19}$/) && exact(identity.producerAttempt, /^[1-9][0-9]{0,19}$/), 'RELEASE_ARCHIVE_IDENTITY_INVALID');
  if (kind === 'tool') return ['build-manifest.json'];
  if (kind === 'checks') return ['delivery-result.json', `package-smoke-tool-${identity.toolSha}-${identity.runId}-${identity.producerAttempt}.json`];
  const prefix = `${identity.gameSha}/${identity.runId}-${identity.producerAttempt}/index-evidence/`;
  return ['manifest', 'audit', 'read-only-before', 'read-only-after', 'references'].map(name => `${prefix}${name}.json`).concat('authorization/authorization.json');
}
function fullIndexPath(kind: ReleaseArchiveKind, identity: ReleaseArchiveIdentity): string | undefined {
  return kind === 'index' ? `${identity.gameSha}/${identity.runId}-${identity.producerAttempt}/index-evidence/index.json` : undefined;
}
async function regularArchive(archive: string) {
  need(typeof archive === 'string' && path.isAbsolute(archive) && /^[A-Za-z]:[\\/]/.test(archive) &&
    !archive.slice(2).includes(':') && !/[\x00-\x1f\x7f]/.test(archive) && /\.zip$/i.test(archive), 'RELEASE_ARCHIVE_PATH_INVALID');
  let current = path.parse(archive).root;
  for (const part of path.relative(current, archive).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    need(!(await lstat(current)).isSymbolicLink(), 'RELEASE_ARCHIVE_LINK_REJECTED');
  }
  const entry = await lstat(archive, { bigint: true });
  need(entry.isFile() && entry.nlink === 1n && entry.size > 0n && entry.size <= BigInt(compressedLimit), 'RELEASE_ARCHIVE_FILE_OR_SIZE_INVALID');
  return entry;
}
function sameFile(before: Awaited<ReturnType<typeof regularArchive>>, after: Awaited<ReturnType<typeof regularArchive>>) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}
async function zipDigest(archive: string): Promise<string> {
  const handle = await open(archive, 'r');
  try {
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead; need(position <= compressedLimit, 'RELEASE_ARCHIVE_CHANGED');
      hash.update(buffer.subarray(0, bytesRead));
    }
    buffer.fill(0); return hash.digest('hex');
  } finally { await handle.close(); }
}
function safeEntry(value: any): ReleaseArchiveEntry {
  need(value !== null && typeof value === 'object' && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 2048 &&
    !/[\x00-\x1f\x7f\ufffd]/.test(value.path) && !value.path.includes('\\') && !value.path.includes(':') && !value.path.startsWith('/') && typeof value.isDirectory === 'boolean', 'RELEASE_ARCHIVE_ENTRY_INVALID');
  const name = value.isDirectory ? value.path.slice(0, -1) : value.path;
  need(value.isDirectory ? value.path.endsWith('/') : !value.path.endsWith('/'), 'RELEASE_ARCHIVE_ENTRY_INVALID');
  need(name.split('/').every((part: string) => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\..*)?$/i.test(part)), 'RELEASE_ARCHIVE_ENTRY_INVALID');
  need(Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= expandedLimit && Number.isInteger(value.externalAttributes) &&
    value.externalAttributes >= 0 && value.externalAttributes <= 0xffffffff, 'RELEASE_ARCHIVE_ENTRY_INVALID');
  const unixType = (value.externalAttributes >>> 16) & 0xf000;
  need([0, 0x8000, 0x4000].includes(unixType) && !(value.externalAttributes & 0x400) &&
    (value.isDirectory ? value.size === 0 && unixType !== 0x8000 : unixType !== 0x4000 && !(value.externalAttributes & 0x10)), 'RELEASE_ARCHIVE_LINK_OR_TYPE_REJECTED');
  return { path: value.path, size: value.size, externalAttributes: value.externalAttributes, isDirectory: value.isDirectory };
}

// Static native parser, never extraction or target execution. Errors contain only a fixed code.
const archiveScript = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$file=$null; $zip=$null; $sha=$null; $indexSha=$null
try {
  Add-Type -AssemblyName System.IO.Compression
  $selected=[string[]](ConvertFrom-Json $env:AE_RELEASE_DOCUMENT_PATHS)
  if($selected.Count -lt 1 -or $selected.Count -gt 6){throw 'reject'}
  $indexPath=[string]$env:AE_RELEASE_INDEX_PATH; $indexEntry=$null
  $file=[IO.File]::Open($env:AE_RELEASE_ARCHIVE_PATH,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  if($file.Length -lt 1 -or $file.Length -gt 512MB){throw 'reject'}
  $bytes=$file.Length; $sha=[Security.Cryptography.SHA256]::Create()
  $beforeHash=[BitConverter]::ToString($sha.ComputeHash($file)).Replace('-','').ToLowerInvariant(); $file.Position=0
  $zip=[IO.Compression.ZipArchive]::new($file,[IO.Compression.ZipArchiveMode]::Read,$true)
  if($zip.Entries.Count -lt 1 -or $zip.Entries.Count -gt 200000){throw 'reject'}
  $names=[Collections.Generic.Dictionary[string,bool]]::new([StringComparer]::OrdinalIgnoreCase)
  $selectedEntries=[Collections.Generic.Dictionary[string,IO.Compression.ZipArchiveEntry]]::new([StringComparer]::Ordinal)
  $entries=[Collections.Generic.List[object]]::new(); $total=0L; $selectedTotal=0L; $pathBytes=0L
  foreach($entry in $zip.Entries){
    $name=$entry.FullName; $directory=$name.EndsWith('/'); $plain=if($directory){$name.Substring(0,$name.Length-1)}else{$name}
    if($name.Length -lt 1 -or $name.Length -gt 2048 -or $name -match '[\x00-\x1f\x7f\ufffd\\:]' -or $name.StartsWith('/')){throw 'reject'}
    foreach($part in $plain.Split('/')){
      if(!$part -or $part -eq '.' -or $part -eq '..' -or $part -match '[. ]$' -or $part -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(\..*)?$'){throw 'reject'}
    }
    if($names.ContainsKey($plain)){throw 'reject'}; $names.Add($plain,$directory)
    $pathBytes+=[Text.Encoding]::UTF8.GetByteCount($name); if($pathBytes -gt 32MB){throw 'reject'}
    $attributes=[BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$entry.ExternalAttributes),0)
    $unixType=($attributes -shr 16) -band 0xF000
    if($unixType -notin @(0,0x8000,0x4000) -or ($attributes -band 0x400) -ne 0){throw 'reject'}
    if(($directory -and ($entry.Length -ne 0 -or $unixType -eq 0x8000)) -or (!$directory -and ($unixType -eq 0x4000 -or ($attributes -band 0x10) -ne 0))){throw 'reject'}
    if($entry.Length -lt 0 -or $entry.Length -gt 2GB){throw 'reject'}; $total+=$entry.Length; if($total -gt 2GB){throw 'reject'}
    if($selected -ccontains $name){
      if($directory -or $entry.Length -gt 32MB){throw 'reject'}
      $selectedTotal+=$entry.Length; if($selectedTotal -gt 64MB){throw 'reject'}
      $selectedEntries.Add($name,$entry)
    }
    if($indexPath -and $name -ceq $indexPath){
      if($directory -or $entry.Length -lt 1){throw 'reject'}
      $indexEntry=$entry
    }
    $entries.Add(@{path=$name;size=$entry.Length;externalAttributes=$attributes;isDirectory=$directory})
  }
  foreach($name in $names.Keys){
    $parts=$name.Split('/')
    for($count=1;$count -lt $parts.Length;$count++){
      $ancestor=[string]::Join('/',$parts[0..($count-1)])
      if($names.ContainsKey($ancestor) -and !$names[$ancestor]){throw 'reject'}
    }
  }
  $documents=@{}; $actualSelectedTotal=0L; $buffer=[byte[]]::new(65536); $utf8=[Text.UTF8Encoding]::new($false,$true)
  foreach($name in $selected){
    if(!$selectedEntries.ContainsKey($name)){throw 'reject'}
    $entry=$selectedEntries[$name]; $stream=$null; $memory=$null; $readTotal=0L
    try {
      $stream=$entry.Open(); $memory=[IO.MemoryStream]::new()
      while(($count=$stream.Read($buffer,0,$buffer.Length)) -gt 0){
        $readTotal+=$count; $actualSelectedTotal+=$count
        if($readTotal -gt 32MB -or $actualSelectedTotal -gt 64MB){throw 'reject'}
        $memory.Write($buffer,0,$count)
      }
      if($readTotal -ne $entry.Length){throw 'reject'}
      $raw=$memory.ToArray(); $null=$utf8.GetString($raw)
      $documents[$name]=[Convert]::ToBase64String($raw)
    } finally { if($stream){$stream.Dispose()}; if($memory){$memory.Dispose()} }
  }
  $indexFile=$null
  if($indexPath){
    if(!$indexEntry){throw 'reject'}
    $stream=$null; $readTotal=0L; $indexSha=[Security.Cryptography.SHA256]::Create()
    try {
      $stream=$indexEntry.Open()
      while(($count=$stream.Read($buffer,0,$buffer.Length)) -gt 0){
        $readTotal+=$count
        if($readTotal -gt $indexEntry.Length -or $readTotal -gt 2GB){throw 'reject'}
        $null=$indexSha.TransformBlock($buffer,0,$count,$buffer,0)
      }
      if($readTotal -ne $indexEntry.Length){throw 'reject'}
      $null=$indexSha.TransformFinalBlock([byte[]]::new(0),0,0)
      $indexFile=@{path=$indexPath;size=$readTotal;sha256=[BitConverter]::ToString($indexSha.Hash).Replace('-','').ToLowerInvariant()}
    } finally { if($stream){$stream.Dispose()}; $indexSha.Dispose(); $indexSha=$null }
  }
  $zip.Dispose(); $zip=$null; $file.Position=0
  $afterHash=[BitConverter]::ToString($sha.ComputeHash($file)).Replace('-','').ToLowerInvariant()
  if($beforeHash -cne $afterHash -or $file.Length -ne $bytes){throw 'reject'}
  $result=@{actualZipSha256=$afterHash;actualZipBytes=$bytes;entries=$entries.ToArray();documents=$documents}
  if($indexFile){$result.indexFile=$indexFile}
  $json=ConvertTo-Json -InputObject $result -Compress -Depth 5
  if([Text.Encoding]::UTF8.GetByteCount($json) -gt 160MB){throw 'reject'}
  [Console]::Write($json)
} catch { [Console]::Error.Write('RELEASE_ARCHIVE_NATIVE_REJECTED'); exit 1 }
finally { if($zip){$zip.Dispose()}; if($file){$file.Dispose()}; if($sha){$sha.Dispose()}; if($indexSha){$indexSha.Dispose()} }
`;

/** Observe the exact raw download-artifact ZIP without extracting or executing any target bytes. */
async function observeReleaseArchive(absoluteZIPPath: string, kind: ReleaseArchiveKind, identity: ReleaseArchiveIdentity): Promise<ReleaseArchiveObservation> {
  need(process.platform === 'win32', 'RELEASE_ARCHIVE_WINDOWS_REQUIRED');
  const selected = selectedDocuments(kind, identity);
  const indexPath = fullIndexPath(kind, identity);
  need(typeof absoluteZIPPath === 'string' && absoluteZIPPath.length <= 32000 && path.isAbsolute(absoluteZIPPath), 'RELEASE_ARCHIVE_PATH_INVALID');
  const archive = path.resolve(absoluteZIPPath);
  const before = await regularArchive(archive), beforeHash = await zipDigest(archive);
  need(sameFile(before, await regularArchive(archive)), 'RELEASE_ARCHIVE_CHANGED');
  let output: string;
  try {
    const result = await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(archiveScript, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 120000, maxBuffer: nativeOutputLimit, encoding: 'utf8',
      env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows', TEMP: os.tmpdir(), TMP: os.tmpdir(),
        AE_RELEASE_ARCHIVE_PATH: archive, AE_RELEASE_DOCUMENT_PATHS: JSON.stringify(selected), AE_RELEASE_INDEX_PATH: indexPath ?? '' },
    });
    need(!result.stderr, 'RELEASE_ARCHIVE_NATIVE_REJECTED'); output = result.stdout;
  } catch { fail('RELEASE_ARCHIVE_NATIVE_REJECTED'); }
  try {
    need(Buffer.byteLength(output) <= nativeOutputLimit, 'RELEASE_ARCHIVE_OUTPUT_LIMIT');
    const observed = JSON.parse(output);
    need(observed !== null && typeof observed === 'object' && observed.actualZipSha256 === beforeHash && observed.actualZipBytes === Number(before.size), 'RELEASE_ARCHIVE_CHANGED');
    need(Array.isArray(observed.entries) && observed.entries.length > 0 && observed.entries.length <= entryLimit, 'RELEASE_ARCHIVE_ENTRY_LIMIT');
    const entries = observed.entries.map(safeEntry), names = new Map<string, ReleaseArchiveEntry>();
    let expanded = 0, pathBytes = 0;
    for (const entry of entries) {
      const name = entry.isDirectory ? entry.path.slice(0, -1) : entry.path;
      need(!names.has(name.toLowerCase()), 'RELEASE_ARCHIVE_DUPLICATE'); names.set(name.toLowerCase(), entry);
      expanded += entry.size; pathBytes += Buffer.byteLength(entry.path);
      need(expanded <= expandedLimit && pathBytes <= pathBytesLimit, 'RELEASE_ARCHIVE_EXPANDED_LIMIT');
    }
    for (const name of names.keys()) {
      const parts = name.split('/');
      for (let count = 1; count < parts.length; count++) need(names.get(parts.slice(0, count).join('/'))?.isDirectory !== false, 'RELEASE_ARCHIVE_PATH_CONFLICT');
    }
    need(observed.documents !== null && typeof observed.documents === 'object' && !Array.isArray(observed.documents) &&
      Object.keys(observed.documents).sort().join('\0') === [...selected].sort().join('\0'), 'RELEASE_ARCHIVE_DOCUMENT_SET_INVALID');
    const documents: Record<string, unknown> = Object.create(null);
    let total = 0;
    for (const name of selected) {
      const entry = names.get(name.toLowerCase()), encoded = observed.documents[name];
      need(entry && entry.path === name && !entry.isDirectory && entry.size <= documentLimit && typeof encoded === 'string' &&
        encoded.length <= Math.ceil(documentLimit / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded), 'RELEASE_ARCHIVE_DOCUMENT_INVALID');
      const bytes = Buffer.from(encoded, 'base64'); total += bytes.length;
      need(bytes.toString('base64') === encoded && bytes.length === entry.size && bytes.length <= documentLimit && total <= documentsLimit, 'RELEASE_ARCHIVE_DOCUMENT_LIMIT');
      documents[name] = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); bytes.fill(0);
    }
    let indexFile: ReleaseIndexFileObservation | undefined;
    if (indexPath) {
      const pin = observed.indexFile, entry = names.get(indexPath.toLowerCase());
      need(pin !== null && typeof pin === 'object' && !Array.isArray(pin) && Object.keys(pin).sort().join(',') === 'path,sha256,size' &&
        pin.path === indexPath && entry && entry.path === indexPath && !entry.isDirectory &&
        Number.isSafeInteger(pin.size) && pin.size > 0 && pin.size <= expandedLimit && pin.size === entry.size &&
        exact(pin.sha256, /^[a-f0-9]{64}$/), 'RELEASE_ARCHIVE_INDEX_PIN_INVALID');
      indexFile = { path: pin.path, size: pin.size, sha256: pin.sha256 };
    } else need(!Object.hasOwn(observed, 'indexFile'), 'RELEASE_ARCHIVE_INDEX_PIN_INVALID');
    const afterHash = await zipDigest(archive), after = await regularArchive(archive);
    need(sameFile(before, after) && beforeHash === afterHash, 'RELEASE_ARCHIVE_CHANGED');
    return { actualZipSha256: beforeHash, actualZipBytes: Number(before.size), entries, documents, ...(indexFile ? { indexFile } : {}) };
  } catch (error) {
    if (error instanceof Error && /^RELEASE_ARCHIVE_[A-Z_]+$/.test(error.message)) throw error;
    fail('RELEASE_ARCHIVE_OBSERVATION_INVALID');
  }
}

export async function readReleaseArchive(absoluteZIPPath: string, kind: ReleaseArchiveKind, identity: ReleaseArchiveIdentity): Promise<ReleaseArchiveObservation> {
  try { return await observeReleaseArchive(absoluteZIPPath, kind, identity); }
  catch (error) {
    if (error instanceof Error && /^RELEASE_ARCHIVE_[A-Z_]+$/.test(error.message)) throw error;
    fail('RELEASE_ARCHIVE_READ_FAILED');
  }
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type Item = { name: string; raw?: string; json?: unknown; attributes?: number; declaredBytes?: number };
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const factoryScript = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -AssemblyName System.IO.Compression
$file=[IO.File]::Open($env:ZIP_FIXTURE_PATH,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$zip=[IO.Compression.ZipArchive]::new($file,[IO.Compression.ZipArchiveMode]::Create,$true)
try {
  foreach($item in (ConvertFrom-Json $env:ZIP_FIXTURE_ENTRIES)){
    $entry=$zip.CreateEntry($item.name,[IO.Compression.CompressionLevel]::Optimal)
    $bytes=[Convert]::FromBase64String($item.raw); $stream=$entry.Open()
    try {$stream.Write($bytes,0,$bytes.Length)} finally {$stream.Dispose()}
    if($null -ne $item.attributes){$entry.ExternalAttributes=[BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]$item.attributes),0)}
    if($null -ne $item.declaredBytes){
      # Malformed/bomb ZIP fixtures use the native writer's central metadata field, not a second ZIP parser.
      $field=[IO.Compression.ZipArchiveEntry].GetField('_uncompressedSize',[Reflection.BindingFlags]'NonPublic,Instance')
      if(!$field){throw 'Native ZIP fixture field unavailable'}
      $field.SetValue($entry,[long]$item.declaredBytes)
    }
  }
  if($env:ZIP_FIXTURE_REPEAT){for($index=0;$index -lt [int]$env:ZIP_FIXTURE_REPEAT;$index++){$null=$zip.CreateEntry('empty-'+$index)}}
} finally {$zip.Dispose();$file.Dispose()}
`;

/** Fixed native ZIP writer for owned, offline fixtures; this module does not register tests or extract files. */
export async function createNativeFixtureZip(zip: string, items: Item[], repeatEntries = 0): Promise<void> {
  const normalized = items.map(item => ({ ...item, raw: item.raw ?? Buffer.from(item.json === undefined ? '' : JSON.stringify(item.json)).toString('base64') }));
  await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(factoryScript, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 60000, maxBuffer: 8192,
    env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', ZIP_FIXTURE_PATH: zip, ZIP_FIXTURE_ENTRIES: JSON.stringify(normalized), ZIP_FIXTURE_REPEAT: String(repeatEntries) },
  });
}

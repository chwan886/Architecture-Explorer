#requires -Version 7.0
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ConfigFile,
  [switch]$Verify,[switch]$Push,[switch]$PullRequest,[switch]$Status,
  [string]$WorkingDirectory='', [string]$Branch='', [string]$ExpectedHead='',
  [string]$Title='', [string]$BodyFile='', [int]$PrNumber=0,
  [string]$NodeExecutable=''
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'dev-app-key.ps1')

try {
  if (-not $IsWindows) { Stop-AppPreflight 'WINDOWS_REQUIRED' }
  $toolRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\','/')
  $selected=@(@($Verify,$Push,$PullRequest,$Status) | Where-Object { $_ })
  if ($selected.Count -ne 1) { Stop-AppPreflight 'EXACTLY_ONE_OPERATION_REQUIRED' }
  $operation=if ($Verify) {'verify'} elseif ($Push) {'push'} elseif ($PullRequest) {'pull-request'} else {'status'}
  $configPath=Get-AppAbsolutePath $ConfigFile
  Assert-AppNoLinks $configPath
  $configItem=Get-Item -LiteralPath $configPath -Force
  if ($configItem.PSIsContainer -or $configItem.Length -gt 16384) { Stop-AppPreflight 'CONFIG_INVALID' }
  $settings=[Text.UTF8Encoding]::new($false,$true).GetString([IO.File]::ReadAllBytes($configPath)).TrimStart([char]0xFEFF) | ConvertFrom-Json
  $attestation=Get-AppKeyAttestation $settings.keyDirectory $toolRoot
  $lock=Get-Content -LiteralPath (Join-Path $toolRoot 'toolchain.lock.json') -Raw | ConvertFrom-Json
  if ($lock.node.version -notmatch '^\d+\.\d+\.\d+$') { Stop-AppPreflight 'LOCKED_NODE_INVALID' }
  $node=if ($NodeExecutable) {Get-AppAbsolutePath $NodeExecutable} else {Join-Path $toolRoot ('.tools/node-v'+$lock.node.version+'-win-x64/node.exe')}
  Assert-AppNoLinks $node
  if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { Stop-AppPreflight 'LOCKED_NODE_UNAVAILABLE' }
  $tsx=Join-Path $toolRoot 'node_modules/tsx/dist/cli.mjs'
  $entry=Join-Path $toolRoot 'Tools/dev-app-cli.ts'
  foreach ($file in @($tsx,$entry)) {if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {Stop-AppPreflight 'RUNTIME_UNAVAILABLE'}}

  $arguments=@($tsx,$entry,'--config-file',$configPath,'--operation',$operation,'--key-file',$attestation.keyFile)
  foreach ($mapping in @(@('WorkingDirectory','working-directory'),@('Branch','branch'),@('ExpectedHead','expected-head'),@('Title','title'),@('BodyFile','body-file'),@('PrNumber','pr-number'))) {
    if ($PSBoundParameters.ContainsKey($mapping[0])) { $arguments+=@('--'+$mapping[1],[string](Get-Variable -Name $mapping[0] -ValueOnly)) }
  }
  $start=[Diagnostics.ProcessStartInfo]::new()
  $start.FileName=$node; $start.WorkingDirectory=$toolRoot; $start.UseShellExecute=$false
  $start.CreateNoWindow=$true; $start.RedirectStandardInput=$true
  foreach ($argument in $arguments) {$start.ArgumentList.Add($argument)}
  foreach ($name in @($start.Environment.Keys)) {
    if ($name -match '^(NODE_|TSX_|GIT_|GH_|GITHUB_|NPM_|npm_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|LD_|DYLD_)') {$start.Environment.Remove($name) | Out-Null}
  }
  # The version is checked in the same sanitized runtime that reads the key.
  $start.Environment['EXPLORER_APP_NODE_VERSION']=[string]$lock.node.version
  $process=[Diagnostics.Process]::Start($start)
  $process.StandardInput.WriteLine(($attestation | ConvertTo-Json -Depth 5 -Compress))
  $process.StandardInput.Close(); $process.WaitForExit()
  $code=$process.ExitCode; $process.Dispose()
  if ($code -ne 0) {Stop-AppPreflight 'OPERATION_FAILED'}
} catch {
  $message=if ($_.Exception.Message -match '^App preflight rejected: [A-Z_]+$') {$_.Exception.Message} else {'App preflight rejected: LOCAL_CHECK_FAILED'}
  [Console]::Error.WriteLine($message)
  exit 1
}

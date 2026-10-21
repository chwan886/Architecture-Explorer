#requires -Version 7.0
# Windows-only, read-only key preflight for the App verification command.
# This wrapper does not repair ACLs, read the PEM, or supply a token through the environment.
[CmdletBinding()]
param(
  [switch]$Verify,
  [string]$PrivateKeyDirectory='C:/Users/chwan/AppData/Local/ChwanDevAgent/keys',
  [string]$ReceiptPath=''
)

$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

function Stop-Preflight([string]$Code) {
  # Never include ACLs, user names, paths, native errors, or key material in diagnostics.
  throw "App verification preflight rejected: $Code"
}

function Get-LocalAbsolutePath([string]$Candidate, [string]$FailureCode) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    Stop-Preflight $FailureCode
  }
  try { $result=[IO.Path]::GetFullPath($Candidate).Replace('/','\') }
  catch { Stop-Preflight $FailureCode }
  if ($result -notmatch '^[A-Za-z]:\\' -or $result.Substring(2).Contains(':')) {
    Stop-Preflight $FailureCode
  }
  return $result
}

function Assert-NoLinks([string]$AbsolutePath, [bool]$AllowMissingLeaf=$false) {
  $pathRoot=[IO.Path]::GetPathRoot($AbsolutePath)
  $segments=@($AbsolutePath.Substring($pathRoot.Length).Split([char[]]'\/', [StringSplitOptions]::RemoveEmptyEntries))
  $cursor=$pathRoot
  $paths=@($cursor)
  foreach ($segment in $segments) {
    $cursor=Join-Path $cursor $segment
    $paths+=@($cursor)
  }
  for ($index=0; $index -lt $paths.Count; $index++) {
    try { $item=Get-Item -LiteralPath $paths[$index] -Force -ErrorAction Stop }
    catch {
      if ($AllowMissingLeaf -and $index -eq $paths.Count-1 -and $_.CategoryInfo.Category -eq 'ObjectNotFound') { return }
      Stop-Preflight 'PATH_UNREADABLE'
    }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Preflight 'LINK_REJECTED' }
    if ($index -lt $paths.Count-1 -and -not $item.PSIsContainer) { Stop-Preflight 'PATH_NOT_DIRECTORY' }
  }
}

function Get-PrincipalClass([string]$Sid, [string]$CurrentSid) {
  if ($Sid -eq $CurrentSid) { return 'current-user' }
  if ($Sid -eq 'S-1-5-18') { return 'SYSTEM' }
  if ($Sid -eq 'S-1-5-32-544') { return 'Administrators' }
  return $null
}

function Get-RestrictedAclEvidence([string]$AbsolutePath, [string]$CurrentSid) {
  try {
    $acl=Get-Acl -LiteralPath $AbsolutePath -ErrorAction Stop
    $ownerSid=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $ownerClass=Get-PrincipalClass $ownerSid $CurrentSid
    if (-not $ownerClass) { Stop-Preflight 'ACL_OWNER_REJECTED' }

    # A null DACL grants everyone access. Inspect raw ACEs as well as the typed
    # rules so an unsupported/conditional ACE cannot disappear from this audit.
    $descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    if (($descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -eq 0 -or $null -eq $descriptor.DiscretionaryAcl) {
      Stop-Preflight 'ACL_UNRESTRICTED'
    }
    foreach ($ace in $descriptor.DiscretionaryAcl) {
      if ($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -and $ace.AceType -ne [Security.AccessControl.AceType]::AccessDenied) {
        Stop-Preflight 'ACL_UNSUPPORTED_ACE'
      }
      if ($ace.AceType -eq [Security.AccessControl.AceType]::AccessAllowed -and $ace.AccessMask -ne 0 -and -not (Get-PrincipalClass $ace.SecurityIdentifier.Value $CurrentSid)) {
        Stop-Preflight 'ACL_GRANT_REJECTED'
      }
    }

    $hasInherited=$false
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.IsInherited) { $hasInherited=$true }
      # Deny rules do not grant access. Inherited Allow rules must meet the same
      # SID whitelist as explicit rules; inheritance alone is not a rejection.
      if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and [long]$rule.FileSystemRights -ne 0 -and -not (Get-PrincipalClass $rule.IdentityReference.Value $CurrentSid)) {
        Stop-Preflight 'ACL_GRANT_REJECTED'
      }
    }
    return @{ owner=$ownerClass; inherited=$hasInherited }
  } catch {
    if ($_.Exception.Message -match '^App verification preflight rejected: [A-Z_]+$') { throw }
    Stop-Preflight 'ACL_UNREADABLE'
  }
}

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { Stop-Preflight 'WINDOWS_REQUIRED' }
  if (-not $Verify) { Stop-Preflight 'VERIFY_REQUIRED' }
  $toolRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\','/')
  $keyDirectory=Get-LocalAbsolutePath $PrivateKeyDirectory 'KEY_DIRECTORY_INVALID'
  Assert-NoLinks $keyDirectory
  $directoryItem=Get-Item -LiteralPath $keyDirectory -Force
  if (-not $directoryItem.PSIsContainer) { Stop-Preflight 'KEY_DIRECTORY_INVALID' }

  try { $pemCandidates=@(Get-ChildItem -LiteralPath $keyDirectory -Force -ErrorAction Stop | Where-Object { $_.Extension -ieq '.pem' }) }
  catch { Stop-Preflight 'KEY_DIRECTORY_UNREADABLE' }
  if ($pemCandidates.Count -ne 1) { Stop-Preflight 'EXACTLY_ONE_PEM_REQUIRED' }
  $keyFile=Get-LocalAbsolutePath $pemCandidates[0].FullName 'KEY_FILE_INVALID'
  Assert-NoLinks $keyFile
  $pemItem=Get-Item -LiteralPath $keyFile -Force
  if ($pemItem.PSIsContainer) { Stop-Preflight 'KEY_FILE_INVALID' }

  $currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $directoryAcl=Get-RestrictedAclEvidence $keyDirectory $currentSid
  $fileAcl=Get-RestrictedAclEvidence $keyFile $currentSid

  $receipt=''
  if (-not [string]::IsNullOrWhiteSpace($ReceiptPath)) {
    $receipt=Get-LocalAbsolutePath $ReceiptPath 'RECEIPT_PATH_INVALID'
    $toolPrefix=$toolRoot+[IO.Path]::DirectorySeparatorChar
    if (-not $receipt.StartsWith($toolPrefix, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($receipt) -ine '.json') {
      Stop-Preflight 'RECEIPT_OUTSIDE_TOOL'
    }
    Assert-NoLinks $receipt $true
    if (Test-Path -LiteralPath $receipt -PathType Container) { Stop-Preflight 'RECEIPT_PATH_INVALID' }
  }

  # This attestation is a trusted-wrapper preflight within the current-user
  # boundary. It is not a cryptographic proof against a malicious same-user process.
  $pemItem.Refresh()
  if (-not $pemItem.Exists -or ($pemItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Preflight 'KEY_FILE_CHANGED' }
  $attestation=@{
    schemaVersion=1
    keyFile=$keyFile
    acl=@{
      checked=$true
      owner=$fileAcl.owner
      allowPrincipals=@('current-user','SYSTEM','Administrators')
      inherited=[bool]($directoryAcl.inherited -or $fileAcl.inherited)
      scope='directory-and-file'
      linksRejected=$true
    }
    fileIdentity=@{
      size=[long]$pemItem.Length
      mtimeMs=([DateTimeOffset]$pemItem.LastWriteTimeUtc).ToUnixTimeMilliseconds()
    }
  } | ConvertTo-Json -Depth 5 -Compress

  try {
    $lock=Get-Content -LiteralPath (Join-Path $toolRoot 'toolchain.lock.json') -Raw | ConvertFrom-Json
    if ($lock.node.version -notmatch '^\d+\.\d+\.\d+$') { Stop-Preflight 'LOCKED_NODE_UNAVAILABLE' }
    $node=Join-Path $toolRoot ('.tools/node-v'+$lock.node.version+'-win-x64/node.exe')
    $tsx=Join-Path $toolRoot 'node_modules/tsx/dist/cli.mjs'
    $entry=Join-Path $toolRoot 'Tools/dev-app-auth.ts'
    foreach ($required in @($node,$tsx,$entry)) {
      if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { Stop-Preflight 'LOCKED_RUNTIME_UNAVAILABLE' }
    }
  } catch {
    if ($_.Exception.Message -match '^App verification preflight rejected: [A-Z_]+$') { throw }
    Stop-Preflight 'LOCKED_RUNTIME_UNAVAILABLE'
  }

  # ArgumentList bypasses shell parsing. Only the PEM path and non-secret ACL
  # metadata cross this boundary; Node is responsible for reading the PEM.
  $start=[Diagnostics.ProcessStartInfo]::new()
  $start.FileName=$node
  $start.WorkingDirectory=$toolRoot
  $start.UseShellExecute=$false
  $start.CreateNoWindow=$true
  $start.RedirectStandardInput=$true
  foreach ($argument in @($tsx,$entry,'--key-file',$keyFile)) { $start.ArgumentList.Add($argument) }
  if ($receipt) { $start.ArgumentList.Add('--receipt'); $start.ArgumentList.Add($receipt) }
  foreach ($external in @('NODE_OPTIONS','NODE_PATH','NODE_DEBUG','NODE_DEBUG_NATIVE','GH_DEBUG','GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN')) {
    $start.Environment.Remove($external) | Out-Null
  }
  Write-Host 'App verification preflight passed: directory/file ACL restricted; links rejected; locked Node selected.'
  $process=[Diagnostics.Process]::Start($start)
  $process.StandardInput.WriteLine($attestation)
  $process.StandardInput.Close()
  $process.WaitForExit()
  $childExitCode=$process.ExitCode
  $process.Dispose()
  if ($childExitCode -ne 0) { Stop-Preflight 'VERIFICATION_FAILED' }
} catch {
  if ($_.Exception.Message -match '^App verification preflight rejected: [A-Z_]+$') {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
  } else {
    Write-Error -Message 'App verification preflight rejected: LOCAL_CHECK_FAILED' -ErrorAction Continue
  }
  exit 1
}

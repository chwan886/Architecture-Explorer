#requires -Version 7.0
# Windows-only key preflight for the narrowly scoped App commands.
# This wrapper does not repair ACLs, read the PEM, or supply a token through the environment.
[CmdletBinding()]
param(
  [switch]$Verify,
  [switch]$Push,
  [switch]$PullRequest,
  [switch]$Status,
  [switch]$InspectMain,
  [switch]$FetchMain,
  [ValidateSet('chwan886/Architecture-Explorer','chwan886/GameDemo02')][string]$Repository='chwan886/Architecture-Explorer',
  [string]$WorkingDirectory='',
  [string]$Branch='',
  [string]$ExpectedHead='',
  [string]$Title='',
  [string]$BodyFile='',
  [int]$PrNumber=0,
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
    if ($_.Exception.Message -match '^App verification preflight rejected: [A-Z0-9_]+$') { throw }
    Stop-Preflight 'ACL_UNREADABLE'
  }
}

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { Stop-Preflight 'WINDOWS_REQUIRED' }
  $toolRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\','/')
  $operationCount=0
  foreach ($selected in @($Verify,$Push,$PullRequest,$Status,$InspectMain,$FetchMain)) { if ($selected) { $operationCount++ } }
  if ($operationCount -ne 1) { Stop-Preflight 'EXACTLY_ONE_OPERATION_REQUIRED' }
  $operation=if ($Verify) { 'verify' } elseif ($Push) { 'push' } elseif ($PullRequest) { 'pr' } elseif ($InspectMain) { 'inspect-main' } elseif ($FetchMain) { 'fetch-main' } else { 'status' }
  $repositoryName=if ($Repository -ieq 'chwan886/GameDemo02') { 'chwan886/GameDemo02' } else { 'chwan886/Architecture-Explorer' }
  $operationArguments=@('--operation',$operation,'--repository',$repositoryName)
  if ($Verify) {
    foreach ($unused in @('WorkingDirectory','Branch','ExpectedHead','Title','BodyFile','PrNumber')) {
      if ($PSBoundParameters.ContainsKey($unused)) { Stop-Preflight 'OPERATION_PARAMETER_INVALID' }
    }
  } elseif ($FetchMain) {
    foreach ($unused in @('Branch','Title','BodyFile','PrNumber')) {
      if ($PSBoundParameters.ContainsKey($unused)) { Stop-Preflight 'OPERATION_PARAMETER_INVALID' }
    }
    if ($ExpectedHead -notmatch '\A[0-9a-fA-F]{40}\z') { Stop-Preflight 'EXACT_HEAD_REQUIRED' }
    $workingPath=Get-LocalAbsolutePath $WorkingDirectory 'WORKING_DIRECTORY_INVALID'
    Assert-NoLinks $workingPath
    if (-not (Test-Path -LiteralPath $workingPath -PathType Container)) { Stop-Preflight 'WORKING_DIRECTORY_INVALID' }
    $operationArguments+=@('--working-directory',$workingPath,'--expected-head',$ExpectedHead.ToLowerInvariant())
  } elseif ($InspectMain) {
    foreach ($unused in @('WorkingDirectory','Branch','Title','BodyFile')) {
      if ($PSBoundParameters.ContainsKey($unused)) { Stop-Preflight 'OPERATION_PARAMETER_INVALID' }
    }
    if (-not $PSBoundParameters.ContainsKey('PrNumber') -or $PrNumber -lt 1) { Stop-Preflight 'PR_NUMBER_INVALID' }
    if ($ExpectedHead -notmatch '\A[0-9a-fA-F]{40}\z') { Stop-Preflight 'EXACT_HEAD_REQUIRED' }
    $operationArguments+=@('--expected-head',$ExpectedHead.ToLowerInvariant(),'--pr-number',$PrNumber.ToString([Globalization.CultureInfo]::InvariantCulture))
  } elseif ($Status) {
    foreach ($unused in @('WorkingDirectory','Branch','Title','BodyFile')) {
      if ($PSBoundParameters.ContainsKey($unused)) { Stop-Preflight 'OPERATION_PARAMETER_INVALID' }
    }
    if ($ExpectedHead -notmatch '\A[0-9a-fA-F]{40}\z') { Stop-Preflight 'EXACT_HEAD_REQUIRED' }
    if (-not $PSBoundParameters.ContainsKey('PrNumber') -or $PrNumber -lt 1) { Stop-Preflight 'PR_NUMBER_INVALID' }
    $operationArguments+=@('--expected-head',$ExpectedHead.ToLowerInvariant(),'--pr-number',$PrNumber.ToString([Globalization.CultureInfo]::InvariantCulture))
  } else {
    # Only ordinary codex feature refs are accepted here. Node independently
    # validates Git state, remote identity, exact HEAD, and the fixed main base.
    if ($Branch -cnotmatch '\Acodex/[A-Za-z0-9][A-Za-z0-9._/-]*\z' -or $Branch.Contains('..') -or $Branch.Contains('//') -or $Branch.EndsWith('/') -or $Branch.EndsWith('.')) {
      Stop-Preflight 'FEATURE_BRANCH_REQUIRED'
    }
    foreach ($component in $Branch.Split('/')) {
      if ($component.StartsWith('.') -or $component.EndsWith('.lock',[StringComparison]::OrdinalIgnoreCase)) { Stop-Preflight 'FEATURE_BRANCH_REQUIRED' }
    }
    if ($ExpectedHead -notmatch '\A[0-9a-fA-F]{40}\z') { Stop-Preflight 'EXACT_HEAD_REQUIRED' }
    $operationArguments+=@('--branch',$Branch,'--expected-head',$ExpectedHead.ToLowerInvariant())
    if ($Push) {
      foreach ($unused in @('Title','BodyFile','PrNumber')) {
        if ($PSBoundParameters.ContainsKey($unused)) { Stop-Preflight 'OPERATION_PARAMETER_INVALID' }
      }
      $workingPath=Get-LocalAbsolutePath $WorkingDirectory 'WORKING_DIRECTORY_INVALID'
      Assert-NoLinks $workingPath
      if (-not (Test-Path -LiteralPath $workingPath -PathType Container)) { Stop-Preflight 'WORKING_DIRECTORY_INVALID' }
      $operationArguments+=@('--working-directory',$workingPath)
    } else {
      if ($PSBoundParameters.ContainsKey('WorkingDirectory')) { Stop-Preflight 'OPERATION_PARAMETER_INVALID' }
      if ([string]::IsNullOrWhiteSpace($Title)) { Stop-Preflight 'PR_TITLE_REQUIRED' }
      $bodyPath=Get-LocalAbsolutePath $BodyFile 'PR_BODY_FILE_INVALID'
      if (-not $bodyPath.StartsWith($toolRoot+[IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-Preflight 'PR_BODY_OUTSIDE_TOOL'
      }
      Assert-NoLinks $bodyPath
      if (-not (Test-Path -LiteralPath $bodyPath -PathType Leaf)) { Stop-Preflight 'PR_BODY_FILE_INVALID' }
      if ((Get-Item -LiteralPath $bodyPath -Force).Length -gt 65536) { Stop-Preflight 'PR_BODY_TOO_LARGE' }
      try {
        # Read only the explicitly supplied PR text, never the PEM. Strict UTF-8
        # decoding prevents UTF-16 BOM auto-detection from changing the contract.
        $bodyBytes=[IO.File]::ReadAllBytes($bodyPath)
        $bodyText=[Text.UTF8Encoding]::new($false,$true).GetString($bodyBytes)
      } catch { Stop-Preflight 'PR_BODY_UTF8_REQUIRED' }
      if ($bodyText -match '-----BEGIN [A-Z0-9 ]+-----') { Stop-Preflight 'PR_BODY_PEM_REJECTED' }
      if ($PSBoundParameters.ContainsKey('PrNumber') -and $PrNumber -lt 1) { Stop-Preflight 'PR_NUMBER_INVALID' }
      $operationArguments+=@('--title',$Title,'--body-file',$bodyPath)
      if ($PSBoundParameters.ContainsKey('PrNumber')) { $operationArguments+=@('--pr-number',$PrNumber.ToString([Globalization.CultureInfo]::InvariantCulture)) }
    }
  }
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
    if ($lock.node.version -notmatch '\A\d+\.\d+\.\d+\z') { Stop-Preflight 'LOCKED_NODE_UNAVAILABLE' }
    $node=Join-Path $toolRoot ('.tools/node-v'+$lock.node.version+'-win-x64/node.exe')
    $tsx=Join-Path $toolRoot 'node_modules/tsx/dist/cli.mjs'
    $entry=Join-Path $toolRoot 'Tools/dev-app-auth.ts'
    foreach ($required in @($node,$tsx,$entry)) {
      if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { Stop-Preflight 'LOCKED_RUNTIME_UNAVAILABLE' }
    }
  } catch {
    if ($_.Exception.Message -match '^App verification preflight rejected: [A-Z0-9_]+$') { throw }
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
  foreach ($argument in (@($tsx,$entry)+$operationArguments+@('--key-file',$keyFile))) { $start.ArgumentList.Add($argument) }
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
  if ($_.Exception.Message -match '^App verification preflight rejected: [A-Z0-9_]+$') {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
  } else {
    Write-Error -Message 'App verification preflight rejected: LOCAL_CHECK_FAILED' -ErrorAction Continue
  }
  exit 1
}

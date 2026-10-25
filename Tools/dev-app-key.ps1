# Windows key metadata checks. Never reads a PEM or changes its ACL.
Set-StrictMode -Version Latest

function Stop-AppPreflight([string]$Code) { throw "App preflight rejected: $Code" }

function Get-AppAbsolutePath([string]$Candidate) {
  if ($Candidate -notmatch '^[A-Za-z]:[\\/]') { Stop-AppPreflight 'ABSOLUTE_LOCAL_PATH_REQUIRED' }
  try { $result=[IO.Path]::GetFullPath($Candidate).Replace('/','\') }
  catch { Stop-AppPreflight 'INVALID_PATH' }
  if ($result.Substring(2).Contains(':')) { Stop-AppPreflight 'INVALID_PATH' }
  return $result
}

function Assert-AppNoLinks([string]$AbsolutePath) {
  $root=[IO.Path]::GetPathRoot($AbsolutePath)
  $cursor=$root
  $paths=@($root)
  foreach ($segment in $AbsolutePath.Substring($root.Length).Split([char[]]'\/',[StringSplitOptions]::RemoveEmptyEntries)) {
    $cursor=Join-Path $cursor $segment
    $paths+=@($cursor)
  }
  foreach ($candidate in $paths) {
    try { $item=Get-Item -LiteralPath $candidate -Force -ErrorAction Stop }
    catch { Stop-AppPreflight 'PATH_UNREADABLE' }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-AppPreflight 'LINK_REJECTED' }
  }
}

function Get-AppPrincipalClass([string]$Sid,[string]$CurrentSid) {
  if ($Sid -eq $CurrentSid) { return 'current-user' }
  if ($Sid -eq 'S-1-5-18') { return 'SYSTEM' }
  if ($Sid -eq 'S-1-5-32-544') { return 'Administrators' }
  return $null
}

function Assert-AppPrivateAcl([string]$AbsolutePath,[string]$CurrentSid) {
  try {
    $acl=Get-Acl -LiteralPath $AbsolutePath -ErrorAction Stop
    if (-not (Get-AppPrincipalClass $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value $CurrentSid)) { Stop-AppPreflight 'ACL_OWNER_REJECTED' }
    $raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
    if (($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -eq 0 -or $null -eq $raw.DiscretionaryAcl) { Stop-AppPreflight 'ACL_UNRESTRICTED' }
    foreach ($ace in $raw.DiscretionaryAcl) {
      if ($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -and $ace.AceType -ne [Security.AccessControl.AceType]::AccessDenied) { Stop-AppPreflight 'ACL_UNSUPPORTED_ACE' }
      if ($ace.AceType -eq [Security.AccessControl.AceType]::AccessAllowed -and $ace.AccessMask -ne 0 -and -not (Get-AppPrincipalClass $ace.SecurityIdentifier.Value $CurrentSid)) { Stop-AppPreflight 'ACL_GRANT_REJECTED' }
    }
  } catch {
    if ($_.Exception.Message -match '^App preflight rejected: [A-Z_]+$') { throw }
    Stop-AppPreflight 'ACL_UNREADABLE'
  }
}

function Get-AppKeyAttestation([string]$Directory,[string]$ToolRoot) {
  $keyDirectory=Get-AppAbsolutePath $Directory
  if ($keyDirectory.Equals($ToolRoot,[StringComparison]::OrdinalIgnoreCase) -or $keyDirectory.StartsWith($ToolRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { Stop-AppPreflight 'KEY_MUST_BE_OUTSIDE_REPOSITORY' }
  Assert-AppNoLinks $keyDirectory
  $ancestor=$keyDirectory
  while ($ancestor) {
    if (Test-Path -LiteralPath (Join-Path $ancestor '.git')) {Stop-AppPreflight 'KEY_MUST_BE_OUTSIDE_REPOSITORY'}
    $parent=Split-Path -Parent $ancestor
    if ($parent -eq $ancestor) {break}
    $ancestor=$parent
  }
  if (-not (Test-Path -LiteralPath $keyDirectory -PathType Container)) { Stop-AppPreflight 'KEY_DIRECTORY_REQUIRED' }
  $candidates=@(Get-ChildItem -LiteralPath $keyDirectory -Force | Where-Object { $_.Extension -ieq '.pem' })
  if ($candidates.Count -ne 1) { Stop-AppPreflight 'EXACTLY_ONE_PEM_REQUIRED' }
  $keyFile=Get-AppAbsolutePath $candidates[0].FullName
  Assert-AppNoLinks $keyFile
  $item=Get-Item -LiteralPath $keyFile -Force
  if ($item.PSIsContainer -or $item.Length -lt 1 -or $item.Length -gt 65536) { Stop-AppPreflight 'KEY_FILE_INVALID' }
  $currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  Assert-AppPrivateAcl $keyDirectory $currentSid
  Assert-AppPrivateAcl $keyFile $currentSid
  return @{
    schemaVersion=1; keyFile=$keyFile
    acl=@{ checked=$true; scope='directory-and-file'; linksRejected=$true }
    fileIdentity=@{size=[long]$item.Length;mtimeMs=([DateTimeOffset]$item.LastWriteTimeUtc).ToUnixTimeMilliseconds()}
  }
}

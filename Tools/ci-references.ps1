# Download an administrator-approved, hash-pinned metadata-only ZIP. Never run files from it.
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$uri=$null
if(![Uri]::TryCreate($env:UNITY_REFERENCES_URL,[UriKind]::Absolute,[ref]$uri) -or $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Fragment){throw 'Configure a protected HTTPS Unity metadata URL'}
if($env:UNITY_REFERENCES_SHA256 -cnotmatch '^[a-f0-9]{64}$'){throw 'Configure exact Unity metadata ZIP SHA256'}
$destination=Join-Path $root '.ci-references'
if(Test-Path -LiteralPath $destination){throw 'Unity reference directory already exists'}
New-Item -ItemType Directory -Path $destination | Out-Null
$archive=Join-Path $destination 'metadata.zip'
Invoke-WebRequest -Uri $uri -OutFile $archive -MaximumRedirection 0
if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $env:UNITY_REFERENCES_SHA256){throw 'Unity metadata ZIP fingerprint mismatch'}
if((Get-Item -LiteralPath $archive).Length -gt 256MB){throw 'Unity metadata archive exceeds 256 MiB'}
$zip=[IO.Compression.ZipFile]::OpenRead($archive)
try {
  $total=0L; $names=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach($entry in $zip.Entries){
    $name=$entry.FullName.Replace('\','/')
    if($name.EndsWith('/')){throw 'Metadata ZIP directory entries are prohibited; use root files only'}
    if($name -notmatch '^(references\.json|[A-Za-z0-9_.-]+\.dll)$' -or !$names.Add($name)){throw 'Metadata ZIP only accepts root references.json and uniquely named DLLs'}
    # Unix symlink attributes are prohibited, even though Windows extraction often materializes them.
    if((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000){throw 'Metadata ZIP links are prohibited'}
    $total+=$entry.Length
    if($total -gt 512MB){throw 'Unity metadata uncompressed budget exceeded'}
  }
  if(!$names.Contains('references.json') -or !$names.Contains('UnityEngine.CoreModule.dll')){throw 'Unity metadata manifest/CoreModule missing'}
  foreach($entry in $zip.Entries){
    $name=$entry.FullName.Replace('\','/')
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,(Join-Path $destination $name),$false)
  }
} finally { $zip.Dispose() }
Write-Host 'Unity reference metadata prepared. Individual DLL fingerprints and editor version are verified before scanning.'

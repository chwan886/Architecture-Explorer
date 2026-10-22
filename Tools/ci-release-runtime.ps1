# Restore only the locked official Node runtime. No package manager, tests, analyzer or downloaded tool code is executed.
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$lock=Get-Content -LiteralPath (Join-Path $root 'toolchain.lock.json') -Raw | ConvertFrom-Json
if($lock.node.version -cnotmatch '^24\.[0-9]+\.[0-9]+$' -or $lock.node.sha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'Invalid locked publisher Node runtime'}
$expectedUrl='https://nodejs.org/dist/v'+$lock.node.version+'/node-v'+$lock.node.version+'-win-x64.zip'
if($lock.node.url -cne $expectedUrl){throw 'Publisher runtime requires the locked official Node URL'}
$releaseRoot=Join-Path $root '.ci-release'
if(Test-Path -LiteralPath $releaseRoot){
  $entry=Get-Item -LiteralPath $releaseRoot -Force
  if(-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Publisher staging must be a regular tool-side directory'}
}
$directory=Join-Path $root '.ci-release/runtime'
if(Test-Path -LiteralPath $directory){throw 'Publisher runtime staging already exists; do not overwrite'}
New-Item -ItemType Directory -Path $directory | Out-Null
$archive=Join-Path $directory 'node.zip'
$cached=Join-Path $root '.tools/node.zip'
if((Test-Path -LiteralPath $cached -PathType Leaf) -and (Get-FileHash -LiteralPath $cached -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $lock.node.sha256){
  Copy-Item -LiteralPath $cached -Destination $archive
}else{
  Invoke-WebRequest -Uri $expectedUrl -OutFile $archive -MaximumRedirection 0 -TimeoutSec 120
}
if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $lock.node.sha256){throw 'Publisher Node ZIP fingerprint mismatch'}
Expand-Archive -LiteralPath $archive -DestinationPath $directory
$node=Join-Path $directory ('node-v'+$lock.node.version+'-win-x64/node.exe')
$env:NODE_OPTIONS=$null
$env:NODE_PATH=$null
$version=& $node --version
if($LASTEXITCODE -ne 0 -or $version -cne ('v'+$lock.node.version)){throw 'Publisher Node version mismatch'}
if($env:GITHUB_OUTPUT){'node='+$node | Add-Content -LiteralPath $env:GITHUB_OUTPUT}
Write-Host 'Locked publisher Node ready; dependency installation and target execution were not performed.'

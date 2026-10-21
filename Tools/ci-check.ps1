param([switch]$Prepare)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
if($Prepare){ & "$PSScriptRoot/explorer.ps1" -Task Setup -SkipLocalConfig }
$lock=Get-Content toolchain.lock.json -Raw | ConvertFrom-Json
if((Get-Content .python-version -Raw).Trim() -cne $lock.python.ciVersion){throw 'Python CI version differs from toolchain.lock.json'}
$node=Join-Path $root ('.tools/node-v'+$lock.node.version+'-win-x64/node.exe')
$env:PATH=(Split-Path -Parent $node)+';'+$env:PATH
$env:EXPLORER_TEST_REQUIRE_CSHARP='1'
$env:DOTNET_CLI_HOME=Join-Path $root '.tools/dotnet-home'
$env:NUGET_PACKAGES=Join-Path $root '.tools/nuget'
New-Item -ItemType Directory -Force test-results | Out-Null
function Run-Logged([string]$Name,[scriptblock]$Command) {
  & $Command 2>&1 | Tee-Object -FilePath (Join-Path $root ('test-results/'+$Name+'.txt'))
  if($LASTEXITCODE -ne 0){throw "$Name failed ($LASTEXITCODE)"}
}
Run-Logged 'typecheck' { & $node node_modules/typescript/bin/tsc --noEmit }
# Worker build precedes tests: required analyzer tests must actually run on the clean runner.
Run-Logged 'csharp-build' { & "$PSScriptRoot/explorer.ps1" -Task BuildAnalyzer }
$testFiles=@('tests/*.test.ts','apps/web/src/*.test.ts','apps/web/src/architecture/*.test.ts','apps/web/src/semantics/*.test.ts','apps/web/src/control/*.test.ts') | ForEach-Object { Get-ChildItem $_ } | ForEach-Object { $_.FullName }
Run-Logged 'tests' { & $node node_modules/tsx/dist/cli.mjs --test --test-reporter=spec --test-reporter=junit --test-reporter-destination=stdout --test-reporter-destination=test-results/junit.xml @testFiles }
[xml]$junit=Get-Content test-results/junit.xml -Raw
if(@($junit.SelectNodes('//skipped')).Count -gt 0){throw 'Required security/regression checks were skipped; use a runner that supports loopback and symbolic links'}
Run-Logged 'frontend-build' { & "$PSScriptRoot/explorer.ps1" -Task Build }

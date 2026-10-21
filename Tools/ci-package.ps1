$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$lock=Get-Content toolchain.lock.json -Raw | ConvertFrom-Json
$sha=(& git rev-parse HEAD).Trim()
if($LASTEXITCODE -ne 0 -or $sha -notmatch '^[0-9a-f]{40}$'){throw 'Cannot identify tool HEAD'}
$sourceStatus=@(& git status --porcelain=v1 --untracked-files=normal)
if($LASTEXITCODE -ne 0){throw 'Cannot read tool source state'}
$sourceDirty=$sourceStatus.Count -gt 0
if($env:GITHUB_ACTIONS -eq 'true' -and $sourceDirty){throw 'CI tool package requires unchanged committed source'}
$run=if($env:GITHUB_RUN_ID){$env:GITHUB_RUN_ID}else{'local'}
$attempt=if($env:GITHUB_RUN_ATTEMPT){$env:GITHUB_RUN_ATTEMPT}else{'1'}
if($run -notmatch '^(local|[1-9][0-9]*)$' -or $attempt -notmatch '^[1-9][0-9]*$'){throw 'Invalid run identity'}
$output=Join-Path $root ('.ci-output/tool-'+$sha+'-'+$run+'-'+$attempt)
if(Test-Path -LiteralPath $output){throw 'Package already exists; never overwrite an artifact'}
New-Item -ItemType Directory -Path $output | Out-Null
# Allowlist runtime inputs; no config/local.json, game, caches, Git, or credentials.
foreach($part in @('dist','apps/server','apps/mcp','packages','architecture','docs','Tools','analyzers/python','analyzers/csharp/bin/Release/net10.0')) {
  $source=Join-Path $root $part
  if(!(Test-Path -LiteralPath $source)){throw "Missing package input: $part"}
  $destination=Join-Path $output $part
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Recurse
}
foreach($file in @('package.json','pnpm-lock.yaml','pnpm-workspace.yaml','toolchain.lock.json','global.json','tsconfig.json','README.md','Start-Explorer.cmd')) { Copy-Item -LiteralPath $file -Destination $output }
# Copying pnpm root symlinks as directories breaks sibling transitive resolution (for example tsx -> esbuild).
# Restore a self-contained regular-directory topology in staging, using only the already frozen local store.
$node=Join-Path $root ('.tools/node-v'+$lock.node.version+'-win-x64/node.exe')
$pnpm=Join-Path $root '.tools/package-manager/node_modules/pnpm/bin/pnpm.cjs'
if(!(Test-Path -LiteralPath $pnpm)){$pnpm=Join-Path $root '.tools/package-manager/node_modules/pnpm/bin/pnpm.mjs'}
$inputLockHash=(Get-FileHash -LiteralPath (Join-Path $root 'pnpm-lock.yaml') -Algorithm SHA256).Hash
Push-Location -LiteralPath $output
try {
  & $node $pnpm install --offline --frozen-lockfile --frozen-store --node-linker=hoisted --config.enable-global-virtual-store=false --package-import-method=copy --ignore-scripts --store-dir (Join-Path $root '.tools/pnpm-store')
  if($LASTEXITCODE -ne 0){throw 'Offline frozen package dependency restore failed'}
  if((Get-FileHash -LiteralPath 'pnpm-lock.yaml' -Algorithm SHA256).Hash -cne $inputLockHash){throw 'Package restore changed its frozen dependency lock'}
  if(!(Test-Path -LiteralPath 'node_modules/@esbuild/win32-x64/esbuild.exe')){throw 'Package is missing the locked Windows esbuild optional binary'}
  if(@(Get-ChildItem -LiteralPath node_modules -Recurse -Force -Attributes ReparsePoint).Count -gt 0){throw 'Package dependency layout contains nonportable links'}
  & $node node_modules/esbuild/bin/esbuild --version
  if($LASTEXITCODE -ne 0){throw 'Packaged esbuild dependency does not run'}
} finally { Pop-Location }
if((Get-FileHash -LiteralPath (Join-Path $root 'pnpm-lock.yaml') -Algorithm SHA256).Hash -cne $inputLockHash){throw 'Package restore changed the source dependency lock'}
New-Item -ItemType Directory -Path (Join-Path $output 'config') | Out-Null
Copy-Item config/projects.example.json (Join-Path $output 'config/projects.example.json')
$portableNode='.tools/node-v'+$lock.node.version+'-win-x64'
New-Item -ItemType Directory -Path (Join-Path $output '.tools') | Out-Null
Copy-Item -LiteralPath $portableNode -Destination (Join-Path $output $portableNode) -Recurse
@'
# Windows tool build package

Contains built Vite frontend, TypeScript server/MCP sources, tsx and locked node_modules,
portable Node, Python analyzer, and built C# worker (including its Roslyn dependencies).
dist alone is not a complete tool. This is a CI build package, not an installer.

Prerequisites: Windows x64, Git CLI on PATH, Python 3.11+, .NET 10 runtime (or locked SDK 10.0.402).
Copy config/projects.example.json to config/local.json and configure authorized local roots,
explicit Unity DLL references, python, and dotnet (use "dotnet" for an installed runtime).
Then run: ./Tools/explorer.ps1 -Task Dev
MCP: ./Tools/explorer.ps1 -Task Mcp

Full node_modules includes tsx and developer tools because the backend runs TypeScript.
Dependencies were restored offline from the frozen lock into a hoisted layout with regular files;
the package does not depend on pnpm symlinks, the source checkout or its package store.
No machine config, Git credentials, game source, caches, or Unity DLLs are included.
Game CI snapshot evidence is a separate artifact, not a local cache installation package.
Use the source checkout for Setup, tests or rebuilding the C# project; this package contains its built worker.
'@ | Set-Content -LiteralPath (Join-Path $output 'RUNNING.md') -Encoding utf8
@{schemaVersion=1;toolSha=$sha;sourceDirty=$sourceDirty;execution=$(if($env:GITHUB_ACTIONS -eq 'true'){'github-actions'}else{'local-check'});runId=$run;attempt=$attempt;runUrl=$(if($env:GITHUB_ACTIONS -eq 'true' -and $env:GITHUB_RUN_ID){'https://github.com/chwan886/Architecture-Explorer/actions/runs/'+$run+'/attempts/'+$attempt}else{$null});toolchain=$lock;kind='windows-source-runtime-build';dependencyLayout='offline-frozen-hoisted-copy';prerequisites=@('Git CLI','Python >=3.11','.NET 10 runtime');limitations=@('No installer','No local index import','No Unity DLL distribution')} | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $output 'build-manifest.json') -Encoding utf8
if($env:GITHUB_OUTPUT){'path='+$output | Add-Content $env:GITHUB_OUTPUT}
Write-Host "Tool package: $output"

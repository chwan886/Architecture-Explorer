param(
  [ValidateSet('Setup','Dev','Web','Scan','Watch','Verify','Test','Build','Typecheck','Mcp')][string]$Task='Dev',
  [string]$ProjectRoot='', [string]$ProjectName='', [string]$ProjectId='my-project',
  [string]$UnityEditorPath='', [string]$Config='', [string]$Project='', [string]$Worktree=''
)
$ErrorActionPreference='Stop'
$toolRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $toolRoot
$lock = Get-Content -LiteralPath (Join-Path $toolRoot 'toolchain.lock.json') -Raw | ConvertFrom-Json
$tools = Join-Path $toolRoot '.tools'
$nodeDir = Join-Path $tools ('node-v'+$lock.node.version+'-win-x64')
$node = Join-Path $nodeDir 'node.exe'
$dotnet = Join-Path $tools 'dotnet/dotnet.exe'
$pnpm = Join-Path $tools 'package-manager/node_modules/pnpm/bin/pnpm.cjs'
if (!(Test-Path -LiteralPath $pnpm)) { $pnpm = Join-Path $tools 'package-manager/node_modules/pnpm/bin/pnpm.mjs' }
function Invoke-Checked([string]$Binary,[string[]]$Arguments) {
  & $Binary @Arguments
  if ($LASTEXITCODE -ne 0) { throw "命令失败，退出码 $LASTEXITCODE" }
}
function Install-Archive([string]$Url,[string]$Destination,[string]$Hash,[string]$Algorithm,[string]$ArchiveName) {
  New-Item -ItemType Directory -Force -Path $tools | Out-Null
  $archive = Join-Path $tools $ArchiveName
  if (!(Test-Path -LiteralPath $archive) -or (Get-FileHash -LiteralPath $archive -Algorithm $Algorithm).Hash.ToLowerInvariant() -ne $Hash) {
    Write-Host "下载官方依赖：$ArchiveName"
    Invoke-WebRequest -Uri $Url -OutFile $archive -UseBasicParsing
  }
  if ((Get-FileHash -LiteralPath $archive -Algorithm $Algorithm).Hash.ToLowerInvariant() -ne $Hash) { throw '下载校验失败' }
  Expand-Archive -LiteralPath $archive -DestinationPath $Destination -Force
}
if ($Task -eq 'Setup') {
  if (!(Test-Path -LiteralPath $node)) { Install-Archive $lock.node.url $tools $lock.node.sha256 'SHA256' 'node.zip' }
  if (!(Test-Path -LiteralPath $dotnet)) { Install-Archive $lock.dotnet.url (Join-Path $tools 'dotnet') $lock.dotnet.sha512 'SHA512' 'dotnet-sdk.zip' }
  $env:PATH = $nodeDir + ';' + $env:PATH
  $env:DOTNET_CLI_HOME = Join-Path $tools 'dotnet-home'
  $env:NUGET_PACKAGES = Join-Path $tools 'nuget'
  $env:DOTNET_CLI_TELEMETRY_OPTOUT='1'
  $env:DOTNET_NOLOGO='1'
  $env:DOTNET_ADD_GLOBAL_TOOLS_TO_PATH='0'
  $env:DOTNET_GENERATE_ASPNET_CERTIFICATE='false'
  $python='python'
  $configured=Join-Path $toolRoot 'config/local.json'
  if(Test-Path -LiteralPath $configured){
    $existing=Get-Content -LiteralPath $configured -Raw | ConvertFrom-Json
    if($existing.python){$python=$existing.python;if($python.Contains('/') -or $python.Contains('\')){if(![IO.Path]::IsPathRooted($python)){$python=Join-Path (Split-Path -Parent $configured) $python}}}
  }
  Invoke-Checked $python @('-B','-c','import sys; assert sys.version_info >= (3,11), "Python 3.11+ required"; print("Python", sys.version.split()[0])')
  if (!(Test-Path -LiteralPath $pnpm)) {
    Invoke-Checked $node @((Join-Path $nodeDir 'node_modules/npm/bin/npm-cli.js'),'install','--prefix',(Join-Path $tools 'package-manager'),('pnpm@'+$lock.pnpm.version),'--ignore-scripts','--no-audit','--no-fund')
    $pnpm=Join-Path $tools 'package-manager/node_modules/pnpm/bin/pnpm.cjs'
    if (!(Test-Path -LiteralPath $pnpm)) { $pnpm=Join-Path $tools 'package-manager/node_modules/pnpm/bin/pnpm.mjs' }
  }
  Invoke-Checked $node @($pnpm,'install','--frozen-lockfile','--store-dir',(Join-Path $tools 'pnpm-store'))
  Invoke-Checked $dotnet @('build','analyzers/csharp/ArchitectureExplorer.Analyzers.csproj','-c','Release','-p:RestoreLockedMode=true')
  $local=Join-Path $toolRoot 'config/local.json'
  if (!(Test-Path -LiteralPath $local)) {
    if ($ProjectRoot) {
      $target=(Resolve-Path -LiteralPath $ProjectRoot).Path
      $settings=Get-Content -LiteralPath 'config/projects.example.json' -Raw | ConvertFrom-Json
      $settings.projects[0].id=$ProjectId
      $settings.projects[0].name=$(if($ProjectName){$ProjectName}else{Split-Path -Leaf $target})
      $settings.projects[0].root=$target
      if($UnityEditorPath){
        $managed=Join-Path (Resolve-Path -LiteralPath $UnityEditorPath).Path 'Editor/Data/Managed'
        $settings.projects[0].references=@(Get-ChildItem -LiteralPath (Join-Path $managed 'UnityEngine') -Filter '*.dll' | ForEach-Object {$_.FullName})
      }
      $settings | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $local -Encoding UTF8
    } else { Copy-Item -LiteralPath 'config/projects.example.json' -Destination $local; Write-Host '请编辑 config/local.json 中的项目路径。' }
  }
  Write-Host '准备完成。使用 Tools/explorer.ps1 -Task Dev 启动。'
  exit 0
}
if (!(Test-Path -LiteralPath $node)) {
  $available=Get-Command node -ErrorAction SilentlyContinue
  if($available){$node=$available.Source}else{throw '请先运行 Tools/explorer.ps1 -Task Setup'}
}
if ($Config) { $env:EXPLORER_CONFIG=(Resolve-Path -LiteralPath $Config).Path }
$commandArgs=@()
if($Project){$commandArgs+=@('--project',$Project)}
if($Worktree){$commandArgs+=@('--worktree',$Worktree)}
switch($Task) {
  'Dev' { Invoke-Checked $node @('node_modules/tsx/dist/cli.mjs','apps/server/src/main.ts') }
  'Mcp' { Invoke-Checked $node @('node_modules/tsx/dist/cli.mjs','apps/mcp/src/main.ts') }
  'Web' { Invoke-Checked $node @('node_modules/vite/bin/vite.js','--config','apps/web/vite.config.ts') }
  'Scan' { Invoke-Checked $node (@('node_modules/tsx/dist/cli.mjs','apps/server/src/cli.ts','scan','--full')+$commandArgs) }
  'Watch' { Invoke-Checked $node (@('node_modules/tsx/dist/cli.mjs','apps/server/src/cli.ts','watch')+$commandArgs) }
  'Verify' { Invoke-Checked $node (@('node_modules/tsx/dist/cli.mjs','apps/server/src/cli.ts','verify')+$commandArgs) }
  'Test' { Invoke-Checked $node @('node_modules/tsx/dist/cli.mjs','--test','tests/*.test.ts','apps/web/src/*.test.ts','apps/web/src/architecture/*.test.ts','apps/web/src/semantics/*.test.ts','apps/web/src/control/*.test.ts') }
  'Typecheck' { Invoke-Checked $node @('node_modules/typescript/bin/tsc','--noEmit') }
  'Build' { Invoke-Checked $node @('node_modules/vite/bin/vite.js','build','--config','apps/web/vite.config.ts') }
}

param(
  [string]$ReceiptPath = 'artifacts/ci/explorer-dispatch.json'
)

# Reference integration source for GameDemo02/Tools/dispatch-explorer.ps1.
# The game controller owns its in-progress sender; do not overwrite that implementation.
# Never run this from a PR or reuse the target's game-read credential.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$sourceRepository = $env:GITHUB_REPOSITORY
$gameSha = $env:GITHUB_SHA
$sourceRunId = $env:GITHUB_RUN_ID
$sourceRunAttempt = $env:GITHUB_RUN_ATTEMPT
if ($sourceRepository -cne 'chwan886/GameDemo02') { throw 'Unexpected source repository' }
if ($env:GITHUB_EVENT_NAME -cne 'push' -or $env:GITHUB_REF -cne 'refs/heads/main') { throw 'Only a main push may dispatch' }
if ($env:DELIVERY_REF_PROTECTED -cne 'true') { throw 'main protection must be active' }
if ($env:EXPLORER_AUTOBUILD_ENABLED -cne 'true') { throw 'Automatic delivery is disabled' }
if ($gameSha -cnotmatch '^[0-9a-f]{40}$') { throw 'Expected the exact 40-character game SHA' }
if ($sourceRunId -cnotmatch '^[1-9][0-9]*$') { throw 'Invalid source run ID' }
if ($sourceRunAttempt -cnotmatch '^[1-9][0-9]*$') { throw 'Invalid source run attempt' }
if ([string]::IsNullOrWhiteSpace($env:EXPLORER_DISPATCH_TOKEN)) { throw 'Missing short-lived dispatch token' }

$targetRepository = 'chwan886/Architecture-Explorer'
$sourceRunUrl = "https://github.com/$sourceRepository/actions/runs/$sourceRunId"
$body = @{
  ref = 'main'
  inputs = @{
    contract_version = '1'
    source_repo = $sourceRepository
    source_ref = 'refs/heads/main'
    source_sha = $gameSha
    source_run_id = $sourceRunId
    source_run_attempt = $sourceRunAttempt
    source_run_url = $sourceRunUrl
  }
} | ConvertTo-Json -Depth 4 -Compress
$headers = @{
  Accept = 'application/vnd.github+json'
  Authorization = "Bearer $($env:EXPLORER_DISPATCH_TOKEN)"
  'X-GitHub-Api-Version' = '2026-03-10'
}
$response = Invoke-WebRequest -Method Post `
  -Uri "https://api.github.com/repos/$targetRepository/actions/workflows/game-index.yml/dispatches" `
  -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 45
if ($response.StatusCode -ne 200) { throw 'Dispatch did not return a run receipt' }
$run = $response.Content | ConvertFrom-Json
$targetRunId = [string]$run.workflow_run_id
if ($targetRunId -cnotmatch '^[1-9][0-9]*$') { throw 'Dispatch response has no valid run ID' }
$expectedRunUrl = "https://github.com/$targetRepository/actions/runs/$targetRunId"
$expectedApiUrl = "https://api.github.com/repos/$targetRepository/actions/runs/$targetRunId"
if ($run.html_url -cne $expectedRunUrl -or $run.run_url -cne $expectedApiUrl) { throw 'Unexpected target run URLs' }

$receipt = [ordered]@{
  schemaVersion = 1
  contractVersion = '1'
  requestedAt = [DateTime]::UtcNow.ToString('o')
  sourceRepository = $sourceRepository
  sourceRef = 'refs/heads/main'
  gameSha = $gameSha
  sourceRunId = $sourceRunId
  sourceRunUrl = $sourceRunUrl
  sourceRunAttempt = $sourceRunAttempt
  sourceAttemptUrl = "$sourceRunUrl/attempts/$sourceRunAttempt"
  targetRepository = $targetRepository
  targetWorkflow = '.github/workflows/game-index.yml'
  targetRef = 'main'
  requestAccepted = $true
  targetRunId = $targetRunId
  targetRunUrl = $expectedRunUrl
  targetConclusion = 'not-observed'
}
$receiptDirectory = Split-Path -Parent $ReceiptPath
if ($receiptDirectory) { New-Item -ItemType Directory -Force -Path $receiptDirectory | Out-Null }
$receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ReceiptPath -Encoding utf8
"target_run_id=$targetRunId" | Add-Content -LiteralPath $env:GITHUB_OUTPUT -Encoding utf8
"target_run_url=$expectedRunUrl" | Add-Content -LiteralPath $env:GITHUB_OUTPUT -Encoding utf8
@"
### Architecture Explorer trigger request accepted

Game SHA: ``$gameSha``

[Source checks]($sourceRunUrl) · [Target workflow run]($expectedRunUrl)

This receipt records request acceptance. The target run reports build/index success or failure independently.
"@ | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding utf8

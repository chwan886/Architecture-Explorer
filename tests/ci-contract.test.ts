import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { TOOL_ROOT } from '../packages/indexer/src/index.ts';
import { authorizeInput } from '../Tools/ci-authorize.ts';
import { snapshotInput } from '../Tools/ci-snapshot.ts';

const execute = promisify(execFile);
test('game reference sender, workflow environment mapping and both receiver gates share the exact v1 contract', async () => {
  await mkdir(path.join(TOOL_ROOT, '.tmp'), { recursive: true });
  const directory = await mkdtemp(path.join(TOOL_ROOT, '.tmp/ci-contract-'));
  try {
    await execute('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference='Stop'
      function Invoke-WebRequest {
        param($Method,$Uri,$Headers,$ContentType,$Body,$TimeoutSec)
        if($Method -cne 'Post' -or $Uri -cne 'https://api.github.com/repos/chwan886/Architecture-Explorer/actions/workflows/game-index.yml/dispatches'){throw 'Unexpected dispatch endpoint'}
        $Body | Set-Content -LiteralPath $env:FIXTURE_BODY -Encoding utf8
        return [pscustomobject]@{StatusCode=200;Content='{"workflow_run_id":99,"run_url":"https://api.github.com/repos/chwan886/Architecture-Explorer/actions/runs/99","html_url":"https://github.com/chwan886/Architecture-Explorer/actions/runs/99"}'}
      }
      & $env:FIXTURE_SENDER -ReceiptPath $env:FIXTURE_RECEIPT
    `], { cwd: directory, windowsHide: true, timeout: 30000, env: { ...process.env,
      GITHUB_REPOSITORY: 'chwan886/GameDemo02', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '71', GITHUB_RUN_ATTEMPT: '2', DELIVERY_REF_PROTECTED: 'true',
      EXPLORER_AUTOBUILD_ENABLED: 'true', EXPLORER_DISPATCH_TOKEN: 'fixture-only-not-a-credential',
      GITHUB_OUTPUT: path.join(directory, 'output.txt'), GITHUB_STEP_SUMMARY: path.join(directory, 'summary.txt'),
      FIXTURE_BODY: path.join(directory, 'body.json'), FIXTURE_SENDER: path.join(TOOL_ROOT, 'docs/ci/dispatch-explorer.ps1'), FIXTURE_RECEIPT: path.join(directory, 'receipt.json'),
    } });
    const body = JSON.parse((await readFile(path.join(directory, 'body.json'), 'utf8')).replace(/^\uFEFF/, ''));
    assert.equal(body.ref, 'main');
    assert.deepEqual(Object.keys(body.inputs).sort(), ['contract_version', 'source_repo', 'source_ref', 'source_sha', 'source_run_id', 'source_run_attempt', 'source_run_url'].sort());
    assert.ok(Object.values(body.inputs).every(value => typeof value === 'string'));
    const workflow = await readFile(path.join(TOOL_ROOT, '.github/workflows/game-index.yml'), 'utf8');
    const mapping = [...workflow.matchAll(/^      (CI_[A-Z_]+): \$\{\{ inputs\.([a-z_]+) \}\}/gm)];
    const received = Object.fromEntries(mapping.map(([, name, input]) => [name, body.inputs[input]]));
    assert.equal(mapping.length, 7, 'Every v1 input must reach both receiver gates');
    const receiver = { ...received, GITHUB_REPOSITORY: 'chwan886/Architecture-Explorer', GITHUB_REF: 'refs/heads/main',
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: 'b'.repeat(40), GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_RUN_ID: '99', GITHUB_RUN_ATTEMPT: '1', INDEX_ACCESS_APPROVED: 'true', RULE_BYPASS_REVIEWED: 'true',
      GAME_CI_WORKFLOW_PATH: '.github/workflows/architecture.yml', GAME_REQUIRED_JOB_NAMES: '["fast-gate"]',
      GAME_REQUIRED_CHECK_CONTEXTS: '["fast-gate"]', CI_GAME_ROOT: 'fixture/game', CI_UNITY_REFERENCES: 'fixture/references.json' };
    assert.equal(authorizeInput(receiver).runAttempt, '2');
    assert.equal(snapshotInput(receiver).sourceRunAttempt, '2');
    assert.equal(snapshotInput(receiver).gameSha, 'a'.repeat(40));
    const receipt = (await readFile(path.join(directory, 'receipt.json'), 'utf8')).replace(/^\uFEFF/, '');
    assert.equal(JSON.parse(receipt).targetConclusion, 'not-observed');
    assert.ok(!receipt.includes('fixture-only-not-a-credential'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

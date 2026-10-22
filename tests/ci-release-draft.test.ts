import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { approvedReleaseRequest, releaseDraftInput, releaseHttp, runReleaseDraft } from '../Tools/ci-release-draft.ts';
import { releaseEvidenceFixture } from './release-evidence-fixture.ts';

function environment(): NodeJS.ProcessEnv {
  const f = releaseEvidenceFixture();
  return { GITHUB_REPOSITORY: f.context.repository, GITHUB_SERVER_URL: 'https://github.com', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main', GITHUB_REF_PROTECTED: 'true', GITHUB_SHA: f.context.toolSha, GITHUB_WORKFLOW_SHA: f.context.toolSha,
    GITHUB_WORKFLOW_REF: `${f.context.repository}/.github/workflows/game-index.yml@refs/heads/main`, GITHUB_RUN_ID: f.context.runId,
    GITHUB_RUN_ATTEMPT: '2', PRODUCER_RUN_ID: f.producer.runId, PRODUCER_ATTEMPT: f.producer.attempt, PRODUCER_TOOL_SHA: f.producer.headSha,
    BUILD_RESULT: 'success', INDEX_ACCESS_APPROVED: 'true', RULE_BYPASS_REVIEWED: 'true',
    TOOL_ARTIFACT_ID: f.artifacts.tool.output.id, TOOL_ARTIFACT_DIGEST: f.artifacts.tool.output.digest,
    INDEX_ARTIFACT_ID: f.artifacts.index.output.id, INDEX_ARTIFACT_DIGEST: f.artifacts.index.output.digest,
    CHECKS_ARTIFACT_ID: f.artifacts.checks.output.id, CHECKS_ARTIFACT_DIGEST: f.artifacts.checks.output.digest,
    CI_CONTRACT_VERSION: f.dispatch.contract_version, CI_SOURCE_REPO: f.dispatch.source_repo, CI_SOURCE_REF: f.dispatch.source_ref,
    CI_SOURCE_SHA: f.dispatch.source_sha, CI_SOURCE_RUN_ID: f.dispatch.source_run_id, CI_SOURCE_RUN_ATTEMPT: f.dispatch.source_run_attempt,
    CI_SOURCE_RUN_URL: f.dispatch.source_run_url };
}

test('publisher CLI freezes one successful producer while a publisher-only rerun keeps its original attempt', () => {
  const input = releaseDraftInput(environment());
  assert.equal(input.producerAttempt, '1'); assert.equal(input.publisherAttempt, '2'); assert.equal(input.runId, '9001');
  assert.deepEqual(Object.keys(input.dispatch).sort(), Object.keys(releaseEvidenceFixture().dispatch).sort());
});
for (const [key, value] of Object.entries({ GITHUB_REPOSITORY: 'other/repo', GITHUB_SERVER_URL: 'https://other.example',
  GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_REF: 'refs/heads/codex/task', GITHUB_REF_PROTECTED: 'false',
  GITHUB_WORKFLOW_SHA: '4'.repeat(40), GITHUB_WORKFLOW_REF: 'other/repo/.github/workflows/game-index.yml@refs/heads/main',
  BUILD_RESULT: 'failure', PRODUCER_RUN_ID: '9002', PRODUCER_TOOL_SHA: '4'.repeat(40), PRODUCER_ATTEMPT: '0',
  INDEX_ACCESS_APPROVED: 'false', RULE_BYPASS_REVIEWED: '', CI_SOURCE_SHA: '', CI_SOURCE_RUN_URL: 'https://evil.example',
  TOOL_ARTIFACT_ID: 'NaN', TOOL_ARTIFACT_DIGEST: 'abc', CHECKS_ARTIFACT_ID: environment().INDEX_ARTIFACT_ID! })) {
  test(`publisher CLI rejects invalid ${key} before HTTP or artifact reads`, () => assert.throws(() => releaseDraftInput({ ...environment(), [key]: value })));
}

test('publisher transport only allows fixed tool reads, draft creation and missing asset uploads', async () => {
  const token = 'fixture-only-token', calls: Array<{ url: string; init: RequestInit }> = [];
  const request = releaseHttp(token, (async (url, init) => {
    calls.push({ url: String(url), init: init! }); return new Response('{"id":123}', { status: 200 });
  }) as typeof fetch);
  await request({ method: 'GET', url: 'https://api.github.com/repos/chwan886/Architecture-Explorer/releases?per_page=100&page=100' });
  assert.equal(calls.length, 1); assert.equal(calls[0].init.redirect, 'error');
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, `Bearer ${token}`);
  for (const [method, url] of [
    ['GET', 'https://api.github.com/repos/chwan886/GameDemo02/releases'],
    ['GET', 'https://api.github.com.evil.example/repos/chwan886/Architecture-Explorer/releases'],
    ['GET', 'https://api.github.com/repos/chwan886/Architecture-Explorer/releases?token=secret'],
    ['GET', 'https://user:pass@api.github.com/repos/chwan886/Architecture-Explorer'],
    ['POST', 'https://api.github.com/repos/chwan886/Architecture-Explorer/pulls'],
    ['PATCH', 'https://api.github.com/repos/chwan886/Architecture-Explorer/releases/1'],
    ['DELETE', 'https://api.github.com/repos/chwan886/Architecture-Explorer/releases/1'],
    ['POST', 'https://uploads.github.com/repos/chwan886/Architecture-Explorer/releases/1/assets?name=../secret.zip'],
  ]) { assert.equal(approvedReleaseRequest(method, url), false); await assert.rejects(request({ method: method as 'GET', url })); }
  assert.equal(calls.length, 1, 'Rejected operations never receive the write token');
  assert.equal(approvedReleaseRequest('POST', 'https://uploads.github.com/repos/chwan886/Architecture-Explorer/releases/1/assets?name=release-manifest.json'), true);
});

test('bounded HTTP JSON and network failures remain failures without following a redirect', async () => {
  const endpoint = 'https://api.github.com/repos/chwan886/Architecture-Explorer';
  const redirected = releaseHttp('fixture-token', (async () => new Response(null, { status: 302, headers: { location: 'https://evil.example?secret=fixture' } })) as typeof fetch);
  assert.equal((await redirected({ method: 'GET', url: endpoint })).status, 302);
  const oversized = releaseHttp('fixture-token', (async () => new Response('x'.repeat(8 * 1024 * 1024 + 1))) as typeof fetch);
  await assert.rejects(oversized({ method: 'GET', url: endpoint }), /RELEASE_HTTP_RESPONSE_LIMIT/);
});

test('invalid source input emits only a sanitized immutable failed receipt and makes no request', async () => {
  const base = path.resolve('.tmp'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'release-cli-rejected-'));
  try {
    let calls = 0;
    const receipt = await runReleaseDraft({ ...environment(), CI_SOURCE_SHA: 'fixture-secret-never-log' }, async () => { calls++; throw Error('must not request'); }, root);
    assert.equal(calls, 0); assert.equal(receipt.outcome, 'failed'); assert.equal(receipt.failureStage, 'context');
    const file = path.join(root, '.ci-release/receipts/release-draft-input-rejected.json'), text = await readFile(file, 'utf8');
    assert.ok(!text.includes('fixture-secret-never-log')); assert.equal(JSON.parse(text).outcome, 'failed');
    await assert.rejects(runReleaseDraft({ ...environment(), CI_SOURCE_SHA: '' }, async () => { calls++; throw Error('must not request'); }, root), { code: 'EEXIST' });
    assert.equal(await readFile(file, 'utf8'), text);
  } finally {
    assert.equal(path.dirname(root).toLowerCase(), base.toLowerCase()); assert.match(path.basename(root), /^release-cli-rejected-/);
    await rm(root, { recursive: true });
  }
});

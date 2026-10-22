import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { releaseHttp, runReleaseDraft } from '../Tools/ci-release-draft.ts';
import type { ReleaseEvidenceInput } from '../Tools/ci-release-evidence.ts';
import type { ReleasePublishHttpRequest, ReleasePublishRequest } from '../Tools/ci-release-publish.ts';
import { releaseEvidenceFixture } from './release-evidence-fixture.ts';
import { releasePublisherFixture } from './release-publisher-fixture.ts';
import { createNativeFixtureZip, type Item } from './release-native-zip-fixture.ts';

const repository = 'chwan886/Architecture-Explorer', api = `https://api.github.com/repos/${repository}`;
const token = 'offline-publisher-fixture-token-do-not-reflect';
type Json = Record<string, any>;
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
type Prepared = { root: string; input: ReleaseEvidenceInput; zipPaths: Record<'tool' | 'index' | 'checks', string>; zipPins: Record<string, string> };

async function withPrepared(mode: 'valid' | 'missing-readme', run: (prepared: Prepared) => Promise<void>) {
  assert.equal(process.platform, 'win32', 'Native ZIP integration exercises the production Windows metadata adapter');
  const workspace = await realpath(process.cwd()), base = path.join(workspace, '.tmp');
  await mkdir(base, { recursive: true });
  assert.equal(await realpath(base), base); assert.equal((await lstat(base)).isSymbolicLink(), false);
  const root = await mkdtemp(path.join(base, 'release-draft-integration-')), ownership = randomUUID();
  const marker = path.join(root, '.fixture-owner'); await writeFile(marker, ownership, { flag: 'wx' });
  const initial = await lstat(root, { bigint: true });
  try {
    const input = releaseEvidenceFixture();
    // The sender's workflow can still run while its successful Fast job has already authorized the receiver.
    (input.artifacts.index.documents['authorization/authorization.json'] as Json).sourceRun.statusAtAuthorization = 'in_progress';
    const zipPaths = {} as Prepared['zipPaths'], zipPins: Record<string, string> = {};
    for (const kind of ['tool', 'index', 'checks'] as const) {
      const evidence = input.artifacts[kind], directory = path.join(root, '.ci-release/raw', kind);
      await mkdir(directory, { recursive: true });
      const filename = path.join(directory, `${kind}.zip`); zipPaths[kind] = filename;
      const items: Item[] = evidence.entries.filter(entry => mode !== 'missing-readme' ||
        !entry.path.endsWith('/human-models/architecture/models/game-demo-02/README.md')).map(entry => {
        if (Object.hasOwn(evidence.documents, entry.path)) return { name: entry.path, json: evidence.documents[entry.path], attributes: entry.externalAttributes };
        const syntheticHumanText = entry.path.endsWith('/architecture/models/game-demo-02/model.json') ? 'unchanged synthetic human text and pending anchors'
          : entry.path.endsWith('/architecture/models/game-demo-02/README.md') ? 'unchanged synthetic maintained README'
          : entry.path.endsWith('/architecture/semantics/game-demo-02/README.md') ? 'unchanged synthetic semantic README' : undefined;
        return { name: entry.path, raw: Buffer.from(syntheticHumanText ?? ' '.repeat(entry.size)).toString('base64'), attributes: entry.externalAttributes };
      });
      if (kind === 'tool') items.push({ name: 'README.md', raw: Buffer.from('Synthetic tool package for a non-executing integration fixture.').toString('base64') },
        { name: 'bin/worker.exe', raw: Buffer.from('MZ static synthetic bytes; never execute or extract.').toString('base64') });
      await createNativeFixtureZip(filename, items);
      const bytes = await readFile(filename), digest = hash(bytes); zipPins[kind] = digest;
      evidence.output.digest = digest;
      evidence.actualZipSha256 = digest; evidence.actualZipBytes = bytes.length;
      Object.assign(evidence.metadata as Json, { digest: `sha256:${digest}`, size_in_bytes: bytes.length,
        unrelatedSensitiveField: 'fake-private-response-field-must-not-reflect' });
    }
    await run({ root, input, zipPaths, zipPins });
  } finally {
    const current = await lstat(root, { bigint: true });
    assert.equal(current.isSymbolicLink(), false); assert.equal(current.dev, initial.dev); assert.equal(current.ino, initial.ino);
    assert.equal(await readFile(marker, 'utf8'), ownership);
    const resolved = await realpath(root);
    assert.equal(path.dirname(resolved), base); assert.match(path.basename(resolved), /^release-draft-integration-/);
    await rm(resolved, { recursive: true });
  }
}
function environment(prepared: Prepared, publisherAttempt = '2'): NodeJS.ProcessEnv {
  const f = prepared.input;
  return { GITHUB_REPOSITORY: f.context.repository, GITHUB_SERVER_URL: 'https://github.com', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main', GITHUB_REF_PROTECTED: 'true', GITHUB_SHA: f.context.toolSha, GITHUB_WORKFLOW_SHA: f.context.toolSha,
    GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/game-index.yml@refs/heads/main`, GITHUB_RUN_ID: f.context.runId,
    GITHUB_RUN_ATTEMPT: publisherAttempt, PRODUCER_RUN_ID: f.producer.runId, PRODUCER_ATTEMPT: f.producer.attempt, PRODUCER_TOOL_SHA: f.producer.headSha,
    BUILD_RESULT: 'success', INDEX_ACCESS_APPROVED: 'true', RULE_BYPASS_REVIEWED: 'true',
    TOOL_ARTIFACT_ID: f.artifacts.tool.output.id, TOOL_ARTIFACT_DIGEST: f.artifacts.tool.output.digest,
    INDEX_ARTIFACT_ID: f.artifacts.index.output.id, INDEX_ARTIFACT_DIGEST: f.artifacts.index.output.digest,
    CHECKS_ARTIFACT_ID: f.artifacts.checks.output.id, CHECKS_ARTIFACT_DIGEST: f.artifacts.checks.output.digest,
    CI_CONTRACT_VERSION: f.dispatch.contract_version, CI_SOURCE_REPO: f.dispatch.source_repo, CI_SOURCE_REF: f.dispatch.source_ref,
    CI_SOURCE_SHA: f.dispatch.source_sha, CI_SOURCE_RUN_ID: f.dispatch.source_run_id, CI_SOURCE_RUN_ATTEMPT: f.dispatch.source_run_attempt,
    CI_SOURCE_RUN_URL: f.dispatch.source_run_url, GITHUB_OUTPUT: path.join(prepared.root, 'github-output.txt'), GITHUB_STEP_SUMMARY: path.join(prepared.root, 'github-summary.md') };
}
function httpFixture(prepared: Prepared, mode: 'valid' | 'wrong-digest' | 'producer-failure' = 'valid') {
  const f = prepared.input, tagName = `ae-tool-${f.context.toolSha}-game-${f.dispatch.source_sha}-r${f.producer.runId}-a${f.producer.attempt}`;
  const publishing = releasePublisherFixture({ toolSha: f.context.toolSha, tagName });
  const calls: ReleasePublishHttpRequest[] = [];
  const request: ReleasePublishRequest = async input => {
    calls.push(input);
    if (input.method === 'GET' && input.url === `${api}/actions/runs/${f.producer.runId}/attempts/${f.producer.attempt}`) return { status: 200, data: {
      id: Number(f.producer.runId), run_attempt: Number(f.producer.attempt), head_sha: f.producer.headSha, head_branch: f.producer.headBranch,
      path: f.producer.workflowPath, event: f.producer.event, status: 'in_progress', conclusion: null,
    } };
    if (input.method === 'GET' && input.url === `${api}/actions/runs/${f.producer.runId}/attempts/${f.producer.attempt}/jobs?per_page=100&page=1`) return { status: 200, data: { jobs: [{
      id: 6001, run_id: Number(f.producer.runId), run_attempt: Number(f.producer.attempt), head_sha: f.producer.headSha,
      name: f.producer.jobName, status: 'completed', conclusion: mode === 'producer-failure' ? 'failure' : 'success',
    }] } };
    for (const kind of ['tool', 'index', 'checks'] as const) if (input.method === 'GET' && input.url === `${api}/actions/artifacts/${f.artifacts[kind].output.id}`) {
      const data = structuredClone(f.artifacts[kind].metadata) as Json;
      if (mode === 'wrong-digest' && kind === 'index') data.digest = 'sha256:' + '0'.repeat(64);
      return { status: 200, data };
    }
    return await publishing.request(input);
  };
  // Exercise the real fixed-host/encoded-path transport gate with an injected fetch implementation, never a network request.
  const send = (async (url, init) => {
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${token}`); assert.equal(headers['X-GitHub-Api-Version'], '2026-03-10');
    assert.equal(init?.redirect, 'error');
    const input: ReleasePublishHttpRequest = { method: init?.method as 'GET' | 'POST', url: String(url) };
    if (typeof init?.body === 'string') input.json = JSON.parse(init.body);
    else if (init?.body instanceof Uint8Array) { input.bytes = init.body; input.contentType = headers['content-type'] as 'application/zip' | 'application/json'; }
    const response = await request(input);
    return new Response(response.data === undefined ? null : JSON.stringify(response.data), { status: response.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { publishing, calls, request: releaseHttp(token, send) };
}

test('full CLI uses three real native ZIPs through the branded validator and fixed HTTP adapter; publisher-only retry reuses every asset', async () => withPrepared('valid', async prepared => {
  const fixture = httpFixture(prepared), env2 = environment(prepared, '2');
  const receipt = await runReleaseDraft(env2, fixture.request, prepared.root);
  assert.equal(receipt.outcome, 'passed', JSON.stringify(receipt)); assert.equal(receipt.complete, true);
  assert.equal(receipt.publisher.runId, '9001'); assert.equal(receipt.publisher.runAttempt, '2');
  assert.equal(receipt.publisher.runUrl, `${api.replace('api.github.com/repos', 'github.com')}/actions/runs/9001/attempts/2`);
  assert.equal(receipt.release.id, 100); assert.equal(receipt.release.draft, true); assert.equal(receipt.release.publishedAt, null);
  assert.equal(receipt.assets.length, 3); assert.equal(fixture.publishing.writes().length, 4);
  const manifestRequest = fixture.publishing.writes().find(call => call.url.endsWith('name=release-manifest.json'))!;
  const manifestBytes = Buffer.from(manifestRequest.bytes!), manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(manifest.evidence.auditResult, 'gaps'); assert.equal(manifest.evidence.semanticCoverage, 'partial-semantic-context');
  assert.ok(manifest.evidence.reviews.ownership.pending > 0); assert.equal(manifest.producerRun.attempt, '1');
  assert.equal(Object.hasOwn(manifest, 'publisherAttempt'), false);
  const receipt2Path = path.join(prepared.root, '.ci-release/receipts/release-draft-9001-p1-publisher-2.json');
  const firstText = await readFile(receipt2Path, 'utf8'); assert.deepEqual(JSON.parse(firstText), receipt);
  for (const secret of [token, 'fake-private-response-field-must-not-reflect']) assert.equal(firstText.includes(secret), false);
  const stableBody = fixture.publishing.state.release!.body, writes = fixture.publishing.writes().length;
  const retried = await runReleaseDraft(environment(prepared, '3'), fixture.request, prepared.root);
  assert.equal(retried.outcome, 'passed', JSON.stringify(retried)); assert.equal(retried.publisher.runAttempt, '3');
  assert.equal(retried.release.id, receipt.release.id); assert.equal(retried.binding.fingerprint, receipt.binding.fingerprint);
  assert.deepEqual(retried.assets.map((asset: Json) => asset.id), receipt.assets.map((asset: Json) => asset.id));
  assert.ok(retried.assets.every((asset: Json) => asset.action === 'reused')); assert.equal(fixture.publishing.writes().length, writes);
  assert.equal(fixture.publishing.state.release!.body, stableBody); assert.equal(await readFile(receipt2Path, 'utf8'), firstText);
  assert.deepEqual((await readdir(path.dirname(receipt2Path))).sort(), ['release-draft-9001-p1-publisher-2.json', 'release-draft-9001-p1-publisher-3.json']);
  for (const kind of ['tool', 'index', 'checks'] as const) assert.equal(hash(await readFile(prepared.zipPaths[kind])), prepared.zipPins[kind]);
  assert.equal((await readdir(prepared.root)).includes('bin'), false, 'No runtime file was extracted or executed');
  assert.ok((await readFile(env2.GITHUB_OUTPUT!, 'utf8')).includes('release_id=100'));
  assert.ok((await readFile(env2.GITHUB_STEP_SUMMARY!, 'utf8')).includes(receipt.release.htmlUrl));
}));

for (const mode of ['wrong-digest', 'missing-readme', 'producer-failure'] as const) test(`full CLI rejects ${mode} before creating any draft`, async () =>
  withPrepared(mode === 'missing-readme' ? 'missing-readme' : 'valid', async prepared => {
    const fixture = httpFixture(prepared, mode === 'missing-readme' ? 'valid' : mode);
    const receipt = await runReleaseDraft(environment(prepared), fixture.request, prepared.root);
    assert.equal(receipt.outcome, 'failed'); assert.equal(receipt.complete, false); assert.equal(receipt.failureStage, 'frozen-evidence');
    assert.equal(fixture.publishing.writes().length, 0); assert.ok(fixture.calls.every(call => call.method === 'GET'));
    const text = await readFile(path.join(prepared.root, '.ci-release/receipts/release-draft-9001-p1-publisher-2.json'), 'utf8');
    assert.equal(text.includes(token), false); assert.equal(text.includes('fake-private-response-field-must-not-reflect'), false);
  }));

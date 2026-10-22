import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appendFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { validateReleaseEvidence, type ReleaseArtifactEvidence, type ReleaseEvidenceInput } from './ci-release-evidence.ts';
import { publishReleaseDraft, type DraftReleaseReceipt, type ReleasePublishRequest } from './ci-release-publish.ts';
import { readReleaseArchive } from './ci-release-archive.ts';

const repository = 'chwan886/Architecture-Explorer';
const api = `https://api.github.com/repos/${repository}`;
const exactSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && value.length === 40;
const positive = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && value.length <= 20;
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && value.length === 64;
type Json = Record<string, any>;

/** The CLI exposes no URL, credential-provider, command or alternate repository parameter. */
export function releaseDraftInput(env: NodeJS.ProcessEnv) {
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.GITHUB_SERVER_URL, 'https://github.com');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_REF_PROTECTED, 'true');
  assert.equal(env.GITHUB_WORKFLOW_REF, `${repository}/.github/workflows/game-index.yml@refs/heads/main`);
  assert.ok(exactSha(env.GITHUB_SHA));
  assert.equal(env.GITHUB_WORKFLOW_SHA, env.GITHUB_SHA);
  assert.equal(env.BUILD_RESULT, 'success');
  assert.equal(env.INDEX_ACCESS_APPROVED, 'true');
  assert.equal(env.RULE_BYPASS_REVIEWED, 'true');
  for (const name of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'PRODUCER_RUN_ID', 'PRODUCER_ATTEMPT']) assert.ok(positive(env[name]) && Number.isSafeInteger(Number(env[name])));
  assert.equal(env.PRODUCER_RUN_ID, env.GITHUB_RUN_ID);
  assert.equal(env.PRODUCER_TOOL_SHA, env.GITHUB_SHA);
  const dispatch = {
    contract_version: env.CI_CONTRACT_VERSION!, source_repo: env.CI_SOURCE_REPO!, source_ref: env.CI_SOURCE_REF!, source_sha: env.CI_SOURCE_SHA!,
    source_run_id: env.CI_SOURCE_RUN_ID!, source_run_attempt: env.CI_SOURCE_RUN_ATTEMPT!, source_run_url: env.CI_SOURCE_RUN_URL!,
  };
  assert.equal(dispatch.contract_version, '1'); assert.equal(dispatch.source_repo, 'chwan886/GameDemo02');
  assert.equal(dispatch.source_ref, 'refs/heads/main'); assert.ok(exactSha(dispatch.source_sha));
  assert.ok(positive(dispatch.source_run_id) && positive(dispatch.source_run_attempt));
  assert.equal(dispatch.source_run_url, `https://github.com/chwan886/GameDemo02/actions/runs/${dispatch.source_run_id}`);
  const artifacts = Object.fromEntries(['tool', 'index', 'checks'].map(kind => {
    const id = env[`${kind.toUpperCase()}_ARTIFACT_ID`], digest = env[`${kind.toUpperCase()}_ARTIFACT_DIGEST`];
    assert.ok(positive(id) && Number.isSafeInteger(Number(id))); assert.ok(sha256(digest));
    return [kind, { id, digest }];
  })) as Record<'tool' | 'index' | 'checks', { id: string; digest: string }>;
  assert.equal(new Set(Object.values(artifacts).map(item => item.id)).size, 3);
  return { toolSha: env.GITHUB_SHA!, gameSha: dispatch.source_sha, runId: env.GITHUB_RUN_ID!, producerAttempt: env.PRODUCER_ATTEMPT!,
    publisherAttempt: env.GITHUB_RUN_ATTEMPT!, dispatch, artifacts };
}

export function approvedReleaseRequest(method: string, raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.href !== raw || url.protocol !== 'https:' || url.username || url.password || url.hash || url.port) return false;
    if (url.origin === 'https://uploads.github.com') return method === 'POST' &&
      /^\/repos\/chwan886\/Architecture-Explorer\/releases\/[1-9][0-9]*\/assets$/.test(url.pathname) &&
      /^\?name=[A-Za-z0-9._-]+\.(?:zip|json)$/.test(url.search);
    if (url.origin !== 'https://api.github.com') return false;
    if (method === 'POST') return raw === `${api}/releases`;
    if (method !== 'GET') return false;
    if (raw === 'https://api.github.com/users/github-actions%5Bbot%5D') return true;
    if (url.search && !/^\?per_page=100&page=(?:[1-9][0-9]?|100)$/.test(url.search)) return false;
    const suffix = url.pathname.slice(`/repos/${repository}`.length);
    if (!url.pathname.startsWith(`/repos/${repository}`)) return false;
    return /^(?:|\/branches\/main|\/git\/ref\/heads\/main|\/git\/ref\/tags\/[A-Za-z0-9._-]+|\/git\/tags\/[a-f0-9]{40}|\/releases|\/releases\/[1-9][0-9]*(?:\/assets)?|\/actions\/artifacts\/[1-9][0-9]*|\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*(?:\/jobs)?)$/.test(suffix);
  } catch { return false; }
}

/** Fixed-host, bounded transport. Errors and response bodies are never logged. POST is never retried. */
export function releaseHttp(token: string, send: typeof fetch = fetch): ReleasePublishRequest {
  assert.ok(typeof token === 'string' && token.length > 0 && !/[\x00-\x20\x7f]/.test(token));
  return async request => {
    assert.ok(approvedReleaseRequest(request.method, request.url));
    assert.ok(!(request.bytes && request.json));
    const response = await send(request.url, { method: request.method, redirect: 'error', signal: AbortSignal.timeout(request.bytes ? 180000 : 30000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10',
        'user-agent': 'Architecture-Explorer-private-draft', ...(request.bytes || request.json ? { 'content-type': request.contentType ?? 'application/json' } : {}) },
      body: request.bytes ? Buffer.from(request.bytes) : request.json ? JSON.stringify(request.json) : undefined });
    const chunks: Uint8Array[] = []; let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length;
          if (size > 8 * 1024 * 1024) { await reader.cancel(); throw Error('RELEASE_HTTP_RESPONSE_LIMIT'); } chunks.push(item.value); }
      } finally { reader.releaseLock(); }
    }
    let data: unknown;
    if (size) data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    return { status: response.status, data };
  };
}

async function noLinks(absolute: string) {
  let cursor = path.parse(absolute).root;
  for (const part of path.relative(cursor, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part); assert.ok(!(await lstat(cursor)).isSymbolicLink());
  }
}
async function rawArtifact(root: string, kind: 'tool' | 'index' | 'checks') {
  const directory = path.join(root, '.ci-release/raw', kind);
  await noLinks(directory);
  const files = await readdir(directory); assert.equal(files.length, 1, 'One pinned raw archive is required per artifact');
  const file = path.join(directory, files[0]);
  assert.ok(path.dirname(file).toLowerCase() === directory.toLowerCase());
  await noLinks(file); assert.ok((await lstat(file)).isFile());
  return file;
}

export async function runReleaseDraft(env: NodeJS.ProcessEnv, request: ReleasePublishRequest, root: string) {
  let stage = 'context', receipt: (DraftReleaseReceipt & { failureStage?: string }) | Json = { schemaVersion: '1.0.0', outcome: 'failed', draftOnly: true,
    complete: false, repository, failureCode: 'RELEASE_INPUT_OR_EVIDENCE_REJECTED' };
  const resolvedRoot = await realpath(root); await noLinks(resolvedRoot);
  let input: ReturnType<typeof releaseDraftInput> | undefined;
  try {
    input = releaseDraftInput(env);
    const get = async (url: string): Promise<Json> => { const response = await request({ method: 'GET', url }); assert.equal(response.status, 200); return response.data as Json; };
    stage = 'repository-and-producer';
    const metadata = await get(api), branch = await get(`${api}/branches/main`);
    assert.equal(metadata.full_name, repository); assert.equal(metadata.private, true); assert.equal(metadata.visibility, 'private');
    assert.equal(metadata.default_branch, 'main'); assert.notEqual(metadata.archived, true); assert.notEqual(metadata.disabled, true);
    assert.equal(branch.name, 'main'); assert.equal(branch.protected, true); assert.equal(branch.commit?.sha, input.toolSha);
    const attempt = await get(`${api}/actions/runs/${input.runId}/attempts/${input.producerAttempt}`);
    assert.equal(attempt.id, Number(input.runId)); assert.equal(attempt.run_attempt, Number(input.producerAttempt));
    const matching: Json[] = [];
    for (let page = 1; page <= 10; page++) {
      const response = await get(`${api}/actions/runs/${input.runId}/attempts/${input.producerAttempt}/jobs?per_page=100&page=${page}`);
      assert.ok(Array.isArray(response.jobs) && response.jobs.length <= 100);
      matching.push(...response.jobs.filter((item: Json) => item.name === 'Build tool and verify exact game SHA'));
      if (response.jobs.length < 100) break; assert.ok(page < 10, 'Producer job pagination limit');
    }
    assert.equal(matching.length, 1); const job = matching[0];
    assert.equal(job.run_id, Number(input.runId)); assert.equal(job.run_attempt, Number(input.producerAttempt)); assert.equal(job.head_sha, input.toolSha);
    const artifacts = {} as ReleaseEvidenceInput['artifacts']; const files = new Map<string, string>();
    for (const kind of ['tool', 'index', 'checks'] as const) {
      stage = `artifact-${kind}`;
      const artifact = await get(`${api}/actions/artifacts/${input.artifacts[kind].id}`);
      const file = await rawArtifact(resolvedRoot, kind); files.set(kind, file);
      const archive = await readReleaseArchive(file, kind, { toolSha: input.toolSha, gameSha: input.gameSha,
        runId: input.runId, producerAttempt: input.producerAttempt });
      artifacts[kind] = { output: input.artifacts[kind], metadata: artifact, ...archive } as ReleaseArtifactEvidence;
    }
    stage = 'frozen-evidence';
    const plan = validateReleaseEvidence({
      context: { repository: env.GITHUB_REPOSITORY!, serverUrl: env.GITHUB_SERVER_URL!, repositoryId: metadata.id,
        isPrivate: metadata.private, visibility: metadata.visibility, defaultBranch: metadata.default_branch, eventName: env.GITHUB_EVENT_NAME!,
        ref: env.GITHUB_REF!, refProtected: env.GITHUB_REF_PROTECTED === 'true', effectiveProtected: branch.protected === true,
        toolSha: input.toolSha, runId: input.runId, publisherAttempt: input.publisherAttempt,
        indexAccessApproved: env.INDEX_ACCESS_APPROVED!, ruleBypassReviewed: env.RULE_BYPASS_REVIEWED! },
      producer: { runId: String(attempt.id), attempt: String(attempt.run_attempt), headSha: attempt.head_sha, headBranch: attempt.head_branch,
        workflowPath: attempt.path, event: attempt.event, jobName: job.name, status: job.status, conclusion: job.conclusion, result: env.BUILD_RESULT! },
      dispatch: input.dispatch, artifacts,
    });
    const bytes = new Map<string, Uint8Array>();
    for (const asset of plan.assets) bytes.set(asset.name, await readFile(files.get(asset.kind)!));
    stage = 'publish-draft';
    receipt = await publishReleaseDraft(plan, bytes, request, { runId: input.runId, runAttempt: input.publisherAttempt,
      runUrl: `https://github.com/${repository}/actions/runs/${input.runId}/attempts/${input.publisherAttempt}` });
  } catch { receipt.failureStage = stage; }
  const output = path.join(resolvedRoot, '.ci-release/receipts');
  await mkdir(output, { recursive: true }); await noLinks(output);
  const name = input ? `release-draft-${input.runId}-p${input.producerAttempt}-publisher-${input.publisherAttempt}.json` : 'release-draft-input-rejected.json';
  await writeFile(path.join(output, name), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  if (receipt.outcome === 'passed') {
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `release_url=${receipt.release.htmlUrl}\nrelease_id=${receipt.release.id}\n`);
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,
      `\n## Private tool Release draft\n\nVerified draft: ${receipt.release.htmlUrl}\n\nTool SHA: ${input!.toolSha}\n\nGame SHA: ${input!.gameSha}\n\nDraft only; publish manually after this job succeeds.\n`);
  }
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 2);
    const token = process.env.RELEASE_PUBLISH_TOKEN; assert.ok(token);
    const receipt = await runReleaseDraft(process.env, releaseHttp(token), fileURLToPath(new URL('..', import.meta.url)));
    if (receipt.outcome !== 'passed') { console.error('Private Release draft failed; inspect the sanitized receipt.'); process.exitCode = 1; }
    else console.log('Private Release draft and pinned assets verified; manual publication remains required.');
  } catch { console.error('Private Release draft entry failed; no credential or response body is logged.'); process.exitCode = 1; }
}

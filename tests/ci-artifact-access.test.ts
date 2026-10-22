import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { authorizeArtifactAccess, type ArtifactRepository } from '../Tools/ci-artifact-access.ts';

const repository = 'chwan886/Architecture-Explorer';
const env = { GITHUB_REPOSITORY: repository, GITHUB_SERVER_URL: 'https://github.com', GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/heads/main', GITHUB_REF_PROTECTED: 'true', GITHUB_SHA: 'a'.repeat(40), INDEX_ACCESS_APPROVED: 'true' };
const metadata: ArtifactRepository = { full_name: repository, default_branch: 'main', private: true, visibility: 'private' };

test('tool package access requires a private repository and an independently approved game audience', async () => {
  const reads: string[] = [];
  const result = await authorizeArtifactAccess(env, async requested => { reads.push(requested); return metadata; });
  assert.deepEqual(reads, [repository], 'The guard only reads its own repository; no game credential is needed');
  assert.equal(result.containsGameSourceExcerpts, true);
  assert.equal(result.sourceGameRepository, 'chwan886/GameDemo02');
});

test('PR, feature/unprotected main, unapproved audience and malformed identities fail before any API read', async () => {
  for (const invalid of [
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'pull_request_target' }, { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_REF_PROTECTED: 'false' },
    { INDEX_ACCESS_APPROVED: undefined }, { INDEX_ACCESS_APPROVED: 'false' },
    { GITHUB_REPOSITORY: 'attacker/Architecture-Explorer' }, { GITHUB_SERVER_URL: 'https://github.com.evil.invalid' },
    { GITHUB_SHA: '' }, { GITHUB_SHA: 'main' },
  ]) {
    let read = false;
    await assert.rejects(authorizeArtifactAccess({ ...env, ...invalid }, async () => { read = true; return metadata; }));
    assert.equal(read, false, `An invalid access condition made a repository read: ${JSON.stringify(invalid)}`);
  }
});

test('public/internal repository, changed default/identity and unreadable metadata cannot authorize delivery', async () => {
  for (const invalid of [
    { private: false, visibility: 'public' }, { private: true, visibility: 'internal' },
    { private: true, visibility: 'public' }, { full_name: 'attacker/Architecture-Explorer' }, { default_branch: 'feature' },
  ]) await assert.rejects(authorizeArtifactAccess(env, async () => ({ ...metadata, ...invalid })));
  await assert.rejects(authorizeArtifactAccess(env, async () => { throw Error('HTTP 403'); }), /HTTP 403/);
});

function job(workflow: string, id: string) {
  const body = new RegExp(`^  ${id}:\\r?\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, 'm').exec(workflow)?.[1];
  assert.ok(body, `Expected job ${id}`); return body;
}

test('required PR checks keep their identity without Environment or cross-repository credentials; only private reports upload', async () => {
  const workflow = await readFile(new URL('../.github/workflows/tool-ci.yml', import.meta.url), 'utf8');
  const checks = job(workflow, 'tool-checks');
  assert.match(checks, /name: Tool \/ typecheck, tests and builds/);
  assert.match(checks, /\.\/Tools\/ci-check\.ps1 -Prepare/);
  assert.doesNotMatch(checks, /environment:|\$\{\{\s*secrets\.|GAME_READ|create-github-app-token|ci-package\.ps1/);
  assert.match(checks, /if: always\(\) && github\.event\.repository\.private/);
});

test('main package job binds tested SHA to its protected Environment and denies upload without artifact access', async () => {
  const workflow = await readFile(new URL('../.github/workflows/tool-ci.yml', import.meta.url), 'utf8');
  const packaging = job(workflow, 'tool-package');
  assert.match(packaging, /needs: tool-checks/);
  assert.match(packaging, /if: github\.event_name == 'push'.*github\.ref == 'refs\/heads\/main'/);
  assert.match(packaging, /environment: architecture-delivery/);
  assert.match(packaging, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(packaging, /TOOL_ARTIFACT_READ_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(packaging, /INDEX_ACCESS_APPROVED: \$\{\{ vars\.INDEX_ACCESS_APPROVED \}\}/);
  assert.doesNotMatch(packaging, /\$\{\{\s*secrets\.|GAME_READ|create-github-app-token|inputs\./);
  const authorize = packaging.indexOf('Tools/ci-artifact-access.ts'), pack = packaging.indexOf('./Tools/ci-package.ps1');
  assert.ok(authorize >= 0 && pack > authorize, 'Access must be verified before copying curated game excerpts into the package');
  assert.match(packaging, /if: success\(\) && steps\.artifact-access\.outputs\.artifact_access == 'allowed'/);
});

test('game dispatch cannot upload its quote-bearing tool package when source authorization failed', async () => {
  const workflow = await readFile(new URL('../.github/workflows/game-index.yml', import.meta.url), 'utf8');
  const toolArtifact = /if: ([^\r\n]+)\r?\n\s+id: tool-artifact/.exec(workflow)?.[1];
  assert.ok(toolArtifact);
  assert.match(toolArtifact, /steps\.package\.outcome == 'success'/);
  assert.match(toolArtifact, /steps\.package-runtime\.outcome == 'success'/);
  assert.match(toolArtifact, /steps\.authorize\.outputs\.index_access == 'allowed'/);
  assert.match(workflow, /UNITY_REFERENCES_URL: \$\{\{ secrets\.UNITY_REFERENCES_URL \}\}/);
});

test('game tool artifact upload requires successful runtime and cleanup even when package and authorization passed', async () => {
  const workflow = await readFile(new URL('../.github/workflows/game-index.yml', import.meta.url), 'utf8');
  const condition = /if: ([^\r\n]+)\r?\n\s+id: tool-artifact/.exec(workflow)?.[1];
  assert.ok(condition);
  const clauses = condition.split(/\s*&&\s*/);
  assert.deepEqual(clauses, ['always()', "steps.package.outcome == 'success'", "steps.package-runtime.outcome == 'success'", "steps.authorize.outputs.index_access == 'allowed'"]);
  const permits = (packageOutcome: string, runtimeOutcome: string, authorization: string) => clauses.every(clause => ({
    'always()': true,
    "steps.package.outcome == 'success'": packageOutcome === 'success',
    "steps.package-runtime.outcome == 'success'": runtimeOutcome === 'success',
    "steps.authorize.outputs.index_access == 'allowed'": authorization === 'allowed',
  } as Record<string, boolean>)[clause] === true);
  assert.equal(permits('success', 'success', 'allowed'), true);
  for (const runtimeOutcome of ['failure', 'cancelled', 'skipped', '', 'cleanup-failed']) {
    assert.equal(permits('success', runtimeOutcome, 'allowed'), false, `Runtime/cleanup outcome ${runtimeOutcome} must block package upload`);
  }
  assert.equal(permits('failure', 'success', 'allowed'), false);
  assert.equal(permits('success', 'success', 'denied'), false);
});

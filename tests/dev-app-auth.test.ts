import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createAppJwt, githubAppRequest, parseDevelopmentAppConfig, runDevelopmentApp, type AppOperation, type AuthRequest } from '../Tools/dev-app-auth.ts';
import type { TaskPushPlan } from '../Tools/dev-app-git.ts';

const config = parseDevelopmentAppConfig({ schemaVersion: 1, appId: 12345, installationId: 67890, appSlug: 'example-development-agent',
  repository: 'example-org/public-tool', baseBranch: 'production', keyDirectory: 'D:/local-app-keys' });
const head = 'a'.repeat(40), branch = 'codex/example-change', installationToken = 'fixture-installation-token', jwt = 'fixture.app.jwt';
const pullRequest: AppOperation = { operation: 'pull-request', branch, expectedHead: head, title: 'Review a public tool change', body: 'A synthetic fixture.' };
type Call = { method: string; endpoint: string; credential: string; body?: Record<string, any> };
type ResponseData = { status: number; data?: any };
function fixture(override?: (call: Call, state: any) => ResponseData | undefined) {
  const permissions = { contents: 'write', metadata: 'read', pull_requests: 'write', workflows: 'write', actions: 'read' };
  const installation = { id: config.installationId, app_id: config.appId, app_slug: config.appSlug,
    account: { id: 345, login: 'example-org', type: 'Organization' }, target_type: 'Organization',
    repository_selection: 'selected', suspended_at: null, permissions };
  const repository = { id: 99, full_name: config.repository, owner: { login: 'example-org' } };
  const pr = { number: 7, html_url: `https://github.com/${config.repository}/pull/7`, state: 'open', merged_at: null,
    base: { ref: config.baseBranch, repo: { full_name: config.repository } },
    head: { ref: branch, sha: head, repo: { full_name: config.repository } },
    user: { id: 76543, login: `${config.appSlug}[bot]`, type: 'Bot' } };
  const state: any = { app: { id: config.appId, slug: config.appSlug, permissions }, installation, membership: structuredClone(installation),
    repository, pr, existing: [], revoked: false, requested: {}, signs: 0, workflowRequired: false, prepares: 0, pushes: 0,
    runs: [{ id: 11, run_attempt: 2, html_url: `https://github.com/${config.repository}/actions/runs/11`, path: '.github/workflows/ci.yml',
      event: 'pull_request', head_sha: head, status: 'completed', conclusion: 'success', pull_requests: [{ number: 7, head: { sha: head } }] }],
    jobs: [{ id: 22, run_id: 11, run_attempt: 2, head_sha: head, name: 'CI gate', status: 'completed', conclusion: 'success' }] };
  const calls: Call[] = [], waits: number[] = [];
  const request: AuthRequest = async (method, endpoint, credential, body) => {
    const call = { method, endpoint, credential, body }; calls.push(call);
    const response = override?.(call, state); if (response !== undefined) return response;
    if (method === 'GET' && endpoint === '/app') return { status: 200, data: state.app };
    if (method === 'GET' && endpoint === `/app/installations/${config.installationId}`) return { status: 200, data: state.installation };
    if (method === 'GET' && endpoint === `/repos/${config.repository}/installation`) return { status: 200, data: state.membership };
    if (method === 'POST' && endpoint === `/app/installations/${config.installationId}/access_tokens`) {
      state.requested = body;
      return { status: 201, data: { token: installationToken, permissions: { ...body!.permissions, metadata: 'read' },
        repository_selection: 'selected', repositories: [state.repository], expires_at: '2026-10-25T21:00:00Z' } };
    }
    if (method === 'DELETE' && endpoint === '/installation/token') { state.revoked = true; return { status: 204 }; }
    if (method === 'GET' && endpoint === '/installation/repositories?per_page=100&page=1') return state.revoked ? { status: 401 }
      : { status: 200, data: { total_count: 1, repositories: [state.repository] } };
    if (method === 'GET' && endpoint === `/repos/${config.repository}/git/ref/heads/${config.baseBranch}`)
      return { status: 200, data: { ref: `refs/heads/${config.baseBranch}`, object: { type: 'commit', sha: 'b'.repeat(40) } } };
    if (method === 'GET' && endpoint === `/repos/${config.repository}/git/ref/heads/${encodeURIComponent(branch)}`)
      return { status: 200, data: { ref: `refs/heads/${branch}`, object: { type: 'commit', sha: head } } };
    if (method === 'GET' && endpoint === `/users/${config.appSlug}%5Bbot%5D`) return { status: 200, data: state.pr.user };
    if (method === 'GET' && endpoint.startsWith(`/repos/${config.repository}/pulls?`)) return { status: 200, data: state.existing };
    if (endpoint === `/repos/${config.repository}/pulls/7`) return { status: 200, data: state.pr };
    if (method === 'POST' && endpoint === `/repos/${config.repository}/pulls`) return { status: 201, data: state.pr };
    if (method === 'GET' && endpoint.includes('/actions/runs?')) return { status: 200, data: { workflow_runs: state.runs } };
    if (method === 'GET' && endpoint.endsWith('/attempts/2/jobs?per_page=100&page=1')) return { status: 200, data: { jobs: state.jobs } };
    throw new Error(`Unexpected fixture request; sensitive diagnostic ${installationToken} ${jwt}`);
  };
  const dependencies = { request, signJwt: () => { state.signs++; return jwt; }, now: () => Date.parse('2026-10-25T20:00:00Z'),
    wait: async (ms: number) => { waits.push(ms); },
    preparePush: async (input: any) => {
      assert.deepEqual(Object.keys(input).sort(), ['baseBranch', 'branch', 'expectedHead', 'repository', 'workingDirectory']);
      state.prepares++;
      return Object.freeze({ ...input, baseHead: 'b'.repeat(40), origin: `https://github.com/${config.repository}.git`, requiresWorkflows: state.workflowRequired }) as TaskPushPlan;
    },
    push: async (plan: TaskPushPlan, token: string) => { assert.equal(token, installationToken); state.pushes++;
      return { outcome: 'passed' as const, repository: plan.repository, branch: plan.branch, expectedHead: plan.expectedHead,
        pushOutcome: 'succeeded' as const, remoteHeadVerified: true, ownerAuthenticationUsed: false as const, secretRecorded: false as const }; } };
  return { state, calls, waits, dependencies, run: (operation: AppOperation = { operation: 'verify' }) => runDevelopmentApp(config, operation, dependencies) };
}
const minted = (f: ReturnType<typeof fixture>) => f.calls.filter(call => call.method === 'POST' && call.endpoint.endsWith('/access_tokens'));
const deleted = (f: ReturnType<typeof fixture>) => f.calls.filter(call => call.method === 'DELETE');
function secretFree(receipt: unknown) {
  const text = JSON.stringify(receipt); assert.ok(!text.includes(installationToken)); assert.ok(!text.includes(jwt));
}

test('explicit single-repository configuration rejects extra credentials, arbitrary destinations and unsafe refs', () => {
  assert.equal(Object.isFrozen(config), true);
  for (const invalid of [null, {}, { ...config, token: 'forbidden' }, { ...config, appId: 0 }, { ...config, installationId: 1.5 },
    { ...config, repository: 'https://example.invalid/repo' }, { ...config, repository: 'owner/repo/extra' },
    { ...config, appSlug: '../agent' }, { ...config, baseBranch: 'codex/feature' }, { ...config, baseBranch: 'main..bad' },
    { ...config, baseBranch: 'main.lock' }, { ...config, keyDirectory: 'relative/keys' }, { ...config, keyDirectory: '//server/share/keys' },
    { ...config, keyDirectory: 'C:/keys:stream' }]) assert.throws(() => parseDevelopmentAppConfig(invalid));
});

test('App JWT uses the configured app ID, bounded lifetime and a verifiable RSA signature', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = Date.parse('2026-10-25T20:00:00Z'), signed = createAppJwt(privateKey, config.appId, now), parts = signed.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(parts[0], 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(parts[1], 'base64url').toString()), { iat: now / 1000 - 60, exp: now / 1000 + 540, iss: config.appId });
  assert.equal(verify('RSA-SHA256', Buffer.from(parts.slice(0, 2).join('.')), publicKey, Buffer.from(parts[2], 'base64url')), true);
  assert.throws(() => createAppJwt(publicKey, config.appId, now));
});

test('verify authenticates the configured organization installation and only its single read-only repository token', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.outcome, 'passed'); assert.equal(result.ownerAuthenticationUsed, false);
  assert.deepEqual(f.state.requested, { repositories: ['public-tool'], permissions: { contents: 'read' } });
  assert.equal(result.token.revocation, 'confirmed-204'); assert.equal(result.token.revokedTokenProbe, 'rejected-401');
  assert.equal(minted(f).length, 1); assert.equal(deleted(f).length, 1); assert.deepEqual(f.waits, []);
  assert.ok(f.calls.every(call => call.credential === jwt || call.credential === installationToken)); secretFree(result);
});

test('invalid operations, base pushes, arbitrary repositories and mixed modes stop before signing or networking', async () => {
  for (const operation of [ { operation: 'merge' }, { operation: 'approve' }, { operation: 'verify', repository: 'other/repo' },
    { operation: 'status', expectedHead: head, prNumber: 0 }, { ...pullRequest, branch: config.baseBranch },
    { ...pullRequest, expectedHead: 'latest' }, { ...pullRequest, state: 'closed' }, { ...pullRequest, body: ['-----BEGIN','PRIVATE KEY-----'].join(' ') }]) {
    const f = fixture(); await assert.rejects(f.run(operation as AppOperation)); assert.equal(f.state.signs, 0); assert.equal(f.calls.length, 0);
  }
});

test('wrong App, installation, target membership or excessive registered permissions never mint a token', async () => {
  for (const change of [(s: any) => { s.app.id++; }, (s: any) => { s.app.permissions = { ...s.app.permissions, administration: 'write' }; },
    (s: any) => { s.installation.id++; }, (s: any) => { s.installation.repository_selection = 'all'; },
    (s: any) => { s.membership.account.login = 'another-org'; }, (s: any) => { s.membership.id++; }]) {
    const f = fixture(); change(f.state); const result = await f.run(); assert.equal(result.outcome, 'failed'); assert.equal(minted(f).length, 0); secretFree(result);
  }
});

test('push preflight runs before signing and workflow rights are requested only when its exact plan requires them', async () => {
  for (const workflows of [false, true]) {
    const f = fixture(); f.state.workflowRequired = workflows;
    const prepare = f.dependencies.preparePush;
    f.dependencies.preparePush = async input => { assert.equal(f.state.signs, 0); return prepare(input); };
    const result = await f.run({ operation: 'push', branch, expectedHead: head, workingDirectory: 'D:/fixture-worktree' });
    assert.equal(result.outcome, 'passed'); assert.equal(f.state.prepares, 1); assert.equal(f.state.pushes, 1);
    assert.deepEqual(f.state.requested.permissions, { contents: 'write', ...(workflows ? { workflows: 'write' } : {}) }); secretFree(result);
  }
  const failed = fixture(); failed.dependencies.preparePush = async () => { throw new Error('dirty tree'); };
  assert.equal((await failed.run({ operation: 'push', branch, expectedHead: head, workingDirectory: 'D:/fixture-worktree' })).failureCode, 'TASK_PUSH_PREFLIGHT_FAILED');
  assert.equal(failed.state.signs, 0); assert.equal(failed.calls.length, 0);
});

test('a minted token is revoked even when its permissions, repository set or expiry are malformed', async () => {
  const mutations = [(data: any) => { data.permissions.administration = 'write'; }, (data: any) => { data.repositories.push({ id: 100, full_name: 'another/repo' }); },
    (data: any) => { data.repository_selection = 'all'; }, (data: any) => { data.expires_at = '2099-01-01T00:00:00Z'; }];
  for (const mutate of mutations) {
    const f = fixture(call => {
      if (call.endpoint.endsWith('/access_tokens')) {
        const data = { token: installationToken, permissions: { contents: 'read', metadata: 'read' }, repository_selection: 'selected',
          repositories: [{ id: 99, full_name: config.repository, owner: { login: 'example-org' } }], expires_at: '2026-10-25T21:00:00Z' };
        mutate(data); return { status: 201, data };
      }
    });
    const result = await f.run(); assert.equal(result.outcome, 'failed'); assert.equal(deleted(f).length, 1);
    assert.equal(result.token.revokedTokenProbe, 'rejected-401'); secretFree(result);
  }
});

test('unexpected issuance HTTP status still captures and revokes any returned token', async () => {
  const f = fixture(call => call.endpoint.endsWith('/access_tokens') ? { status: 500, data: { token: installationToken } } : undefined);
  const result = await f.run(); assert.equal(result.outcome, 'failed'); assert.equal(deleted(f).length, 1); secretFree(result);
});

test('actual visible repository scope must match the exact issued single-repository identity', async () => {
  const f = fixture((call, state) => call.endpoint === '/installation/repositories?per_page=100&page=1' && !state.revoked
    ? { status: 200, data: { total_count: 2, repositories: [state.repository, { id: 100, full_name: 'another/repo' }] } } : undefined);
  const result = await f.run(); assert.equal(result.failureCode, 'TOKEN_VISIBLE_SCOPE_MISMATCH'); assert.equal(deleted(f).length, 1);
});

test('operation errors cannot expose raw JWTs, tokens, response bodies or Owner credentials', async () => {
  const f = fixture(call => { if (call.endpoint.includes('/git/ref/')) throw new Error(`Bearer ${installationToken}; PEM parser ${jwt}`); });
  const result = await f.run(); assert.equal(result.failureCode, 'APP_OPERATION_FAILED'); assert.equal(deleted(f).length, 1); secretFree(result);
});

test('revocation requires both DELETE 204 and the original token returning 401; issuance and DELETE never retry', async () => {
  const f = fixture((call, state) => state.revoked && call.method === 'GET' && call.endpoint.startsWith('/installation/repositories') ? { status: 200, data: {} } : undefined);
  const result = await f.run(); assert.equal(result.outcome, 'failed'); assert.equal(result.failureCode, 'TOKEN_REVOCATION_NOT_CONFIRMED');
  assert.deepEqual(result.token.revokedTokenProbeStatuses, [200, 200, 200, 200, 200, 200]);
  assert.deepEqual(f.waits, [250, 500, 1000, 2000, 4000]); assert.equal(minted(f).length, 1); assert.equal(deleted(f).length, 1);
  const badDelete = fixture((call, state) => {
    if (call.method === 'DELETE') { state.revoked = true; return { status: 403 }; }
  });
  const denied = await badDelete.run(); assert.equal(denied.outcome, 'failed'); assert.equal(denied.token.revokedTokenProbe, 'rejected-401');
});

test('403 and 429 during invalidation probing stop without being counted as token revocation', async () => {
  for (const status of [403, 429]) {
    const f = fixture((call, state) => state.revoked && call.method === 'GET' ? { status } : undefined);
    const result = await f.run(); assert.equal(result.outcome, 'failed'); assert.deepEqual(result.token.revokedTokenProbeStatuses, [status]); assert.deepEqual(f.waits, []);
  }
});

test('App PR creation uses the configured base, exact branch/head and verified bot numeric identity', async () => {
  const f = fixture(), result = await f.run(pullRequest);
  assert.equal(result.outcome, 'passed'); assert.equal(result.performedOperations.createPr, true);
  assert.equal(result.pullRequest.author.login, `${config.appSlug}[bot]`); assert.equal(result.pullRequest.author.id, 76543);
  assert.deepEqual(f.state.requested.permissions, { contents: 'read', pull_requests: 'write' });
  const writes = f.calls.filter(call => call.method === 'POST' && call.endpoint.endsWith('/pulls'));
  assert.equal(writes.length, 1); assert.deepEqual(writes[0].body, { title: (pullRequest as any).title, body: (pullRequest as any).body,
    head: branch, base: config.baseBranch, draft: false, maintainer_can_modify: false }); secretFree(result);
});

test('existing App PR updates contain only title/body and never approval, merge, state, base or head mutations', async () => {
  const f = fixture(), result = await f.run({ ...pullRequest, prNumber: 7 } as AppOperation);
  assert.equal(result.outcome, 'passed'); assert.equal(result.performedOperations.updatePr, true);
  const writes = f.calls.filter(call => call.method === 'PATCH'); assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0].body!).sort(), ['body', 'title']);
  assert.ok(f.calls.every(call => !/\/reviews|\/merge|\/rules|\/dispatch/.test(call.endpoint)));
});

test('a personal or spoofed-bot PR is refused before any update', async () => {
  for (const user of [{ id: 1, login: 'human-maintainer', type: 'User' }, { id: 123, login: `${config.appSlug}[bot]`, type: 'Bot' }]) {
    const f = fixture(call => call.endpoint.startsWith('/users/') ? { status: 200, data: { login: `${config.appSlug}[bot]`, type: 'Bot', id: 76543 } } : undefined);
    f.state.pr.user = user; const result = await f.run({ ...pullRequest, prNumber: 7 } as AppOperation);
    assert.equal(result.failureCode, 'PR_AUTHOR_IS_NOT_APP'); assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 0); assert.equal(deleted(f).length, 1);
  }
});

test('push refuses forged or stale local tracking bases even when a local plan requests fewer workflow permissions', async () => {
  const f = fixture(call => call.endpoint.endsWith(`/heads/${config.baseBranch}`)
    ? { status: 200, data: { ref: `refs/heads/${config.baseBranch}`, object: { type: 'commit', sha: 'c'.repeat(40) } } } : undefined);
  const result = await f.run({ operation: 'push', branch, expectedHead: head, workingDirectory: 'D:/fixture-worktree' });
  assert.equal(result.failureCode, 'PUSH_BASE_HEAD_CHANGED_OR_MISMATCHED'); assert.equal(f.state.pushes, 0); assert.equal(deleted(f).length, 1);
});

test('ambiguous existing PRs and remote head changes block writes without retrying', async () => {
  const ambiguous = fixture(); ambiguous.state.existing = [ambiguous.state.pr, ambiguous.state.pr];
  assert.equal((await ambiguous.run(pullRequest)).failureCode, 'OPEN_TASK_PR_AMBIGUOUS');
  const moved = fixture(call => call.endpoint.endsWith(`/heads/${encodeURIComponent(branch)}`) ? { status: 200, data: { ref: `refs/heads/${branch}`, object: { type: 'commit', sha: 'c'.repeat(40) } } } : undefined);
  assert.equal((await moved.run(pullRequest)).failureCode, 'REMOTE_TASK_HEAD_MISMATCH');
  assert.equal(moved.calls.filter(call => call.method === 'POST' && call.endpoint.endsWith('/pulls')).length, 0);
});

test('an accepted PR mutation stays recorded when later verification fails; interrupted creation stays unconfirmed', async () => {
  let headReads = 0;
  const moved = fixture(call => {
    if (call.endpoint.endsWith(`/heads/${encodeURIComponent(branch)}`) && ++headReads === 2)
      return { status: 200, data: { ref: `refs/heads/${branch}`, object: { type: 'commit', sha: 'c'.repeat(40) } } };
  });
  const result = await moved.run(pullRequest); assert.equal(result.outcome, 'failed'); assert.equal(result.performedOperations.createPr, true);
  assert.equal(result.pullRequestMutation.outcome, 'accepted'); assert.equal(deleted(moved).length, 1);
  const unknown = fixture(call => { if (call.method === 'POST' && call.endpoint.endsWith('/pulls')) throw new Error(installationToken); });
  const interrupted = await unknown.run(pullRequest); assert.equal(interrupted.pullRequestMutation.outcome, 'unconfirmed');
  assert.equal(unknown.calls.filter(call => call.method === 'POST' && call.endpoint.endsWith('/pulls')).length, 1); secretFree(interrupted);
});

test('status returns actual head-bound workflow and attempt-bound jobs without claiming branch rules or human approval', async () => {
  const f = fixture(), result = await f.run({ operation: 'status', expectedHead: head, prNumber: 7 });
  assert.equal(result.outcome, 'passed'); assert.equal(result.ci.outcome, 'success'); assert.equal(result.ci.complete, true);
  assert.equal(result.ci.requiredChecksVerified, false); assert.equal(result.ci.runs[0].attempt, 2); assert.equal(result.ci.runs[0].jobs[0].name, 'CI gate');
  assert.deepEqual(f.state.requested.permissions, { contents: 'read', pull_requests: 'read', actions: 'read' }); secretFree(result);
});

test('status never turns wrong SHA, empty jobs, failed jobs or missing Actions read into successful CI', async () => {
  for (const scenario of ['wrong-head', 'empty-jobs', 'failed-job', 'no-actions']) {
    const f = fixture();
    if (scenario === 'wrong-head') f.state.runs[0].head_sha = 'd'.repeat(40);
    if (scenario === 'empty-jobs') f.state.jobs = [];
    if (scenario === 'failed-job') f.state.jobs[0].conclusion = 'failure';
    if (scenario === 'no-actions') { delete f.state.app.permissions.actions; delete f.state.membership.permissions.actions; }
    const result = await f.run({ operation: 'status', expectedHead: head, prNumber: 7 });
    assert.equal(result.outcome, 'passed'); assert.notEqual(result.ci.outcome, 'success'); assert.equal(result.ci.requiredChecksVerified, false);
  }
});

test('jobs from another run, attempt or head and secret-bearing names fail closed and still revoke the token', async () => {
  for (const patch of [{ run_id: 12 }, { run_attempt: 1 }, { head_sha: 'd'.repeat(40) }, { name: installationToken }]) {
    const f = fixture(); Object.assign(f.state.jobs[0], patch);
    const result = await f.run({ operation: 'status', expectedHead: head, prNumber: 7 });
    assert.equal(result.failureCode, 'CI_JOB_IDENTITY_INVALID'); assert.equal(deleted(f).length, 1); secretFree(result);
  }
});

test('HTTP adapter pins GitHub, disables redirects, bounds successful JSON and discards failed bodies', async t => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
    assert.equal(url.origin, 'https://api.github.com'); assert.ok(url.searchParams.has('_verification_nonce'));
    assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 403 });
  });
  assert.deepEqual(await githubAppRequest('GET', '/app', jwt), { status: 403 }); assert.equal(cancelled, true);
  await assert.rejects(githubAppRequest('GET', '//attacker.invalid/path', jwt));
});

test('HTTP JSON response budget counts streamed bytes and cancels before consuming an oversized body', async t => {
  let pulls = 0, cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; },
  }), { status: 200 }));
  await assert.rejects(githubAppRequest('GET', '/app', jwt), /GITHUB_RESPONSE_TOO_LARGE/);
  assert.equal(cancelled, true); assert.ok(pulls <= 6, `Only budgeted chunks and at most one prefetched chunk are pulled: ${pulls}`);
});

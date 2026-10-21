import test from 'node:test';
import assert from 'node:assert/strict';
import { DEV_APP, runDevelopmentApp, type AppOperation, type AuthRequest, type Repository } from '../Tools/dev-app-auth.ts';

const now = Date.parse('2026-10-21T23:00:00Z'), sha = 'd'.repeat(40), jwt = 'fixture-jwt', token = 'fixture-iat';
const owner = { id: 1, login: DEV_APP.owner, type: 'User' }, bot = { id: 99, login: 'chwan-dev-agent[bot]', type: 'Bot' };
const appPermissions = { contents: 'write', metadata: 'read', pull_requests: 'write', workflows: 'write' };
const prOptions = (repository: Repository = 'chwan886/Architecture-Explorer'): Extract<AppOperation, { operation: 'pr' }> =>
  ({ operation: 'pr', repository, branch: 'codex/delivery', expectedHead: sha, title: 'Reviewed delivery change', body: 'Problem, behavior and actual validation.' });
type Mutate = (method: string, endpoint: string, result: any) => any;

function fixture(options: AppOperation, config: { existing?: boolean; actionsRead?: boolean; mutate?: Mutate } = {}) {
  const calls: { method: string; endpoint: string; credential: string; body?: Record<string, any> }[] = [];
  const repo = { id: 2, full_name: options.repository, owner, private: true };
  const permissions = { ...appPermissions, ...(config.actionsRead ? { actions: 'read' } : {}) };
  const installation = { id: 3, app_id: DEV_APP.id, app_slug: DEV_APP.slug, account: owner, target_type: 'User', repository_selection: 'selected', suspended_at: null, permissions };
  const pr = { number: 7, html_url: `https://github.com/${options.repository}/pull/7`, state: 'open', merged_at: null, user: bot,
    base: { ref: 'main', repo }, head: { ref: 'codex/delivery', sha, repo } };
  let revoked = false, requestedPermissions: any;
  const request: AuthRequest = async (method, endpoint, credential, body) => {
    calls.push({ method, endpoint, credential, body });
    let result: any;
    if (endpoint === '/app') result = { status: 200, data: { id: DEV_APP.id, client_id: DEV_APP.clientId, slug: DEV_APP.slug, owner, permissions } };
    else if (endpoint.startsWith('/app/installations?')) result = { status: 200, data: [installation] };
    else if (endpoint.endsWith('/installation') && endpoint.startsWith('/repos/')) result = { status: 200, data: installation };
    else if (endpoint === '/app/installations/3/access_tokens') { requestedPermissions = body?.permissions; result = { status: 201, data: { token, expires_at: new Date(now + 3_600_000).toISOString(), repository_selection: 'selected', repositories: [repo], permissions: { ...requestedPermissions, metadata: 'read' } } }; }
    else if (method === 'DELETE') { revoked = true; result = { status: 204 }; }
    else if (endpoint.startsWith('/installation/repositories')) result = revoked ? { status: 401 } : { status: 200, data: { total_count: 1, repositories: [repo] } };
    else if (endpoint.endsWith('/git/ref/heads/main')) result = { status: 200, data: { ref: 'refs/heads/main', object: { type: 'commit', sha: 'a'.repeat(40) } } };
    else if (endpoint.includes('/git/ref/heads/')) result = { status: 200, data: { ref: 'refs/heads/codex/delivery', object: { type: 'commit', sha } } };
    else if (endpoint.startsWith('/users/')) result = { status: 200, data: bot };
    else if (endpoint.includes('/pulls?')) result = { status: 200, data: config.existing ? [pr] : [] };
    else if (endpoint.endsWith('/pulls') && method === 'POST') result = { status: 201, data: pr };
    else if (/\/pulls\/7$/.test(endpoint)) result = { status: 200, data: pr };
    else if (endpoint.includes('/actions/runs?')) result = { status: 200, data: { workflow_runs: [{ id: 8, run_attempt: 2, head_sha: sha, event: 'pull_request', path: '.github/workflows/tool-ci.yml', status: 'completed', conclusion: 'success', html_url: `https://github.com/${options.repository}/actions/runs/8`, pull_requests: [{ number: 7, head: { sha } }] }] } };
    else if (endpoint.includes('/attempts/2/jobs?')) result = { status: 200, data: { jobs: [{ id: 9, name: 'Tool / typecheck, tests and builds', status: 'completed', conclusion: 'success',
      steps: [{ number: 1, name: 'Checks', status: 'completed', conclusion: 'success' }] }] } };
    else if (endpoint.endsWith('/actions/jobs/9/logs')) result = { status: 200, data: { outcome: 'unreadable', reason: 'CI_LOG_REDIRECT_UNAVAILABLE' } };
    else if (endpoint === '/graphql') result = { status: 200, data: { errors: [{ message: 'Resource not accessible by integration' }] } };
    else throw Error(`Unexpected fixture route ${method} ${endpoint}`);
    assert.equal(credential, endpoint.startsWith('/app') || endpoint.endsWith('/installation') ? jwt : token);
    return config.mutate ? config.mutate(method, endpoint, structuredClone(result)) : result;
  };
  const run = async () => {
    const result = await runDevelopmentApp(options, () => jwt, request, () => now, async () => {});
    assert.ok(!JSON.stringify(result).includes(token) && !JSON.stringify(result).includes(jwt));
    return result;
  };
  return { calls, run };
}

test('both repositories verify through the same auth session with a single selected read-only repository', async () => {
  for (const repository of DEV_APP.installedRepositories as Repository[]) {
    const f = fixture({ operation: 'verify', repository }), result = await f.run();
    assert.equal(result.outcome, 'passed');
    const mint = f.calls.find(call => call.endpoint.endsWith('/access_tokens'))!;
    assert.deepEqual(mint.body, { repositories: [repository.split('/')[1]], permissions: { contents: 'read' } });
    assert.deepEqual(result.installation.verifiedTargetMembership, [repository]);
    assert.equal(result.token.revocation, 'confirmed-204');
    assert.ok(!f.calls.some(call => call.endpoint.includes(repository.endsWith('GameDemo02') ? '/repos/chwan886/Architecture-Explorer/' : '/repos/chwan886/GameDemo02/')));
  }
});

test('invalid repository, main/ref injection, malformed exact SHA and PEM PR text are rejected before any credential use', async () => {
  for (const options of [
    { operation: 'verify', repository: 'other/repo' }, { ...prOptions(), branch: 'main' }, { ...prOptions(), branch: 'codex/x\n' },
    { ...prOptions(), branch: 'codex/../main' }, { ...prOptions(), expectedHead: sha + '\n' }, { ...prOptions(), expectedHead: 'abc' },
    { ...prOptions(), body: '-----BEGIN RSA PRIVATE KEY-----' }, { ...prOptions(), body: '-----BEGIN PGP PRIVATE KEY BLOCK-----' },
    { ...prOptions(), body: '-----begin private key-----' }, { ...prOptions(), prNumber: 0 },
  ]) {
    let calls = 0;
    const result = await runDevelopmentApp(options as AppOperation, () => { calls++; return jwt; }, async () => { calls++; throw Error('must not request'); });
    assert.equal(result.outcome, 'failed'); assert.equal(calls, 0);
  }
});

test('PR creation uses exact branch/head and main, and binds the returned author to the actual App bot ID', async () => {
  for (const repository of DEV_APP.installedRepositories as Repository[]) {
    const options = prOptions(repository), f = fixture(options), result = await f.run();
    assert.equal(result.outcome, 'passed'); assert.equal(result.pullRequest.author.login, bot.login);
    const mint = f.calls.find(call => call.endpoint.endsWith('/access_tokens'))!;
    assert.deepEqual(mint.body?.permissions, { contents: 'read', pull_requests: 'write' });
    assert.deepEqual(f.calls.find(call => call.endpoint.endsWith('/pulls') && call.method === 'POST')?.body,
      { title: options.title, body: options.body, head: options.branch, base: 'main', draft: false, maintainer_can_modify: false });
    assert.equal(result.token.revokedTokenProbe, 'rejected-401');
  }
});

test('existing App PR updates are idempotent and PATCH only title/body', async () => {
  for (const explicit of [false, true]) {
    const options = { ...prOptions(), ...(explicit ? { prNumber: 7 } : {}) }, f = fixture(options, { existing: true }), result = await f.run();
    assert.equal(result.outcome, 'passed'); assert.equal(result.pullRequest.operation, 'updated');
    assert.deepEqual(f.calls.find(call => call.method === 'PATCH')?.body, { title: options.title, body: options.body });
    assert.ok(!f.calls.some(call => call.method === 'POST' && call.endpoint.endsWith('/pulls')));
  }
});

test('PR wrong author/base/repository/head, closed PR or ambiguous candidates cannot be updated', async () => {
  for (const mutatePr of [
    (pr: any) => { pr.user.id++; }, (pr: any) => { pr.user.type = 'User'; }, (pr: any) => { pr.base.ref = 'other'; },
    (pr: any) => { pr.head.sha = 'a'.repeat(40); }, (pr: any) => { pr.head.repo.full_name = 'other/repo'; },
    (pr: any) => { pr.state = 'closed'; }, (pr: any) => { pr.merged_at = '2026-01-01'; },
  ]) {
    const f = fixture(prOptions(), { existing: true, mutate: (_method, endpoint, result) => { if (endpoint.includes('/pulls?')) mutatePr(result.data[0]); return result; } });
    assert.equal((await f.run()).outcome, 'failed'); assert.ok(!f.calls.some(call => call.method === 'PATCH'));
  }
  const f = fixture(prOptions(), { existing: true, mutate: (_method, endpoint, result) => { if (endpoint.includes('/pulls?')) result.data.push(result.data[0]); return result; } });
  assert.equal((await f.run()).failureCode, 'OPEN_TASK_PR_AMBIGUOUS');
  const wrongNumber = fixture({ ...prOptions(), prNumber: 7 }, { mutate: (_method, endpoint, result) => {
    if (endpoint.endsWith('/pulls/7')) { result.data.number = 8; result.data.html_url = `https://github.com/${DEV_APP.repository}/pull/8`; }
    return result;
  } });
  assert.equal((await wrongNumber.run()).outcome, 'failed');
  assert.ok(!wrongNumber.calls.some(call => call.method === 'PATCH'));
});

test('remote head mismatch or lost PR POST cannot pass, leak errors or retry POST', async () => {
  for (const mode of ['head', 'post']) {
    const f = fixture(prOptions(), { mutate: (method, endpoint, result) => {
      if (mode === 'head' && endpoint.includes('/git/ref/heads/codex')) result.data.object.sha = 'b'.repeat(40);
      if (mode === 'post' && method === 'POST' && endpoint.endsWith('/pulls')) throw Error(token);
      return result;
    } });
    const result = await f.run(); assert.equal(result.outcome, 'failed'); assert.equal(result.token.revocation, 'confirmed-204');
    assert.ok(f.calls.filter(call => call.method === 'POST' && call.endpoint.endsWith('/pulls')).length <= 1);
  }
});

test('CI reads exact PR head and exact run attempt jobs with a single-repository read-only Actions token', async () => {
  const options: AppOperation = { operation: 'status', repository: 'chwan886/Architecture-Explorer', prNumber: 7, expectedHead: sha };
  const f = fixture(options, { actionsRead: true }), result = await f.run();
  assert.equal(result.outcome, 'passed'); assert.equal(result.ci.outcome, 'success'); assert.equal(result.ci.runs[0].attempt, 2);
  assert.deepEqual(f.calls.find(call => call.endpoint.endsWith('/access_tokens'))?.body?.permissions,
    { contents: 'read', pull_requests: 'read', actions: 'read' });
  assert.ok(f.calls.some(call => call.endpoint.includes(`/actions/runs?event=pull_request&head_sha=${sha}`)));
  assert.ok(f.calls.some(call => call.endpoint.includes('/runs/8/attempts/2/jobs')));
  assert.equal(result.ci.runs[0].jobs[0].steps[0].name, 'Checks');
  assert.ok(!f.calls.some(call => call.endpoint.endsWith('/logs')));
});

test('only a failed valid job gets read-only log diagnostics; unavailable logs never hide failure or prevent revocation', async () => {
  const options: AppOperation = { operation: 'status', repository: 'chwan886/Architecture-Explorer', prNumber: 7, expectedHead: sha };
  const f = fixture(options, { actionsRead: true, mutate: (_method, endpoint, result) => {
    if (endpoint.includes('/actions/runs?')) result.data.workflow_runs[0].conclusion = 'failure';
    if (endpoint.includes('/attempts/2/jobs?')) result.data.jobs[0].conclusion = 'failure';
    return result;
  } });
  const result = await f.run();
  assert.equal(result.outcome, 'passed');
  assert.equal(result.ci.outcome, 'failure');
  assert.deepEqual(result.ci.runs[0].jobs[0].logDiagnostic, { outcome: 'unreadable', reason: 'CI_LOG_REDIRECT_UNAVAILABLE' });
  assert.equal(f.calls.filter(call => call.endpoint.endsWith('/logs')).length, 1);
  assert.equal(result.token.revocation, 'confirmed-204');
  for (const id of [0, -1, 1.5, '9/../../8']) {
    const invalid = fixture(options, { actionsRead: true, mutate: (_method, endpoint, result) => {
      if (endpoint.includes('/attempts/2/jobs?')) { result.data.jobs[0].id = id; result.data.jobs[0].conclusion = 'failure'; }
      return result;
    } });
    assert.equal((await invalid.run()).failureCode, 'CI_JOB_IDENTITY_INVALID');
    assert.ok(!invalid.calls.some(call => call.endpoint.endsWith('/logs')));
  }
});

test('CI missing permissions, GraphQL errors, no matching runs and failed runs never become successful CI', async () => {
  const options: AppOperation = { operation: 'status', repository: 'chwan886/Architecture-Explorer', prNumber: 7, expectedHead: sha };
  assert.equal((await fixture(options).run()).ci.outcome, 'unreadable');
  for (const mode of ['wrong-sha', 'wrong-pr', 'failure', 'pending']) {
    const f = fixture(options, { actionsRead: true, mutate: (_method, endpoint, result) => {
      if (endpoint.includes('/actions/runs?')) {
        const run = result.data.workflow_runs[0];
        if (mode === 'wrong-sha') run.head_sha = 'a'.repeat(40);
        if (mode === 'wrong-pr') run.pull_requests[0].number++;
        if (mode === 'failure') run.conclusion = 'failure';
        if (mode === 'pending') run.status = 'in_progress';
      }
      return result;
    } });
    const result = await f.run(); assert.notEqual(result.ci.outcome, 'success');
  }
});

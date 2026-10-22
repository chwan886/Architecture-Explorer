import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRepositoryMain } from '../Tools/dev-app-main.ts';
import type { AuthRequest, Repository } from '../Tools/dev-app-auth.ts';

const head = 'a'.repeat(40), merged = 'b'.repeat(40), prHead = 'c'.repeat(40), token = 'fixture-secret-iat';
function fixture(repository: Repository, mutate?: (endpoint: string, result: any) => any) {
  const calls: { method: string; endpoint: string }[] = [], prefix = `/repos/${repository}`;
  const ciPath = repository.endsWith('GameDemo02') ? '.github/workflows/architecture.yml' : '.github/workflows/tool-ci.yml';
  const request: AuthRequest = async (method, endpoint, credential) => {
    assert.equal(credential, token); assert.equal(method, 'GET'); calls.push({ method, endpoint });
    let result: any;
    if (endpoint === prefix) result = { status: 200, data: { id: 1, full_name: repository, html_url: `https://github.com/${repository}`, default_branch: 'main', private: true } };
    else if (endpoint.endsWith('/branches/main') && !endpoint.includes('/rules/')) result = { status: 200, data: { protected: true, commit: { sha: head } } };
    else if (endpoint.endsWith('/pulls/1')) result = { status: 200, data: { number: 1, html_url: `https://github.com/${repository}/pull/1`, state: 'closed', merged: true, merged_at: '2026-10-21T23:00:00Z', merge_commit_sha: merged,
      head: { sha: prHead, repo: { full_name: repository } }, base: { ref: 'main', repo: { full_name: repository } }, user: { login: 'chwan-dev-agent[bot]', type: 'Bot', id: 7 } } };
    else if (endpoint.startsWith('/users/')) result = { status: 200, data: { login: 'chwan-dev-agent[bot]', type: 'Bot', id: 7 } };
    else if (endpoint.includes('/compare/')) result = { status: 200, data: { base_commit: { sha: merged }, status: 'ahead' } };
    else if (endpoint.includes('/git/commits/')) result = { status: 200, data: { sha: endpoint.split('/').at(-1), tree: { sha: 'e'.repeat(40) } } };
    else if (endpoint.endsWith('/rules/branches/main')) result = { status: 200, data: [
      { type: 'pull_request', parameters: { required_approving_review_count: 1, require_code_owner_review: true } },
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Tool / typecheck, tests and builds' }] } } ] };
    else if (endpoint.includes('/contents/')) {
      const path = endpoint.slice(`${prefix}/contents/`.length).split('?')[0];
      const text = path.endsWith('ProjectVersion.txt') ? 'm_EditorVersion: 6000.1.2f1\n' : path.endsWith('.json')
        ? JSON.stringify({ receiver_ready: false, receiver_commit: null, receiver_validation_run_url: null, unrelated: token }) : `fixed source ${path}`;
      result = { status: 200, data: { path, type: 'file', sha: 'd'.repeat(40), encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') } };
    } else if (endpoint.includes('/actions/workflows/')) result = { status: 200, data: { id: 8, path: `.github/workflows/${endpoint.split('/').at(-1)}`, state: 'active' } };
    else if (endpoint.includes('/actions/runs?')) result = { status: 200, data: { workflow_runs: [{ id: 9, run_attempt: 2, html_url: `https://github.com/${repository}/actions/runs/9`, head_sha: head, head_branch: 'main', event: 'push', path: ciPath, status: 'completed', conclusion: 'success' }] } };
    else if (endpoint.includes('/attempts/2/jobs?')) result = { status: 200, data: { jobs: [{ id: 10, run_id: 9, head_sha: head, run_attempt: 2,
      name: repository.endsWith('GameDemo02') ? 'fast-gate' : 'Tool / typecheck, tests and builds', status: 'completed', conclusion: 'success',
      steps: [{ number: 1, name: 'Actual step', status: 'completed', conclusion: 'success' }] }] } };
    else if (endpoint.includes('/artifacts?')) result = { status: 200, data: { artifacts: [{ id: 11, name: 'actual-report', size_in_bytes: 123, expired: false,
      workflow_run: { id: 9, head_sha: head }, archive_download_url: `https://api.github.com/private?sig=${token}` }] } };
    else if (endpoint.endsWith('/releases/tags/unity-references-6000.6.5f1-win64-dev-v1')) result = { status: 404 };
    else throw Error(`Unexpected fixture path: ${endpoint}`);
    return mutate ? mutate(endpoint, structuredClone(result)) : result;
  };
  const run = async () => {
    const result = await inspectRepositoryMain({ repository, prNumber: 1 }, head, token, request);
    assert.ok(!JSON.stringify(result).includes(token)); return result;
  };
  return { calls, run };
}

test('Tool InspectMain projects the fixed dependency release through the existing single-repository session', async () => {
  const repository = 'chwan886/Architecture-Explorer', tag = 'unity-references-6000.6.5f1-win64-dev-v1';
  const f = fixture(repository, (endpoint, result) => endpoint.endsWith(`/releases/tags/${tag}`) ? { status: 200, data: {
    id: 31, tag_name: tag, name: 'Private Unity metadata dependency', draft: false, published_at: '2026-10-21T20:10:11Z',
    html_url: `https://github.com/${repository}/releases/tag/${tag}`, url: `https://api.github.com/repos/${repository}/releases/31`, body: token,
    assets: [{ id: 41, name: 'unity-6000.6.5f1-win64-development-metadata.zip', size: 3797931, digest: `sha256:${'a'.repeat(64)}`, state: 'uploaded',
      url: `https://api.github.com/repos/${repository}/releases/assets/41`, browser_download_url: `https://release-assets.githubusercontent.com/private?sig=${token}` }]
  } } : result);
  const result = await f.run();
  assert.equal(result.unityDependencyRelease.status, 'found'); assert.equal(result.unityDependencyRelease.expectedAsset.id, 41);
  assert.equal(result.unityDependencyRelease.artifactBytesVerified, false); assert.equal(result.productionReady, false);
  assert.equal(f.calls.filter(call => call.endpoint.includes('/releases/')).length, 1);
  assert.ok(f.calls.every(call => call.method === 'GET' && !call.endpoint.includes('GameDemo02')));
});

test('Tool InspectMain preserves denied dependency observations without claiming not-found or readiness', async () => {
  for (const mode of ['denied', 'throw']) {
    const f = fixture('chwan886/Architecture-Explorer', (endpoint, result) => {
      if (endpoint.includes('/releases/')) { if (mode === 'throw') throw Error(token); return { status: 403, data: { token } }; }
      return result;
    });
    const result = await f.run(); assert.equal(result.unityDependencyRelease.status, 'unreadable'); assert.equal(result.productionReady, false);
    assert.notEqual(result.unityDependencyRelease.failureCode, undefined);
  }
});

test('merged main inspection reads frozen files, exact main push run attempts and actual App author without granting readiness', async () => {
  for (const repository of ['chwan886/Architecture-Explorer', 'chwan886/GameDemo02'] as Repository[]) {
    const f = fixture(repository), result = await f.run();
    assert.equal(result.mainSha, head); assert.equal(result.mainCi, 'success');
    assert.equal(result.mergedPr.mergeInMainHistory, true); assert.equal(result.mergedPr.appAuthorVerified, true);
    assert.equal(result.mergedPr.headTreeMatchesMain, true); assert.equal(result.mergedPr.mainTreeSha, 'e'.repeat(40));
    assert.equal(result.productionReady, false); assert.equal(result.sourceTupleControllerConfirmed, false);
    assert.ok(f.calls.filter(call => call.endpoint.includes('/contents/')).every(call => call.endpoint.endsWith(`?ref=${head}`)));
    assert.ok(f.calls.some(call => call.endpoint.includes('/runs/9/attempts/2/jobs')));
    assert.equal(result.mainPushRuns[0].jobs[0].steps[0].name, 'Actual step');
    assert.deepEqual(result.mainPushRuns[0].artifacts[0], { id: 11, name: 'actual-report', sizeBytes: 123, expired: false,
      url: `https://github.com/${repository}/actions/runs/9/artifacts/11` });
    assert.ok(result.files.every((file: any) => /^[a-f0-9]{64}$/.test(file.sha256) && file.sourceSha === head && !('content' in file)));
    if (repository.endsWith('GameDemo02')) {
      assert.equal(result.unityDependencyRelease, undefined);
      assert.equal(f.calls.filter(call => call.endpoint.includes('/releases/')).length, 0);
      assert.equal(result.editorVersion, '6000.1.2f1');
      assert.equal(result.files.find((file: any) => file.path.endsWith('contract.json')).receiverReady, false);
    } else {
      assert.equal(result.unityDependencyRelease.status, 'not-found');
      assert.equal(f.calls.filter(call => call.endpoint.includes('/releases/')).length, 1);
      assert.ok(f.calls.every(call => !call.endpoint.includes('GameDemo02')));
    }
  }
});

test('head/main file equivalence requires actual equal Git trees, not merge metadata alone', async () => {
  for (const mode of ['different', 'unreadable', 'wrong-commit']) {
    const f = fixture('chwan886/GameDemo02', (endpoint, result) => {
      if (endpoint.endsWith(`/git/commits/${prHead}`)) {
        if (mode === 'different') result.data.tree.sha = merged;
        if (mode === 'wrong-commit') result.data.sha = head;
        if (mode === 'unreadable') return { status: 403 };
      }
      return result;
    });
    const result = await f.run();
    assert.notEqual(result.mergedPr.headTreeMatchesMain, true);
    if (mode !== 'different') assert.ok(result.blockers.includes('MERGED_PR_TREE_RELATION_UNREADABLE'));
  }
});

test('invalid repository, PR or SHA rejects before HTTP; changed identity and public visibility cannot inspect', async () => {
  let calls = 0;
  const request: AuthRequest = async () => { calls++; throw Error(token); };
  for (const options of [{ repository: 'other/repo', prNumber: 1 }, { repository: 'chwan886/GameDemo02', prNumber: 0 }]) {
    await assert.rejects(inspectRepositoryMain(options as any, head, token, request), /MAIN_INSPECTION_ARGUMENT_INVALID/);
  }
  await assert.rejects(inspectRepositoryMain({ repository: 'chwan886/GameDemo02', prNumber: 1 }, 'main', token, request), /MAIN_INSPECTION_ARGUMENT_INVALID/);
  assert.equal(calls, 0);
  for (const change of [(data: any) => { data.private = false; }, (data: any) => { data.default_branch = 'other'; }, (data: any) => { data.full_name = 'other/repo'; }]) {
    const f = fixture('chwan886/GameDemo02', (endpoint, result) => { if (endpoint === '/repos/chwan886/GameDemo02') change(result.data); return result; });
    await assert.rejects(f.run(), /MAIN_REPOSITORY_IDENTITY_OR_VISIBILITY_MISMATCH/);
    assert.equal(f.calls.length, 1);
  }
});

test('unreadable rules, files and CI retain explicit blockers without copying error bodies or pretending missing protection', async () => {
  const f = fixture('chwan886/GameDemo02', (endpoint, result) =>
    /\/rules\/|\/contents\/|\/actions\/runs\?/.test(endpoint) ? { status: 403, data: { secret: token } } : result);
  const result = await f.run();
  assert.deepEqual(result.effectiveRules, { readable: false });
  assert.equal(result.mainCi, 'not-proven');
  assert.ok(result.blockers.includes('EFFECTIVE_RULES_UNREADABLE'));
  assert.ok(result.blockers.includes('MAIN_PUSH_RUNS_UNREADABLE_OR_LIMITED'));
  assert.equal(result.files.length, 3); assert.ok(result.files.every((file: any) => file.readable === false));
});

test('main races, unmerged or wrong-author PRs and foreign run heads cannot become valid main evidence', async () => {
  for (const mode of ['race', 'unmerged', 'author', 'not-ancestor', 'run-sha', 'run-event']) {
    const f = fixture('chwan886/Architecture-Explorer', (endpoint, result) => {
      if (mode === 'race' && endpoint.endsWith('/branches/main') && !endpoint.includes('/rules/')) result.data.commit.sha = merged;
      if (endpoint.endsWith('/pulls/1')) { if (mode === 'unmerged') result.data.merged_at = null; if (mode === 'author') result.data.user.login = 'someone'; }
      if (mode === 'not-ancestor' && endpoint.includes('/compare/')) result.data.status = 'diverged';
      if (endpoint.includes('/actions/runs?')) { if (mode === 'run-sha') result.data.workflow_runs[0].head_sha = merged; if (mode === 'run-event') result.data.workflow_runs[0].event = 'pull_request'; }
      return result;
    });
    const result = await f.run(); assert.ok(result.blockers.length > 0);
    if (mode.startsWith('run-')) { assert.equal(result.mainCi, 'not-proven'); assert.ok(!f.calls.some(call => call.endpoint.includes('/attempts/'))); }
  }
});

test('failed or pending main run and unreadable job attempt never become successful CI', async () => {
  for (const mode of ['failure', 'pending', 'jobs']) {
    const f = fixture('chwan886/Architecture-Explorer', (endpoint, result) => {
      if (endpoint.includes('/actions/runs?')) { if (mode === 'failure') result.data.workflow_runs[0].conclusion = 'failure'; if (mode === 'pending') result.data.workflow_runs[0].status = 'in_progress'; }
      if (mode === 'jobs' && endpoint.includes('/attempts/2/jobs?')) return { status: 403 };
      return result;
    });
    assert.notEqual((await f.run()).mainCi, 'success');
  }
});

test('job run ID, exact head and attempt bind to the run; failed, skipped, unknown or absent required jobs never pass', async () => {
  for (const mode of ['run-id', 'head', 'attempt', 'failure', 'skipped', 'unknown', 'missing']) {
    const f = fixture('chwan886/Architecture-Explorer', (endpoint, result) => {
      if (endpoint.includes('/attempts/2/jobs?')) {
        const job = result.data.jobs[0];
        if (mode === 'run-id') job.run_id++;
        if (mode === 'head') job.head_sha = merged;
        if (mode === 'attempt') job.run_attempt++;
        if (mode === 'failure' || mode === 'skipped') job.conclusion = mode;
        if (mode === 'unknown') job.conclusion = 'unknown';
        if (mode === 'missing') result.data.jobs = [];
      }
      return result;
    });
    assert.notEqual((await f.run()).mainCi, 'success');
  }
  const senderSkipped = fixture('chwan886/GameDemo02', (endpoint, result) => {
    if (endpoint.includes('/attempts/2/jobs?')) result.data.jobs.push({ ...result.data.jobs[0], id: 12, name: 'dispatch-explorer', conclusion: 'skipped' });
    return result;
  });
  assert.equal((await senderSkipped.run()).mainCi, 'success', 'disabled sender is optional while exact fast-gate must succeed');
});

test('artifact and step metadata must bind to actual IDs and frozen head, without downloading or exposing raw URLs', async () => {
  for (const mode of ['artifact-head', 'artifact-id', 'step', 'artifact-unreadable']) {
    const f = fixture('chwan886/Architecture-Explorer', (endpoint, result) => {
      if (endpoint.includes('/artifacts?')) {
        if (mode === 'artifact-head') result.data.artifacts[0].workflow_run.head_sha = merged;
        if (mode === 'artifact-id') result.data.artifacts[0].id = '11/../../other';
        if (mode === 'artifact-unreadable') return { status: 403, data: { raw: token } };
      }
      if (mode === 'step' && endpoint.includes('/jobs?')) result.data.jobs[0].steps[0].name = token;
      return result;
    });
    const result = await f.run();
    assert.ok(result.blockers.includes(mode === 'step' ? 'MAIN_RUN_JOBS_UNREADABLE' : 'MAIN_RUN_ARTIFACTS_UNREADABLE'));
    assert.ok(!f.calls.some(call => /\/download|\/zip|archive/.test(call.endpoint)));
  }
});

test('projected metadata normalizes dates and rejects contradictory merge, coercible states and trailing controls', async () => {
  const date = fixture('chwan886/Architecture-Explorer', (endpoint, result) => {
    if (endpoint.endsWith('/pulls/1')) result.data.merged_at = `Wed, 21 Oct 2026 00:00:00 GMT (${token})`;
    return result;
  });
  assert.equal((await date.run()).mergedPr.mergedAt, '2026-10-21T00:00:00.000Z');
  for (const mode of ['merged-false', 'merge-sha', 'head-sha', 'file-sha', 'run-status', 'job-conclusion', 'contract-url']) {
    const f = fixture('chwan886/GameDemo02', (endpoint, result) => {
      if (endpoint.endsWith('/pulls/1')) {
        if (mode === 'merged-false') result.data.merged = false;
        if (mode === 'merge-sha') result.data.merge_commit_sha += '\n';
        if (mode === 'head-sha') result.data.head.sha += '\n';
      }
      if (mode === 'file-sha' && endpoint.includes('/contents/')) result.data.sha += '\n';
      if (mode === 'run-status' && endpoint.includes('/actions/runs?')) result.data.workflow_runs[0].status = ['completed'];
      if (mode === 'job-conclusion' && endpoint.includes('/attempts/2/jobs?')) result.data.jobs[0].conclusion = ['success'];
      if (mode === 'contract-url' && endpoint.includes('/contents/Tools/explorer-dispatch-contract.json')) {
        const text = JSON.stringify({ receiver_ready: false, receiver_validation_run_url: 'https://github.com/chwan886/Architecture-Explorer/actions/runs/1\n' });
        result.data.content = Buffer.from(text).toString('base64'); result.data.size = Buffer.byteLength(text);
      }
      return result;
    });
    const result = await f.run();
    if (['merged-false', 'merge-sha', 'head-sha'].includes(mode)) assert.equal(result.mergedPr, undefined);
    if (mode === 'file-sha') assert.ok(result.files.every((file: any) => file.readable === false));
    if (mode === 'run-status' || mode === 'job-conclusion') assert.notEqual(result.mainCi, 'success');
    if (mode === 'contract-url') assert.equal(result.files.find((file: any) => file.path.endsWith('contract.json')).receiverValidationRunUrl, null);
  }
});

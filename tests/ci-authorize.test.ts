import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeInput, authorizeDelivery, type ReadApi } from '../Tools/ci-authorize.ts';

const game = 'chwan886/GameDemo02', tool = 'chwan886/Architecture-Explorer';
const sha = 'a'.repeat(40), headSha = 'c'.repeat(40);
const env = {
  GITHUB_REPOSITORY: tool, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
  CI_CONTRACT_VERSION: '1', CI_SOURCE_REF: 'refs/heads/main', CI_SOURCE_RUN_ATTEMPT: '2',
  CI_SOURCE_REPO: game, CI_SOURCE_SHA: sha, GITHUB_SHA: 'b'.repeat(40), CI_SOURCE_RUN_ID: '12',
  CI_SOURCE_RUN_URL: `https://github.com/${game}/actions/runs/12`, GITHUB_SERVER_URL: 'https://github.com',
  INDEX_ACCESS_APPROVED: 'true', RULE_BYPASS_REVIEWED: 'true',
  GAME_CI_WORKFLOW_PATH: '.github/workflows/architecture.yml',
  GAME_REQUIRED_JOB_NAMES: '["Fast", "Tools"]', GAME_REQUIRED_CHECK_CONTEXTS: '["Fast check", "Tools check"]',
};
const pull = {
  number: 31, html_url: `https://github.com/${game}/pull/31`, merged_at: '2026-10-21T10:00:00Z',
  merge_commit_sha: sha, base: { ref: 'main', repo: { full_name: game } }, head: { sha: headSha },
  user: { id: 2, login: 'author', type: 'User' },
};
const approval = {
  id: 101, state: 'APPROVED', commit_id: headSha, submitted_at: '2026-10-21T09:00:00Z',
  user: { id: 3, login: 'reviewer', type: 'User' },
};
const secondApproval = { ...approval, id: 102, user: { id: 4, login: 'second-reviewer', type: 'User' } };
const pullsEndpoint = `/commits/${sha}/pulls?per_page=100&page=1`;
const reviewsEndpoint = '/pulls/31/reviews?per_page=100&page=1';
const reviewRule = { type: 'pull_request', parameters: { required_approving_review_count: 1, require_code_owner_review: true, dismiss_stale_reviews_on_push: true, require_last_push_approval: true, required_review_thread_resolution: true } };
const statusRule = (...contexts: string[]) => ({ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: contexts.map(context => ({ context })) } });
const rules = [reviewRule, statusRule('Fast check', 'Tools check')];
const classic = {
  required_pull_request_reviews: { required_approving_review_count: 1, require_code_owner_reviews: true, dismiss_stale_reviews: true, require_last_push_approval: true },
  required_status_checks: { strict: true, checks: [{ context: 'Fast check' }], contexts: ['Tools check'] }, enforce_admins: { enabled: true }, required_conversation_resolution: { enabled: true },
};

function api(overrides: Record<string, any> = {}): ReadApi {
  return async (repository, endpoint) => {
    const key = `${repository}${endpoint}` in overrides ? `${repository}${endpoint}` : endpoint;
    if (key in overrides) { const value = overrides[key]; if (value instanceof Error) throw value; return value; }
    if (endpoint === '') return { full_name: repository, default_branch: 'main', private: true, visibility: 'private' };
    if (endpoint === '/branches/main') return { protected: true };
    if (endpoint === '/rules/branches/main') return repository === game ? rules : [reviewRule, statusRule('Tool / typecheck, tests and builds')];
    if (endpoint.startsWith('/compare/')) return { status: 'ahead' };
    if (endpoint === pullsEndpoint) return [pull];
    if (endpoint === reviewsEndpoint) return [approval];
    if (endpoint === '/actions/runs/12/attempts/2') return {
      id: 12, run_attempt: 2, repository: { full_name: game }, event: 'push', head_branch: 'main', head_sha: sha,
      path: env.GAME_CI_WORKFLOW_PATH, status: 'in_progress', conclusion: null,
    };
    if (endpoint.includes('/jobs?')) return { total_count: 2, jobs: ['Fast', 'Tools'].map(name => ({ name, head_sha: sha, status: 'completed', conclusion: 'success' })) };
    throw Error(`Unexpected API ${repository}${endpoint}`);
  };
}

test('accepts actual independently reviewed merge and successful prerequisites while sender is in progress', async () => {
  const result = await authorizeDelivery(env, api());
  assert.deepEqual(result.prerequisites, ['Fast', 'Tools']);
  assert.equal(result.gameProtection.requiresIndependentReview, true);
  assert.equal(result.mergedPr.mergeSha, sha);
  assert.equal(result.mergedPr.approvals[0].reviewer, 'reviewer');
  assert.equal(result.sourceRun.attempt, '2');
});

test('rejects illegal dispatch values and missing protected Environment confirmations', () => {
  for (const invalid of [
    { CI_CONTRACT_VERSION: '2' }, { CI_SOURCE_REF: 'refs/heads/feature' }, { CI_SOURCE_RUN_ATTEMPT: '0' }, { CI_SOURCE_RUN_ATTEMPT: '' },
    { CI_SOURCE_REPO: 'attacker/GameDemo02' }, { CI_SOURCE_SHA: 'main' }, { CI_SOURCE_SHA: '' },
    { CI_SOURCE_RUN_URL: 'https://evil.test/12' }, { GITHUB_REF: 'refs/heads/feature' },
    { GAME_REQUIRED_JOB_NAMES: '[]' }, { GAME_REQUIRED_CHECK_CONTEXTS: '[]' },
    { GAME_REQUIRED_CHECK_CONTEXTS: '["Fast check","Fast check"]' },
    { INDEX_ACCESS_APPROVED: 'false' }, { RULE_BYPASS_REVIEWED: 'false' },
  ]) assert.throws(() => authorizeInput({ ...env, ...invalid }));
});

test('combines required contexts across active rulesets instead of accepting any unrelated check', async () => {
  await authorizeDelivery(env, api({ [`${game}/rules/branches/main`]: [reviewRule, statusRule('Fast check'), statusRule('Tools check')] }));
  await assert.rejects(authorizeDelivery(env, api({
    [`${game}/rules/branches/main`]: [reviewRule, statusRule('Unrelated check')],
    '/branches/main/protection': { ...classic, required_status_checks: { strict: true, contexts: ['Unrelated check'] } },
  })), /every confirmed PR check context/);
  await assert.rejects(authorizeDelivery(env, api({ [`${tool}/rules/branches/main`]: [reviewRule, statusRule('Unrelated check')] })), /Tool main requires a readable Ruleset/);
});

test('combines effective PR review counts and flags across rulesets regardless of response order', async () => {
  const gamePolicies = [
    { type: 'pull_request', parameters: { required_approving_review_count: 2 } },
    { type: 'pull_request', parameters: { required_approving_review_count: 0, require_code_owner_review: true } },
    { type: 'pull_request', parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true } },
    { type: 'pull_request', parameters: { required_approving_review_count: 0, require_last_push_approval: true, required_review_thread_resolution: true } },
    statusRule('Fast check'), statusRule('Tools check'),
  ];
  const toolPolicies = [
    { type: 'pull_request', parameters: { required_approving_review_count: 1 } },
    { type: 'pull_request', parameters: { required_approving_review_count: 3 } },
    { type: 'pull_request', parameters: { required_approving_review_count: 0, require_code_owner_review: true } },
    statusRule('Tool / typecheck, tests and builds'),
  ];
  for (const reverse of [false, true]) {
    const result = await authorizeDelivery(env, api({
      [`${game}/rules/branches/main`]: reverse ? [...gamePolicies].reverse() : gamePolicies,
      [`${tool}/rules/branches/main`]: reverse ? [...toolPolicies].reverse() : toolPolicies,
      [reviewsEndpoint]: [approval, secondApproval],
    }));
    assert.equal(result.gameProtection.type, 'ruleset');
    assert.equal(result.gameProtection.requiredApprovingReviewCount, 2);
    assert.equal(result.toolProtection.type, 'ruleset');
    assert.equal(result.toolProtection.requiredApprovingReviewCount, 3);
  }
});

test('the exact game merge must satisfy the effective approval count with distinct independent Users', async () => {
  const requireTwo = { ...reviewRule, parameters: { ...reviewRule.parameters, required_approving_review_count: 2 } };
  const policies = [
    { [`${game}/rules/branches/main`]: [requireTwo, statusRule('Fast check', 'Tools check')] },
    { [`${game}/rules/branches/main`]: [], '/branches/main/protection': {
      ...classic, required_pull_request_reviews: { ...classic.required_pull_request_reviews, required_approving_review_count: 2 },
    } },
  ];
  for (const policy of policies) {
    for (const insufficient of [
      [approval],
      [approval, { ...approval, id: 102, submitted_at: '2026-10-21T09:30:00Z' }],
      [approval, { ...secondApproval, user: pull.user }],
      [approval, { ...secondApproval, commit_id: 'd'.repeat(40) }],
    ]) {
      await assert.rejects(authorizeDelivery(env, api({ ...policy, [reviewsEndpoint]: insufficient })), /do not meet the effective required count \(2\)/);
    }
    const result = await authorizeDelivery(env, api({ ...policy, [reviewsEndpoint]: [approval, secondApproval] }));
    assert.equal(result.gameProtection.requiredApprovingReviewCount, 2);
    assert.equal(new Set(result.mergedPr.approvals.map(review => review.reviewerId)).size, 2);
  }
});

test('combined rules still require a positive approval count, Code Owner and every game review flag', async () => {
  const complete = [
    { type: 'pull_request', parameters: { required_approving_review_count: 1 } },
    { type: 'pull_request', parameters: { required_approving_review_count: 0, require_code_owner_review: true } },
    { type: 'pull_request', parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: true } },
    { type: 'pull_request', parameters: { required_approving_review_count: 0, require_last_push_approval: true } },
    { type: 'pull_request', parameters: { required_approving_review_count: 0, required_review_thread_resolution: true } },
  ];
  for (let missing = 0; missing < complete.length; missing++) {
    const incomplete = complete.filter((_, index) => index !== missing);
    await assert.rejects(authorizeDelivery(env, api({
      [`${game}/rules/branches/main`]: [...incomplete, statusRule('Fast check', 'Tools check')],
      '/branches/main/protection': new Error('Incomplete effective rules have no valid classic fallback'),
    })), /no valid classic fallback/);
  }
  await assert.rejects(authorizeDelivery(env, api({
    [`${tool}/rules/branches/main`]: [complete[1], statusRule('Tool / typecheck, tests and builds')],
  })), /Code Owner review/);
});

test('unreadable review counts cannot be merged into an apparently valid effective policy', async () => {
  await assert.rejects(authorizeDelivery(env, api({
    [`${game}/rules/branches/main`]: [reviewRule, { type: 'pull_request', parameters: { required_approving_review_count: '2' } }, statusRule('Fast check', 'Tools check')],
  })), /Effective review count is unreadable/);
});

test('game classic protection must enforce administrators and cover all confirmed contexts', async () => {
  const base = { [`${game}/rules/branches/main`]: [], '/branches/main/protection': classic };
  const result = await authorizeDelivery(env, api(base));
  assert.equal(result.gameProtection.type, 'classic');
  await assert.rejects(authorizeDelivery(env, api({ ...base, '/branches/main/protection': { ...classic, enforce_admins: { enabled: false } } })), /enforce administrators/);
});

test('game main enforces phase-one Code Owner, latest-push review and strict up-to-date checks', async () => {
  const weakRules = [{ ...reviewRule, parameters: { ...reviewRule.parameters, require_code_owner_review: false } }, statusRule('Fast check', 'Tools check')];
  const weakClassic = { ...classic, required_pull_request_reviews: { ...classic.required_pull_request_reviews, require_code_owner_reviews: false } };
  await assert.rejects(authorizeDelivery(env, api({ [`${game}/rules/branches/main`]: weakRules, '/branches/main/protection': weakClassic })), /require_code_owner_reviews/);
});

test('tool main must enforce its CODEOWNERS instead of merely storing the file', async () => {
  const weak = { ...reviewRule, parameters: { ...reviewRule.parameters, require_code_owner_review: false } };
  await assert.rejects(authorizeDelivery(env, api({ [`${tool}/rules/branches/main`]: [weak, statusRule('Tool / typecheck, tests and builds')] })), /Code Owner review/);
});

test('protection, associated PR and Review API failures block authorization', async () => {
  for (const invalid of [
    { '/branches/main': { protected: false } }, { '/rules/branches/main': new Error('403') },
    { [pullsEndpoint]: new Error('404') }, { [reviewsEndpoint]: new Error('403') },
  ]) await assert.rejects(authorizeDelivery(env, api(invalid)));
});

test('requires exactly one merged PR for this merge SHA and allowed base', async () => {
  for (const invalid of [[], [pull, pull], [{ ...pull, merged_at: null }], [{ ...pull, merge_commit_sha: 'd'.repeat(40) }],
    [{ ...pull, base: { ref: 'feature', repo: { full_name: game } } }],
    [{ ...pull, base: { ref: 'main', repo: { full_name: 'attacker/GameDemo02' } } }]]) {
    await assert.rejects(authorizeDelivery(env, api({ [pullsEndpoint]: invalid })), /one merged PR/);
  }
});

test('author, bot, dismissed, different-head or post-merge approvals cannot prove pre-merge independent Review', async () => {
  for (const review of [
    { ...approval, user: pull.user }, { ...approval, user: { id: 3, login: 'automation[bot]', type: 'Bot' } },
    { ...approval, state: 'DISMISSED' }, { ...approval, commit_id: 'd'.repeat(40) },
    { ...approval, submitted_at: '2026-10-21T10:01:00Z' },
  ]) await assert.rejects(authorizeDelivery(env, api({ [reviewsEndpoint]: [review] })), /no current independent User approval/);
});

test('latest Review per reviewer supersedes an earlier approval regardless of response order', async () => {
  const changed = { ...approval, id: 102, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-21T09:30:00Z' };
  await assert.rejects(authorizeDelivery(env, api({ [reviewsEndpoint]: [changed, approval] })), /no current independent User approval/);
  const restored = { ...approval, id: 103, submitted_at: '2026-10-21T09:45:00Z' };
  const result = await authorizeDelivery(env, api({ [reviewsEndpoint]: [restored, changed, approval] }));
  assert.equal(result.mergedPr.approvals[0].reviewId, 103);
});

test('ordinary comments do not revoke an exact-head independent approval made before merge', async () => {
  const result = await authorizeDelivery(env, api({ [reviewsEndpoint]: [approval, { ...approval, id: 102, state: 'COMMENTED', submitted_at: '2026-10-21T09:30:00Z' }] }));
  assert.equal(result.mergedPr.approvals[0].reviewId, approval.id);
});

test('paginates associated PRs and Review evidence', async () => {
  const unrelated = { ...pull, merged_at: null };
  const comments = Array.from({ length: 100 }, (_, i) => ({ ...approval, id: i + 1, state: 'COMMENTED', user: { id: i + 1000, login: `observer-${i}`, type: 'User' } }));
  const result = await authorizeDelivery(env, api({
    [pullsEndpoint]: Array.from({ length: 100 }, () => unrelated),
    [`/commits/${sha}/pulls?per_page=100&page=2`]: [pull],
    [reviewsEndpoint]: comments, '/pulls/31/reviews?per_page=100&page=2': [approval],
  }));
  assert.equal(result.mergedPr.approvals[0].reviewId, approval.id);
});

test('rejects PR/failed source runs, mismatched jobs and non-main history', async () => {
  const validRun = await api()(game, '/actions/runs/12/attempts/2');
  for (const run of [{ ...validRun, event: 'pull_request' }, { ...validRun, conclusion: 'cancelled' }, { ...validRun, head_sha: 'd'.repeat(40) }, { ...validRun, run_attempt: 1 }]) {
    await assert.rejects(authorizeDelivery(env, api({ '/actions/runs/12/attempts/2': run })));
  }
  await assert.rejects(authorizeDelivery(env, api({ [`/compare/${sha}...main`]: { status: 'diverged' } })), /outside allowed main history/);
  await assert.rejects(authorizeDelivery(env, api({ '/actions/runs/12/attempts/2/jobs?per_page=100&page=1': {
    total_count: 1, jobs: [{ name: 'Fast', head_sha: sha, status: 'completed', conclusion: 'failure' }],
  } })), /Required job did not pass/);
});

test('private game evidence cannot flow to a public receiver', async () => {
  await assert.rejects(authorizeDelivery(env, api({ [tool]: { full_name: tool, default_branch: 'main', private: false, visibility: 'public' } })), /private evidence storage/);
});

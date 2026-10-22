import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { githubApiVersion } from './github-api-version.ts';

const game = 'chwan886/GameDemo02', tool = 'chwan886/Architecture-Explorer';
const toolCheckContext = 'Tool / typecheck, tests and builds';
type RecordValue = Record<string, any>;
export type ReadApi = (repository: string, endpoint: string) => Promise<any>;

export function authorizeInput(env: NodeJS.ProcessEnv) {
  assert.equal(env.GITHUB_REPOSITORY, tool, 'Unexpected receiving repository');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Receiver must run protected main');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'Only workflow_dispatch is accepted');
  assert.equal(env.CI_CONTRACT_VERSION, '1', 'Only contract_version=1 is accepted');
  assert.equal(env.CI_SOURCE_REPO, game, 'Unapproved source repository');
  assert.equal(env.CI_SOURCE_REF, 'refs/heads/main', 'Source ref must be the game main');
  assert.match(env.CI_SOURCE_SHA ?? '', /^[a-f0-9]{40}$/, 'Exact game SHA required');
  assert.match(env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/, 'Exact tool SHA required');
  assert.match(env.CI_SOURCE_RUN_ID ?? '', /^[1-9]\d{0,19}$/, 'Invalid source run ID');
  assert.match(env.CI_SOURCE_RUN_ATTEMPT ?? '', /^[1-9]\d{0,19}$/, 'Invalid source run attempt');
  assert.equal(env.CI_SOURCE_RUN_URL, `https://github.com/${game}/actions/runs/${env.CI_SOURCE_RUN_ID}`, 'Source run URL mismatch');
  assert.equal(env.GITHUB_SERVER_URL, 'https://github.com', 'Unsupported GitHub host');
  assert.equal(env.INDEX_ACCESS_APPROVED, 'true', 'Game audience artifact access review is not configured');
  assert.equal(env.RULE_BYPASS_REVIEWED, 'true', 'Main rule bypass permissions require protected Environment review');
  const workflow = env.GAME_CI_WORKFLOW_PATH ?? '';
  assert.match(workflow, /^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/, 'Game controller must confirm workflow path');
  const names = (variable: string, description: string): string[] => {
    const value: unknown = JSON.parse(env[variable] ?? 'null');
    assert.ok(Array.isArray(value) && value.length > 0 && value.length <= 20 && value.every(n => typeof n === 'string' && n.trim() === n && n.length > 0 && n.length < 150 && !/[\x00-\x1f]/.test(n)), description);
    assert.equal(new Set(value).size, value.length, `Duplicate ${variable} values`);
    return value as string[];
  };
  const jobs = names('GAME_REQUIRED_JOB_NAMES', 'Game controller must confirm exact Fast/tools job names');
  const checkContexts = names('GAME_REQUIRED_CHECK_CONTEXTS', 'Game controller must confirm exact required PR check contexts');
  return { sha: env.CI_SOURCE_SHA!, toolSha: env.GITHUB_SHA!, runId: env.CI_SOURCE_RUN_ID!, runAttempt: env.CI_SOURCE_RUN_ATTEMPT!, workflow, jobs, checkContexts };
}

/** Active rulesets are readable with contents:read. Classic rules require administration:read. */
async function protectedReview(repository: string, branch: RecordValue, requiredContexts: string[], api: ReadApi) {
  assert.equal(branch.protected, true, `${repository} main is not protected`);
  const rules: RecordValue[] = await api(repository, '/rules/branches/main');
  assert.ok(Array.isArray(rules), 'Effective main rules are unreadable');
  // GitHub applies every active ruleset. Review count takes the strictest minimum;
  // each required flag can be supplied by a different effective pull_request rule.
  const reviewPolicies = rules.filter(r => r.type === 'pull_request').map(r => r.parameters ?? {});
  const requiredApprovingReviewCount = reviewPolicies.reduce((strictest, policy) => {
    const count = policy.required_approving_review_count ?? 0;
    assert.ok(Number.isSafeInteger(count) && count >= 0, 'Effective review count is unreadable');
    return Math.max(strictest, count);
  }, 0);
  const requiresReviewFlag = (name: string) => reviewPolicies.some(policy => policy[name] === true);
  const requiresCodeOwnerReview = requiresReviewFlag('require_code_owner_review');
  const gameReviewPolicy = repository !== game || ['dismiss_stale_reviews_on_push', 'require_last_push_approval', 'required_review_thread_resolution']
    .every(requiresReviewFlag);
  // Multiple active rulesets may each supply only some mandatory contexts.
  const contexts = new Set(rules.filter(r => r.type === 'required_status_checks')
    .flatMap(r => r.parameters?.required_status_checks ?? []).map(check => check.context));
  const strictChecks = repository !== game || rules.some(r => r.type === 'required_status_checks' && r.parameters?.strict_required_status_checks_policy === true);
  if (requiredApprovingReviewCount >= 1 && requiresCodeOwnerReview && gameReviewPolicy && strictChecks && requiredContexts.every(context => contexts.has(context))) {
    return { type: 'ruleset', requiresIndependentReview: true, requiredApprovingReviewCount, requiredCheckContexts: requiredContexts, bypassPermissions: 'manually-reviewed' };
  }
  assert.notEqual(repository, tool, 'Tool main requires a readable Ruleset covering Code Owner review, PR review and the Tool CI check');
  // A 403/404 is a blocker, never evidence that protections exist.
  const protection = await api(repository, '/branches/main/protection');
  assert.ok(protection.required_pull_request_reviews?.required_approving_review_count >= 1, `${repository} requires independent PR Review`);
  for (const key of ['require_code_owner_reviews', 'dismiss_stale_reviews', 'require_last_push_approval']) {
    assert.equal(protection.required_pull_request_reviews[key], true, `Game main protection must enforce ${key}`);
  }
  assert.equal(protection.required_status_checks?.strict, true, 'Game main checks must be up to date');
  assert.equal(protection.required_conversation_resolution?.enabled, true, 'Game main must require resolved conversations');
  for (const check of protection.required_status_checks?.checks ?? []) contexts.add(check.context);
  for (const context of protection.required_status_checks?.contexts ?? []) contexts.add(context);
  assert.ok(requiredContexts.every(context => contexts.has(context)), `${repository} main does not require every confirmed PR check context`);
  assert.equal(protection.enforce_admins?.enabled, true, `${repository} protection must also enforce administrators`);
  return { type: 'classic', requiresIndependentReview: true, requiredApprovingReviewCount: protection.required_pull_request_reviews.required_approving_review_count,
    requiredCheckContexts: requiredContexts, bypassPermissions: 'manually-reviewed' };
}

/** Bind actual merged-PR and independent approval evidence to this precise main SHA. */
async function reviewedMerge(sha: string, api: ReadApi) {
  const associated: RecordValue[] = [];
  for (let page = 1; page <= 10; page++) {
    const result = await api(game, `/commits/${sha}/pulls?per_page=100&page=${page}`);
    assert.ok(Array.isArray(result), 'Associated PR evidence is unreadable');
    associated.push(...result);
    if (result.length < 100) break;
    assert.ok(page < 10, 'Associated PR result budget exceeded');
  }
  const matches = associated.filter(pr => pr.merged_at && pr.merge_commit_sha === sha && pr.base?.ref === 'main' && pr.base?.repo?.full_name === game);
  assert.equal(matches.length, 1, 'Game SHA must identify one merged PR into the allowed main');
  const pr = matches[0];
  assert.ok(Number.isSafeInteger(pr.number) && pr.number > 0, 'Invalid merged PR number');
  assert.ok(typeof pr.merged_at === 'string' && Number.isFinite(Date.parse(pr.merged_at)), 'Merged PR time is unreadable');
  assert.match(pr.head?.sha ?? '', /^[a-f0-9]{40}$/, 'Merged PR must retain its reviewed head SHA');
  assert.ok(Number.isSafeInteger(pr.user?.id) && typeof pr.user?.login === 'string', 'Merged PR author identity is unreadable');
  const prUrl = `https://github.com/${game}/pull/${pr.number}`;
  assert.equal(pr.html_url, prUrl, 'Merged PR URL is not canonical');
  const latest = new Map<number, RecordValue>();
  for (let page = 1; page <= 20; page++) {
    const reviews = await api(game, `/pulls/${pr.number}/reviews?per_page=100&page=${page}`);
    assert.ok(Array.isArray(reviews), 'PR Review evidence is unreadable');
    for (const review of reviews) {
      if (review.state === 'PENDING') continue;
      assert.ok(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(review.state), 'Unknown Review state');
      assert.ok(Number.isSafeInteger(review.id) && review.id > 0 && Number.isSafeInteger(review.user?.id) && review.user.id > 0, 'Review identity is unreadable');
      assert.ok(typeof review.submitted_at === 'string' && Number.isFinite(Date.parse(review.submitted_at)), 'Review submission time is unreadable');
      // A comment does not revoke an approval. Historical proof uses decisions made before merge.
      if (review.state === 'COMMENTED' || Date.parse(review.submitted_at) > Date.parse(pr.merged_at)) continue;
      const previous = latest.get(review.user.id);
      if (!previous || Date.parse(review.submitted_at) > Date.parse(previous.submitted_at) ||
        (Date.parse(review.submitted_at) === Date.parse(previous.submitted_at) && review.id > previous.id)) latest.set(review.user.id, review);
    }
    if (reviews.length < 100) break;
    assert.ok(page < 20, 'PR Review result budget exceeded');
  }
  const approvals = [...latest.values()].filter(review => review.state === 'APPROVED' && review.commit_id === pr.head.sha &&
    Date.parse(review.submitted_at) <= Date.parse(pr.merged_at) &&
    review.user.type === 'User' && typeof review.user.login === 'string' && !review.user.login.endsWith('[bot]') &&
    review.user.id !== pr.user.id && review.user.login.toLowerCase() !== pr.user.login.toLowerCase());
  assert.ok(approvals.length > 0, 'Merged PR has no current independent User approval for its exact head SHA');
  return { number: pr.number, url: prUrl, mergeSha: sha, headSha: pr.head.sha, mergedAt: pr.merged_at,
    approvals: approvals.map(review => ({ reviewId: review.id, reviewerId: review.user.id, reviewer: review.user.login,
      commitId: review.commit_id, submittedAt: review.submitted_at })) };
}

export async function authorizeDelivery(env: NodeJS.ProcessEnv, api: ReadApi) {
  const input = authorizeInput(env);
  const gameMeta = await api(game, ''), toolMeta = await api(tool, '');
  for (const [repo, meta] of [[game, gameMeta], [tool, toolMeta]] as const) {
    assert.equal(meta.full_name, repo, 'Repository identity mismatch');
    assert.equal(meta.default_branch, 'main', `${repo} default branch must be confirmed main`);
  }
  // Private game excerpts cannot be uploaded into a public or internal receiving repository.
  if (gameMeta.private) assert.equal(toolMeta.visibility, 'private', 'Private game requires private evidence storage');
  const gameBranch = await api(game, '/branches/main'), toolBranch = await api(tool, '/branches/main');
  const gameProtection = await protectedReview(game, gameBranch, input.checkContexts, api);
  // This records the tool's active platform policy, not reviewed-PR evidence for its SHA.
  // The exact merged PR and approval evidence queried below belong to the game only.
  const toolProtection = await protectedReview(tool, toolBranch, [toolCheckContext], api);
  const compare = await api(game, `/compare/${input.sha}...main`);
  assert.ok(['ahead', 'identical'].includes(compare.status), 'Game SHA is outside allowed main history');
  const toolCompare = await api(tool, `/compare/${input.toolSha}...main`);
  assert.ok(['ahead', 'identical'].includes(toolCompare.status), 'Tool SHA is outside protected main history');
  const mergedPr = await reviewedMerge(input.sha, api);
  const requiredGameApprovals = gameProtection.requiredApprovingReviewCount;
  assert.ok(Number.isSafeInteger(requiredGameApprovals) && requiredGameApprovals >= 1, 'Effective game approval count is unreadable');
  const independentReviewerCount = new Set(mergedPr.approvals.map(review => review.reviewerId)).size;
  assert.ok(independentReviewerCount >= requiredGameApprovals,
    `Merged PR independent approvals (${independentReviewerCount}) do not meet the effective required count (${requiredGameApprovals})`);
  const run = await api(game, `/actions/runs/${input.runId}/attempts/${input.runAttempt}`);
  assert.equal(String(run.id), input.runId, 'Source run ID mismatch');
  assert.equal(String(run.run_attempt), input.runAttempt, 'Source run attempt mismatch');
  assert.equal(run.repository?.full_name, game, 'Source run repository mismatch');
  assert.equal(run.event, 'push', 'Source must be a main push, never a PR/dispatch');
  assert.equal(run.head_branch, 'main', 'Source is not main');
  assert.equal(run.head_sha, input.sha, 'Source run SHA differs from request');
  assert.equal(run.path, input.workflow, 'Source workflow was not confirmed by game controller');
  assert.ok(!['failure', 'cancelled', 'timed_out', 'action_required', 'skipped', 'stale'].includes(run.conclusion), 'Source run failed or was cancelled');
  if (run.status === 'completed') assert.equal(run.conclusion, 'success', 'Completed source run did not succeed');
  const jobs: RecordValue[] = [];
  for (let page = 1; page <= 20; page++) {
    const result = await api(game, `/actions/runs/${input.runId}/attempts/${input.runAttempt}/jobs?per_page=100&page=${page}`);
    assert.ok(Array.isArray(result.jobs), 'Missing source job results');
    jobs.push(...result.jobs);
    if (jobs.length >= result.total_count) break;
    assert.ok(page < 20, 'Source job result budget exceeded');
  }
  for (const name of input.jobs) {
    const matches = jobs.filter(j => j.name === name);
    assert.equal(matches.length, 1, `Required job missing or ambiguous: ${name}`);
    assert.equal(matches[0].head_sha, input.sha, `Job SHA mismatch: ${name}`);
    assert.equal(matches[0].status, 'completed', `Required job incomplete: ${name}`);
    assert.equal(matches[0].conclusion, 'success', `Required job did not pass: ${name}`);
  }
  return { schemaVersion: 1, contractVersion: '1', sourceRepository: game, sourceRef: env.CI_SOURCE_REF, toolRepository: tool, gameSha: input.sha, toolSha: input.toolSha,
    sourceRun: { id: input.runId, attempt: input.runAttempt, url: env.CI_SOURCE_RUN_URL, attemptUrl: `${env.CI_SOURCE_RUN_URL}/attempts/${input.runAttempt}`, statusAtAuthorization: run.status },
    prerequisites: input.jobs, requiredPrCheckContexts: input.checkContexts, gameProtection, toolProtection, mergedPr,
    access: 'private audience manually approved through protected Environment; no public distribution', authorizedAt: new Date().toISOString() };
}

async function main() {
  const api: ReadApi = async (repository, endpoint) => {
    const token = repository === game ? process.env.GAME_READ_TOKEN : process.env.TOOL_POLICY_READ_TOKEN;
    assert.ok(token, `Missing read-only authorization for ${repository}`);
    const response = await fetch(`https://api.github.com/repos/${repository}${endpoint}`, { redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': githubApiVersion('GET', `/repos/${repository}${endpoint}`) } });
    assert.ok(response.ok, `GitHub authorization read failed: ${repository}${endpoint} HTTP ${response.status}`);
    return response.json();
  };
  const result = await authorizeDelivery(process.env, api);
  await mkdir('.ci-output/authorization', { recursive: true });
  await writeFile('.ci-output/authorization/authorization.json', JSON.stringify(result, null, 2));
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'index_access=allowed\n');
  console.log('Source jobs and protected main history verified; artifact audience approved.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });

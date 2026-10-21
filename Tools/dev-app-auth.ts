import path from 'node:path';
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { lstat, open, realpath, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { TOOL_ROOT } from '../packages/indexer/src/config.ts';
import { canonical, ensureCacheDirectory, isWithin, readAuthorized } from '../packages/indexer/src/security.ts';
import { prepareTaskPush, runTaskPush, type TaskPushPlan } from './dev-app-git.ts';

export const DEV_APP = Object.freeze({ id: 5417611, clientId: 'Iv23lil3cvGyWUbx4yfS', slug: 'chwan-dev-agent', owner: 'chwan886',
  repository: 'chwan886/Architecture-Explorer', installedRepositories: ['chwan886/Architecture-Explorer', 'chwan886/GameDemo02'] });
const expectedAppPermissions = { contents: 'write', metadata: 'read', pull_requests: 'write', workflows: 'write' };
type Json = Record<string, any>;
export type AuthRequest = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', endpoint: string, credential: string, body?: Json) => Promise<{ status: number; data?: any; requestId?: string }>;
export type Repository = 'chwan886/Architecture-Explorer' | 'chwan886/GameDemo02';
export type AppOperation = { repository: Repository } & (
  { operation: 'verify' } | { operation: 'push'; workingDirectory: string; branch: string; expectedHead: string } |
  { operation: 'pr'; branch: string; expectedHead: string; title: string; body: string; prNumber?: number } |
  { operation: 'status'; expectedHead: string; prNumber: number });
export function validateTaskBranch(branch: string) {
  requireValue(/^codex\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) && !branch.includes('..') && !branch.includes('//') &&
    !/[\r\n\0]/.test(branch) && branch.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')) && !branch.endsWith('/'), 'TASK_BRANCH_REQUIRED');
}
function validateOperation(options: AppOperation) {
  requireValue(DEV_APP.installedRepositories.includes(options.repository), 'UNAPPROVED_REPOSITORY');
  requireValue(['verify', 'push', 'pr', 'status'].includes(options.operation), 'UNAPPROVED_OPERATION');
  if (options.operation !== 'verify') requireValue(options.expectedHead.length === 40 && /^[a-f0-9]{40}$/.test(options.expectedHead), 'EXACT_TASK_HEAD_REQUIRED');
  if (options.operation === 'push' || options.operation === 'pr') validateTaskBranch(options.branch);
  if (options.operation === 'pr') requireValue(options.title.trim().length > 0 && options.title.length <= 256 && !/[\r\n\0]/.test(options.title) &&
    Buffer.byteLength(options.body) <= 65536 && !options.body.includes('\0') && !/-----BEGIN\b/i.test(options.body), 'PR_TEXT_INVALID');
  if (options.operation === 'status' || (options.operation === 'pr' && options.prNumber !== undefined)) {
    requireValue(Number.isSafeInteger(options.prNumber) && options.prNumber! > 0, 'PR_NUMBER_INVALID');
  }
}
class AuthFailure extends Error { constructor(readonly code: string) { super(code); } }
function requireValue(condition: unknown, code: string): asserts condition { if (!condition) throw new AuthFailure(code); }
function samePermissions(actual: unknown, expected: Record<string, string>) {
  return actual !== null && typeof actual === 'object' && !Array.isArray(actual) &&
    Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([name, value]) => (actual as Json)[name] === value);
}

export function createAppJwt(key: KeyObject, nowMs = Date.now()): string {
  requireValue(key.type === 'private' && key.asymmetricKeyType === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048, 'RSA_PRIVATE_KEY_REQUIRED');
  const now = Math.floor(nowMs / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: DEV_APP.clientId })}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(key).toString('base64url')}`;
}

/** No caller action callback: only the trusted HTTP adapter receives tokens for fixed verification/revocation requests. */
export async function runDevelopmentApp(options: AppOperation, signJwt: () => string, request: AuthRequest, now = () => Date.now(),
  wait: (ms: number) => Promise<void> = async ms => { await delay(ms); }, push = runTaskPush) {
  const receipt: Json = { schemaVersion: 2, mode: options.operation, repository: options.repository, checkedAt: new Date(now()).toISOString(), outcome: 'failed',
    app: { id: DEV_APP.id, clientId: DEV_APP.clientId, slug: DEV_APP.slug, owner: DEV_APP.owner, verified: false },
    installation: { verifiedTargetMembership: [], exactRepositorySetVerified: false,
      exactRepositorySet: 'not-proven: App JWT does not enumerate installation repositories; manually confirm only the two approved repositories' },
    token: { requestedRepositories: [options.repository], requestedPermissions: { contents: 'read' }, issued: false, secretRecorded: false,
      revocation: 'not-issued', revokedTokenProbe: 'not-run', revokedTokenProbeStatuses: [], revokedTokenProbes: [] }, ownerAuthenticationUsed: false,
    performedOperations: { push: false, createPr: false, updatePr: false },
    forbiddenOperations: { pushMain: false, forcePush: false, approve: false, merge: false, dispatch: false, modifyGitConfiguration: false } };
  let token = '', jwt = '', verified = false;
  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', endpoint: string, credential: string, status: number, code: string, body?: Json) => {
    const response = await request(method, endpoint, credential, body);
    requireValue(response.status === status, code);
    return response.data;
  };
  try {
    validateOperation(options);
    let pushPlan: TaskPushPlan | undefined;
    if (options.operation === 'push') {
      try { pushPlan = await prepareTaskPush(options); } catch { throw new AuthFailure('TASK_PUSH_PREFLIGHT_FAILED'); }
    }
    jwt = signJwt();
    const app = await call('GET', '/app', jwt, 200, 'APP_IDENTITY_READ_FAILED');
    requireValue(app?.id === DEV_APP.id && app?.client_id === DEV_APP.clientId && app?.slug === DEV_APP.slug &&
      app?.owner?.login === DEV_APP.owner && app?.owner?.type === 'User' && Number.isSafeInteger(app?.owner?.id), 'APP_IDENTITY_MISMATCH');
    const registeredPermissions = { ...expectedAppPermissions, ...(app.permissions?.actions === 'read' ? { actions: 'read' } : {}) };
    requireValue(samePermissions(app.permissions, registeredPermissions), 'APP_PERMISSION_BOUNDARY_MISMATCH');
    receipt.app.verified = true;
    receipt.app.permissions = registeredPermissions;
    const installations: Json[] = [];
    for (let page = 1; page <= 10; page++) {
      const found = await call('GET', `/app/installations?per_page=100&page=${page}`, jwt, 200, 'INSTALLATION_LIST_READ_FAILED');
      requireValue(Array.isArray(found) && found.length <= 100, 'INSTALLATION_LIST_INVALID');
      installations.push(...found);
      if (found.length < 100) break;
      requireValue(page < 10, 'INSTALLATION_LIST_LIMIT');
    }
    requireValue(installations.length === 1, 'EXPECTED_ONE_ACCOUNT_INSTALLATION');
    const installation = installations[0];
    requireValue(Number.isSafeInteger(installation.id) && installation.id > 0 && installation.app_id === DEV_APP.id &&
      installation.app_slug === DEV_APP.slug && installation.account?.login === DEV_APP.owner && installation.account?.id === app.owner.id && installation.target_type === 'User' &&
      installation.repository_selection === 'selected' && installation.suspended_at === null, 'INSTALLATION_IDENTITY_OR_SCOPE_MISMATCH');
    requireValue(samePermissions(installation.permissions, registeredPermissions), 'INSTALLATION_PERMISSION_BOUNDARY_MISMATCH');
    receipt.installation.id = installation.id;
    receipt.installation.repositorySelection = 'selected';
    receipt.installation.permissions = registeredPermissions;
    for (const repository of [options.repository]) {
      const membership = await call('GET', `/repos/${repository}/installation`, jwt, 200, 'TARGET_INSTALLATION_READ_FAILED');
      requireValue(membership?.id === installation.id && membership?.app_id === DEV_APP.id && membership?.account?.login === DEV_APP.owner && membership?.account?.id === app.owner.id &&
        membership?.repository_selection === 'selected' && membership?.suspended_at === null, 'TARGET_INSTALLATION_MISMATCH');
      receipt.installation.verifiedTargetMembership.push(repository);
    }
    // Capture the token before validating the response so every subsequent failure still revokes it.
    const requestedPermissions: Record<string, string> = options.operation === 'push'
      ? { contents: 'write', ...(pushPlan!.requiresWorkflows ? { workflows: 'write' } : {}) }
      : options.operation === 'pr' ? { contents: 'read', pull_requests: 'write' }
      : options.operation === 'status' ? { contents: 'read', pull_requests: 'read', ...(app.permissions.actions === 'read' ? { actions: 'read' } : {}) }
      : { contents: 'read' };
    receipt.token.requestedPermissions = requestedPermissions;
    receipt.token.issued = 'unconfirmed';
    receipt.token.revocation = 'unconfirmed-no-token';
    const minted = await request('POST', `/app/installations/${installation.id}/access_tokens`, jwt,
      { repositories: [options.repository.split('/')[1]], permissions: requestedPermissions });
    if (typeof minted.data?.token === 'string' && minted.data.token.length > 0) {
      token = minted.data.token;
      receipt.token.issued = true;
      receipt.token.revocation = 'pending';
    } else if ([401, 403, 404, 422].includes(minted.status)) {
      receipt.token.issued = false;
      receipt.token.revocation = 'not-issued';
    }
    requireValue(minted.status === 201 && token.length > 0, 'TOKEN_ISSUANCE_FAILED_OR_UNCONFIRMED');
    const issued = minted.data;
    const expectedTokenPermissions = { ...requestedPermissions, ...(issued.permissions?.metadata === 'read' ? { metadata: 'read' } : {}) };
    requireValue(samePermissions(issued.permissions, expectedTokenPermissions), 'TOKEN_PERMISSIONS_NOT_READ_ONLY');
    requireValue(issued.repository_selection === 'selected' && Array.isArray(issued.repositories) && issued.repositories.length === 1 &&
      issued.repositories[0]?.full_name === options.repository && issued.repositories[0]?.owner?.login === DEV_APP.owner &&
      Number.isSafeInteger(issued.repositories[0]?.id) && issued.repositories[0].id > 0, 'TOKEN_REPOSITORY_SCOPE_MISMATCH');
    const expiry = Date.parse(issued.expires_at);
    requireValue(typeof issued.expires_at === 'string' && Number.isFinite(expiry) && expiry > now() && expiry <= now() + 3_720_000, 'TOKEN_EXPIRY_INVALID');
    receipt.token.permissions = expectedTokenPermissions;
    receipt.token.expiresAt = new Date(expiry).toISOString();
    const visible = await call('GET', '/installation/repositories?per_page=100&page=1', token, 200, 'TOKEN_REPOSITORY_READ_FAILED');
    requireValue(visible?.total_count === 1 && Array.isArray(visible.repositories) && visible.repositories.length === 1 &&
      visible.repositories[0]?.id === issued.repositories[0].id && visible.repositories[0]?.full_name === options.repository &&
      visible.repositories[0]?.owner?.login === DEV_APP.owner, 'TOKEN_VISIBLE_SCOPE_MISMATCH');
    receipt.token.visibleRepositories = [options.repository];
    const main = await call('GET', `/repos/${options.repository}/git/ref/heads/main`, token, 200, 'CONTENTS_READ_PROBE_FAILED');
    requireValue(main?.ref === 'refs/heads/main' && main.object?.type === 'commit' && /^[a-f0-9]{40}$/.test(main.object?.sha ?? ''), 'CONTENTS_READ_PROBE_INVALID');
    receipt.readProbe = { repository: options.repository, ref: main.ref, sha: main.object.sha, contentsReadVerified: true };
    if (options.operation === 'push') {
      receipt.push = await push(pushPlan!, token);
      requireValue(receipt.push.outcome === 'passed', 'TASK_BRANCH_PUSH_FAILED');
      receipt.performedOperations.push = true;
    } else if (options.operation === 'pr') {
      receipt.pullRequest = await upsertTaskPr(options, token, request);
      receipt.performedOperations.createPr = receipt.pullRequest.operation === 'created';
      receipt.performedOperations.updatePr = receipt.pullRequest.operation === 'updated';
    } else if (options.operation === 'status') {
      receipt.ci = await readTaskCi(options, token, request, requestedPermissions.actions === 'read');
    }
    verified = true;
  } catch (error) {
    // Never print network errors, response bodies, headers, JWTs, tokens or PEM parser errors.
    receipt.failureCode = error instanceof AuthFailure ? error.code : 'AUTHENTICATION_VERIFICATION_FAILED';
  } finally {
    jwt = '';
    if (token) {
      receipt.token.revocation = 'failed';
      try {
        const revoked = await request('DELETE', '/installation/token', token);
        receipt.token.revocation = revoked.status === 204 ? 'confirmed-204' : 'failed';
      } catch { /* A failed DELETE is never reported as confirmed. */ }
      // Only read-only invalidation probes retry; token issuance and DELETE never retry.
      const probeStart = now();
      for (const pause of [0, 250, 500, 1000, 2000, 4000]) {
        if (pause) await wait(pause);
        try {
          const probe = await request('GET', '/installation/repositories?per_page=100&page=1', token);
          receipt.token.revokedTokenProbeStatuses.push(probe.status);
          receipt.token.revokedTokenProbes.push({ status: probe.status, elapsedMs: Math.max(0, now() - probeStart),
            ...(probe.requestId && /^[a-f0-9:]{1,128}$/i.test(probe.requestId) ? { requestId: probe.requestId } : {}) });
          receipt.token.revokedTokenProbe = probe.status === 401 ? 'rejected-401' : 'not-confirmed';
          if (probe.status === 401) break;
          if ([403, 429].includes(probe.status)) break; // Stop on denial/rate limiting; never substitute it for 401.
        } catch {
          receipt.token.revokedTokenProbeStatuses.push('network-error');
          receipt.token.revokedTokenProbes.push({ status: 'network-error', elapsedMs: Math.max(0, now() - probeStart) });
          receipt.token.revokedTokenProbe = 'not-confirmed';
        }
      }
      token = '';
    }
  }
  receipt.outcome = verified && receipt.token.revocation === 'confirmed-204' && receipt.token.revokedTokenProbe === 'rejected-401' ? 'passed' : 'failed';
  if (verified && receipt.outcome !== 'passed') receipt.failureCode = 'TOKEN_REVOCATION_NOT_CONFIRMED';
  return receipt;
}

export function verifyDevelopmentApp(signJwt: () => string, request: AuthRequest, now = () => Date.now(), wait?: (ms: number) => Promise<void>) {
  return runDevelopmentApp({ operation: 'verify', repository: 'chwan886/Architecture-Explorer' }, signJwt, request, now, wait);
}

async function apiData(request: AuthRequest, method: 'GET' | 'POST' | 'PATCH', endpoint: string, token: string, expected: number, body?: Json) {
  const response = await request(method, endpoint, token, body);
  requireValue(response.status === expected, `TASK_API_${expected}_EXPECTED`);
  return response.data;
}
function taskPr(pr: Json, options: { repository: Repository; branch?: string; expectedHead: string; prNumber?: number }, botId: number) {
  requireValue(Number.isSafeInteger(pr?.number) && pr.number > 0 && pr.html_url === `https://github.com/${options.repository}/pull/${pr.number}` &&
    pr.state === 'open' && pr.merged_at === null && pr.base?.ref === 'main' && pr.base?.repo?.full_name === options.repository &&
    pr.head?.repo?.full_name === options.repository && pr.head?.sha === options.expectedHead &&
    (options.branch === undefined || pr.head.ref === options.branch) && (options.prNumber === undefined || options.prNumber === pr.number), 'PR_REPOSITORY_BASE_OR_HEAD_MISMATCH');
  validateTaskBranch(pr.head.ref);
  requireValue(pr.user?.type === 'Bot' && pr.user.login === `${DEV_APP.slug}[bot]` && pr.user.id === botId, 'PR_AUTHOR_IS_NOT_DEVELOPMENT_APP');
  return { number: pr.number as number, url: pr.html_url as string, headSha: pr.head.sha as string, branch: pr.head.ref as string,
    base: 'main', author: { login: pr.user.login as string, id: botId, type: 'Bot' } };
}
async function botIdentity(request: AuthRequest, token: string) {
  const bot = await apiData(request, 'GET', `/users/${DEV_APP.slug}%5Bbot%5D`, token, 200);
  requireValue(bot?.login === `${DEV_APP.slug}[bot]` && bot?.type === 'Bot' && Number.isSafeInteger(bot.id) && bot.id > 0, 'APP_BOT_IDENTITY_UNREADABLE');
  return bot.id as number;
}

export async function upsertTaskPr(options: Extract<AppOperation, { operation: 'pr' }>, token: string, request: AuthRequest) {
  validateOperation(options);
  const botId = await botIdentity(request, token);
  const head = await apiData(request, 'GET', `/repos/${options.repository}/git/ref/heads/${encodeURIComponent(options.branch)}`, token, 200);
  requireValue(head?.ref === `refs/heads/${options.branch}` && head.object?.type === 'commit' && head.object?.sha === options.expectedHead, 'REMOTE_TASK_HEAD_MISMATCH');
  let existing: Json | undefined;
  if (options.prNumber !== undefined) {
    existing = await apiData(request, 'GET', `/repos/${options.repository}/pulls/${options.prNumber}`, token, 200);
  } else {
    const found = await apiData(request, 'GET', `/repos/${options.repository}/pulls?state=open&head=${encodeURIComponent(`${DEV_APP.owner}:${options.branch}`)}&base=main&per_page=100`, token, 200);
    requireValue(Array.isArray(found) && found.length <= 1, 'OPEN_TASK_PR_AMBIGUOUS');
    existing = found[0];
  }
  if (existing) taskPr(existing, options, botId);
  const text = { title: options.title, body: options.body };
  // PATCH never accepts base/head/state/merge options. POST never retries after an unknown outcome.
  const changed = existing
    ? await apiData(request, 'PATCH', `/repos/${options.repository}/pulls/${existing.number}`, token, 200, text)
    : await apiData(request, 'POST', `/repos/${options.repository}/pulls`, token, 201,
      { ...text, head: options.branch, base: 'main', draft: false, maintainer_can_modify: false });
  const checked = taskPr(changed, options, botId);
  const confirmed = taskPr(await apiData(request, 'GET', `/repos/${options.repository}/pulls/${checked.number}`, token, 200), options, botId);
  return { ...confirmed, operation: existing ? 'updated' : 'created' };
}

export async function readTaskCi(options: Extract<AppOperation, { operation: 'status' }>, token: string, request: AuthRequest, actionsRead: boolean) {
  validateOperation(options);
  const botId = await botIdentity(request, token);
  const pr = taskPr(await apiData(request, 'GET', `/repos/${options.repository}/pulls/${options.prNumber}`, token, 200), options, botId);
  if (!actionsRead) {
    // GraphQL uses only the existing single-repository token. Partial data or errors never imply green CI.
    const response = await request('POST', '/graphql', token, { query: 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid baseRefName commits(last:1){nodes{commit{oid statusCheckRollup{state}}}}}}}',
      variables: { owner: DEV_APP.owner, name: options.repository.split('/')[1], number: options.prNumber } });
    const row = response.data?.data?.repository?.pullRequest;
    const commit = row?.commits?.nodes?.[0]?.commit;
    if (response.status !== 200 || response.data?.errors?.length || row?.headRefOid !== options.expectedHead || row?.baseRefName !== 'main' || commit?.oid !== options.expectedHead) {
      return { outcome: 'unreadable', complete: false, reason: 'CI_REQUIRES_ACTIONS_READ_OR_READABLE_GRAPHQL', pullRequest: pr, runs: [] };
    }
    return { outcome: 'aggregate-only', complete: false, aggregate: commit.statusCheckRollup?.state ?? null,
      reason: 'Named workflow runs and jobs require Actions read; aggregate is not a complete CI result', pullRequest: pr, runs: [] };
  }
  const runs: Json[] = [];
  for (let page = 1; page <= 10; page++) {
    const result = await apiData(request, 'GET', `/repos/${options.repository}/actions/runs?event=pull_request&head_sha=${options.expectedHead}&per_page=100&page=${page}`, token, 200);
    requireValue(Array.isArray(result?.workflow_runs), 'CI_RUNS_UNREADABLE');
    runs.push(...result.workflow_runs);
    if (result.workflow_runs.length < 100) break;
    requireValue(page < 10, 'CI_RUN_PAGE_LIMIT');
  }
  const selected = runs.filter(run => run.event === 'pull_request' && run.head_sha === options.expectedHead &&
    run.pull_requests?.some((item: Json) => item.number === options.prNumber && item.head?.sha === options.expectedHead));
  const evidence: Json[] = [];
  for (const run of selected) {
    requireValue(Number.isSafeInteger(run.id) && run.id > 0 && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0 &&
      run.html_url === `https://github.com/${options.repository}/actions/runs/${run.id}` && /^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/.test(run.path), 'CI_RUN_IDENTITY_INVALID');
    const jobs: Json[] = [];
    for (let page = 1; page <= 10; page++) {
      const result = await apiData(request, 'GET', `/repos/${options.repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`, token, 200);
      requireValue(Array.isArray(result?.jobs), 'CI_JOBS_UNREADABLE');
      for (const job of result.jobs) jobs.push({ id: job.id, name: job.name, status: job.status, conclusion: job.conclusion,
        url: `https://github.com/${options.repository}/actions/runs/${run.id}/job/${job.id}` });
      if (result.jobs.length < 100) break;
      requireValue(page < 10, 'CI_JOB_PAGE_LIMIT');
    }
    evidence.push({ id: run.id, url: run.html_url, workflow: run.path, attempt: run.run_attempt, headSha: run.head_sha,
      status: run.status, conclusion: run.conclusion, jobs });
  }
  const complete = evidence.length > 0 && evidence.every(run => run.status === 'completed');
  return { pullRequest: pr, runs: evidence, complete, outcome: !evidence.length ? 'not-observed' : !complete ? 'in-progress'
    : evidence.every(run => run.conclusion === 'success') ? 'success' : 'failure' };
}

// This is independent of gh/GCM/Owner credentials. Authentication never leaves this process.
const githubRequest: AuthRequest = async (method, endpoint, credential, body) => {
  const response = await fetch(`https://api.github.com${endpoint}`, { method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${credential}`, accept: 'application/vnd.github+json', 'cache-control': 'no-cache, no-store, max-age=0', 'X-GitHub-Api-Version': '2026-03-10', 'user-agent': 'chwan-dev-agent-local-verification',
      ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const requestId = response.headers.get('x-github-request-id') ?? undefined;
  if (response.status === 204 || response.status === 401) { await response.body?.cancel().catch(() => {}); return { status: response.status, requestId }; }
  // Failed responses may reflect credentials; do not parse, expose or persist their bodies.
  if (!response.ok) { await response.body?.cancel().catch(() => {}); return { status: response.status, requestId }; }
  return { status: response.status, data: await response.json(), requestId };
};

async function main() {
  requireValue(process.platform === 'win32', 'WINDOWS_ACL_ENTRY_REQUIRED');
  const args = process.argv.slice(2);
  const allowed = new Set(['--key-file', '--receipt', '--operation', '--repository', '--working-directory', '--branch', '--expected-head', '--title', '--body-file', '--pr-number']);
  const flags = new Map<string, string>();
  requireValue(args.length % 2 === 0, 'USE_VERIFIED_POWERSHELL_ENTRY');
  for (let index = 0; index < args.length; index += 2) {
    requireValue(allowed.has(args[index]) && !flags.has(args[index]) && !args[index + 1].includes('\0'), 'INVALID_ENTRY_ARGUMENTS');
    flags.set(args[index], args[index + 1]);
  }
  requireValue(flags.has('--key-file'), 'USE_VERIFIED_POWERSHELL_ENTRY');
  const operation = flags.get('--operation') ?? 'verify', repository = (flags.get('--repository') ?? DEV_APP.repository) as Repository;
  let options: AppOperation;
  if (operation === 'verify') options = { operation, repository };
  else if (operation === 'push') options = { operation, repository, workingDirectory: flags.get('--working-directory') ?? '', branch: flags.get('--branch') ?? '', expectedHead: flags.get('--expected-head') ?? '' };
  else if (operation === 'pr') {
    const bodyPath = path.resolve(flags.get('--body-file') ?? '');
    requireValue(isWithin(TOOL_ROOT, bodyPath), 'PR_BODY_MUST_STAY_IN_TOOL_ROOT');
    const body = new TextDecoder('utf-8', { fatal: true }).decode(await readAuthorized(TOOL_ROOT, path.relative(TOOL_ROOT, bodyPath).replaceAll('\\', '/'), 65536));
    requireValue(!/-----BEGIN\b/i.test(body), 'PRIVATE_KEY_IS_NOT_PR_TEXT');
    options = { operation, repository, branch: flags.get('--branch') ?? '', expectedHead: flags.get('--expected-head') ?? '', title: flags.get('--title') ?? '', body,
      ...(flags.has('--pr-number') ? { prNumber: Number(flags.get('--pr-number')) } : {}) };
  } else if (operation === 'status') options = { operation, repository, expectedHead: flags.get('--expected-head') ?? '', prNumber: Number(flags.get('--pr-number')) };
  else throw new AuthFailure('UNAPPROVED_OPERATION');
  const operationFlags = operation === 'verify' ? [] : operation === 'push' ? ['--working-directory', '--branch', '--expected-head']
    : operation === 'pr' ? ['--branch', '--expected-head', '--title', '--body-file', '--pr-number'] : ['--expected-head', '--pr-number'];
  requireValue([...flags.keys()].every(name => ['--key-file', '--receipt', '--operation', '--repository', ...operationFlags].includes(name)), 'MIXED_OPERATION_ARGUMENTS');
  validateOperation(options);
  requireValue(!process.stdin.isTTY, 'ACL_PREFLIGHT_REQUIRED');
  let input = '';
  for await (const part of process.stdin) { input += part.toString(); requireValue(Buffer.byteLength(input) <= 8192, 'ACL_PREFLIGHT_INVALID'); }
  const preflight = JSON.parse(input);
  const keyPath = path.resolve(flags.get('--key-file')!);
  requireValue(preflight.schemaVersion === 1 && canonical(preflight.keyFile) === canonical(keyPath) && preflight.acl?.checked === true &&
    preflight.acl.scope === 'directory-and-file' && preflight.acl.linksRejected === true && typeof preflight.acl.inherited === 'boolean' &&
    ['current-user', 'SYSTEM', 'Administrators'].includes(preflight.acl.owner) && Array.isArray(preflight.acl.allowPrincipals) &&
    preflight.acl.allowPrincipals.every((principal: string) => ['current-user', 'SYSTEM', 'Administrators'].includes(principal)), 'ACL_PREFLIGHT_INVALID');
  let receiptPath: string | undefined;
  if (flags.has('--receipt')) {
    receiptPath = path.resolve(flags.get('--receipt')!);
    requireValue(isWithin(TOOL_ROOT, receiptPath) && receiptPath.endsWith('.json'), 'RECEIPT_MUST_STAY_IN_TOOL_ROOT');
    await ensureCacheDirectory(path.dirname(receiptPath), TOOL_ROOT);
    try { await lstat(receiptPath); throw new AuthFailure('RECEIPT_ALREADY_EXISTS'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  requireValue(canonical(await realpath(keyPath)) === canonical(keyPath), 'PRIVATE_KEY_LINK_REJECTED');
  const file = await open(keyPath, 'r');
  let bytes: Buffer | undefined, key: KeyObject | undefined;
  let receipt: Json;
  try {
    const entry = await file.stat(), link = await lstat(keyPath);
    requireValue(entry.isFile() && !link.isSymbolicLink() && entry.size > 0 && entry.size <= 65536 && entry.size === preflight.fileIdentity?.size &&
      Math.abs(entry.mtimeMs - preflight.fileIdentity?.mtimeMs) < 2 && entry.ino === link.ino, 'PRIVATE_KEY_CHANGED_AFTER_ACL_CHECK');
    bytes = await file.readFile();
    key = createPrivateKey(bytes); bytes.fill(0); bytes = undefined;
    receipt = await runDevelopmentApp(options, () => createAppJwt(key!), githubRequest);
    receipt.privateKeyAcl = { checked: true, owner: preflight.acl.owner, allowPrincipals: [...new Set(preflight.acl.allowPrincipals)],
      inherited: preflight.acl.inherited, scope: 'directory-and-file', linksRejected: true };
  } finally { bytes?.fill(0); key = undefined; await file.close(); }
  if (receiptPath) await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(receipt, null, 2));
  if (receipt.outcome !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Development App authentication failed; no secret details emitted.'); process.exitCode = 1; });
}

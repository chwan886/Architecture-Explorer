import { createSign, randomUUID, type KeyObject } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { prepareTaskPush, runTaskPush, type TaskPushPlan } from './dev-app-git.ts';
import { DevelopmentAppFailure, parseDevelopmentAppConfig, requireApp, validateTaskBranch, type DevelopmentAppConfig } from './dev-app-config.ts';

export { parseDevelopmentAppConfig, validateTaskBranch } from './dev-app-config.ts';
export type { DevelopmentAppConfig } from './dev-app-config.ts';
type Json = Record<string, any>;
export type AuthRequest = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', endpoint: string, credential: string, body?: Json) =>
  Promise<{ status: number; data?: any; requestId?: string }>;
export type AppOperation = { operation: 'verify' }
  | { operation: 'push'; workingDirectory: string; branch: string; expectedHead: string }
  | { operation: 'pull-request'; branch: string; expectedHead: string; title: string; body: string; prNumber?: number }
  | { operation: 'status'; expectedHead: string; prNumber: number };
export interface DevelopmentAppDependencies {
  signJwt: () => string;
  request: AuthRequest;
  preparePush?: typeof prepareTaskPush;
  push?: typeof runTaskPush;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}
const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const samePermissions = (actual: unknown, expected: Record<string, string>) => actual !== null && typeof actual === 'object' && !Array.isArray(actual) &&
  Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => (actual as Json)[key] === value);

export function createAppJwt(key: KeyObject, appId: number, nowMs = Date.now()): string {
  requireApp(id(appId) && Number.isFinite(nowMs) && key.type === 'private' && key.asymmetricKeyType === 'rsa' &&
    (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048, 'RSA_APP_SIGNING_KEY_REQUIRED');
  const now = Math.floor(nowMs / 1000), encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(key).toString('base64url')}`;
}

function validateOperation(config: DevelopmentAppConfig, options: AppOperation) {
  requireApp(options !== null && typeof options === 'object' && !Array.isArray(options), 'APP_OPERATION_INVALID');
  const fields = options.operation === 'verify' ? ['operation'] : options.operation === 'push' ? ['operation', 'workingDirectory', 'branch', 'expectedHead']
    : options.operation === 'pull-request' ? ['operation', 'branch', 'expectedHead', 'title', 'body', 'prNumber']
    : options.operation === 'status' ? ['operation', 'expectedHead', 'prNumber'] : [];
  requireApp(fields.length > 0 && Object.keys(options).every(key => fields.includes(key)), 'APP_OPERATION_INVALID');
  if (options.operation !== 'verify') requireApp(sha(options.expectedHead), 'EXACT_TASK_HEAD_REQUIRED');
  if (options.operation === 'push' || options.operation === 'pull-request') validateTaskBranch(options.branch, config.baseBranch);
  if (options.operation === 'push') requireApp(typeof options.workingDirectory === 'string' &&
    (path.isAbsolute(options.workingDirectory) || path.win32.isAbsolute(options.workingDirectory)) && !/[\x00-\x1f\x7f]/.test(options.workingDirectory), 'ABSOLUTE_WORKTREE_REQUIRED');
  if (options.operation === 'pull-request') requireApp(typeof options.title === 'string' && options.title.trim().length > 0 && options.title.length <= 256 &&
    !/[\r\n\0]/.test(options.title) && typeof options.body === 'string' && Buffer.byteLength(options.body) <= 65536 &&
    !/\0|-----BEGIN\b/i.test(options.body), 'PR_TEXT_INVALID');
  if (options.operation === 'status' || (options.operation === 'pull-request' && options.prNumber !== undefined)) requireApp(id(options.prNumber), 'PR_NUMBER_INVALID');
}

function appPermissions(value: unknown): Record<string, string> {
  const expected = { contents: 'write', metadata: 'read', pull_requests: 'write',
    ...((value as Json)?.workflows === 'write' ? { workflows: 'write' } : {}),
    ...((value as Json)?.actions === 'read' ? { actions: 'read' } : {}) };
  requireApp(samePermissions(value, expected), 'APP_PERMISSION_BOUNDARY_MISMATCH');
  return expected;
}
function installationMatches(value: Json, config: DevelopmentAppConfig): boolean {
  return value?.id === config.installationId && value.app_id === config.appId && value.app_slug === config.appSlug &&
    value.account?.login === config.repository.split('/')[0] && id(value.account?.id) &&
    ['User', 'Organization'].includes(value.account?.type) && value.target_type === value.account.type &&
    value.repository_selection === 'selected' && value.suspended_at === null;
}

/** Credentials reach only these fixed operations and the isolated Git adapter. No owner fallback or remote rule mutation exists. */
export async function runDevelopmentApp(input: DevelopmentAppConfig, options: AppOperation, dependencies: DevelopmentAppDependencies) {
  const config = parseDevelopmentAppConfig(input); validateOperation(config, options);
  const { request, signJwt } = dependencies, now = dependencies.now ?? Date.now, wait = dependencies.wait ?? (async ms => { await delay(ms); });
  const receipt: Json = { schemaVersion: 1, mode: options.operation, repository: config.repository, baseBranch: config.baseBranch,
    checkedAt: new Date(now()).toISOString(), outcome: 'failed', app: { id: config.appId, slug: config.appSlug, verified: false },
    installation: { id: config.installationId, verified: false }, ownerAuthenticationUsed: false,
    token: { issued: false, secretRecorded: false, requestedRepositories: [config.repository], revocation: 'not-issued', revokedTokenProbe: 'not-run', revokedTokenProbeStatuses: [] },
    performedOperations: { push: false, createPr: false, updatePr: false },
    forbiddenOperations: { pushBase: false, forcePush: false, approve: false, merge: false, dispatch: false, changeRules: false } };
  let token = '', jwt = '', verified = false;
  const call = async (method: Parameters<AuthRequest>[0], endpoint: string, credential: string, status: number, code: string, body?: Json) => {
    const response = await request(method, endpoint, credential, body); requireApp(response.status === status, code); return response.data;
  };
  try {
    let pushPlan: TaskPushPlan | undefined;
    if (options.operation === 'push') {
      try { pushPlan = await (dependencies.preparePush ?? prepareTaskPush)({ repository: config.repository, baseBranch: config.baseBranch,
        workingDirectory: options.workingDirectory, branch: options.branch, expectedHead: options.expectedHead }); }
      catch { throw new DevelopmentAppFailure('TASK_PUSH_PREFLIGHT_FAILED'); }
      requireApp(pushPlan.repository === config.repository && pushPlan.baseBranch === config.baseBranch && pushPlan.branch === options.branch &&
        pushPlan.expectedHead === options.expectedHead && sha(pushPlan.baseHead) && typeof pushPlan.requiresWorkflows === 'boolean', 'TASK_PUSH_PLAN_MISMATCH');
    }
    jwt = signJwt(); requireApp(typeof jwt === 'string' && jwt.length > 0 && jwt.length <= 16384 && !/[\x00-\x20\x7f]/.test(jwt), 'APP_JWT_INVALID');
    const app = await call('GET', '/app', jwt, 200, 'APP_IDENTITY_READ_FAILED');
    requireApp(app?.id === config.appId && app?.slug === config.appSlug, 'APP_IDENTITY_MISMATCH');
    const registered = appPermissions(app.permissions); receipt.app.verified = true; receipt.app.permissions = registered;
    const installation = await call('GET', `/app/installations/${config.installationId}`, jwt, 200, 'INSTALLATION_READ_FAILED');
    requireApp(installationMatches(installation, config) && samePermissions(installation.permissions, registered), 'INSTALLATION_BOUNDARY_MISMATCH');
    const membership = await call('GET', `/repos/${config.repository}/installation`, jwt, 200, 'TARGET_INSTALLATION_READ_FAILED');
    requireApp(installationMatches(membership, config) && membership.account.id === installation.account.id, 'TARGET_INSTALLATION_MISMATCH');
    receipt.installation.verified = true; receipt.installation.repositorySelection = 'selected';
    const requested: Record<string, string> = options.operation === 'push' ? { contents: 'write', ...(pushPlan!.requiresWorkflows ? { workflows: 'write' } : {}) }
      : options.operation === 'pull-request' ? { contents: 'read', pull_requests: 'write' }
      : options.operation === 'status' ? { contents: 'read', pull_requests: 'read', ...(registered.actions === 'read' ? { actions: 'read' } : {}) }
      : { contents: 'read' };
    requireApp(!requested.workflows || registered.workflows === 'write', 'APP_WORKFLOWS_PERMISSION_REQUIRED');
    receipt.token.requestedPermissions = requested;
    receipt.token.issued = 'unconfirmed'; receipt.token.revocation = 'unconfirmed-no-token';
    const minted = await request('POST', `/app/installations/${config.installationId}/access_tokens`, jwt,
      { repositories: [config.repository.split('/')[1]], permissions: requested });
    // Capture before validating any response field so a malformed issuance response still triggers revocation.
    if (typeof minted.data?.token === 'string' && minted.data.token.length > 0) { token = minted.data.token; receipt.token.issued = true; receipt.token.revocation = 'pending'; }
    else if ([401, 403, 404, 422].includes(minted.status)) { receipt.token.issued = false; receipt.token.revocation = 'not-issued'; }
    requireApp(minted.status === 201 && token.length > 0 && token.length <= 16384 && !/[\x00-\x20\x7f]/.test(token), 'TOKEN_ISSUANCE_FAILED_OR_UNCONFIRMED');
    const issued = minted.data, permissions = { ...requested, ...(issued.permissions?.metadata === 'read' ? { metadata: 'read' } : {}) };
    requireApp(samePermissions(issued.permissions, permissions), 'TOKEN_PERMISSION_BOUNDARY_MISMATCH');
    requireApp(issued.repository_selection === 'selected' && Array.isArray(issued.repositories) && issued.repositories.length === 1 &&
      issued.repositories[0]?.full_name === config.repository && issued.repositories[0]?.owner?.login === config.repository.split('/')[0] &&
      id(issued.repositories[0]?.id), 'TOKEN_REPOSITORY_SCOPE_MISMATCH');
    const expires = Date.parse(issued.expires_at);
    requireApp(typeof issued.expires_at === 'string' && Number.isFinite(expires) && expires > now() && expires <= now() + 3720000, 'TOKEN_EXPIRY_INVALID');
    receipt.token.permissions = permissions; receipt.token.expiresAt = new Date(expires).toISOString();
    const visible = await call('GET', '/installation/repositories?per_page=100&page=1', token, 200, 'TOKEN_REPOSITORY_READ_FAILED');
    requireApp(visible?.total_count === 1 && Array.isArray(visible.repositories) && visible.repositories.length === 1 &&
      visible.repositories[0]?.id === issued.repositories[0].id && visible.repositories[0]?.full_name === config.repository &&
      visible.repositories[0]?.owner?.login === config.repository.split('/')[0], 'TOKEN_VISIBLE_SCOPE_MISMATCH');
    const base = await call('GET', `/repos/${config.repository}/git/ref/heads/${encodeURIComponent(config.baseBranch)}`, token, 200, 'CONTENTS_READ_PROBE_FAILED');
    requireApp(base?.ref === `refs/heads/${config.baseBranch}` && base.object?.type === 'commit' && sha(base.object?.sha), 'CONTENTS_READ_PROBE_INVALID');
    receipt.readProbe = { ref: base.ref, sha: base.object.sha, contentsReadVerified: true };
    if (options.operation === 'push') {
      requireApp(base.object.sha === pushPlan!.baseHead, 'PUSH_BASE_HEAD_CHANGED_OR_MISMATCHED');
      const pushed = await (dependencies.push ?? runTaskPush)(pushPlan!, token);
      requireApp(pushed.repository === config.repository && pushed.branch === options.branch && pushed.expectedHead === options.expectedHead &&
        pushed.ownerAuthenticationUsed === false && pushed.secretRecorded === false, 'TASK_PUSH_PROOF_MISMATCH');
      // Project only fixed fields; a transport error/unknown extra field must never enter the receipt.
      receipt.push = { outcome: pushed.outcome, pushOutcome: pushed.pushOutcome, remoteHeadVerified: pushed.remoteHeadVerified };
      receipt.performedOperations.push = pushed.pushOutcome === 'succeeded';
      requireApp(pushed.outcome === 'passed' && pushed.pushOutcome === 'succeeded' && pushed.remoteHeadVerified === true, 'TASK_BRANCH_PUSH_FAILED');
    } else if (options.operation === 'pull-request') {
      receipt.pullRequest = await upsertTaskPr(config, options, token, request, receipt);
    } else if (options.operation === 'status') receipt.ci = await readTaskCi(config, options, token, request, registered.actions === 'read');
    verified = true;
  } catch (error) { receipt.failureCode = error instanceof DevelopmentAppFailure ? error.code : 'APP_OPERATION_FAILED'; }
  finally {
    jwt = '';
    if (token) {
      receipt.token.revocation = 'failed';
      try { receipt.token.revocation = (await request('DELETE', '/installation/token', token)).status === 204 ? 'confirmed-204' : 'failed'; } catch { /* No raw network errors. */ }
      for (const pause of [0, 250, 500, 1000, 2000, 4000]) {
        if (pause) await wait(pause);
        try {
          const probe = await request('GET', '/installation/repositories?per_page=100&page=1', token);
          receipt.token.revokedTokenProbeStatuses.push(probe.status);
          receipt.token.revokedTokenProbe = probe.status === 401 ? 'rejected-401' : 'not-confirmed';
          if ([401, 403, 429].includes(probe.status)) break;
        } catch { receipt.token.revokedTokenProbeStatuses.push('network-error'); receipt.token.revokedTokenProbe = 'not-confirmed'; }
      }
      token = '';
    }
  }
  receipt.outcome = verified && receipt.token.revocation === 'confirmed-204' && receipt.token.revokedTokenProbe === 'rejected-401' ? 'passed' : 'failed';
  if (verified && receipt.outcome !== 'passed') receipt.failureCode = 'TOKEN_REVOCATION_NOT_CONFIRMED';
  return receipt;
}

async function apiData(request: AuthRequest, method: 'GET' | 'POST' | 'PATCH', endpoint: string, token: string, expected: number, body?: Json) {
  const response = await request(method, endpoint, token, body); requireApp(response.status === expected, 'TASK_API_REQUEST_FAILED'); return response.data;
}
async function botIdentity(config: DevelopmentAppConfig, request: AuthRequest, token: string) {
  const bot = await apiData(request, 'GET', `/users/${config.appSlug}%5Bbot%5D`, token, 200);
  requireApp(bot?.login === `${config.appSlug}[bot]` && bot?.type === 'Bot' && id(bot.id), 'APP_BOT_IDENTITY_UNCONFIRMED'); return bot.id as number;
}
function taskPr(config: DevelopmentAppConfig, pr: Json, options: { branch?: string; expectedHead: string; prNumber?: number }, botId: number) {
  requireApp(id(pr?.number) && (options.prNumber === undefined || pr.number === options.prNumber) && pr.html_url === `https://github.com/${config.repository}/pull/${pr.number}` &&
    pr.state === 'open' && pr.merged_at === null && pr.base?.ref === config.baseBranch && pr.base?.repo?.full_name === config.repository &&
    pr.head?.repo?.full_name === config.repository && pr.head?.sha === options.expectedHead && (options.branch === undefined || pr.head.ref === options.branch), 'PR_REPOSITORY_BASE_OR_HEAD_MISMATCH');
  validateTaskBranch(pr.head.ref, config.baseBranch);
  requireApp(pr.user?.login === `${config.appSlug}[bot]` && pr.user?.type === 'Bot' && pr.user?.id === botId, 'PR_AUTHOR_IS_NOT_APP');
  return { number: pr.number as number, url: pr.html_url as string, branch: pr.head.ref as string, headSha: pr.head.sha as string,
    base: config.baseBranch, author: { login: `${config.appSlug}[bot]`, id: botId, type: 'Bot' } };
}
async function upsertTaskPr(config: DevelopmentAppConfig, options: Extract<AppOperation, { operation: 'pull-request' }>, token: string, request: AuthRequest, receipt: Json) {
  const botId = await botIdentity(config, request, token), prefix = `/repos/${config.repository}`;
  const checkHead = async () => {
    const head = await apiData(request, 'GET', `${prefix}/git/ref/heads/${encodeURIComponent(options.branch)}`, token, 200);
    requireApp(head?.ref === `refs/heads/${options.branch}` && head.object?.type === 'commit' && head.object?.sha === options.expectedHead, 'REMOTE_TASK_HEAD_MISMATCH');
  };
  await checkHead(); let existing: Json | undefined;
  if (options.prNumber !== undefined) existing = await apiData(request, 'GET', `${prefix}/pulls/${options.prNumber}`, token, 200);
  else {
    const found = await apiData(request, 'GET', `${prefix}/pulls?state=open&head=${encodeURIComponent(`${config.repository.split('/')[0]}:${options.branch}`)}&base=${encodeURIComponent(config.baseBranch)}&per_page=100`, token, 200);
    requireApp(Array.isArray(found) && found.length <= 1, 'OPEN_TASK_PR_AMBIGUOUS'); existing = found[0];
  }
  if (existing) taskPr(config, existing, options, botId);
  const text = { title: options.title, body: options.body };
  // A successful mutation is still recorded if later identity/head verification fails.
  // An interrupted POST has an unknown outcome and must never be automatically retried.
  receipt.pullRequestMutation = { operation: existing ? 'update' : 'create', outcome: 'unconfirmed' };
  const changed = existing ? await apiData(request, 'PATCH', `${prefix}/pulls/${existing.number}`, token, 200, text)
    : await apiData(request, 'POST', `${prefix}/pulls`, token, 201, { ...text, head: options.branch, base: config.baseBranch, draft: false, maintainer_can_modify: false });
  receipt.pullRequestMutation.outcome = 'accepted';
  receipt.performedOperations[existing ? 'updatePr' : 'createPr'] = true;
  const checked = taskPr(config, changed, options, botId);
  const confirmed = taskPr(config, await apiData(request, 'GET', `${prefix}/pulls/${checked.number}`, token, 200), { ...options, prNumber: checked.number }, botId);
  await checkHead(); return { ...confirmed, operation: existing ? 'updated' : 'created' };
}

async function readTaskCi(config: DevelopmentAppConfig, options: Extract<AppOperation, { operation: 'status' }>, token: string, request: AuthRequest, actionsRead: boolean) {
  const botId = await botIdentity(config, request, token), prefix = `/repos/${config.repository}`;
  const pr = taskPr(config, await apiData(request, 'GET', `${prefix}/pulls/${options.prNumber}`, token, 200), options, botId);
  if (!actionsRead) return { pullRequest: pr, outcome: 'unreadable', complete: false, reason: 'ACTIONS_READ_NOT_GRANTED', runs: [], requiredChecksVerified: false };
  const runs: Json[] = [];
  for (let page = 1; page <= 10; page++) {
    const result = await apiData(request, 'GET', `${prefix}/actions/runs?event=pull_request&head_sha=${options.expectedHead}&per_page=100&page=${page}`, token, 200);
    requireApp(Array.isArray(result?.workflow_runs) && result.workflow_runs.length <= 100, 'CI_RUNS_UNREADABLE');
    runs.push(...result.workflow_runs); if (result.workflow_runs.length < 100) break; requireApp(page < 10, 'CI_RUN_PAGE_LIMIT');
  }
  const selected = runs.filter(run => run.event === 'pull_request' && run.head_sha === options.expectedHead &&
    run.pull_requests?.some((item: Json) => item.number === options.prNumber && item.head?.sha === options.expectedHead));
  const evidence: Json[] = [], seen = new Set<number>();
  const statuses = ['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested'];
  const conclusions = ['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure'];
  const safeName = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value) &&
    !value.includes(token) && !/-----BEGIN|\b(?:Bearer\s|gh[pousr]_|github_pat_)/i.test(value);
  const state = (value: Json) => statuses.includes(value.status) && (value.conclusion === null || conclusions.includes(value.conclusion)) &&
    (value.status !== 'completed' || value.conclusion !== null);
  for (const run of selected) {
    requireApp(id(run.id) && !seen.has(run.id) && id(run.run_attempt) && state(run) &&
      run.html_url === `https://github.com/${config.repository}/actions/runs/${run.id}` && /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(run.path), 'CI_RUN_IDENTITY_INVALID');
    seen.add(run.id); const jobs: Json[] = [], jobIds = new Set<number>();
    for (let page = 1; page <= 10; page++) {
      const result = await apiData(request, 'GET', `${prefix}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`, token, 200);
      requireApp(Array.isArray(result?.jobs) && result.jobs.length <= 100, 'CI_JOBS_UNREADABLE');
      for (const job of result.jobs) {
        requireApp(id(job.id) && !jobIds.has(job.id) && job.run_id === run.id && job.head_sha === options.expectedHead &&
          (job.run_attempt === undefined || job.run_attempt === run.run_attempt) && safeName(job.name) && state(job), 'CI_JOB_IDENTITY_INVALID');
        jobIds.add(job.id); jobs.push({ id: job.id, name: job.name, status: job.status, conclusion: job.conclusion,
          url: `https://github.com/${config.repository}/actions/runs/${run.id}/job/${job.id}` });
      }
      if (result.jobs.length < 100) break; requireApp(page < 10, 'CI_JOB_PAGE_LIMIT');
    }
    evidence.push({ id: run.id, url: run.html_url, workflow: run.path, attempt: run.run_attempt, headSha: options.expectedHead, status: run.status, conclusion: run.conclusion, jobs });
  }
  const complete = evidence.length > 0 && evidence.every(run => run.status === 'completed' && run.jobs.length > 0 && run.jobs.every((job: Json) => job.status === 'completed'));
  const failed = evidence.some(run => run.status === 'completed' && run.conclusion !== 'success' || run.jobs.some((job: Json) => job.status === 'completed' && !['success', 'skipped', 'neutral'].includes(job.conclusion)));
  return { pullRequest: pr, runs: evidence, complete, requiredChecksVerified: false,
    outcome: failed ? 'failure' : !evidence.length ? 'not-observed' : !complete ? 'in-progress' : 'success' };
}

/** Fixed GitHub HTTPS transport. Failed response bodies, redirects and credentials are never logged or returned. */
export const githubAppRequest: AuthRequest = async (method, endpoint, credential, body) => {
  requireApp(endpoint.startsWith('/') && !endpoint.startsWith('//') && !/[\x00-\x20\x7f\\#]/.test(endpoint) &&
    typeof credential === 'string' && credential.length > 0 && !/[\x00-\x20\x7f]/.test(credential), 'GITHUB_REQUEST_INVALID');
  const target = new URL(`https://api.github.com${endpoint}`);
  requireApp(target.origin === 'https://api.github.com', 'GITHUB_REQUEST_INVALID');
  if (method === 'GET') target.searchParams.set('_verification_nonce', randomUUID());
  const response = await fetch(target, { method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${credential}`, accept: 'application/vnd.github+json', 'cache-control': 'no-cache, no-store, max-age=0',
      'X-GitHub-Api-Version': '2026-03-10', 'user-agent': 'architecture-explorer-development-app', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok || response.status === 204) { await response.body?.cancel().catch(() => {}); return { status: response.status }; }
  const limit = 4 * 1024 * 1024, length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel().catch(() => {}); throw new DevelopmentAppFailure('GITHUB_RESPONSE_TOO_LARGE');
  }
  if (!response.body) return { status: response.status };
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      requireApp(size <= limit, 'GITHUB_RESPONSE_TOO_LARGE'); chunks.push(next.value);
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
    return { status: response.status, data: text ? JSON.parse(text) : undefined };
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
};

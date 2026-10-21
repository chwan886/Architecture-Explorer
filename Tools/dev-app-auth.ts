import path from 'node:path';
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { lstat, open, realpath, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { TOOL_ROOT } from '../packages/indexer/src/config.ts';
import { canonical, ensureCacheDirectory, isWithin } from '../packages/indexer/src/security.ts';

export const DEV_APP = Object.freeze({ id: 5417611, clientId: 'Iv23lil3cvGyWUbx4yfS', slug: 'chwan-dev-agent', owner: 'chwan886',
  repository: 'chwan886/Architecture-Explorer', installedRepositories: ['chwan886/Architecture-Explorer', 'chwan886/GameDemo02'] });
const expectedAppPermissions = { contents: 'write', metadata: 'read', pull_requests: 'write', workflows: 'write' };
type Json = Record<string, any>;
export type AuthRequest = (method: 'GET' | 'POST' | 'DELETE', endpoint: string, credential: string, body?: Json) => Promise<{ status: number; data?: any; requestId?: string }>;
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
export async function verifyDevelopmentApp(signJwt: () => string, request: AuthRequest, now = () => Date.now(), wait: (ms: number) => Promise<void> = async ms => { await delay(ms); }) {
  const receipt: Json = { schemaVersion: 1, mode: 'authentication-verification-only', checkedAt: new Date(now()).toISOString(), outcome: 'failed',
    app: { id: DEV_APP.id, clientId: DEV_APP.clientId, slug: DEV_APP.slug, owner: DEV_APP.owner, verified: false },
    installation: { verifiedTargetMembership: [], exactRepositorySetVerified: false,
      exactRepositorySet: 'not-proven: App JWT does not enumerate installation repositories; manually confirm only the two approved repositories' },
    token: { requestedRepositories: [DEV_APP.repository], requestedPermissions: { contents: 'read' }, issued: false, secretRecorded: false,
      revocation: 'not-issued', revokedTokenProbe: 'not-run', revokedTokenProbeStatuses: [], revokedTokenProbes: [] }, ownerAuthenticationUsed: false,
    forbiddenOperations: { push: false, createPr: false, merge: false, dispatch: false, modifyGitConfiguration: false } };
  let token = '', jwt = '', verified = false;
  const call = async (method: 'GET' | 'POST' | 'DELETE', endpoint: string, credential: string, status: number, code: string, body?: Json) => {
    const response = await request(method, endpoint, credential, body);
    requireValue(response.status === status, code);
    return response.data;
  };
  try {
    jwt = signJwt();
    const app = await call('GET', '/app', jwt, 200, 'APP_IDENTITY_READ_FAILED');
    requireValue(app?.id === DEV_APP.id && app?.client_id === DEV_APP.clientId && app?.slug === DEV_APP.slug &&
      app?.owner?.login === DEV_APP.owner && app?.owner?.type === 'User' && Number.isSafeInteger(app?.owner?.id), 'APP_IDENTITY_MISMATCH');
    requireValue(samePermissions(app.permissions, expectedAppPermissions), 'APP_PERMISSION_BOUNDARY_MISMATCH');
    receipt.app.verified = true;
    receipt.app.permissions = expectedAppPermissions;
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
    requireValue(samePermissions(installation.permissions, expectedAppPermissions), 'INSTALLATION_PERMISSION_BOUNDARY_MISMATCH');
    receipt.installation.id = installation.id;
    receipt.installation.repositorySelection = 'selected';
    receipt.installation.permissions = expectedAppPermissions;
    for (const repository of DEV_APP.installedRepositories) {
      const membership = await call('GET', `/repos/${repository}/installation`, jwt, 200, 'TARGET_INSTALLATION_READ_FAILED');
      requireValue(membership?.id === installation.id && membership?.app_id === DEV_APP.id && membership?.account?.login === DEV_APP.owner && membership?.account?.id === app.owner.id &&
        membership?.repository_selection === 'selected' && membership?.suspended_at === null, 'TARGET_INSTALLATION_MISMATCH');
      receipt.installation.verifiedTargetMembership.push(repository);
    }
    // Capture the token before validating the response so every subsequent failure still revokes it.
    receipt.token.issued = 'unconfirmed';
    receipt.token.revocation = 'unconfirmed-no-token';
    const minted = await request('POST', `/app/installations/${installation.id}/access_tokens`, jwt,
      { repositories: ['Architecture-Explorer'], permissions: { contents: 'read' } });
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
    requireValue(issued.permissions?.contents === 'read' && Object.keys(issued.permissions).every(name =>
      name === 'contents' || (name === 'metadata' && issued.permissions.metadata === 'read')), 'TOKEN_PERMISSIONS_NOT_READ_ONLY');
    requireValue(issued.repository_selection === 'selected' && Array.isArray(issued.repositories) && issued.repositories.length === 1 &&
      issued.repositories[0]?.full_name === DEV_APP.repository && issued.repositories[0]?.owner?.login === DEV_APP.owner &&
      Number.isSafeInteger(issued.repositories[0]?.id) && issued.repositories[0].id > 0, 'TOKEN_REPOSITORY_SCOPE_MISMATCH');
    const expiry = Date.parse(issued.expires_at);
    requireValue(typeof issued.expires_at === 'string' && Number.isFinite(expiry) && expiry > now() && expiry <= now() + 3_720_000, 'TOKEN_EXPIRY_INVALID');
    receipt.token.permissions = { contents: 'read', ...(issued.permissions.metadata === 'read' ? { metadata: 'read' } : {}) };
    receipt.token.expiresAt = new Date(expiry).toISOString();
    const visible = await call('GET', '/installation/repositories?per_page=100&page=1', token, 200, 'TOKEN_REPOSITORY_READ_FAILED');
    requireValue(visible?.total_count === 1 && Array.isArray(visible.repositories) && visible.repositories.length === 1 &&
      visible.repositories[0]?.id === issued.repositories[0].id && visible.repositories[0]?.full_name === DEV_APP.repository &&
      visible.repositories[0]?.owner?.login === DEV_APP.owner, 'TOKEN_VISIBLE_SCOPE_MISMATCH');
    receipt.token.visibleRepositories = [DEV_APP.repository];
    const main = await call('GET', `/repos/${DEV_APP.repository}/git/ref/heads/main`, token, 200, 'CONTENTS_READ_PROBE_FAILED');
    requireValue(main?.ref === 'refs/heads/main' && main.object?.type === 'commit' && /^[a-f0-9]{40}$/.test(main.object?.sha ?? ''), 'CONTENTS_READ_PROBE_INVALID');
    receipt.readProbe = { repository: DEV_APP.repository, ref: main.ref, sha: main.object.sha, contentsReadVerified: true };
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
  requireValue((args.length === 2 || args.length === 4) && args[0] === '--key-file' && (args.length === 2 || args[2] === '--receipt'), 'USE_VERIFIED_POWERSHELL_ENTRY');
  requireValue(!process.stdin.isTTY, 'ACL_PREFLIGHT_REQUIRED');
  let input = '';
  for await (const part of process.stdin) { input += part.toString(); requireValue(Buffer.byteLength(input) <= 8192, 'ACL_PREFLIGHT_INVALID'); }
  const preflight = JSON.parse(input);
  const keyPath = path.resolve(args[1]);
  requireValue(preflight.schemaVersion === 1 && canonical(preflight.keyFile) === canonical(keyPath) && preflight.acl?.checked === true &&
    preflight.acl.scope === 'directory-and-file' && preflight.acl.linksRejected === true && typeof preflight.acl.inherited === 'boolean' &&
    ['current-user', 'SYSTEM', 'Administrators'].includes(preflight.acl.owner) && Array.isArray(preflight.acl.allowPrincipals) &&
    preflight.acl.allowPrincipals.every((principal: string) => ['current-user', 'SYSTEM', 'Administrators'].includes(principal)), 'ACL_PREFLIGHT_INVALID');
  let receiptPath: string | undefined;
  if (args[3]) {
    receiptPath = path.resolve(args[3]);
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
    receipt = await verifyDevelopmentApp(() => createAppJwt(key!), githubRequest);
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

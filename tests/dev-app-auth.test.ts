import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { createAppJwt, DEV_APP, verifyDevelopmentApp, type AuthRequest } from '../Tools/dev-app-auth.ts';

const time = Date.parse('2026-10-21T17:00:00Z');
const jwtSecret = 'fixture-jwt-never-write', tokenSecret = 'fixture-installation-token-never-write';
const permissions = { contents: 'write', metadata: 'read', pull_requests: 'write', workflows: 'write' };
const owner = { id: 123, login: 'chwan886', type: 'User' };
const repository = { id: 456, full_name: DEV_APP.repository, owner, private: true };
const installation = { id: 789, app_id: DEV_APP.id, app_slug: DEV_APP.slug, account: owner, target_type: 'User',
  repository_selection: 'selected', suspended_at: null, permissions };
type Mutation = (method: string, endpoint: string, result: any) => any;

function fixture(mutate?: Mutation) {
  const calls: { method: string; endpoint: string; credential: string; body?: Record<string, any> }[] = [];
  let revoked = false;
  const request: AuthRequest = async (method, endpoint, credential, body) => {
    calls.push({ method, endpoint, credential, body });
    let result: any;
    if (endpoint === '/app') result = { status: 200, data: { id: DEV_APP.id, client_id: DEV_APP.clientId, slug: DEV_APP.slug, owner, permissions } };
    else if (endpoint === '/app/installations?per_page=100&page=1') result = { status: 200, data: [installation] };
    else if (DEV_APP.installedRepositories.some(repo => endpoint === `/repos/${repo}/installation`)) result = { status: 200, data: installation };
    else if (method === 'POST' && endpoint === '/app/installations/789/access_tokens') result = { status: 201, data: {
      token: tokenSecret, permissions: { contents: 'read', metadata: 'read' }, repository_selection: 'selected', repositories: [repository],
      expires_at: new Date(time + 3_600_000).toISOString() } };
    else if (method === 'DELETE' && endpoint === '/installation/token') { revoked = true; result = { status: 204 }; }
    else if (endpoint === '/installation/repositories?per_page=100&page=1') result = revoked ? { status: 401 } : { status: 200, data: { total_count: 1, repositories: [repository] } };
    else if (endpoint === `/repos/${DEV_APP.repository}/git/ref/heads/main`) result = { status: 200, data: { ref: 'refs/heads/main', object: { type: 'commit', sha: 'a'.repeat(40) } } };
    else throw Error(`Unexpected fixture request: ${method} ${endpoint}`);
    if (endpoint.startsWith('/app') || endpoint.endsWith('/installation')) assert.equal(credential, jwtSecret);
    else assert.equal(credential, tokenSecret);
    return mutate ? mutate(method, endpoint, structuredClone(result)) : result;
  };
  const run = async () => {
    const receipt = await verifyDevelopmentApp(() => jwtSecret, request, () => time, async () => {});
    const serialized = JSON.stringify(receipt);
    assert.ok(!serialized.includes(jwtSecret) && !serialized.includes(tokenSecret), 'No credential may enter any receipt');
    return receipt;
  };
  return { calls, run };
}

test('development App JWT uses RS256, the exact Client ID, clock skew and a short lifetime', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwt = createAppJwt(privateKey, time), parts = jwt.split('.');
  assert.equal(parts.length, 3);
  assert.deepEqual(JSON.parse(Buffer.from(parts[0], 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(parts[1], 'base64url').toString()), { iat: time / 1000 - 60, exp: time / 1000 + 540, iss: DEV_APP.clientId });
  assert.ok(verify('RSA-SHA256', Buffer.from(parts.slice(0, 2).join('.')), createPublicKey(privateKey), Buffer.from(parts[2], 'base64url')));
  assert.throws(() => createAppJwt(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey, time), /RSA_PRIVATE_KEY_REQUIRED/);
  assert.throws(() => createAppJwt(generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey, time), /RSA_PRIVATE_KEY_REQUIRED/);
});

test('authentication verifies the real App contract, requests one read-only repository, then revokes and proves 401', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.token.visibleRepositories, [DEV_APP.repository]);
  assert.equal(result.token.revocation, 'confirmed-204');
  assert.equal(result.token.revokedTokenProbe, 'rejected-401');
  assert.match(result.installation.exactRepositorySet, /not-proven/);
  assert.deepEqual(f.calls.filter(call => call.method === 'POST').map(call => call.body), [{ repositories: ['Architecture-Explorer'], permissions: { contents: 'read' } }]);
  assert.deepEqual(f.calls.filter(call => call.method !== 'GET').map(call => [call.method, call.endpoint]),
    [['POST', '/app/installations/789/access_tokens'], ['DELETE', '/installation/token']]);
  assert.ok(!f.calls.some(call => /\/user|\/pulls|\/dispatches/.test(call.endpoint)));
});

test('wrong App identity or excessive App/installation permissions prevents token issuance', async () => {
  for (const mutate of [
    (data: any) => { data.id++; }, (data: any) => { data.client_id = 'another-client'; }, (data: any) => { data.slug = 'another-app'; },
    (data: any) => { data.owner.login = 'other'; }, (data: any) => { data.permissions.administration = 'read'; },
  ]) {
    const f = fixture((_method, endpoint, result) => { if (endpoint === '/app') mutate(result.data); return result; });
    assert.equal((await f.run()).outcome, 'failed');
    assert.ok(!f.calls.some(call => call.method === 'POST'));
  }
  const f = fixture((_method, endpoint, result) => { if (endpoint.startsWith('/app/installations?')) result.data[0].permissions.actions = 'write'; return result; });
  assert.equal((await f.run()).failureCode, 'INSTALLATION_PERMISSION_BOUNDARY_MISMATCH');
  assert.ok(!f.calls.some(call => call.method === 'POST'));
});

test('all-repository, wrong-owner, suspended, multiple or mismatched installation membership fails before minting', async () => {
  for (const change of [
    (data: any[]) => { data[0].repository_selection = 'all'; }, (data: any[]) => { data[0].account.id++; },
    (data: any[]) => { data[0].suspended_at = new Date(time).toISOString(); }, (data: any[]) => { data.push({ ...data[0], id: 999 }); },
  ]) {
    const f = fixture((_method, endpoint, result) => { if (endpoint.startsWith('/app/installations?')) change(result.data); return result; });
    assert.equal((await f.run()).outcome, 'failed'); assert.ok(!f.calls.some(call => call.method === 'POST'));
  }
  const f = fixture((_method, endpoint, result) => { if (endpoint.endsWith('/GameDemo02/installation')) result.data.id++; return result; });
  assert.equal((await f.run()).failureCode, 'TARGET_INSTALLATION_MISMATCH');
  assert.ok(!f.calls.some(call => call.method === 'POST'));
});

test('minted token is revoked even when its permissions or repository scope are excessive', async () => {
  for (const change of [
    (data: any) => { data.permissions.contents = 'write'; }, (data: any) => { data.permissions.pull_requests = 'read'; },
    (data: any) => { data.permissions.metadata = 'write'; }, (data: any) => { data.repositories.push({ ...repository, id: 333, full_name: 'chwan886/GameDemo02' }); },
    (data: any) => { data.repository_selection = 'all'; }, (data: any) => { data.repositories[0].owner.login = 'other'; },
  ]) {
    const f = fixture((method, endpoint, result) => { if (method === 'POST') change(result.data); return result; });
    const result = await f.run(); assert.equal(result.outcome, 'failed');
    assert.equal(result.token.revocation, 'confirmed-204'); assert.equal(result.token.revokedTokenProbe, 'rejected-401');
    assert.ok(!f.calls.some(call => call.endpoint.endsWith('/git/ref/heads/main')));
  }
});

test('metadata may be omitted in a narrowed token response; token format is opaque', async () => {
  const f = fixture((method, _endpoint, result) => { if (method === 'POST') delete result.data.permissions.metadata; return result; });
  assert.equal((await f.run()).outcome, 'passed');
});

test('expired, missing or excessively long token expiry is rejected and the token is still revoked', async () => {
  for (const expiry of [undefined, 'invalid', new Date(time - 1).toISOString(), new Date(time + 7_200_000).toISOString()]) {
    const f = fixture((method, _endpoint, result) => { if (method === 'POST') result.data.expires_at = expiry; return result; });
    const result = await f.run(); assert.equal(result.failureCode, 'TOKEN_EXPIRY_INVALID'); assert.equal(result.token.revocation, 'confirmed-204');
  }
});

test('actual token repository list must be exactly the declared tool repository', async () => {
  for (const change of [
    (data: any) => { data.total_count = 2; }, (data: any) => { data.repositories[0].full_name = 'chwan886/GameDemo02'; },
    (data: any) => { data.repositories[0].id++; },
  ]) {
    let listCount = 0;
    const f = fixture((_method, endpoint, result) => { if (endpoint.startsWith('/installation/repositories') && ++listCount === 1) change(result.data); return result; });
    const result = await f.run(); assert.equal(result.failureCode, 'TOKEN_VISIBLE_SCOPE_MISMATCH'); assert.equal(result.token.revocation, 'confirmed-204');
  }
});

test('Contents probe failure, malformed ref or network errors cannot pass or expose raw errors', async () => {
  for (const change of [
    (result: any) => { result.status = 403; }, (result: any) => { result.data.object.sha = ''; },
    () => { throw Error(`Authorization: ${tokenSecret} PEM PRIVATE KEY ${jwtSecret}`); },
  ]) {
    const f = fixture((_method, endpoint, result) => { if (endpoint.endsWith('/git/ref/heads/main')) change(result); return result; });
    const result = await f.run(); assert.equal(result.outcome, 'failed'); assert.equal(result.token.revocation, 'confirmed-204');
  }
});

test('uncertain issuance is explicit when a POST response is lost; no broader or Owner retry occurs', async () => {
  const f = fixture((method, _endpoint, result) => {
    if (method === 'POST') throw Error(tokenSecret);
    return result;
  });
  const result = await f.run();
  assert.equal(result.outcome, 'failed'); assert.equal(result.token.issued, 'unconfirmed');
  assert.equal(result.token.revocation, 'unconfirmed-no-token');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('an unknown issuance error cannot prove no token was issued', async () => {
  for (const status of [408, 429, 500]) {
    const f = fixture((method, _endpoint, result) => method === 'POST' ? { status } : result);
    const result = await f.run();
    assert.equal(result.outcome, 'failed'); assert.equal(result.token.issued, 'unconfirmed');
    assert.equal(result.token.revocation, 'unconfirmed-no-token');
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  }
  const f = fixture((method, _endpoint, result) => method === 'POST' ? { status: 403 } : result);
  assert.equal((await f.run()).token.issued, false);
});

test('revocation must return 204 and the original token must then return 401', async () => {
  for (const mode of ['delete-fails', 'delete-throws', 'probe-not-401', 'probe-throws']) {
    let deleted = false;
    const f = fixture((method, endpoint, result) => {
      if (method === 'DELETE') { deleted = true; if (mode === 'delete-fails') result.status = 403; if (mode === 'delete-throws') throw Error(tokenSecret); }
      if (deleted && endpoint.startsWith('/installation/repositories')) { if (mode === 'probe-not-401') result.status = 403; if (mode === 'probe-throws') throw Error(tokenSecret); }
      return result;
    });
    const result = await f.run(); assert.equal(result.outcome, 'failed'); assert.equal(result.failureCode, 'TOKEN_REVOCATION_NOT_CONFIRMED');
    assert.equal(f.calls.at(-1)?.method, 'GET');
    assert.equal(f.calls.at(-1)?.endpoint, '/installation/repositories?per_page=100&page=1');
  }
});

test('bounded read-only revocation probes can observe 200 then 401 without retrying token creation or deletion', async () => {
  let deleted = false, probes = 0;
  const f = fixture((method, endpoint, result) => {
    if (method === 'DELETE') deleted = true;
    if (deleted && endpoint.startsWith('/installation/repositories') && ++probes === 1) result.status = 200;
    return result;
  });
  const result = await f.run();
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.token.revokedTokenProbeStatuses, [200, 401]);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1);
});

test('signing failure is sanitized and cannot consult Owner login or start HTTP requests', async () => {
  let calls = 0;
  const result = await verifyDevelopmentApp(() => { throw Error(`PEM PRIVATE KEY ${jwtSecret}`); }, async () => { calls++; throw Error('unexpected'); }, () => time);
  assert.equal(calls, 0); assert.equal(result.outcome, 'failed'); assert.equal(result.token.revocation, 'not-issued');
  assert.ok(!JSON.stringify(result).includes(jwtSecret));
});

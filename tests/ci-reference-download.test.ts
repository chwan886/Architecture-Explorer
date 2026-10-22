import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { downloadUnityReferenceAsset, isApprovedUnityAssetRedirect, parseUnityAssetInput, transferUnityReferenceAsset,
  UnityAssetDownloadError, type UnityAssetInput } from '../Tools/ci-reference-download.ts';

const repository = 'chwan886/Architecture-Explorer', repoUrl = `https://api.github.com/repos/${repository}`;
const token = 'fixture-read-only-token', bytes = Buffer.from('synthetic reference ZIP bytes; target code is never executed');
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const input: UnityAssetInput = { assetId: '12345', sha256: hash(bytes) };
const assetUrl = `${repoUrl}/releases/assets/${input.assetId}`;
const signedLocation = 'https://release-assets.githubusercontent.com/github-production-release-asset/fixture?sig=private-query-canary';
const validEnv = (): NodeJS.ProcessEnv => ({ GITHUB_ACTIONS: 'true', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: repository,
  GITHUB_REF: 'refs/heads/main', GITHUB_REF_PROTECTED: 'true', UNITY_REFERENCES_ASSET_ID: input.assetId, UNITY_REFERENCES_SHA256: input.sha256,
  UNITY_REFERENCES_URL: 'https://legacy-invalid.example/never-used?private=url-canary', GH_TOKEN: 'owner-must-never-be-read' });
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const repo = () => ({ full_name: repository, private: true, visibility: 'private' });
const metadata = () => ({ id: Number(input.assetId), url: assetUrl, state: 'uploaded', size: bytes.byteLength, digest: `sha256:${input.sha256}` });
const binary = (data: Uint8Array = bytes, contentLength?: string) => new Response(Uint8Array.from(data), {
  status: 200, headers: contentLength === undefined ? {} : { 'content-length': contentLength },
});
function mock(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const send: typeof fetch = async (resource, init) => {
    calls.push({ url: String(resource), init }); const next = responses.shift();
    assert.ok(next, 'Unexpected network request or fallback'); if (next instanceof Error) throw next; return next;
  };
  return { calls, send };
}
async function transfer(responses: Array<Response | Error>, selected: UnityAssetInput = input) {
  const network = mock(responses), output: Uint8Array[] = [];
  const receipt = await transferUnityReferenceAsset(selected, token, async chunk => { output.push(Uint8Array.from(chunk)); }, network.send);
  return { ...network, receipt, output: Buffer.concat(output) };
}
function rejectsCode(error: unknown, code: string): boolean {
  assert.ok(error instanceof UnityAssetDownloadError); assert.equal(error.message, code);
  assert.ok(!String(error).includes(token) && !String(error).includes('private-query-canary') && !String(error).includes('url-canary'));
  return true;
}

test('fixed input selection ignores legacy URL and owner credential environment values', () => {
  const parsed = parseUnityAssetInput(validEnv()); assert.deepEqual(parsed, input); assert.ok(Object.isFrozen(parsed));
});
for (const [field, value] of [['GITHUB_REPOSITORY', 'someone/Architecture-Explorer'], ['GITHUB_SERVER_URL', 'https://github.example'],
  ['GITHUB_REF', 'refs/heads/codex/test'], ['GITHUB_REF_PROTECTED', 'false'], ['GITHUB_ACTIONS', 'false'],
  ['UNITY_REFERENCES_ASSET_ID', '0'], ['UNITY_REFERENCES_ASSET_ID', '12345\n'], ['UNITY_REFERENCES_ASSET_ID', '0012345'],
  ['UNITY_REFERENCES_ASSET_ID', 'https://github.com/asset'], ['UNITY_REFERENCES_ASSET_ID', '9007199254740993'],
  ['UNITY_REFERENCES_SHA256', input.sha256 + '\n'], ['UNITY_REFERENCES_SHA256', 'A'.repeat(64)]]) {
  test(`rejects exact input ${field}=${JSON.stringify(value)}`, () => {
    const env = validEnv(); env[field] = value; assert.throws(() => parseUnityAssetInput(env), error => rejectsCode(error, 'UNITY_ASSET_INPUT_REJECTED'));
  });
}

test('direct 200 downloads only fixed own-repository API paths and verifies exact size/hash', async () => {
  const original = Buffer.from(bytes), result = await transfer([json(repo()), json(metadata()), binary()]);
  assert.deepEqual(result.output, bytes); assert.deepEqual(bytes, original);
  assert.deepEqual(result.calls.map(call => call.url), [repoUrl, assetUrl, assetUrl]);
  assert.equal(result.receipt.redirected, false); assert.equal(result.receipt.sha256, input.sha256);
  for (const call of result.calls) { assert.equal(call.init?.method, 'GET'); assert.equal(call.init?.redirect, 'manual');
    assert.equal(new Headers(call.init?.headers).get('authorization'), `Bearer ${token}`); }
  assert.equal(new Headers(result.calls[2].init?.headers).get('accept'), 'application/octet-stream');
});
test('one approved 302 uses a fresh request without Authorization or Cookie, never records its signed query', async () => {
  const result = await transfer([json(repo()), json(metadata()), new Response(null, { status: 302, headers: { location: signedLocation, 'set-cookie': 'secret-cookie' } }), binary()]);
  assert.equal(result.calls.length, 4); assert.equal(result.receipt.redirected, true); assert.deepEqual(result.output, bytes);
  const headers = new Headers(result.calls[3].init?.headers);
  assert.equal(headers.get('authorization'), null); assert.equal(headers.get('cookie'), null);
  assert.equal(result.calls[3].init?.credentials, 'omit'); assert.equal(result.calls[3].init?.redirect, 'manual');
  assert.ok(!JSON.stringify(result.receipt).includes('private-query-canary'));
});
test('explicit default HTTPS port is allowed but a different port is not', () => {
  assert.ok(isApprovedUnityAssetRedirect('https://release-assets.githubusercontent.com:443/a?sig=x'));
  assert.equal(isApprovedUnityAssetRedirect('https://release-assets.githubusercontent.com:444/a'), false);
});
for (const url of ['http://release-assets.githubusercontent.com/a', 'https://release-assets.githubusercontent.com.evil.example/a',
  'https://objects.githubusercontent.com/a', 'https://github.com/a', 'https://user:secret@release-assets.githubusercontent.com/a',
  'https://@release-assets.githubusercontent.com/a', 'https://release-assets.githubusercontent.com/a#fragment',
  'https://release-assets.githubusercontent.com/a#', 'https://release-assets.githubusercontent.com./a', 'https://release-assets.githubusercontent.com/a\n',
  '/relative', 'https://release-assets.githubusercontent.com\\@evil.example/a']) {
  test(`rejects redirect ${JSON.stringify(url)}`, async () => {
    assert.equal(isApprovedUnityAssetRedirect(url), false);
    const redirect = new Response(null, { status: 302 });
    // Observe raw adapter header data; native Headers would trim terminal whitespace before validation.
    Object.defineProperty(redirect, 'headers', { value: { get: (name: string) => name === 'location' ? url : null } });
    const network = mock([json(repo()), json(metadata()), redirect]);
    await assert.rejects(transferUnityReferenceAsset(input, token, async () => {}, network.send), error => rejectsCode(error, 'UNITY_ASSET_REDIRECT_REJECTED'));
    assert.equal(network.calls.length, 3, 'No second request to an unapproved destination');
  });
}
test('a third hop is rejected and never requested', async () => {
  const network = mock([json(repo()), json(metadata()), new Response(null, { status: 302, headers: { location: signedLocation } }),
    new Response(null, { status: 302, headers: { location: 'https://evil.example/third' } })]);
  await assert.rejects(transferUnityReferenceAsset(input, token, async () => {}, network.send), error => rejectsCode(error, 'UNITY_ASSET_DOWNLOAD_STATUS_REJECTED'));
  assert.equal(network.calls.length, 4);
});
test('expired or unauthorized signed URL stays failed without trying the legacy URL', async () => {
  const network = mock([json(repo()), json(metadata()), new Response(null, { status: 302, headers: { location: signedLocation } }), new Response('expired private-query-canary', { status: 403 })]);
  await assert.rejects(transferUnityReferenceAsset(input, token, async () => {}, network.send), error => rejectsCode(error, 'UNITY_ASSET_DOWNLOAD_STATUS_REJECTED'));
  assert.ok(network.calls.every(call => !call.url.includes('legacy-invalid.example')));
});
for (const [name, modify] of [
  ['wrong ID', (value: any) => { value.id++; }], ['other repository asset URL', (value: any) => { value.url = 'https://api.github.com/repos/someone/Other/releases/assets/12345'; }],
  ['starter state', (value: any) => { value.state = 'starter'; }], ['zero size', (value: any) => { value.size = 0; }],
  ['oversized metadata', (value: any) => { value.size = 256 * 1024 * 1024 + 1; }], ['wrong digest', (value: any) => { value.digest = 'sha256:' + 'f'.repeat(64); }],
  ['missing digest', (value: any) => { delete value.digest; }],
] as const) {
  test(`metadata ${name} is rejected before raw download`, async () => {
    const value = metadata(); modify(value); const network = mock([json(repo()), json(value)]);
    await assert.rejects(transferUnityReferenceAsset(input, token, async () => {}, network.send), error => rejectsCode(error, 'UNITY_ASSET_METADATA_REJECTED'));
    assert.equal(network.calls.length, 2);
  });
}
test('private repository boundary is checked without expanding token permissions', async () => {
  const network = mock([json({ ...repo(), private: false, visibility: 'public' })]);
  await assert.rejects(transferUnityReferenceAsset(input, token, async () => {}, network.send), error => rejectsCode(error, 'UNITY_ASSET_PRIVATE_REPOSITORY_REQUIRED'));
  assert.equal(network.calls.length, 1);
});
for (const status of [301, 307, 308, 401, 404]) test(`unexpected raw HTTP ${status} is red`, async () => {
  await assert.rejects(transfer([json(repo()), json(metadata()), new Response(null, { status })]), error => rejectsCode(error, 'UNITY_ASSET_DOWNLOAD_STATUS_REJECTED'));
});
test('wrong actual bytes cannot pass a correct metadata digest', async () => {
  await assert.rejects(transfer([json(repo()), json(metadata()), binary(Buffer.alloc(bytes.length, 0))]), error => rejectsCode(error, 'UNITY_ASSET_HASH_MISMATCH'));
});
test('a truncated body cannot pass', async () => {
  await assert.rejects(transfer([json(repo()), json(metadata()), binary(bytes.subarray(1))]), error => rejectsCode(error, 'UNITY_ASSET_SIZE_MISMATCH'));
});
test('an oversized chunk is stopped before the sink receives it', async () => {
  let sinkCalls = 0;
  const network = mock([json(repo()), json(metadata()), binary(Buffer.concat([bytes, Buffer.from('x')]))]);
  await assert.rejects(transferUnityReferenceAsset(input, token, async () => { sinkCalls++; }, network.send), error => rejectsCode(error, 'UNITY_ASSET_BYTE_LIMIT'));
  assert.equal(sinkCalls, 0);
});
test('declared oversized body is rejected before streaming', async () => {
  await assert.rejects(transfer([json(repo()), json(metadata()), binary(bytes, String(256 * 1024 * 1024 + 1))]), error => rejectsCode(error, 'UNITY_ASSET_SIZE_MISMATCH'));
});
test('raw network errors and write errors are replaced with fixed diagnostics', async () => {
  const network = mock([json(repo()), json(metadata()), new Error(`raw ${token} ${signedLocation}`)]);
  await assert.rejects(transferUnityReferenceAsset(input, token, async () => {}, network.send), error => rejectsCode(error, 'UNITY_ASSET_NETWORK_FAILED'));
  const valid = mock([json(repo()), json(metadata()), binary()]);
  await assert.rejects(transferUnityReferenceAsset(input, token, async () => { throw Error(`raw ${token}`); }, valid.send), error => rejectsCode(error, 'UNITY_ASSET_OUTPUT_REJECTED'));
});

const stagingRoot = fileURLToPath(new URL('..', import.meta.url));
async function withOutput(action: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(stagingRoot, '.test-output-'));
  try { await action(root); }
  finally { assert.equal(path.dirname(root), path.resolve(stagingRoot)); assert.ok(path.basename(root).startsWith('.test-output-')); await rm(root, { recursive: true }); }
}
test('output is a fresh exact tool-side metadata.zip and cannot overwrite an existing file', async () => withOutput(async root => {
  await mkdir(path.join(root, '.ci-references'));
  const network = mock([json(repo()), json(metadata()), binary()]);
  const receipt = await downloadUnityReferenceAsset(input, token, root, network.send);
  assert.equal(receipt.outcome, 'verified'); assert.deepEqual(await readFile(path.join(root, '.ci-references/metadata.zip')), bytes);
  const never = mock([]); await assert.rejects(downloadUnityReferenceAsset(input, token, root, never.send), error => rejectsCode(error, 'UNITY_ASSET_OUTPUT_REJECTED'));
  assert.equal(never.calls.length, 0); assert.deepEqual(await readFile(path.join(root, '.ci-references/metadata.zip')), bytes);
}));
test('output links cannot redirect writes outside the chosen tool-side directory', async () => withOutput(async root => {
  const elsewhere = path.join(root, 'elsewhere'); await mkdir(elsewhere);
  const link = path.join(root, '.ci-references'); await symlink(elsewhere, link, process.platform === 'win32' ? 'junction' : 'dir');
  try { const network = mock([]); await assert.rejects(downloadUnityReferenceAsset(input, token, root, network.send), error => rejectsCode(error, 'UNITY_ASSET_OUTPUT_REJECTED'));
    assert.equal(network.calls.length, 0); await assert.rejects(access(path.join(elsewhere, 'metadata.zip')), { code: 'ENOENT' }); }
  finally { await unlink(link); }
}));
test('CLI rejects malformed selection with only a fixed code, before network or filesystem work', async () => {
  const env = validEnv(); env.UNITY_REFERENCES_ASSET_ID = 'private-invalid-id'; env.UNITY_REFERENCES_READ_TOKEN = token;
  let caught: any;
  try { await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../Tools/ci-reference-download.ts', import.meta.url))], { env: { ...process.env, ...env }, windowsHide: true, timeout: 10000 }); }
  catch (error) { caught = error; }
  assert.ok(caught); assert.equal(caught.stdout, ''); assert.equal(caught.stderr.trim(), 'UNITY_ASSET_INPUT_REJECTED');
  assert.ok(!caught.stderr.includes(token) && !caught.stderr.includes('url-canary'));
});

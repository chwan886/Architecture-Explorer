import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectUnityDependencyRelease, unityDependencyAssetName, unityDependencyRepository, unityDependencyTag } from '../Tools/dev-app-dependency.ts';

const token = 'fixture-secret-iat', digest = `sha256:${'a'.repeat(64)}`;
const endpoint = `/repos/${unityDependencyRepository}/releases/tags/${unityDependencyTag}`;
function release(): any {
  return { id: 31, tag_name: unityDependencyTag, name: 'Private Unity metadata dependency', draft: false,
    published_at: '2026-10-21T20:10:11Z', html_url: `https://github.com/${unityDependencyRepository}/releases/tag/${unityDependencyTag}`,
    url: `https://api.github.com/repos/${unityDependencyRepository}/releases/31`,
    body: token, upload_url: `https://api.github.com/private?sig=${token}`, assets: [{ id: 41, name: unityDependencyAssetName, size: 3797931,
      url: `https://api.github.com/repos/${unityDependencyRepository}/releases/assets/41`, state: 'uploaded', digest,
      browser_download_url: `https://release-assets.githubusercontent.com/private?sig=${token}`, uploader: { login: token } }] };
}
async function inspect(data: unknown = release(), status = 200) {
  let calls = 0;
  const report = await inspectUnityDependencyRelease(token, async (method, path, credential) => {
    calls++; assert.equal(method, 'GET'); assert.equal(path, endpoint); assert.equal(credential, token);
    return { status, data };
  });
  assert.equal(calls, 1); assert.ok(!JSON.stringify(report).includes(token));
  assert.ok(!JSON.stringify(report).includes('download')); return report;
}

test('fixed published private dependency metadata is safely projected, without claiming downloaded bytes', async () => {
  const result = await inspect();
  assert.equal(result.status, 'found'); assert.equal(result.metadataOnly, true); assert.equal(result.artifactBytesVerified, false);
  if (result.status !== 'found') throw Error('fixture');
  assert.deepEqual(result.release, { id: 31, name: 'Private Unity metadata dependency', draft: false, published: true,
    publishedAt: '2026-10-21T20:10:11Z', htmlUrl: `https://github.com/${unityDependencyRepository}/releases/tag/${unityDependencyTag}` });
  assert.deepEqual(result.expectedAsset, { id: 41, name: unityDependencyAssetName, sizeBytes: 3797931, state: 'uploaded', digest });
  assert.deepEqual(result.assets, [result.expectedAsset]);
});

test('draft and missing digest are honest metadata observations, not ready-to-download proof', async () => {
  const value = release(); value.draft = true; value.published_at = null; value.name = null; value.assets[0].digest = null;
  const result = await inspect(value); assert.equal(result.status, 'found');
  if (result.status !== 'found') throw Error('fixture');
  assert.equal(result.release.published, false); assert.equal(result.release.draft, true);
  assert.equal(result.release.publishedAt, null); assert.equal(result.release.name, null); assert.equal(result.expectedAsset?.digest, null);
});

test('published release with no expected ZIP does not fabricate an asset ID', async () => {
  const value = release(); value.assets = []; const result = await inspect(value);
  assert.equal(result.status, 'found'); if (result.status === 'found') assert.equal(result.expectedAsset, null);
});

test('only 404 means not-found; authorization, throttling and server failures remain unreadable', async () => {
  assert.equal((await inspect({ raw: token }, 404)).status, 'not-found');
  for (const status of [201, 301, 302, 401, 403, 429, 500, 503]) {
    const result = await inspect({ message: token }, status); assert.equal(result.status, 'unreadable');
    assert.equal(result.failureCode, 'DEPENDENCY_RELEASE_HTTP_FAILED'); assert.equal(result.httpStatus, status);
  }
});

test('network exceptions and malformed transport result never echo raw errors', async () => {
  const result = await inspectUnityDependencyRelease(token, async () => { throw Error(`signed-url?${token}`); });
  assert.equal(result.status, 'unreadable'); assert.equal(result.failureCode, 'DEPENDENCY_RELEASE_REQUEST_FAILED');
  assert.ok(!JSON.stringify(result).includes(token));
  for (const response of [null, undefined, {}, { status: token }, { status: NaN }]) {
    const report = await inspectUnityDependencyRelease(token, async () => response as any);
    assert.equal(report.status, 'unreadable'); assert.ok(!JSON.stringify(report).includes(token));
  }
});

const malformed: [string, (value: any) => void][] = [
  ['foreign tag', value => { value.tag_name = 'other'; }],
  ['foreign repository HTML URL', value => { value.html_url = 'https://github.com/other/repository/releases/tag/' + unityDependencyTag; }],
  ['signed HTML URL', value => { value.html_url += '?signed=' + token; }],
  ['unsafe HTML URL', value => { value.html_url = 'javascript:alert(1)'; }],
  ['foreign API release URL', value => { value.url = 'https://api.github.com/repos/other/repository/releases/31'; }],
  ['zero release ID', value => { value.id = 0; }],
  ['unsafe release ID', value => { value.id = Number.MAX_SAFE_INTEGER + 1; }],
  ['string release ID', value => { value.id = '31'; }],
  ['secret release name', value => { value.name = token; }],
  ['control release name', value => { value.name = 'a\nb'; }],
  ['nonboolean draft', value => { value.draft = 'false'; }],
  ['draft with published timestamp', value => { value.draft = true; }],
  ['published without timestamp', value => { value.published_at = null; }],
  ['invalid calendar date', value => { value.published_at = '2026-02-31T20:10:11Z'; }],
  ['timestamp suffix', value => { value.published_at += '\n'; }],
  ['nonarray assets', value => { value.assets = {}; }],
  ['too many assets', value => { value.assets = Array(101).fill(value.assets[0]); }],
  ['null asset', value => { value.assets = [null]; }],
  ['negative asset ID', value => { value.assets[0].id = -1; }],
  ['unsafe asset ID', value => { value.assets[0].id = Number.MAX_SAFE_INTEGER + 1; }],
  ['string asset ID', value => { value.assets[0].id = '41'; }],
  ['foreign asset API URL', value => { value.assets[0].url = 'https://api.github.com/repos/other/repository/releases/assets/41'; }],
  ['secret asset name', value => { value.assets[0].name = token; }],
  ['control asset name', value => { value.assets[0].name += '\n'; }],
  ['asset slash', value => { value.assets[0].name = 'directory/file.zip'; }],
  ['asset backslash', value => { value.assets[0].name = 'directory\\file.zip'; }],
  ['asset traversal', value => { value.assets[0].name = '../file.zip'; }],
  ['negative size', value => { value.assets[0].size = -1; }],
  ['unsafe size', value => { value.assets[0].size = Number.MAX_SAFE_INTEGER + 1; }],
  ['string size', value => { value.assets[0].size = '3797931'; }],
  ['fractional size', value => { value.assets[0].size = 1.5; }],
  ['unknown state', value => { value.assets[0].state = token; }],
  ['uppercase digest', value => { value.assets[0].digest = 'sha256:' + 'A'.repeat(64); }],
  ['short digest', value => { value.assets[0].digest = 'sha256:abc'; }],
  ['secret digest', value => { value.assets[0].digest = token; }],
  ['missing digest', value => { delete value.assets[0].digest; }],
  ['digest suffix', value => { value.assets[0].digest += '\n'; }],
  ['duplicate asset ID', value => { value.assets.push({ ...value.assets[0], name: 'other.zip' }); }],
  ['duplicate asset name', value => { value.assets.push({ ...value.assets[0], id: 42, url: value.assets[0].url.replace('/41', '/42') }); }],
  ['case-insensitive duplicate name', value => { value.assets.push({ ...value.assets[0], id: 42, name: value.assets[0].name.toUpperCase(), url: value.assets[0].url.replace('/41', '/42') }); }],
];
for (const [name, mutate] of malformed) test(`invalid metadata is unreadable: ${name}`, async () => {
  const value = release(); mutate(value); const result = await inspect(value);
  assert.equal(result.status, 'unreadable'); assert.equal(result.failureCode, 'DEPENDENCY_RELEASE_METADATA_INVALID');
});
for (const value of [undefined, null, [], false, 'secret']) test(`invalid root ${String(value)} is unreadable`, async () => {
  const result = await inspect(value === undefined ? null : value);
  assert.equal(result.status, 'unreadable');
});

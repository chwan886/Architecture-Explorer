import { releasePublisherFixture as server } from './release-publisher-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReleaseEvidence } from '../Tools/ci-release-evidence.ts';
import { publishReleaseDraft, type ReleasePublishRequest } from '../Tools/ci-release-publish.ts';
import { releaseEvidenceFixture, fixtureArchiveBytes } from './release-evidence-fixture.ts';

const repository = 'chwan886/Architecture-Explorer', api = `https://api.github.com/repos/${repository}`;
const publisherAt = (attempt: string) => ({ runId: '9001', runAttempt: attempt, runUrl: `https://github.com/${repository}/actions/runs/9001/attempts/${attempt}` });
const publisher = publisherAt('2');
function validated() {
  const plan = validateReleaseEvidence(releaseEvidenceFixture());
  const bytes = new Map(plan.assets.map(asset => [asset.name, fixtureArchiveBytes[asset.kind]]));
  return { plan, bytes };
}

test('first successful production evidence creates one static private Tool draft and verifies its exact three assets without updating the release', async () => {
  const { plan, bytes } = validated(), fixture = server(plan);
  const receipt = await publishReleaseDraft(plan, bytes, fixture.request, publisher);
  assert.equal(receipt.outcome, 'passed', JSON.stringify(receipt)); assert.equal(receipt.complete, true);
  assert.equal(receipt.release?.id, 100); assert.equal(receipt.release?.draft, true); assert.equal(receipt.release?.publishedAt, null);
  assert.equal(receipt.release?.tagName, plan.tagName);
  assert.equal(receipt.releaseCreation, 'confirmed');
  assert.equal(receipt.assets.length, 3); assert.deepEqual(receipt.assets.map(asset => asset.action), ['uploaded', 'uploaded', 'uploaded']);
  assert.equal(fixture.writes().filter(call => call.url === `${api}/releases`).length, 1);
  assert.ok(fixture.writes().every(call => call.method === 'POST'));
  assert.equal(fixture.state.release?.body, fixture.writes()[0].json?.body);
  assert.ok(fixture.state.calls.every(call => !/\/git\/refs?$|\/pulls\//.test(new URL(call.url).pathname) || call.method === 'GET'));
  const manifestUpload = fixture.writes().find(call => call.url.endsWith('name=release-manifest.json'))!;
  assert.equal(Buffer.from(manifestUpload.bytes!).toString('utf8'), plan.releaseManifestJson);
  assert.equal(Object.hasOwn(plan.releaseManifest, 'publisher'), false);
  assert.equal(Object.hasOwn(plan.releaseManifest, 'publisherAttempt'), false);
});

test('same producer retry reuses the exact draft and uploaded bytes while publisher attempt stays outside binding', async () => {
  const { plan, bytes } = validated(), fixture = server(plan);
  fixture.state.failUploadOnce = plan.assets[1].name;
  const failed = await publishReleaseDraft(plan, bytes, fixture.request, publisher);
  assert.equal(failed.outcome, 'failed'); assert.equal(failed.complete, false); assert.equal(failed.failureCode, 'ASSET_UPLOAD_UNCONFIRMED');
  assert.equal(failed.release?.id, 100); assert.equal(failed.assets.length, 1);
  assert.ok(fixture.writes().every(call => call.method === 'POST'));
  const body = fixture.state.release!.body;
  const resumed = await publishReleaseDraft(plan, bytes, fixture.request, publisherAt('3'));
  assert.equal(resumed.outcome, 'passed', JSON.stringify(resumed)); assert.equal(resumed.release?.id, 100); assert.equal(resumed.releaseCreation, 'reused');
  assert.equal(resumed.assets[0].action, 'reused'); assert.equal(resumed.binding?.fingerprint, failed.binding?.fingerprint);
  assert.equal(resumed.binding?.tagName, failed.binding?.tagName); assert.equal(resumed.publisher?.runAttempt, '3');
  const before = fixture.writes().length;
  const repeated = await publishReleaseDraft(plan, bytes, fixture.request, publisherAt('4'));
  assert.equal(repeated.outcome, 'passed'); assert.equal(fixture.state.release!.body, body);
  assert.equal(fixture.writes().length, before); assert.ok(repeated.assets.every(asset => asset.action === 'reused'));
});

test('draft lookup traverses pagination and existing correctly peeled tags never cause Git-ref writes', async () => {
  for (const tag of ['commit', 'annotated'] as const) {
    const { plan, bytes } = validated(), fixture = server(plan);
    fixture.state.tag = tag;
    assert.equal((await publishReleaseDraft(plan, bytes, fixture.request, publisher)).outcome, 'passed');
    fixture.state.listPageFillers = true;
    const writes = fixture.writes().length;
    assert.equal((await publishReleaseDraft(plan, bytes, fixture.request, publisher)).outcome, 'passed');
    assert.equal(fixture.writes().length, writes);
    assert.ok(fixture.state.calls.some(call => call.url === `${api}/releases?per_page=100&page=2`));
    assert.ok(fixture.writes().every(call => !call.url.includes('/git/')));
  }
});

test('published, ambiguous, wrong-author, changed-binding or wrong-target releases fail without any further write', async () => {
  for (const mode of ['published', 'author', 'binding', 'target', 'ambiguous', 'upload-url', 'html-url'] as const) {
    const { plan, bytes } = validated(), fixture = server(plan);
    assert.equal((await publishReleaseDraft(plan, bytes, fixture.request, publisher)).outcome, 'passed');
    if (mode === 'published') { fixture.state.release!.draft = false; fixture.state.release!.published_at = '2026-10-22T01:00:00Z'; }
    if (mode === 'author') fixture.state.release!.author.id++;
    if (mode === 'binding') fixture.state.release!.body += '\nchanged';
    if (mode === 'target') fixture.state.release!.target_commitish = '0'.repeat(40);
    if (mode === 'ambiguous') fixture.state.duplicateRelease = true;
    if (mode === 'upload-url') fixture.state.release!.upload_url = 'https://attacker.invalid/upload';
    if (mode === 'html-url') fixture.state.release!.html_url = `https://github.com/${repository}/releases/%2e%2e%2f%2e%2e%2fGameDemo02`;
    const writes = fixture.writes().length;
    const receipt = await publishReleaseDraft(plan, bytes, fixture.request, publisher);
    assert.equal(receipt.outcome, 'failed', mode); assert.equal(fixture.writes().length, writes, mode);
  }
});

test('non-private/unprotected/main-advanced repositories and conflicting tags stop before draft creation', async () => {
  for (const mode of ['public', 'unprotected', 'advanced', 'tag'] as const) {
    const { plan, bytes } = validated(), fixture = server(plan);
    if (mode === 'public') fixture.state.private = false;
    if (mode === 'unprotected') fixture.state.protected = false;
    if (mode === 'advanced') fixture.state.main = '0'.repeat(40);
    if (mode === 'tag') fixture.state.tag = 'wrong';
    const receipt = await publishReleaseDraft(plan, bytes, fixture.request, publisher);
    assert.equal(receipt.outcome, 'failed', mode); assert.equal(fixture.writes().length, 0, mode);
  }
});

test('starter assets, digest/size conflicts, duplicate names and different uploaders are never deleted or overwritten', async () => {
  for (const mode of ['starter', 'digest', 'size', 'duplicate', 'uploader', 'extra'] as const) {
    const { plan, bytes } = validated(), fixture = server(plan);
    assert.equal((await publishReleaseDraft(plan, bytes, fixture.request, publisher)).outcome, 'passed');
    const asset = fixture.state.assets[0];
    if (mode === 'starter') asset.state = 'starter';
    if (mode === 'digest') asset.digest = 'sha256:' + '0'.repeat(64);
    if (mode === 'size') asset.size++;
    if (mode === 'duplicate') fixture.state.assets.push(structuredClone(asset));
    if (mode === 'uploader') asset.uploader.id++;
    if (mode === 'extra') fixture.state.assets.push({ ...asset, id: 10000, name: 'not-in-plan.zip' });
    const writes = fixture.writes().length;
    assert.equal((await publishReleaseDraft(plan, bytes, fixture.request, publisher)).outcome, 'failed', mode);
    assert.equal(fixture.writes().length, writes, mode);
  }
});

test('bad upload confirmation remains a red real-draft receipt and never edits its stable body', async () => {
  const { plan, bytes } = validated(), fixture = server(plan);
  fixture.state.wrongUploadDigest = true;
  const receipt = await publishReleaseDraft(plan, bytes, fixture.request, publisher);
  assert.equal(receipt.outcome, 'failed'); assert.equal(receipt.release?.id, 100); assert.equal(receipt.release?.draft, true);
  assert.equal(receipt.complete, false);
  assert.equal(receipt.failureCode, 'ASSET_STATE_SIZE_OR_DIGEST_CONFLICT');
  assert.ok(fixture.writes().every(call => call.method === 'POST'));
  assert.equal(fixture.state.release!.body, fixture.writes()[0].json!.body);
});

test('an externally published release observed during the run stops without any release update or further upload', async () => {
  const { plan, bytes } = validated(), fixture = server(plan);
  fixture.state.publishAfterLastUpload = true;
  const receipt = await publishReleaseDraft(plan, bytes, fixture.request, publisher);
  assert.equal(receipt.outcome, 'failed'); assert.equal(receipt.failureCode, 'RELEASE_ALREADY_PUBLISHED_OR_NOT_DRAFT');
  assert.equal(receipt.complete, false); assert.equal(receipt.observedReleaseState?.draft, false);
  assert.equal(receipt.observedReleaseState?.publishedAt, '2026-10-22T01:00:00Z');
  assert.ok(fixture.writes().every(call => call.method === 'POST'));
  assert.equal(fixture.writes().length, 4);
});

test('unconfirmed creation is not retried and raw transport errors never enter receipts', async () => {
  const { plan, bytes } = validated(), fixture = server(plan);
  fixture.state.failCreate = true;
  const receipt = await publishReleaseDraft(plan, bytes, fixture.request, publisher);
  assert.equal(receipt.outcome, 'failed'); assert.equal(receipt.releaseCreation, 'unconfirmed'); assert.equal(receipt.release, undefined);
  assert.equal(fixture.writes().length, 1); assert.ok(!JSON.stringify(receipt).includes('bearer-secret'));
});

test('unbranded plans, mutated bytes and extra asset bytes fail before any request', async () => {
  const { plan, bytes } = validated();
  let requests = 0;
  const never: ReleasePublishRequest = async () => { requests++; throw Error('must not request'); };
  const forged = JSON.parse(JSON.stringify(plan)); Object.freeze(forged);
  assert.equal((await publishReleaseDraft(forged, bytes, never, publisher)).failureCode, 'VALIDATED_FROZEN_PLAN_REQUIRED');
  const changed = new Map(bytes); changed.set(plan.assets[0].name, Buffer.from('wrong bytes'));
  assert.equal((await publishReleaseDraft(plan, changed, never, publisher)).failureCode, 'ASSET_BYTES_PIN_MISMATCH');
  const extra = new Map(bytes); extra.set('extra.zip', Buffer.from('extra'));
  assert.equal((await publishReleaseDraft(plan, extra, never, publisher)).failureCode, 'EXACT_TWO_ZIP_BYTES_REQUIRED');
  assert.equal(requests, 0);
});

test('publisher must use the same producer run, a non-earlier attempt and its exact attempt URL', async () => {
  const { plan, bytes } = validated();
  let requests = 0;
  const never: ReleasePublishRequest = async () => { requests++; throw Error('must not request'); };
  for (const invalid of [
    { ...publisher, runId: '999', runUrl: `https://github.com/${repository}/actions/runs/999/attempts/2` },
    { ...publisher, runAttempt: '0', runUrl: `https://github.com/${repository}/actions/runs/9001/attempts/0` },
    { ...publisher, runUrl: `https://github.com/${repository}/actions/runs/9001` },
    { ...publisher, runUrl: `https://github.com/${repository}/actions/runs/9001/attempts/1` },
    { ...publisher, runAttempt: '2\n' },
  ]) assert.equal((await publishReleaseDraft(plan, bytes, never, invalid)).failureCode, 'PUBLISHER_CONTEXT_INVALID');
  const laterProducer = validateReleaseEvidence(releaseEvidenceFixture('2'));
  const laterBytes = new Map(laterProducer.assets.map(asset => [asset.name, fixtureArchiveBytes[asset.kind]]));
  assert.equal((await publishReleaseDraft(laterProducer, laterBytes, never, publisherAt('1'))).failureCode, 'PUBLISHER_CONTEXT_INVALID');
  assert.equal(requests, 0);
});

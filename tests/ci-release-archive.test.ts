import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, unlink } from 'node:fs/promises';
import { readReleaseArchive, type ReleaseArchiveIdentity } from '../Tools/ci-release-archive.ts';
import { validateReleaseEvidence } from '../Tools/ci-release-evidence.ts';
import { releaseEvidenceFixture } from './release-evidence-fixture.ts';
import { createNativeFixtureZip as createZip, type Item } from './release-native-zip-fixture.ts';

const identity: ReleaseArchiveIdentity = { toolSha: 'a'.repeat(40), gameSha: 'b'.repeat(40), runId: '731', producerAttempt: '2' };
const fixtureRoot = fileURLToPath(new URL('./.zip-fixtures/', import.meta.url));
async function withFixture(action: (directory: string, zip: string) => Promise<void>) {
  await mkdir(fixtureRoot, { recursive: true });
  const directory = await mkdtemp(path.join(fixtureRoot, 'archive-')), zip = path.join(directory, 'artifact.zip');
  try { await action(directory, zip); }
  finally {
    const resolved = await realpath(directory);
    assert.ok(resolved.startsWith((await realpath(fixtureRoot)) + path.sep), 'Fixture deletion must stay inside staging tests');
    assert.ok(!(await lstat(directory)).isSymbolicLink());
    await rm(directory, { recursive: true });
  }
}
const manifest = { name: 'build-manifest.json', json: { toolSha: identity.toolSha, marker: 'native ZIP fixture' } };
const smoke = `package-smoke-tool-${identity.toolSha}-${identity.runId}-${identity.producerAttempt}.json`;
const indexPrefix = `${identity.gameSha}/${identity.runId}-${identity.producerAttempt}/index-evidence/`;
const indexNames = ['manifest', 'index', 'audit', 'read-only-before', 'read-only-after', 'references'].map(name => `${indexPrefix}${name}.json`).concat('authorization/authorization.json');

test('real native tool ZIP returns exact raw pins, safe complete metadata and only selected JSON without extraction', async () => withFixture(async (directory, zip) => {
  assert.equal(process.platform, 'win32');
  const executable = Buffer.from('MZ fixture bytes must never execute');
  await createZip(zip, [manifest, { name: 'bin/' }, { name: 'bin/tool.exe', raw: executable.toString('base64'), attributes: 0x81a40000 },
    { name: 'unselected.json', json: { neverReturned: true } }]);
  const before = await readdir(directory), bytes = await readFile(zip), result = await readReleaseArchive(zip, 'tool', identity);
  assert.equal(result.actualZipSha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(result.actualZipBytes, bytes.length);
  assert.deepEqual(Object.keys(result.documents), ['build-manifest.json']); assert.deepEqual(result.documents['build-manifest.json'], manifest.json);
  assert.equal(result.entries.length, 4); assert.deepEqual(result.entries.find(entry => entry.path === 'bin/'), { path: 'bin/', size: 0, externalAttributes: 0, isDirectory: true });
  assert.equal(result.entries.find(entry => entry.path === 'bin/tool.exe')?.externalAttributes, 0x81a40000);
  assert.deepEqual(await readdir(directory), before); assert.deepEqual(await readFile(zip), bytes);
}));

test('checks and index ZIPs select only identity-bound exact producer JSON names', async () => {
  await withFixture(async (_directory, zip) => {
    await createZip(zip, [{ name: 'delivery-result.json', json: { outcome: 'success' } }, { name: smoke, json: { cleanupVerified: true } },
      { name: 'package-smoke-old.json', json: { outcome: 'passed' } }]);
    const result = await readReleaseArchive(zip, 'checks', identity);
    assert.deepEqual(Object.keys(result.documents).sort(), ['delivery-result.json', smoke].sort());
    await assert.rejects(readReleaseArchive(zip, 'checks', { ...identity, producerAttempt: '3' }), /^Error: RELEASE_ARCHIVE_NATIVE_REJECTED$/);
  });
  await withFixture(async (_directory, zip) => {
    await createZip(zip, indexNames.map((name, ordinal) => ({ name, json: { ordinal } })));
    const result = await readReleaseArchive(zip, 'index', identity);
    assert.deepEqual(Object.keys(result.documents).sort(), [...indexNames].sort());
    assert.deepEqual(result.documents[indexNames[0]], { ordinal: 0 });
  });
});

test('all three real native archive observations satisfy the independent semantic evidence contract', async () => {
  const input = releaseEvidenceFixture(), selectedIdentity = { toolSha: input.context.toolSha, gameSha: input.dispatch.source_sha,
    runId: input.context.runId, producerAttempt: input.producer.attempt };
  for (const kind of ['tool', 'index', 'checks'] as const) await withFixture(async (_directory, zip) => {
    const evidence = input.artifacts[kind];
    await createZip(zip, evidence.entries.map(entry => ({ name: entry.path, attributes: entry.externalAttributes,
      ...(Object.hasOwn(evidence.documents, entry.path) ? { json: evidence.documents[entry.path] } : { raw: Buffer.alloc(entry.size, 32).toString('base64') }) })));
    const observation = await readReleaseArchive(zip, kind, selectedIdentity);
    input.artifacts[kind] = { ...evidence, ...observation, output: { ...evidence.output, digest: observation.actualZipSha256 },
      metadata: { ...(evidence.metadata as any), digest: `sha256:${observation.actualZipSha256}`, size_in_bytes: observation.actualZipBytes } };
  });
  const plan = validateReleaseEvidence(input);
  assert.equal(plan.toolSha, selectedIdentity.toolSha); assert.equal(plan.gameSha, selectedIdentity.gameSha);
  assert.equal(plan.releaseManifest.draft, true); assert.equal(plan.releaseManifest.automaticPublication, false);
});

test('native parser rejects traversal, duplicate, symlink and conflicting entry metadata without extracting', async () => {
  for (const unsafe of [
    { name: '../outside.json' }, { name: '/absolute.json' }, { name: 'C:/drive.json' }, { name: 'folder\\backslash.json' },
    { name: 'folder//empty.json' }, { name: 'folder/trailing./x' }, { name: 'NUL.txt' }, { name: 'case.json' }, { name: 'x'.repeat(2049) },
    { name: 'link', attributes: 0xa1ff0000 }, { name: 'reparse', attributes: 0x400 },
    { name: 'not-directory', attributes: 0x41ed0000 }, { name: 'bad-directory/', raw: Buffer.from('payload').toString('base64') },
  ] as Item[]) await withFixture(async (directory, zip) => {
    const extra = unsafe.name === 'case.json' ? [{ name: 'CASE.JSON', json: {} }] : [];
    await createZip(zip, [manifest, unsafe, ...extra]);
    await assert.rejects(readReleaseArchive(zip, 'tool', identity), /^Error: RELEASE_ARCHIVE_NATIVE_REJECTED$/);
    assert.deepEqual(await readdir(directory), ['artifact.zip']);
  });
  await withFixture(async (directory, zip) => {
    await createZip(zip, [manifest, { name: 'parent', json: {} }, { name: 'parent/child.json', json: {} }]);
    await assert.rejects(readReleaseArchive(zip, 'tool', identity), /^Error: RELEASE_ARCHIVE_NATIVE_REJECTED$/);
    assert.deepEqual(await readdir(directory), ['artifact.zip']);
  });
});

test('selected JSON rejects malformed UTF-8, binary executable payload and malformed JSON with only fixed errors', async () => {
  for (const raw of [Buffer.from([0xff, 0xfe, 0]), Buffer.from('MZtarget'), Buffer.from('{"unfinished":')]) await withFixture(async (directory, zip) => {
    await createZip(zip, [{ name: 'build-manifest.json', raw: raw.toString('base64') }]);
    await assert.rejects(readReleaseArchive(zip, 'tool', identity), (error: unknown) => error instanceof Error && /^RELEASE_ARCHIVE_[A-Z_]+$/.test(error.message));
    assert.deepEqual(await readdir(directory), ['artifact.zip']);
  });
});

test('compressed, expanded and per-document/total selected budgets reject malicious native ZIP metadata before reading payloads', async () => {
  for (const item of [{ name: 'bomb.bin', declaredBytes: 2 * 1024 * 1024 * 1024 + 1 }, { ...manifest, declaredBytes: 32 * 1024 * 1024 + 1 }]) {
    await withFixture(async (_directory, zip) => {
      await createZip(zip, item.name === manifest.name ? [item] : [manifest, item]);
      await assert.rejects(readReleaseArchive(zip, 'tool', identity), /^Error: RELEASE_ARCHIVE_NATIVE_REJECTED$/);
    });
  }
  await withFixture(async (_directory, zip) => {
    await createZip(zip, indexNames.map(name => ({ name, json: {}, declaredBytes: 10 * 1024 * 1024 })));
    await assert.rejects(readReleaseArchive(zip, 'index', identity), /^Error: RELEASE_ARCHIVE_NATIVE_REJECTED$/);
  });
  await withFixture(async (_directory, zip) => {
    await createZip(zip, [manifest]);
    const handle = await open(zip, 'r+'); try { await handle.truncate(512 * 1024 * 1024 + 1); } finally { await handle.close(); }
    await assert.rejects(readReleaseArchive(zip, 'tool', identity), /^Error: RELEASE_ARCHIVE_FILE_OR_SIZE_INVALID$/);
  });
});

test('a real native ZIP with more than 200000 entries is rejected within the metadata budget', async () => withFixture(async (_directory, zip) => {
  await createZip(zip, [manifest], 200000);
  await assert.rejects(readReleaseArchive(zip, 'tool', identity), /^Error: RELEASE_ARCHIVE_NATIVE_REJECTED$/);
}));

test('UTF-8 BOM JSON remains data while a dishonest selected expanded length cannot be accepted', async () => {
  await withFixture(async (_directory, zip) => {
    await createZip(zip, [{ name: 'build-manifest.json', raw: Buffer.from('\ufeff{"fixture":"中文"}').toString('base64') }]);
    assert.deepEqual((await readReleaseArchive(zip, 'tool', identity)).documents['build-manifest.json'], { fixture: '中文' });
  });
  await withFixture(async (_directory, zip) => {
    await createZip(zip, [{ name: 'build-manifest.json', json: { larger: true }, declaredBytes: 1 }]);
    await assert.rejects(readReleaseArchive(zip, 'tool', identity), /^Error: RELEASE_ARCHIVE_NATIVE_REJECTED$/);
  });
});

test('file and ancestor links, wrong identities and wrong kinds reject without reading a different archive', async () => withFixture(async (directory, zip) => {
  await createZip(zip, [manifest]);
  for (const invalid of [{ ...identity, runId: '731\n' }, { ...identity, runId: 731 }, { ...identity, producerAttempt: '0' },
    { ...identity, toolSha: `${identity.toolSha}\n` }, { ...identity, extra: 'unexpected' }]) {
    await assert.rejects(readReleaseArchive(zip, 'tool', invalid as any), /^Error: RELEASE_ARCHIVE_IDENTITY_INVALID$/);
  }
  await assert.rejects(readReleaseArchive(zip, 'other' as any, identity), /^Error: RELEASE_ARCHIVE_KIND_INVALID$/);
  await assert.rejects(readReleaseArchive('relative.zip', 'tool', identity), /^Error: RELEASE_ARCHIVE_PATH_INVALID$/);
  const link = path.join(directory, 'linked.zip'); await symlink(zip, link, 'file');
  try { await assert.rejects(readReleaseArchive(link, 'tool', identity), /^Error: RELEASE_ARCHIVE_LINK_REJECTED$/); }
  finally { await unlink(link); }
  const junction = path.join(directory, 'junction'); await symlink(directory, junction, 'junction');
  try { await assert.rejects(readReleaseArchive(path.join(junction, 'artifact.zip'), 'tool', identity), /^Error: RELEASE_ARCHIVE_LINK_REJECTED$/); }
  finally { await unlink(junction); }
}));

test('a ZIP concurrently changed during the observation cannot yield accepted raw pins', async () => withFixture(async (_directory, zip) => {
  await createZip(zip, [manifest]);
  const pending = new Set<Promise<unknown>>(); let writes = 0;
  const timer = setInterval(() => {
    const write = appendFile(zip, 'x').then(() => { writes++; }).catch(() => {});
    pending.add(write); void write.finally(() => pending.delete(write));
  }, 1);
  try { await assert.rejects(readReleaseArchive(zip, 'tool', identity), /^Error: RELEASE_ARCHIVE_[A-Z_]+$/); }
  finally { clearInterval(timer); await Promise.allSettled([...pending]); }
  assert.ok(writes > 0, 'The fixture must actually mutate the ZIP');
}));

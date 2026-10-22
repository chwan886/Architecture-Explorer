import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonicalReleaseJson, isValidatedReleasePlan, releaseSha256, validateReleaseEvidence } from '../Tools/ci-release-evidence.ts';
import { releaseEvidenceFixture } from './release-evidence-fixture.ts';

type Fixture = ReturnType<typeof releaseEvidenceFixture>;
const doc = (input: Fixture, kind: 'tool' | 'index' | 'checks', ending: string): any => {
  const matches = Object.entries(input.artifacts[kind].documents).filter(([name]) => name.endsWith(ending));
  assert.equal(matches.length, 1); return matches[0][1];
};
const smokeDoc = (input: Fixture): any => Object.entries(input.artifacts.checks.documents).find(([name]) => name.startsWith('package-smoke-'))![1];
function rejectMutation(label: string, mutate: (input: Fixture) => void, expected?: RegExp) {
  test(label, () => { const input = releaseEvidenceFixture(); mutate(input);
    if (expected) assert.throws(() => validateReleaseEvidence(input), expected); else assert.throws(() => validateReleaseEvidence(input)); });
}

test('release index revision matches the real indexer source contract, while fingerprints remain SHA256', async () => {
  const producer = await readFile(new URL('../packages/indexer/src/indexer.ts', import.meta.url), 'utf8');
  // This guard reads the production indexer, not the synthetic release fixture. A changed producer format must update its consumer deliberately.
  const producerFormula = 'const revision = contentHash(`${scope.id}|${signature(snapshot.files)}|${configFingerprint}|${compilationFingerprint}|${after.head}|${after.statusHash}`).slice(0, 24);';
  assert.ok(producer.includes(producerFormula), 'Recheck the real indexer revision contract before changing release validation');
  const actualShapeRevision = releaseSha256('game-demo-02:primary|source-signature|config|compilation|head|clean-status').slice(0, 24);
  const input = releaseEvidenceFixture(), snapshot = doc(input, 'index', '/manifest.json'), audit = doc(input, 'index', '/audit.json');
  snapshot.index.revision = actualShapeRevision; audit.snapshot.sourceRevision = actualShapeRevision;
  const plan = validateReleaseEvidence(input);
  assert.equal((plan.releaseManifest as any).evidence.indexRevision, actualShapeRevision);
  assert.equal(actualShapeRevision.length, 24);
  for (const key of ['configFingerprint', 'compilationFingerprint', 'referenceFingerprint', 'sourceFingerprint']) {
    assert.equal(snapshot.index[key].length, 64);
    const bad = structuredClone(input); doc(bad, 'index', '/manifest.json').index[key] = 'a'.repeat(24);
    assert.throws(() => validateReleaseEvidence(bad), /Snapshot .*invalid exact format/);
  }
});

for (const revision of ['', 'a'.repeat(23), 'a'.repeat(25), 'a'.repeat(40), 'a'.repeat(64), 'A'.repeat(24), 'a'.repeat(24) + '\n']) {
  rejectMutation(`rejects non-producer index revision ${JSON.stringify(revision)}`, input => {
    doc(input, 'index', '/manifest.json').index.revision = revision;
    doc(input, 'index', '/audit.json').snapshot.sourceRevision = revision;
  });
}

test('successful exact bindings retain honest gaps, partial context, pending reviews and unchanged input', () => {
  const input = releaseEvidenceFixture(), before = JSON.stringify(input), plan = validateReleaseEvidence(input);
  assert.equal(JSON.stringify(input), before, 'Validation must not rewrite explanations, reviews or adapter observations');
  assert.equal(isValidatedReleasePlan(plan), true); assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.assets[0]), true); assert.equal(Object.isFrozen(plan.releaseManifest), true);
  const manifest = plan.releaseManifest as any;
  assert.equal(manifest.draft, true); assert.equal(manifest.automaticPublication, false);
  assert.equal(manifest.evidence.auditResult, 'gaps'); assert.equal(manifest.evidence.semanticCoverage, 'partial-semantic-context');
  assert.equal(manifest.evidence.reviews.entities.pending, 2); assert.equal(manifest.evidence.reviews.ownership.pending, 1);
  assert.deepEqual(manifest.evidence.limitations, doc(input, 'index', '/manifest.json').limitations);
  assert.equal(plan.releaseManifestAsset.sha256, releaseSha256(plan.releaseManifestJson));
  assert.equal(plan.releaseManifestAsset.size, Buffer.byteLength(plan.releaseManifestJson));
  assert.deepEqual(JSON.parse(plan.releaseManifestJson), manifest);
  const { bindingFingerprint, ...core } = manifest;
  assert.equal(bindingFingerprint, releaseSha256(canonicalReleaseJson(core)));
  assert.equal(plan.assets.length, 2); assert.ok(plan.assets.every(asset => /^[A-Za-z0-9_.-]+\.zip$/.test(asset.name)));
  assert.ok(plan.tagName.includes(input.context.toolSha) && plan.tagName.includes(input.dispatch.source_sha));
  assert.throws(() => { (plan.assets[0] as any).sha256 = 'f'.repeat(64); }, TypeError);
  doc(input, 'index', '/manifest.json').limitations[0] = 'later input mutation';
  assert.notEqual(manifest.evidence.limitations[0], 'later input mutation');
});

test('publisher-only rerun preserves producer binding, tag and exact manifest bytes', () => {
  const input = releaseEvidenceFixture(), original = validateReleaseEvidence(input);
  input.context.publisherAttempt = '4';
  const rerun = validateReleaseEvidence(input);
  assert.equal(rerun.producerRunAttempt, '1'); assert.equal(rerun.sourceRunAttempt, '2');
  assert.equal(rerun.tagName, original.tagName); assert.equal(rerun.bindingFingerprint, original.bindingFingerprint);
  assert.equal(rerun.releaseManifestJson, original.releaseManifestJson);
});
test('successful Fast gate authorization may originate from a game workflow whose sender is still in progress', () => {
  const f = releaseEvidenceFixture(); doc(f, 'index', 'authorization/authorization.json').sourceRun.statusAtAuthorization = 'in_progress';
  assert.equal(isValidatedReleasePlan(validateReleaseEvidence(f)), true);
});

test('serialized/frozen lookalikes and arbitrary objects have no validated-plan capability', () => {
  const plan = validateReleaseEvidence(releaseEvidenceFixture());
  for (const fake of [undefined, null, {}, { ...plan }, Object.freeze(structuredClone(plan)), JSON.parse(JSON.stringify(plan))]) assert.equal(isValidatedReleasePlan(fake), false);
});

test('consistent configured static context is accepted without pretending runtime/Unity Full evidence', () => {
  const input = releaseEvidenceFixture(), snapshot = doc(input, 'index', '/manifest.json');
  snapshot.index.diagnostics = [];
  snapshot.semanticDiagnostics = []; snapshot.semanticCoverage = 'configured-static-analysis'; snapshot.auditResult = 'consistent';
  doc(input, 'index', '/audit.json').result = 'consistent';
  const plan = validateReleaseEvidence(input), manifest = plan.releaseManifest as any;
  assert.equal(manifest.evidence.semanticDiagnosticCount, 0); assert.equal(manifest.evidence.readOnlyVerified, true);
  assert.ok(manifest.limitations.includes('No game build or target code execution'));
});

for (const [label, mutate] of [
  ['fork repository', (f: Fixture) => { f.context.repository = 'someone/Architecture-Explorer'; }],
  ['non-GitHub host', (f: Fixture) => { f.context.serverUrl = 'https://github.example'; }],
  ['public repository', (f: Fixture) => { f.context.isPrivate = false; f.context.visibility = 'public'; }],
  ['internal visibility', (f: Fixture) => { f.context.visibility = 'internal'; }],
  ['different default branch', (f: Fixture) => { f.context.defaultBranch = 'develop'; }],
  ['pull request context', (f: Fixture) => { f.context.eventName = 'pull_request'; }],
  ['unprotected ref', (f: Fixture) => { f.context.refProtected = false; }],
  ['missing effective protection', (f: Fixture) => { f.context.effectiveProtected = false; }],
  ['non-main receiving ref', (f: Fixture) => { f.context.ref = 'refs/heads/codex/test'; }],
  ['audience approval missing', (f: Fixture) => { f.context.indexAccessApproved = ''; }],
  ['bypass review missing', (f: Fixture) => { f.context.ruleBypassReviewed = 'false'; }],
  ['producer still running', (f: Fixture) => { f.producer.status = 'in_progress'; }],
  ['producer failure', (f: Fixture) => { f.producer.conclusion = 'failure'; }],
  ['producer skipped needs result', (f: Fixture) => { f.producer.result = 'skipped'; }],
  ['producer wrong workflow', (f: Fixture) => { f.producer.workflowPath = '.github/workflows/tool-ci.yml'; }],
  ['producer wrong job', (f: Fixture) => { f.producer.jobName = 'Other green job'; }],
  ['producer other run', (f: Fixture) => { f.producer.runId = '9002'; }],
  ['producer another tool head', (f: Fixture) => { f.producer.headSha = '4'.repeat(40); }],
  ['publisher attempt before producer', (f: Fixture) => { f.producer.attempt = '2'; }],
] as const) rejectMutation(`rejects ${label}`, mutate);

for (const [label, mutate] of [
  ['illegal game repository', (f: Fixture) => { (f.dispatch as any).source_repo = 'someone/GameDemo02'; }],
  ['upper-case SHA', (f: Fixture) => { (f.dispatch as any).source_sha = 'A'.repeat(40); }],
  ['SHA trailing newline', (f: Fixture) => { (f.dispatch as any).source_sha += '\n'; }],
  ['tool SHA trailing newline', (f: Fixture) => { f.context.toolSha += '\n'; }],
  ['source run numeric instead of string', (f: Fixture) => { (f.dispatch as any).source_run_id = 8001; }],
  ['zero source attempt', (f: Fixture) => { (f.dispatch as any).source_run_attempt = '0'; }],
  ['source run ID trailing newline', (f: Fixture) => { (f.dispatch as any).source_run_id += '\n'; }],
  ['source URL another attempt path', (f: Fixture) => { (f.dispatch as any).source_run_url += '/attempts/2'; }],
  ['source ref latest alias', (f: Fixture) => { (f.dispatch as any).source_ref = 'main'; }],
  ['self-asserted review extra field', (f: Fixture) => { (f.dispatch as any).reviewed = 'true'; }],
] as const) rejectMutation(`rejects ${label}`, mutate);

for (const kind of ['tool', 'index', 'checks'] as const) {
  rejectMutation(`${kind}: rejects raw ZIP fingerprint mismatch`, f => { f.artifacts[kind].actualZipSha256 = 'f'.repeat(64); });
  rejectMutation(`${kind}: rejects server digest mismatch`, f => { (f.artifacts[kind].metadata as any).digest = 'sha256:' + 'f'.repeat(64); });
  rejectMutation(`${kind}: rejects frozen ID mismatch`, f => { f.artifacts[kind].output.id = '999'; });
  rejectMutation(`${kind}: rejects size mismatch`, f => { f.artifacts[kind].actualZipBytes++; });
  rejectMutation(`${kind}: rejects expired evidence`, f => { (f.artifacts[kind].metadata as any).expired = true; });
  rejectMutation(`${kind}: rejects other tool SHA`, f => { (f.artifacts[kind].metadata as any).workflow_run.head_sha = '4'.repeat(40); });
  rejectMutation(`${kind}: rejects fork artifact origin`, f => { (f.artifacts[kind].metadata as any).workflow_run.head_repository_id = 7002; });
  rejectMutation(`${kind}: rejects other producer run`, f => { (f.artifacts[kind].metadata as any).workflow_run.id = 9002; });
  rejectMutation(`${kind}: rejects old attempt artifact name`, f => { (f.artifacts[kind].metadata as any).name += '-old'; });
}

for (const name of ['../outside.json', '/absolute.json', 'C:/outside.json', 'a/../outside.json', 'a\\b.json', 'a//b.json',
  'a/./b.json', 'a/file.json\n', 'a/file.json\0', 'folder./file.json', 'con/file.json', 'a:stream.json']) {
  rejectMutation(`ZIP rejects dangerous path ${JSON.stringify(name)}`, f => { (f.artifacts.tool.entries as any[]).push({ path: name, size: 1, externalAttributes: 0, isDirectory: false }); });
}
rejectMutation('ZIP rejects case-insensitive duplicate entry', f => { (f.artifacts.tool.entries as any[]).push({ ...f.artifacts.tool.entries[0], path: 'BUILD-MANIFEST.JSON' }); });
rejectMutation('ZIP rejects file/directory alias', f => { (f.artifacts.tool.entries as any[]).push({ path: 'build-manifest.json/', size: 0, externalAttributes: 0x10, isDirectory: true }); });
rejectMutation('ZIP rejects a file used as an ancestor directory', f => { (f.artifacts.tool.entries as any[]).push({ path: 'build-manifest.json/evil.json', size: 1, externalAttributes: 0, isDirectory: false }); });
rejectMutation('ZIP rejects Unix symlink', f => { (f.artifacts.tool.entries as any[]).push({ path: 'link', size: 1, externalAttributes: 0xa1ff << 16, isDirectory: false }); });
rejectMutation('ZIP rejects Windows reparse entry', f => { (f.artifacts.tool.entries as any[]).push({ path: 'link', size: 1, externalAttributes: 0x400, isDirectory: false }); });
rejectMutation('ZIP rejects mismatched directory metadata', f => { (f.artifacts.tool.entries as any[]).push({ path: 'folder/', size: 0, externalAttributes: 0x10, isDirectory: false }); });
for (const path of ['config/local.json', '.git/config', '.tools/dotnet/dotnet.exe', '.ci-references/metadata.zip', 'game/Assets/Game/Actor.cs',
  '.cache/index.json', 'nested/.cache/index.json', 'smoke-cache-abc/bridge/runtime.json', 'bridge/runtime.json', 'nested/bridge/runtime',
  'node_modules/UnityEngine.CoreModule.dll', 'Assembly-CSharp.dll', 'nested/GameDemo02.Runtime.dll', '.package-smoke-owner']) {
  rejectMutation(`tool ZIP rejects sensitive residual ${path}`, f => { (f.artifacts.tool.entries as any[]).push({ path, size: 1, externalAttributes: 0, isDirectory: false }); });
}
test('tool ZIP permits actual worker and Roslyn runtime DLLs, ordinary directories and regular Unix attributes', () => {
  const f = releaseEvidenceFixture();
  (f.artifacts.tool.entries as any[]).push({ path: 'analyzers/', size: 0, externalAttributes: (0x41ed << 16) | 0x10, isDirectory: true },
    ...['ArchitectureExplorer.Analyzers.dll', 'Microsoft.CodeAnalysis.CSharp.dll'].map(name => ({ path: 'analyzers/' + name, size: 1, externalAttributes: 0x81a4 << 16, isDirectory: false })));
  assert.ok(isValidatedReleasePlan(validateReleaseEvidence(f)));
});
for (const path of ['different-game/other/manifest.json', 'authorization/extra.json', 'game/Assets/Game/Actor.cs']) {
  rejectMutation(`index ZIP rejects unrelated binding ${path}`, f => { (f.artifacts.index.entries as any[]).push({ path, size: 1, externalAttributes: 0, isDirectory: false }); });
}
for (const relative of ['failed/index.json', 'failure.json', '.cache/index.json', 'Assembly-CSharp.dll', 'source.py']) {
  rejectMutation(`index ZIP rejects failed/cache/binary payload ${relative}`, f => {
    const prefix = `${f.dispatch.source_sha}/${f.producer.runId}-${f.producer.attempt}/index-evidence/`;
    (f.artifacts.index.entries as any[]).push({ path: prefix + relative, size: 1, externalAttributes: 0, isDirectory: false });
  });
}
test('index ZIP allows explicit root ancestors, read-only logs and preserved human model JSON', () => {
  const f = releaseEvidenceFixture(), prefix = `${f.dispatch.source_sha}/${f.producer.runId}-${f.producer.attempt}/index-evidence/`;
  for (const path of [f.dispatch.source_sha + '/', `${f.dispatch.source_sha}/${f.producer.runId}-${f.producer.attempt}/`, prefix, 'authorization/']) {
    (f.artifacts.index.entries as any[]).push({ path, size: 0, externalAttributes: 0x10, isDirectory: true });
  }
  for (const path of [prefix + 'logs/scan.stdout.log']) {
    (f.artifacts.index.entries as any[]).push({ path, size: 1, externalAttributes: 0, isDirectory: false });
  }
  assert.ok(isValidatedReleasePlan(validateReleaseEvidence(f)));
});
test('real human-model copy contract includes both maintained READMEs without broad Markdown allowance', () => {
  const f = releaseEvidenceFixture(), entries = f.artifacts.index.entries;
  assert.ok(entries.some(entry => entry.path.endsWith('/human-models/architecture/models/game-demo-02/README.md')));
  assert.ok(entries.some(entry => entry.path.endsWith('/human-models/architecture/semantics/game-demo-02/README.md')));
  assert.equal(isValidatedReleasePlan(validateReleaseEvidence(f)), true);
});
test('source-bearing index stays outside JSON documents while its independent native pin is required', () => {
  const input = releaseEvidenceFixture(), snapshot = doc(input, 'index', '/manifest.json');
  assert.ok(!Object.keys(input.artifacts.index.documents).some(name => name.endsWith('/index.json')));
  assert.equal(snapshot.index.fullIndex.path, 'index.json');
  assert.equal(input.artifacts.index.indexFile!.sha256, snapshot.index.fullIndex.sha256);
  assert.equal(input.artifacts.index.indexFile!.size, snapshot.index.fullIndex.size);
  assert.equal(isValidatedReleasePlan(validateReleaseEvidence(input)), true);
});
for (const [label, mutate] of [
  ['missing manifest pin', (f: Fixture) => { delete doc(f, 'index', '/manifest.json').index.fullIndex; }],
  ['pin relative path changed', (f: Fixture) => { doc(f, 'index', '/manifest.json').index.fullIndex.path = 'other.json'; }],
  ['pin absolute path', (f: Fixture) => { doc(f, 'index', '/manifest.json').index.fullIndex.path = 'C:/index.json'; }],
  ['pin full archive path instead of literal filename', (f: Fixture) => { doc(f, 'index', '/manifest.json').index.fullIndex.path = f.artifacts.index.indexFile!.path; }],
  ['pin digest differs from native stream', (f: Fixture) => { doc(f, 'index', '/manifest.json').index.fullIndex.sha256 = 'f'.repeat(64); }],
  ['pin size differs from native stream', (f: Fixture) => { doc(f, 'index', '/manifest.json').index.fullIndex.size++; }],
  ['pin missing digest', (f: Fixture) => { delete doc(f, 'index', '/manifest.json').index.fullIndex.sha256; }],
  ['pin missing size', (f: Fixture) => { delete doc(f, 'index', '/manifest.json').index.fullIndex.size; }],
  ['missing native observation', (f: Fixture) => { delete f.artifacts.index.indexFile; }],
  ['native wrong path', (f: Fixture) => { f.artifacts.index.indexFile!.path = 'index.json'; }],
  ['native wrong attempt', (f: Fixture) => { f.artifacts.index.indexFile!.path = f.artifacts.index.indexFile!.path.replace('/9001-1/', '/9001-2/'); }],
  ['native changed digest', (f: Fixture) => { f.artifacts.index.indexFile!.sha256 = 'f'.repeat(64); }],
  ['native changed size', (f: Fixture) => { f.artifacts.index.indexFile!.size++; }],
  ['native zero size', (f: Fixture) => { f.artifacts.index.indexFile!.size = 0; }],
  ['archive entry size differs from native and pin', (f: Fixture) => { (f.artifacts.index.entries.find(entry => entry.path.endsWith('/index.json')) as any).size++; }],
  ['archive full index entry missing', (f: Fixture) => { (f.artifacts.index as any).entries = f.artifacts.index.entries.filter(entry => !entry.path.endsWith('/index.json')); }],
  ['tool carries an index observation', (f: Fixture) => { f.artifacts.tool.indexFile = { ...f.artifacts.index.indexFile! }; }],
  ['checks carry an index observation', (f: Fixture) => { f.artifacts.checks.indexFile = { ...f.artifacts.index.indexFile! }; }],
] as const) rejectMutation(`full index rejects ${label}`, mutate);
rejectMutation('unrelated Markdown is not accepted as maintained human evidence', f => {
  const prefix = `${f.dispatch.source_sha}/${f.producer.runId}-${f.producer.attempt}/index-evidence/`;
  (f.artifacts.index.entries as any[]).push({ path: prefix + 'human-models/unrelated.md', size: 1, externalAttributes: 0, isDirectory: false });
}, /Unattested/);
rejectMutation('an attested README must actually be present in the immutable index ZIP', f => {
  (f.artifacts.index as any).entries = f.artifacts.index.entries.filter(entry => !entry.path.endsWith('/human-models/architecture/models/game-demo-02/README.md'));
}, /README is missing/);

rejectMutation('legacy fixed-name runtime receipt cannot substitute for precise cleaned package receipt', f => {
  const a = f.artifacts.checks, name = Object.keys(a.documents).find(name => name.startsWith('package-smoke-'))!;
  (a.documents as any)['package-smoke.json'] = a.documents[name]; delete (a.documents as any)[name];
  (a.entries.find(entry => entry.path === name) as any).path = 'package-smoke.json';
}, /Required exact ZIP entry missing/);
for (const [label, mutate] of [
  ['runtime cleanup evidence false', (f: Fixture) => { smokeDoc(f).cleanupVerified = false; }],
  ['runtime credential removal false', (f: Fixture) => { smokeDoc(f).fixtureRuntimeCredentialsRemoved = false; }],
  ['runtime old package identity', (f: Fixture) => { smokeDoc(f).packageId = 'tool-old'; }],
  ['runtime no preserved quotes', (f: Fixture) => { smokeDoc(f).sourceQuoteAnchorCount = 0; }],
  ['local execution package', (f: Fixture) => { doc(f, 'tool', 'build-manifest.json').execution = 'local-check'; }],
  ['dirty tool source', (f: Fixture) => { doc(f, 'tool', 'build-manifest.json').sourceDirty = true; }],
  ['missing source excerpt disclosure', (f: Fixture) => { doc(f, 'tool', 'build-manifest.json').containsGameSourceExcerpts = false; }],
  ['failed delivery checks', (f: Fixture) => { doc(f, 'checks', 'delivery-result.json').checksOutcome = 'failure'; }],
  ['skipped index outcome', (f: Fixture) => { doc(f, 'checks', 'delivery-result.json').indexOutcome = 'skipped'; }],
  ['unverified index outcome boolean', (f: Fixture) => { doc(f, 'checks', 'delivery-result.json').indexVerified = false; }],
  ['other delivery source attempt', (f: Fixture) => { doc(f, 'checks', 'delivery-result.json').source.attempt = '3'; }],
  ['snapshot not read-only', (f: Fixture) => { doc(f, 'index', '/manifest.json').readOnlyVerified = false; }],
  ['snapshot pending outcome', (f: Fixture) => { doc(f, 'index', '/manifest.json').outcome = 'pending-read-only-verification'; }],
  ['snapshot incomplete', (f: Fixture) => { doc(f, 'index', '/manifest.json').incomplete = true; }],
  ['snapshot other target attempt', (f: Fixture) => { doc(f, 'index', '/manifest.json').targetRun.attempt = '2'; }],
  ['snapshot other source attempt', (f: Fixture) => { doc(f, 'index', '/manifest.json').sourceRun.attempt = '3'; }],
  ['index empty Git HEAD', (f: Fixture) => { doc(f, 'index', '/manifest.json').index.gitHead = ''; }],
  ['index other game SHA', (f: Fixture) => { doc(f, 'index', '/manifest.json').index.gitHead = '4'.repeat(40); }],
  ['index dirty', (f: Fixture) => { doc(f, 'index', '/manifest.json').index.gitDirty = true; }],
  ['index clean flag without clean Git fingerprint', (f: Fixture) => { doc(f, 'index', '/manifest.json').index.gitStatusHash = releaseSha256(' M source.cs'); }],
  ['index Git read failure despite false summary flag', (f: Fixture) => { doc(f, 'index', '/manifest.json').index.diagnostics.push({ code: 'git-unavailable', severity: 'warning' }); }],
  ['empty index files', (f: Fixture) => { doc(f, 'index', '/manifest.json').index.fileCount = 0; }],
  ['index missing Git availability flag', (f: Fixture) => { delete doc(f, 'index', '/manifest.json').index.gitUnavailable; }],
  ['index unreadable Git flag despite empty diagnostic projection', (f: Fixture) => { doc(f, 'index', '/manifest.json').index.gitUnavailable = true; }],
  ['index unapproved scope', (f: Fixture) => { doc(f, 'index', '/manifest.json').index.scopeId = 'other:primary'; }],
  ['index fractional file count', (f: Fixture) => { doc(f, 'index', '/manifest.json').index.fileCount = 1.5; }],
  ['index string file count', (f: Fixture) => { doc(f, 'index', '/manifest.json').index.fileCount = '1'; }],
  ['index file count exceeds preserved 50000 bound', (f: Fixture) => { doc(f, 'index', '/manifest.json').index.fileCount = 50001; }],
  ['index missing complete diagnostic count', (f: Fixture) => { delete doc(f, 'index', '/manifest.json').index.diagnosticCount; }],
  ['index complete diagnostic count exceeds preserved 50000 bound', (f: Fixture) => { doc(f, 'index', '/manifest.json').index.diagnosticCount = 50001; }],
  ['index negative complete diagnostic count', (f: Fixture) => { doc(f, 'index', '/manifest.json').index.diagnosticCount = -1; }],
  ['index string complete diagnostic count', (f: Fixture) => { doc(f, 'index', '/manifest.json').index.diagnosticCount = '1'; }],
  ['index diagnostic projection exceeds complete count', (f: Fixture) => { doc(f, 'index', '/manifest.json').index.diagnosticCount = 0; }],
  ['modified game bytes', (f: Fixture) => { doc(f, 'index', '/read-only-after.json').sourceHashes[0][1] = releaseSha256('changed'); }],
  ['modified game HEAD', (f: Fixture) => { doc(f, 'index', '/read-only-after.json').head = '4'.repeat(40); }],
  ['untracked game change', (f: Fixture) => { doc(f, 'index', '/read-only-after.json').status = '?? new.py'; }],
  ['modified human explanations', (f: Fixture) => { doc(f, 'index', '/read-only-after.json').humanModels[0][1] = releaseSha256('rewritten'); }],
  ['source fingerprint cannot be self-asserted', (f: Fixture) => { doc(f, 'index', '/read-only-before.json').sourceFingerprint = 'f'.repeat(64); }],
  ['invalid audit', (f: Fixture) => { doc(f, 'index', '/audit.json').result = 'invalid'; }],
  ['incomplete audit', (f: Fixture) => { doc(f, 'index', '/audit.json').result = 'incomplete'; }],
  ['audit other game', (f: Fixture) => { doc(f, 'index', '/audit.json').snapshot.gitHead = '4'.repeat(40); }],
  ['audit other index revision', (f: Fixture) => { doc(f, 'index', '/audit.json').snapshot.sourceRevision = releaseSha256('another index'); }],
  ['audit false runtime claim', (f: Fixture) => { doc(f, 'index', '/audit.json').coverage.runtimeVerificationClaimedByAudit = true; }],
  ['pending reviews rewritten in manifest', (f: Fixture) => { doc(f, 'index', '/manifest.json').reviews.entities.pending = 0; }],
  ['partial diagnostics silently removed', (f: Fixture) => { doc(f, 'index', '/manifest.json').semanticDiagnostics = []; }],
  ['partial index diagnostic projection silently removed', (f: Fixture) => { doc(f, 'index', '/manifest.json').index.diagnostics = []; }],
  ['partial scope falsely called complete', (f: Fixture) => { doc(f, 'index', '/manifest.json').semanticCoverage = 'configured-static-analysis'; }],
  ['references pin mismatch', (f: Fixture) => { doc(f, 'index', '/references.json').references[0].sha256 = releaseSha256('different DLL'); }],
  ['wrong Unity metadata version', (f: Fixture) => { doc(f, 'index', '/references.json').unityVersion = '6000.6.6f1'; }],
  ['authorization other SHA', (f: Fixture) => { doc(f, 'index', 'authorization/authorization.json').gameSha = '4'.repeat(40); }],
  ['authorization other source attempt', (f: Fixture) => { doc(f, 'index', 'authorization/authorization.json').sourceRun.attempt = '3'; }],
  ['authorization source job missing', (f: Fixture) => { doc(f, 'index', 'authorization/authorization.json').prerequisites = []; }],
  ['authorization weak game rule', (f: Fixture) => { doc(f, 'index', 'authorization/authorization.json').gameProtection.requiresIndependentReview = false; }],
  ['authorization weak tool rule', (f: Fixture) => { doc(f, 'index', 'authorization/authorization.json').toolProtection.requiredCheckContexts = []; }],
  ['authorization zero actual independent approvals', (f: Fixture) => { doc(f, 'index', 'authorization/authorization.json').mergedPr.approvals = []; }],
  ['authorization approval for old head', (f: Fixture) => { doc(f, 'index', 'authorization/authorization.json').mergedPr.approvals[0].commitId = '4'.repeat(40); }],
  ['authorization approval after merge', (f: Fixture) => { doc(f, 'index', 'authorization/authorization.json').mergedPr.approvals[0].submittedAt = '2026-10-22T00:50:00Z'; }],
  ['authorization bot approval', (f: Fixture) => { doc(f, 'index', 'authorization/authorization.json').mergedPr.approvals[0].reviewer = 'app[bot]'; }],
  ['authorization noncanonical approval date', (f: Fixture) => { doc(f, 'index', 'authorization/authorization.json').mergedPr.approvals[0].submittedAt = '2026-02-30T00:30:00Z'; }],
  ['authorization approval date suffix reflection', (f: Fixture) => { doc(f, 'index', 'authorization/authorization.json').mergedPr.approvals[0].submittedAt += '\n'; }],
] as const) rejectMutation(`rejects ${label}`, mutate);

rejectMutation('duplicate approval IDs cannot satisfy the effective independent reviewer count', f => {
  const auth = doc(f, 'index', 'authorization/authorization.json'); auth.gameProtection.requiredApprovingReviewCount = 2;
  auth.mergedPr.approvals.push({ ...auth.mergedPr.approvals[0], reviewId: 22 });
}, /Insufficient distinct/);

test('two actual distinct approved reviewers satisfy the effective rule count without rewriting evidence', () => {
  const f = releaseEvidenceFixture(), auth = doc(f, 'index', 'authorization/authorization.json');
  auth.gameProtection.requiredApprovingReviewCount = 2;
  auth.mergedPr.approvals.push({ ...auth.mergedPr.approvals[0], reviewId: 22, reviewerId: 32, reviewer: 'OtherHuman' });
  assert.equal(isValidatedReleasePlan(validateReleaseEvidence(f)), true);
});

test('projection does not reflect unknown API or document fields into the manifest', () => {
  const f = releaseEvidenceFixture();
  (f.context as any).unexpected = 'secret-not-in-contract';
  (f.artifacts.tool.metadata as any).unexpected = 'secret-not-in-contract';
  doc(f, 'index', 'authorization/authorization.json').unexpected = 'secret-not-in-contract';
  doc(f, 'checks', 'delivery-result.json').unexpected = 'secret-not-in-contract';
  assert.ok(!validateReleaseEvidence(f).releaseManifestJson.includes('secret-not-in-contract'));
});

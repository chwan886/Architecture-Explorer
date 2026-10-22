import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const RELEASE_REPOSITORY = 'chwan886/Architecture-Explorer' as const;
export const RELEASE_GAME_REPOSITORY = 'chwan886/GameDemo02' as const;
const workflowPath = '.github/workflows/game-index.yml';
const buildJobName = 'Build tool and verify exact game SHA';
const toolCheck = 'Tool / typecheck, tests and builds';
const sourceKeys = ['contract_version', 'source_repo', 'source_ref', 'source_sha', 'source_run_id', 'source_run_url', 'source_run_attempt'];
type JsonRecord = Record<string, any>;

/** ZIP/API adapters supply observations; this module performs no I/O or target execution. */
export interface ReleaseZipEntry { path: string; size: number; externalAttributes: number; isDirectory: boolean }
export interface ReleaseArtifactEvidence {
  output: { id: string; digest: string };
  metadata: unknown;
  actualZipSha256: string;
  actualZipBytes: number;
  entries: readonly ReleaseZipEntry[];
  /** Only selected, bounded JSON objects read from the same pinned archive, keyed by exact ZIP entry path. */
  documents: Readonly<Record<string, unknown>>;
}
export interface ReleaseEvidenceInput {
  context: { repository: string; repositoryId: number; serverUrl: string; isPrivate: boolean; visibility: string; defaultBranch: string;
    eventName: string; ref: string; refProtected: boolean; effectiveProtected: boolean; toolSha: string;
    runId: string; publisherAttempt: string; indexAccessApproved: string; ruleBypassReviewed: string };
  /** status/conclusion/result describe the successful producer job, not the still-running overall workflow. */
  producer: { runId: string; attempt: string; headSha: string; headBranch: string; workflowPath: string;
    event: string; jobName: string; status: string; conclusion: string; result: string };
  dispatch: Readonly<Record<string, string>>;
  artifacts: { tool: ReleaseArtifactEvidence; index: ReleaseArtifactEvidence; checks: ReleaseArtifactEvidence };
}
export interface ReleaseAssetPin { kind: 'tool' | 'index'; name: string; size: number; sha256: string;
  artifactId: number; artifactName: string; artifactDigest: string }
export interface ValidatedReleasePlan {
  schemaVersion: '1.0.0'; kind: 'architecture-explorer-private-tool-release-draft'; repository: typeof RELEASE_REPOSITORY;
  toolSha: string; gameSha: string; producerRunId: string; producerRunAttempt: string; sourceRunId: string; sourceRunAttempt: string;
  tagName: string; bindingFingerprint: string; assets: readonly [ReleaseAssetPin, ReleaseAssetPin];
  releaseManifest: Readonly<Record<string, unknown>>; releaseManifestJson: string;
  releaseManifestAsset: Readonly<{ name: 'release-manifest.json'; size: number; sha256: string }>;
}
const validatedPlans = new WeakSet<object>();
export function isValidatedReleasePlan(value: unknown): value is ValidatedReleasePlan {
  return typeof value === 'object' && value !== null && validatedPlans.has(value);
}
export function releaseSha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function record(value: unknown, label: string): JsonRecord {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value as JsonRecord;
}
function exact(value: unknown, expected: unknown, label: string): void { assert.equal(value, expected, label); }
function match(value: unknown, pattern: RegExp, label: string): string {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  const found = pattern.exec(value as string);
  assert.ok(found && found[0] === value, `${label} has an invalid exact format`);
  return value as string;
}
function sha(value: unknown, label: string): string { return match(value, /^[a-f0-9]{40}$/, label); }
function digest(value: unknown, label: string): string { return match(value, /^[a-f0-9]{64}$/, label); }
function run(value: unknown, label: string): string { return match(value, /^[1-9][0-9]{0,19}$/, label); }
function integer(value: unknown, label: string, minimum = 1): number {
  assert.ok(Number.isSafeInteger(value) && (value as number) >= minimum, `${label} must be a safe integer >= ${minimum}`);
  return value as number;
}
function text(value: unknown, label: string, maximum = 8192): string {
  assert.ok(typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value), `${label} must be bounded plain text`);
  return value as string;
}
function array(value: unknown, label: string, maximum = 50000): any[] {
  assert.ok(Array.isArray(value) && value.length <= maximum, `${label} must be a bounded array`);
  return value;
}
function date(value: unknown, label: string): number {
  const raw = match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/, label);
  const stamp = Date.parse(raw); assert.ok(Number.isFinite(stamp), `${label} must be a real UTC date`);
  assert.ok(new Date(stamp).toISOString() === raw || new Date(stamp).toISOString().replace('.000Z', 'Z') === raw, `${label} must be canonical`);
  return stamp;
}
function plainPath(value: unknown, label: string): string {
  const raw = text(value, label, 2048);
  assert.ok(!raw.includes('\\') && !raw.includes(':') && !raw.startsWith('/') && !raw.endsWith('/') &&
    raw.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)), `${label} must be an exact relative file path`);
  return raw;
}
export function canonicalReleaseJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalReleaseJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalReleaseJson((value as JsonRecord)[key])).join(',') + '}';
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}
function copiedJson<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function zipEntries(artifact: ReleaseArtifactEvidence, label: string): Map<string, ReleaseZipEntry> {
  const entries = array(artifact.entries, `${label} ZIP entries`, 200000); assert.ok(entries.length > 0, `${label} ZIP is empty`);
  const result = new Map<string, ReleaseZipEntry>(), names = new Set<string>(), folded = new Map<string, ReleaseZipEntry>();
  for (const raw of entries) {
    const entry = record(raw, `${label} ZIP entry`);
    exact(typeof entry.isDirectory, 'boolean', `${label} ZIP directory flag`);
    const name = entry.isDirectory ? text(entry.path, `${label} directory`).replace(/\/$/, '') : entry.path;
    plainPath(name, `${label} ZIP path`);
    assert.ok(entry.isDirectory ? entry.path === name + '/' : entry.path === name, `${label} ZIP directory path mismatch`);
    assert.ok(!names.has(name.toLowerCase()), `${label} ZIP duplicate path`); names.add(name.toLowerCase());
    integer(entry.size, `${label} ZIP entry size`, 0);
    assert.ok(Number.isInteger(entry.externalAttributes) && entry.externalAttributes >= -2147483648 && entry.externalAttributes <= 4294967295, `${label} ZIP attributes invalid`);
    const attributes = entry.externalAttributes >>> 0, unixType = (attributes >>> 16) & 0xf000;
    assert.ok(unixType !== 0xa000 && (attributes & 0x400) === 0, `${label} ZIP link entry rejected`);
    assert.ok(unixType === 0 || unixType === 0x8000 || unixType === 0x4000, `${label} ZIP special file rejected`);
    assert.ok(entry.isDirectory ? entry.size === 0 && (unixType !== 0x8000) : unixType !== 0x4000 && (attributes & 0x10) === 0, `${label} ZIP type mismatch`);
    result.set(name, entry as ReleaseZipEntry); folded.set(name.toLowerCase(), entry as ReleaseZipEntry);
  }
  for (const name of names) {
    const parts = name.split('/');
    for (let count = 1; count < parts.length; count++) {
      const prefix = parts.slice(0, count).join('/');
      const ancestor = folded.get(prefix);
      assert.ok(!ancestor || ancestor.isDirectory, `${label} ZIP file used as directory`);
    }
  }
  return result;
}
function document(artifact: ReleaseArtifactEvidence, entries: Map<string, ReleaseZipEntry>, name: string): JsonRecord {
  const entry = entries.get(name); assert.ok(entry && !entry.isDirectory, `Required exact ZIP entry missing: ${name}`);
  assert.ok(Object.hasOwn(artifact.documents, name), `Bounded JSON observation missing: ${name}`);
  return record(artifact.documents[name], name);
}
function sourceHashes(value: unknown, label: string): Array<[string, string]> {
  const items = array(value, label), names = new Set<string>(); assert.ok(items.length > 0, `${label} must be nonempty`);
  for (const item of items) {
    assert.ok(Array.isArray(item) && item.length === 2, `${label} tuple invalid`);
    const name = plainPath(item[0], label); digest(item[1], label);
    assert.ok(!names.has(name.toLowerCase()), `${label} duplicate source`); names.add(name.toLowerCase());
  }
  return items as Array<[string, string]>;
}
function reviewCounts(value: unknown): JsonRecord {
  const source = record(value, 'review coverage'), result: JsonRecord = {};
  for (const key of ['ownership', 'entities', 'architectureFlows', 'semanticFlows', 'semanticNodes', 'semanticEdges']) {
    const counts = record(source[key], `review coverage ${key}`); result[key] = {};
    assert.ok(Object.keys(counts).length <= 30, 'Review coverage budget exceeded');
    for (const name of Object.keys(counts)) {
      match(name, /^[a-z][a-z-]{0,60}$/, 'review state'); result[key][name] = integer(counts[name], 'review count', 0);
    }
  }
  return result;
}

export function validateReleaseEvidence(input: ReleaseEvidenceInput): ValidatedReleasePlan {
  const c = record(input.context, 'context'), p = record(input.producer, 'producer'), source = record(input.dispatch, 'dispatch');
  exact(c.repository, RELEASE_REPOSITORY, 'Fixed tool repository'); integer(c.repositoryId, 'Repository ID'); exact(c.serverUrl, 'https://github.com', 'Fixed GitHub host');
  exact(c.isPrivate, true, 'Release repository must be private'); exact(c.visibility, 'private', 'Release visibility');
  exact(c.defaultBranch, 'main', 'Tool default branch'); exact(c.eventName, 'workflow_dispatch', 'Dispatch event');
  exact(c.ref, 'refs/heads/main', 'Receiving main'); exact(c.refProtected, true, 'Protected receiving ref');
  exact(c.effectiveProtected, true, 'Effective main protection'); exact(c.indexAccessApproved, 'true', 'Audience approval');
  exact(c.ruleBypassReviewed, 'true', 'Rule bypass review');
  const toolSha = sha(c.toolSha, 'Tool SHA'), runId = run(c.runId, 'Run ID'), publisherAttempt = run(c.publisherAttempt, 'Publisher attempt');
  const producerAttempt = run(p.attempt, 'Producer attempt');
  assert.ok(BigInt(publisherAttempt) >= BigInt(producerAttempt), 'Publisher attempt precedes producer attempt');
  for (const [key, expected] of Object.entries({ runId, headSha: toolSha, headBranch: 'main', workflowPath, event: 'workflow_dispatch',
    jobName: buildJobName, status: 'completed', conclusion: 'success', result: 'success' })) exact(p[key], expected, `Producer ${key}`);
  assert.deepEqual(Object.keys(source).sort(), [...sourceKeys].sort(), 'Exactly seven dispatch strings are required');
  for (const name of sourceKeys) assert.equal(typeof source[name], 'string', `${name} must remain a string`);
  exact(source.contract_version, '1', 'Contract version'); exact(source.source_repo, RELEASE_GAME_REPOSITORY, 'Game repository');
  exact(source.source_ref, 'refs/heads/main', 'Game main');
  const gameSha = sha(source.source_sha, 'Game SHA'), sourceRunId = run(source.source_run_id, 'Source run ID'), sourceAttempt = run(source.source_run_attempt, 'Source attempt');
  const sourceUrl = `https://github.com/${RELEASE_GAME_REPOSITORY}/actions/runs/${sourceRunId}`;
  exact(source.source_run_url, sourceUrl, 'Source run URL');
  const producerUrl = `https://github.com/${RELEASE_REPOSITORY}/actions/runs/${runId}/attempts/${producerAttempt}`;
  const packageId = `tool-${toolSha}-${runId}-${producerAttempt}`;
  const artifactNames = { tool: `tool-build-${toolSha}-${runId}-${producerAttempt}`, index: `game-index-${gameSha}-${toolSha}-${runId}-${producerAttempt}`, checks: `tool-checks-${toolSha}-${runId}-${producerAttempt}` };
  const indexes = {} as Record<'tool' | 'index' | 'checks', Map<string, ReleaseZipEntry>>;
  const ids = new Set<number>();
  for (const kind of ['tool', 'index', 'checks'] as const) {
    const artifact = input.artifacts[kind], api = record(artifact.metadata, `${kind} artifact API`), output = record(artifact.output, `${kind} artifact output`);
    const id = integer(api.id, `${kind} artifact ID`); assert.ok(!ids.has(id), 'Distinct artifact IDs required'); ids.add(id);
    exact(output.id, String(id), `${kind} frozen artifact ID`); exact(api.name, artifactNames[kind], `${kind} artifact name`);
    exact(api.expired, false, `${kind} artifact expired`); integer(api.size_in_bytes, `${kind} artifact size`);
    const expectedDigest = digest(output.digest, `${kind} producer ZIP digest`);
    exact(api.digest, `sha256:${expectedDigest}`, `${kind} API digest`); exact(artifact.actualZipSha256, expectedDigest, `${kind} raw ZIP digest`);
    exact(artifact.actualZipBytes, api.size_in_bytes, `${kind} raw ZIP size`);
    const runMeta = record(api.workflow_run, `${kind} artifact workflow run`);
    exact(String(integer(runMeta.id, 'Artifact run ID')), runId, `${kind} artifact run`);
    exact(runMeta.repository_id, c.repositoryId, `${kind} artifact repository ID`); exact(runMeta.head_repository_id, c.repositoryId, `${kind} artifact head repository`);
    exact(runMeta.head_branch, 'main', `${kind} artifact branch`); exact(runMeta.head_sha, toolSha, `${kind} artifact tool SHA`);
    record(artifact.documents, `${kind} bounded JSON observations`); indexes[kind] = zipEntries(artifact, kind);
  }
  const tool = input.artifacts.tool, index = input.artifacts.index, checks = input.artifacts.checks;
  for (const name of indexes.tool.keys()) {
    const lower = name.toLowerCase();
    assert.ok(!['config/local.json', '.git', '.ci-references', 'game', '.cache', '.tools/dotnet'].some(forbidden => lower === forbidden || lower.startsWith(forbidden + '/')),
      'Forbidden local/game/cache input in tool ZIP');
    assert.ok(!/(?:^|\/)(?:\.git|\.cache|\.ci-references)(?:\/|$)/.test(lower) && !/(?:^|\/)\.tools\/dotnet(?:\/|$)/.test(lower) && !/(?:^|\/)config\/local\.json$/.test(lower), 'Nested local config/Git/cache input in tool ZIP');
    assert.ok(!/(?:^|\/)(?:smoke-cache-|package-runtime-)[^/]*(?:\/|$)/.test(lower) && !lower.endsWith('/.package-smoke-owner') && lower !== '.package-smoke-owner' && !/(?:^|\/)bridge\/runtime(?:\.json)?$/.test(lower), 'Runtime fixture/credentials remain in tool ZIP');
    assert.ok(!/^(?:unityengine|unityeditor|unity\.scripting|assembly-csharp|gamedemo02)(?:[.-].*)?\.dll$/i.test(name.split('/').at(-1)!), 'Unity or target-game DLL in tool ZIP');
  }
  const build = document(tool, indexes.tool, 'build-manifest.json');
  for (const [key, expected] of Object.entries({ schemaVersion: 1, toolSha, sourceDirty: false, execution: 'github-actions', runId, attempt: producerAttempt,
    runUrl: producerUrl, kind: 'windows-source-runtime-build', dependencyLayout: 'offline-frozen-hoisted-copy', containsGameSourceExcerpts: true })) exact(build[key], expected, `Build ${key}`);
  const delivery = document(checks, indexes.checks, 'delivery-result.json');
  for (const [key, expected] of Object.entries({ schemaVersion: 1, contractVersion: '1', toolSha, targetRunUrl: producerUrl,
    checksOutcome: 'success', toolBuildCompleted: true, packageOutcome: 'success', packageRuntimeOutcome: 'success', authorizationOutcome: 'success', indexOutcome: 'success', indexVerified: true })) exact(delivery[key], expected, `Delivery ${key}`);
  assert.deepEqual(delivery.source, { repository: RELEASE_GAME_REPOSITORY, ref: 'refs/heads/main', sha: gameSha, runId: sourceRunId, attempt: sourceAttempt, url: sourceUrl }, 'Delivery source binding');
  const smokePath = `package-smoke-${packageId}.json`, smoke = document(checks, indexes.checks, smokePath);
  for (const [key, expected] of Object.entries({ outcome: 'passed', execution: 'github-actions', runUrl: producerUrl, sourceDirty: false, toolSha, packageId,
    containsGameSourceExcerpts: true, humanModelBytesPreserved: true, cleanupVerified: true, fixtureRuntimeCredentialsRemoved: true })) exact(smoke[key], expected, `Unique runtime receipt ${key}`);
  integer(smoke.sourceQuoteAnchorCount, 'Smoke preserved source quote count');
  const prefix = `${gameSha}/${runId}-${producerAttempt}/index-evidence/`;
  const before = document(index, indexes.index, prefix + 'read-only-before.json'), after = document(index, indexes.index, prefix + 'read-only-after.json');
  const attestedHumanFiles = new Set(sourceHashes(before.humanModels, 'Before human models').map(([name]) => 'human-models/' + name));
  const attestedHumanDirectories = new Set<string>();
  for (const name of attestedHumanFiles) {
    const parts = name.split('/');
    for (let count = 1; count < parts.length; count++) attestedHumanDirectories.add(parts.slice(0, count).join('/'));
    const copied = indexes.index.get(prefix + name);
    assert.ok(copied && !copied.isDirectory, 'Attested human model or README is missing from index ZIP');
  }
  const indexParents = [gameSha, `${gameSha}/${runId}-${producerAttempt}`, prefix.slice(0, -1), 'authorization'];
  for (const [name, entry] of indexes.index) {
    assert.ok(entry.isDirectory && indexParents.includes(name) || name === 'authorization/authorization.json' || name.startsWith(prefix), 'Index ZIP contains another binding or unrelated payload');
    if (name.startsWith(prefix)) {
      const relative = name.slice(prefix.length).toLowerCase();
      assert.ok(relative !== 'failure.json' && !relative.startsWith('failed/') && relative !== 'failed', 'Index ZIP contains failed-attempt evidence');
      assert.ok(!/(?:^|\/)(?:\.cache|\.ci-references|\.git|smoke-cache-[^/]*)(?:\/|$)/.test(relative), 'Index ZIP contains a cache or runtime fixture');
      const originalRelative = name.slice(prefix.length);
      if (relative === 'human-models' || relative.startsWith('human-models/')) {
        assert.ok(entry.isDirectory ? attestedHumanDirectories.has(originalRelative) : attestedHumanFiles.has(originalRelative), 'Unattested human model/README in index ZIP');
      } else assert.ok(entry.isDirectory || /\.(?:json|log)$/i.test(name), 'Index ZIP contains target code or binary payload');
    }
  }
  const snapshot = document(index, indexes.index, prefix + 'manifest.json');
  for (const [key, expected] of Object.entries({ schemaVersion: '1.0.0', kind: 'ci-snapshot-evidence', outcome: 'success', readOnlyVerified: true })) exact(snapshot[key], expected, `Snapshot ${key}`);
  assert.ok(snapshot.incomplete === undefined || snapshot.incomplete === false, 'Incomplete snapshot cannot form a release');
  assert.deepEqual(snapshot.tool, { repository: RELEASE_REPOSITORY, sha: toolSha }, 'Snapshot tool binding');
  assert.deepEqual(snapshot.game, { repository: RELEASE_GAME_REPOSITORY, sha: gameSha }, 'Snapshot game binding');
  assert.deepEqual(snapshot.dispatch, { contractVersion: '1', sourceRef: 'refs/heads/main' }, 'Snapshot dispatch binding');
  assert.deepEqual(snapshot.sourceRun, { id: sourceRunId, attempt: sourceAttempt, url: sourceUrl, attemptUrl: `${sourceUrl}/attempts/${sourceAttempt}` }, 'Snapshot source attempt');
  assert.deepEqual(snapshot.targetRun, { id: runId, attempt: producerAttempt, url: producerUrl }, 'Snapshot producer attempt');
  const indexJson = document(index, indexes.index, prefix + 'index.json'), metadata = record(indexJson.metadata, 'Index metadata');
  exact(sha(metadata.gitHead, 'Index HEAD'), gameSha, 'Exact index game HEAD'); exact(metadata.gitDirty, false, 'Index clean');
  exact(metadata.gitStatusHash, releaseSha256(''), 'Git status was actually read clean'); exact(metadata.scopeId, 'game-demo-02:primary', 'Index scope');
  assert.ok(array(indexJson.files, 'Index files').length > 0, 'Empty game index');
  const diagnostics = array(indexJson.diagnostics, 'Index diagnostics');
  assert.ok(!diagnostics.some(item => record(item, 'Index diagnostic').code === 'git-unavailable'), 'Git read failure cannot pass');
  const snapshotIndex = record(snapshot.index, 'Snapshot index fingerprint');
  for (const key of ['revision', 'analyzerVersion', 'schemaVersion', 'generatedAt', 'configFingerprint', 'compilationFingerprint']) {
    text(metadata[key], `Index ${key}`); exact(snapshotIndex[key], metadata[key], `Snapshot/index ${key}`);
  }
  match(snapshotIndex.revision, /^[a-f0-9]{24}$/, 'Snapshot index revision');
  for (const key of ['configFingerprint', 'compilationFingerprint', 'referenceFingerprint', 'sourceFingerprint']) digest(snapshotIndex[key], `Snapshot ${key}`);
  date(metadata.generatedAt, 'Index generated time');
  exact(before.head, gameSha, 'Read-only before HEAD'); exact(after.head, gameSha, 'Read-only after HEAD');
  exact(before.status, '', 'Read-only before clean'); exact(after.status, '', 'Read-only after clean');
  sourceHashes(before.sourceHashes, 'Before source hashes'); sourceHashes(after.sourceHashes, 'After source hashes');
  assert.deepEqual(after.sourceHashes, before.sourceHashes, 'Source bytes changed');
  const sourceFingerprint = releaseSha256(JSON.stringify(before.sourceHashes));
  exact(before.sourceFingerprint, sourceFingerprint, 'Before source fingerprint'); exact(after.sourceFingerprint, sourceFingerprint, 'After source fingerprint');
  exact(snapshotIndex.sourceFingerprint, sourceFingerprint, 'Snapshot source fingerprint');
  sourceHashes(before.humanModels, 'Before human models'); sourceHashes(after.humanModels, 'After human models');
  assert.deepEqual(after.humanModels, before.humanModels, 'Human model/anchor/review bytes changed');
  exact(snapshot.humanModelFingerprint, releaseSha256(JSON.stringify(before.humanModels)), 'Human model fingerprint');
  const audit = document(index, indexes.index, prefix + 'audit.json'), auditSnapshot = record(audit.snapshot, 'Audit snapshot');
  exact(audit.schemaVersion, '1.0.0', 'Audit schema'); assert.ok(['consistent', 'gaps'].includes(audit.result), 'Audit must be valid and complete');
  exact(snapshot.auditResult, audit.result, 'Snapshot/audit result'); exact(auditSnapshot.gitHead, gameSha, 'Audit game HEAD');
  exact(auditSnapshot.gitStatusHash, releaseSha256(''), 'Audit clean Git proof'); exact(auditSnapshot.scopeId, metadata.scopeId, 'Audit scope');
  exact(auditSnapshot.sourceRevision, metadata.revision, 'Audit/index revision'); exact(auditSnapshot.analyzerVersion, metadata.analyzerVersion, 'Audit analyzer');
  exact(auditSnapshot.sourceSchemaVersion, metadata.schemaVersion, 'Audit index schema'); exact(auditSnapshot.indexGeneratedAt, metadata.generatedAt, 'Audit index time');
  const auditCoverage = record(audit.coverage, 'Audit coverage'); exact(auditCoverage.runtimeVerificationClaimedByAudit, false, 'Static audit must not claim runtime proof');
  const reviews = reviewCounts(auditCoverage.reviews); assert.deepEqual(snapshot.reviews, auditCoverage.reviews, 'Review coverage changed');
  const semanticDiagnostics = diagnostics.filter(item => typeof item.code === 'string' && item.code.startsWith('CS_') && item.severity !== 'info');
  assert.deepEqual(snapshot.semanticDiagnostics, semanticDiagnostics, 'Semantic diagnostics changed');
  exact(snapshot.semanticCoverage, semanticDiagnostics.length ? 'partial-semantic-context' : 'configured-static-analysis', 'Honest semantic scope');
  const limitations = array(snapshot.limitations, 'Snapshot limitations', 200).map(value => text(value, 'Snapshot limitation'));
  assert.ok(limitations.length > 0, 'Snapshot limitations must be retained');
  const refs = document(index, indexes.index, prefix + 'references.json');
  exact(refs.unityVersion, snapshotIndex.unityVersion, 'Reference Unity version'); match(refs.unityVersion, /^[0-9]+\.[0-9]+\.[0-9]+[abfp][0-9]+$/, 'Exact Unity version');
  const fingerprints = array(refs.references, 'Reference fingerprints', 512), referenceNames = new Set<string>(); assert.ok(fingerprints.length > 0, 'Reference fingerprints missing');
  for (const raw of fingerprints) { const ref = record(raw, 'Reference fingerprint'); const name = match(ref.file, /^[A-Za-z0-9_.-]+\.dll$/, 'Reference DLL');
    assert.ok(!referenceNames.has(name.toLowerCase()), 'Duplicate reference DLL'); referenceNames.add(name.toLowerCase()); digest(ref.sha256, 'Reference digest'); }
  assert.ok(referenceNames.has('unityengine.coremodule.dll') && !referenceNames.has('unityengine.dll'), 'Reference module boundary');
  const defines = array(refs.defines, 'Reference defines', 200); for (const define of defines) match(define, /^[A-Za-z_][A-Za-z0-9_]*$/, 'Reference define');
  exact(snapshotIndex.referenceFingerprint, releaseSha256(JSON.stringify({ unityVersion: refs.unityVersion, fingerprints, defines })), 'Reference fingerprint');
  const auth = document(index, indexes.index, 'authorization/authorization.json');
  for (const [key, expected] of Object.entries({ schemaVersion: 1, contractVersion: '1', sourceRepository: RELEASE_GAME_REPOSITORY,
    sourceRef: 'refs/heads/main', toolRepository: RELEASE_REPOSITORY, gameSha, toolSha })) exact(auth[key], expected, `Authorization ${key}`);
  const authRun = record(auth.sourceRun, 'Authorized source run');
  for (const [key, expected] of Object.entries({ id: sourceRunId, attempt: sourceAttempt, url: sourceUrl, attemptUrl: `${sourceUrl}/attempts/${sourceAttempt}` })) exact(authRun[key], expected, `Authorized source ${key}`);
  assert.ok(['completed', 'in_progress', 'queued', 'waiting', 'pending', 'requested'].includes(authRun.statusAtAuthorization), 'Unknown authorized source status');
  assert.deepEqual(auth.prerequisites, ['fast-gate'], 'Authorized source jobs'); assert.deepEqual(auth.requiredPrCheckContexts, ['fast-gate'], 'Authorized required contexts');
  let approvalCount = 0;
  for (const key of ['gameProtection', 'toolProtection']) { const policy = record(auth[key], key);
    assert.ok(key === 'gameProtection' ? ['ruleset', 'classic'].includes(policy.type) : policy.type === 'ruleset', `${key} policy type`);
    exact(policy.requiresIndependentReview, true, `${key} independent review`); const count = integer(policy.requiredApprovingReviewCount, `${key} approval count`);
    exact(policy.bypassPermissions, 'manually-reviewed', `${key} bypass review`);
    assert.ok(array(policy.requiredCheckContexts, `${key} contexts`, 20).includes(key === 'gameProtection' ? 'fast-gate' : toolCheck), `${key} required context`);
    if (key === 'gameProtection') approvalCount = count;
  }
  const merged = record(auth.mergedPr, 'Merged game PR'); integer(merged.number, 'Merged PR number'); exact(merged.mergeSha, gameSha, 'Merged game SHA');
  const reviewedHead = sha(merged.headSha, 'Reviewed game PR head'), mergedTime = date(merged.mergedAt, 'Game merge time');
  exact(merged.url, `https://github.com/${RELEASE_GAME_REPOSITORY}/pull/${merged.number}`, 'Merged PR URL');
  const reviewers = new Set<number>(); for (const raw of array(merged.approvals, 'Independent approvals', 100)) { const approval = record(raw, 'Independent approval');
    integer(approval.reviewId, 'Review ID'); reviewers.add(integer(approval.reviewerId, 'Reviewer ID'));
    match(approval.reviewer, /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/, 'Human reviewer login');
    exact(approval.commitId, reviewedHead, 'Exact approved game head'); assert.ok(date(approval.submittedAt, 'Approval time') <= mergedTime, 'Approval after merge'); }
  assert.ok(reviewers.size >= approvalCount, 'Insufficient distinct approved reviewers');

  const assets = (['tool', 'index'] as const).map(kind => { const artifact = input.artifacts[kind], api = record(artifact.metadata, 'Artifact'); return {
    kind, name: kind === 'tool' ? `Architecture-Explorer-win-x64-${toolSha}-r${runId}-a${producerAttempt}.zip` : `GameDemo02-index-${gameSha}-tool-${toolSha}-r${runId}-a${producerAttempt}.zip`,
    size: artifact.actualZipBytes, sha256: artifact.actualZipSha256, artifactId: api.id as number, artifactName: api.name as string, artifactDigest: api.digest as string,
  }; }) as [ReleaseAssetPin, ReleaseAssetPin];
  const tagName = `ae-tool-${toolSha}-game-${gameSha}-r${runId}-a${producerAttempt}`;
  const core = { schemaVersion: '1.0.0' as const, kind: 'architecture-explorer-private-tool-release-draft' as const, repository: RELEASE_REPOSITORY,
    draft: true, automaticPublication: false, tool: { repository: RELEASE_REPOSITORY, sha: toolSha }, game: { repository: RELEASE_GAME_REPOSITORY, sha: gameSha },
    dispatch: Object.fromEntries(sourceKeys.map(key => [key, source[key]])), sourceRun: { id: sourceRunId, attempt: sourceAttempt, url: sourceUrl },
    producerRun: { id: runId, attempt: producerAttempt, url: producerUrl, workflow: workflowPath, job: buildJobName }, packageId, tagName,
    assets, checksArtifact: { id: record(checks.metadata, 'Checks artifact').id, name: artifactNames.checks, sha256: checks.actualZipSha256 },
    evidence: { indexRevision: metadata.revision, analyzerVersion: metadata.analyzerVersion, indexSchemaVersion: metadata.schemaVersion,
      configFingerprint: snapshotIndex.configFingerprint, compilationFingerprint: snapshotIndex.compilationFingerprint,
      referenceFingerprint: snapshotIndex.referenceFingerprint, unityVersion: snapshotIndex.unityVersion, sourceFingerprint,
      humanModelFingerprint: snapshot.humanModelFingerprint, readOnlyVerified: true, auditResult: audit.result, reviews,
      semanticCoverage: snapshot.semanticCoverage, semanticDiagnosticCount: semanticDiagnostics.length, limitations },
    access: 'Private tool release draft. Contains game source excerpts; readers must remain within the approved game audience. User publishes manually.',
    limitations: ['No game build or target code execution', 'No local cache import or installer', 'No Unity DLL distribution', 'Not a Game Windows Release'],
  };
  const bindingFingerprint = releaseSha256(canonicalReleaseJson(core));
  const releaseManifest = { ...core, bindingFingerprint }, releaseManifestJson = JSON.stringify(releaseManifest, null, 2) + '\n';
  const result: ValidatedReleasePlan = { schemaVersion: '1.0.0', kind: core.kind, repository: RELEASE_REPOSITORY, toolSha, gameSha,
    producerRunId: runId, producerRunAttempt: producerAttempt, sourceRunId, sourceRunAttempt: sourceAttempt, tagName, bindingFingerprint,
    assets, releaseManifest, releaseManifestJson, releaseManifestAsset: { name: 'release-manifest.json', size: Buffer.byteLength(releaseManifestJson), sha256: releaseSha256(releaseManifestJson) } };
  const frozen = deepFreeze(copiedJson(result)); validatedPlans.add(frozen); return frozen;
}

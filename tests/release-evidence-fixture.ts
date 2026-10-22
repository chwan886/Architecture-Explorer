import { releaseSha256, type ReleaseArtifactEvidence, type ReleaseEvidenceInput } from '../Tools/ci-release-evidence.ts';

// Synthetic, already-read adapter observations. These are not real GitHub runs or target programs.
export const fixtureArchiveBytes = {
  tool: Buffer.from('opaque synthetic tool artifact archive bytes'),
  index: Buffer.from('opaque synthetic index artifact archive bytes'),
  checks: Buffer.from('opaque synthetic checks artifact archive bytes'),
};
const toolSha = '1'.repeat(40), gameSha = '2'.repeat(40), headSha = '3'.repeat(40);
const h = releaseSha256;
const reviews = { ownership: { pending: 1 }, entities: { confirmed: 1, pending: 2 }, architectureFlows: { pending: 1 },
  semanticFlows: { pending: 1 }, semanticNodes: { pending: 2 }, semanticEdges: { pending: 1 } };

export function releaseEvidenceFixture(producerAttempt = '1'): ReleaseEvidenceInput {
  const runId = '9001', attempt = producerAttempt, sourceId = '8001', sourceAttempt = '2';
  const toolRepo = 'chwan886/Architecture-Explorer', gameRepo = 'chwan886/GameDemo02';
  const producerUrl = `https://github.com/${toolRepo}/actions/runs/${runId}/attempts/${attempt}`;
  const sourceUrl = `https://github.com/${gameRepo}/actions/runs/${sourceId}`;
  const packageId = `tool-${toolSha}-${runId}-${attempt}`, prefix = `${gameSha}/${runId}-${attempt}/index-evidence/`;
  const sourceHashes = [['Assets/Game/Actor.cs', h('synthetic source bytes')]];
  // humanModelHashes copies every maintained file, including README.md, not just JSON models.
  const humanModels = [['architecture/models/game-demo-02/model.json', h('unchanged synthetic human text and pending anchors')],
    ['architecture/models/game-demo-02/README.md', h('unchanged synthetic maintained README')],
    ['architecture/semantics/game-demo-02/README.md', h('unchanged synthetic semantic README')]];
  const before = { head: gameSha, status: '', sourceHashes, sourceFingerprint: h(JSON.stringify(sourceHashes)), humanModels };
  const diagnostics = [{ code: 'CS_CS0246', severity: 'warning', message: 'Synthetic missing optional context; preserved as partial.' }];
  const metadata = { gitHead: gameSha, gitDirty: false, gitStatusHash: h(''), scopeId: 'game-demo-02:primary',
    revision: h('revision').slice(0, 24), analyzerVersion: 'synthetic-analyzer-1', schemaVersion: '1.0.0', generatedAt: '2026-10-22T01:00:00.000Z',
    configFingerprint: h('config'), compilationFingerprint: h('compilation') };
  const fingerprints = [{ file: 'UnityEngine.CoreModule.dll', sha256: h('synthetic metadata') }];
  const refs = { unityVersion: '6000.6.5f1', defines: ['DEBUG'], references: fingerprints };
  const referenceFingerprint = h(JSON.stringify({ unityVersion: refs.unityVersion, fingerprints, defines: refs.defines }));
  const snapshot = { schemaVersion: '1.0.0', kind: 'ci-snapshot-evidence', outcome: 'success', readOnlyVerified: true,
    tool: { repository: toolRepo, sha: toolSha }, game: { repository: gameRepo, sha: gameSha },
    dispatch: { contractVersion: '1', sourceRef: 'refs/heads/main' },
    sourceRun: { id: sourceId, attempt: sourceAttempt, url: sourceUrl, attemptUrl: `${sourceUrl}/attempts/${sourceAttempt}` },
    targetRun: { id: runId, attempt, url: producerUrl },
    index: { revision: metadata.revision, analyzerVersion: metadata.analyzerVersion, schemaVersion: metadata.schemaVersion,
      generatedAt: metadata.generatedAt, configFingerprint: metadata.configFingerprint, compilationFingerprint: metadata.compilationFingerprint,
      referenceFingerprint, unityVersion: refs.unityVersion, sourceFingerprint: before.sourceFingerprint },
    humanModelFingerprint: h(JSON.stringify(humanModels)), auditResult: 'gaps', reviews,
    semanticCoverage: 'partial-semantic-context', semanticDiagnostics: diagnostics,
    limitations: ['Synthetic configured static context only; pending human reviews remain pending.'] };
  const auth = { schemaVersion: 1, contractVersion: '1', sourceRepository: gameRepo, sourceRef: 'refs/heads/main', toolRepository: toolRepo,
    gameSha, toolSha, sourceRun: { id: sourceId, attempt: sourceAttempt, url: sourceUrl, attemptUrl: `${sourceUrl}/attempts/${sourceAttempt}`, statusAtAuthorization: 'completed' },
    prerequisites: ['fast-gate'], requiredPrCheckContexts: ['fast-gate'],
    gameProtection: { type: 'ruleset', requiresIndependentReview: true, requiredApprovingReviewCount: 1, requiredCheckContexts: ['fast-gate'], bypassPermissions: 'manually-reviewed' },
    toolProtection: { type: 'ruleset', requiresIndependentReview: true, requiredApprovingReviewCount: 1, requiredCheckContexts: ['Tool / typecheck, tests and builds'], bypassPermissions: 'manually-reviewed' },
    mergedPr: { number: 7, url: `https://github.com/${gameRepo}/pull/7`, mergeSha: gameSha, headSha,
      mergedAt: '2026-10-22T00:40:00Z', approvals: [{ reviewId: 21, reviewerId: 31, reviewer: 'HumanOwner', commitId: headSha, submittedAt: '2026-10-22T00:30:00Z' }] } };
  const toolDocuments = { 'build-manifest.json': { schemaVersion: 1, toolSha, sourceDirty: false, execution: 'github-actions', runId, attempt,
    runUrl: producerUrl, kind: 'windows-source-runtime-build', dependencyLayout: 'offline-frozen-hoisted-copy', containsGameSourceExcerpts: true } };
  const checksDocuments = { 'delivery-result.json': { schemaVersion: 1, contractVersion: '1', toolSha,
    source: { repository: gameRepo, ref: 'refs/heads/main', sha: gameSha, runId: sourceId, attempt: sourceAttempt, url: sourceUrl },
    targetRunUrl: producerUrl, checksOutcome: 'success', toolBuildCompleted: true, packageOutcome: 'success', packageRuntimeOutcome: 'success', authorizationOutcome: 'success', indexOutcome: 'success', indexVerified: true },
    [`package-smoke-${packageId}.json`]: { outcome: 'passed', execution: 'github-actions', runUrl: producerUrl, sourceDirty: false,
      toolSha, packageId, containsGameSourceExcerpts: true, humanModelBytesPreserved: true, cleanupVerified: true,
      fixtureRuntimeCredentialsRemoved: true, sourceQuoteAnchorCount: 2 } };
  const indexDocuments = { [prefix + 'manifest.json']: snapshot, [prefix + 'index.json']: { metadata, diagnostics, files: [{ path: 'Assets/Game/Actor.cs' }] },
    [prefix + 'read-only-before.json']: before, [prefix + 'read-only-after.json']: structuredClone(before), [prefix + 'references.json']: refs,
    [prefix + 'audit.json']: { schemaVersion: '1.0.0', result: 'gaps', snapshot: { gitHead: gameSha, gitStatusHash: h(''), scopeId: metadata.scopeId,
      sourceRevision: metadata.revision, analyzerVersion: metadata.analyzerVersion, sourceSchemaVersion: metadata.schemaVersion, indexGeneratedAt: metadata.generatedAt },
      coverage: { reviews, runtimeVerificationClaimedByAudit: false } }, 'authorization/authorization.json': auth };
  function artifact(kind: 'tool' | 'index' | 'checks', id: number, name: string, documents: Record<string, unknown>): ReleaseArtifactEvidence {
    const bytes = fixtureArchiveBytes[kind], digest = h(bytes);
    return { output: { id: String(id), digest }, actualZipBytes: bytes.byteLength, actualZipSha256: digest,
      metadata: { id, name, size_in_bytes: bytes.byteLength, digest: `sha256:${digest}`, expired: false,
        workflow_run: { id: Number(runId), repository_id: 7001, head_repository_id: 7001, head_branch: 'main', head_sha: toolSha } },
      entries: [...Object.entries(documents).map(([path, value]) => ({ path, size: Buffer.byteLength(JSON.stringify(value)), externalAttributes: 0, isDirectory: false })),
        ...(kind === 'index' ? humanModels.map(([path]) => ({ path: prefix + 'human-models/' + path, size: 40, externalAttributes: 0, isDirectory: false })) : [])], documents };
  }
  // Each ZIP document is parsed independently in production; JSON copying deliberately removes cross-document aliases.
  return JSON.parse(JSON.stringify({ context: { repository: toolRepo, repositoryId: 7001, serverUrl: 'https://github.com', isPrivate: true, visibility: 'private', defaultBranch: 'main',
    eventName: 'workflow_dispatch', ref: 'refs/heads/main', refProtected: true, effectiveProtected: true, toolSha, runId, publisherAttempt: attempt,
    indexAccessApproved: 'true', ruleBypassReviewed: 'true' }, producer: { runId, attempt, headSha: toolSha, headBranch: 'main',
    workflowPath: '.github/workflows/game-index.yml', event: 'workflow_dispatch', jobName: 'Build tool and verify exact game SHA', status: 'completed', conclusion: 'success', result: 'success' },
    dispatch: { contract_version: '1', source_repo: gameRepo, source_ref: 'refs/heads/main', source_sha: gameSha, source_run_id: sourceId, source_run_attempt: sourceAttempt, source_run_url: sourceUrl },
    artifacts: { tool: artifact('tool', 11, `tool-build-${toolSha}-${runId}-${attempt}`, toolDocuments),
      index: artifact('index', 12, `game-index-${gameSha}-${toolSha}-${runId}-${attempt}`, indexDocuments),
      checks: artifact('checks', 13, `tool-checks-${toolSha}-${runId}-${attempt}`, checksDocuments) } }));
}

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { TOOL_ROOT, loadConfig, IndexManager } from '../packages/indexer/src/index.ts';
import { git } from '../packages/indexer/src/git.ts';
import { canonical, createFilePolicy, ensureCacheDirectory, isWithin, readAuthorized } from '../packages/indexer/src/security.ts';
import { contentHash, type ArchitectureIndex, type ProjectConfig } from '../packages/schema/src/index.ts';
import { validateIndex } from '../packages/schema/src/validate.ts';
import type { EvidenceAuditReport } from '../packages/evidence-audit/src/index.ts';

export const GAME_REPOSITORY = 'chwan886/GameDemo02';
export const TOOL_REPOSITORY = 'chwan886/Architecture-Explorer';
const shaPattern = /^[a-f0-9]{40}$/;
const runPattern = /^[1-9]\d{0,19}$/;
const sourceExtensions = new Set(['.cs', '.py', '.json', '.asmdef', '.asset', '.prefab', '.unity', '.meta', '.shader', '.uss', '.tss', '.uxml']);
const projectScope = 'game-demo-02:primary';
const projectSettings = {
  id: 'game-demo-02', name: 'GameDemo02', worktrees: [], include: ['src', 'Assets/Game', 'Server'],
  exclude: ['Library', 'artifacts', 'Art', 'Logs', 'UserSettings', 'work', '.git', 'node_modules', '__pycache__', 'bin', 'obj', '**/Tests/**', '**/Editor/**', '**/test_*.py'],
};

export interface SnapshotInput {
  contractVersion: '1'; sourceRepository: string; sourceRef: 'refs/heads/main'; gameSha: string; sourceRunId: string; sourceRunAttempt: string; sourceRunUrl: string;
  gameRoot: string; unityReferences: string; toolSha: string; runId: string; runAttempt: string; runUrl: string;
  python: string; dotnet: string;
}

/** Dispatch strings are data, never shell arguments or paths. No reviewed=true assertion is accepted. */
export function snapshotInput(env: NodeJS.ProcessEnv): SnapshotInput {
  const required = (name: string) => { const value = env[name]; assert.ok(value && !value.includes('\0'), `${name} is required`); return value; };
  const contractVersion = required('CI_CONTRACT_VERSION'); assert.equal(contractVersion, '1', 'Unsupported dispatch contract version');
  const sourceRepository = required('CI_SOURCE_REPO');
  assert.equal(sourceRepository, GAME_REPOSITORY, 'Unapproved source repository');
  const sourceRef = required('CI_SOURCE_REF'); assert.equal(sourceRef, 'refs/heads/main', 'Source ref must be protected main');
  assert.equal(required('GITHUB_REPOSITORY'), TOOL_REPOSITORY, 'Unapproved tool repository');
  assert.equal(required('GITHUB_SERVER_URL'), 'https://github.com', 'Only github.com is supported');
  const gameSha = required('CI_SOURCE_SHA'), toolSha = required('GITHUB_SHA');
  assert.match(gameSha, shaPattern, 'source_sha must be an exact lowercase 40-character SHA');
  assert.match(toolSha, shaPattern, 'tool SHA must be an exact lowercase 40-character SHA');
  const sourceRunId = required('CI_SOURCE_RUN_ID'), sourceRunAttempt = required('CI_SOURCE_RUN_ATTEMPT'), runId = required('GITHUB_RUN_ID'), runAttempt = required('GITHUB_RUN_ATTEMPT');
  for (const value of [sourceRunId, sourceRunAttempt, runId, runAttempt]) assert.match(value, runPattern, 'Run identifiers and attempts must be positive integers');
  const sourceRunUrl = required('CI_SOURCE_RUN_URL');
  assert.equal(sourceRunUrl, `https://github.com/${GAME_REPOSITORY}/actions/runs/${sourceRunId}`, 'Source run URL does not match source run ID');
  return { contractVersion, sourceRepository, sourceRef, gameSha, sourceRunId, sourceRunAttempt, sourceRunUrl, toolSha, runId, runAttempt,
    runUrl: `https://github.com/${TOOL_REPOSITORY}/actions/runs/${runId}/attempts/${runAttempt}`,
    gameRoot: required('CI_GAME_ROOT'), unityReferences: required('CI_UNITY_REFERENCES'),
    python: env.CI_PYTHON ?? 'python', dotnet: env.CI_DOTNET ?? 'dotnet' };
}

export interface ReadOnlyState { head: string; status: string; sourceHashes: Array<[string, string]>; sourceFingerprint: string }

/** Strict Git reads: unlike the local explorer's plain-directory fallback, every error aborts CI. */
export async function captureReadOnlyState(root: string, expectedSha: string, project: Pick<ProjectConfig, 'include' | 'exclude'>): Promise<ReadOnlyState> {
  assert.match(expectedSha, shaPattern, 'Expected game SHA is missing or invalid');
  assert.equal(canonical((await git(root, ['rev-parse', '--show-toplevel'])).trim()), canonical(root), 'Game root must be a checkout root');
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  assert.equal(head, expectedSha, 'Game checkout HEAD does not match requested SHA');
  const origin = (await git(root, ['remote', 'get-url', 'origin'])).trim();
  assert.ok([`https://github.com/${GAME_REPOSITORY}.git`, `https://github.com/${GAME_REPOSITORY}`, `git@github.com:${GAME_REPOSITORY}.git`].includes(origin), 'Game origin is not the allowed repository');
  const mainHead = (await git(root, ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'])).trim();
  assert.match(mainHead, shaPattern, 'Fetched origin/main is required');
  await git(root, ['merge-base', '--is-ancestor', expectedSha, 'refs/remotes/origin/main']);
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  assert.equal(status, '', 'Game checkout must be clean, including untracked files');
  const policy = createFilePolicy(project.include, project.exclude);
  const files = (await git(root, ['ls-files', '-z', '--cached'])).split('\0').filter(Boolean)
    .filter(file => policy.included(file) && sourceExtensions.has(path.extname(file).toLowerCase())).sort();
  assert.ok(files.length > 0 && files.length <= 50000, 'No eligible source files or source file budget exceeded');
  const sourceHashes: Array<[string, string]> = []; let totalBytes = 0;
  for (const file of files) {
    // Hash the original bytes, including binary/unsupported text the scanner may explicitly skip.
    const bytes = await readAuthorized(root, file, 32 * 1024 * 1024);
    totalBytes += bytes.length; assert.ok(totalBytes <= 512 * 1024 * 1024, 'Read-only integrity check exceeds 512 MiB budget');
    sourceHashes.push([file, contentHash(bytes)]);
  }
  return { head, status, sourceHashes, sourceFingerprint: contentHash(JSON.stringify(sourceHashes)) };
}

export function assertReadOnlyState(before: ReadOnlyState, after: ReadOnlyState): void {
  assert.equal(after.head, before.head, 'Game HEAD changed during Scan/Verify/Audit');
  assert.equal(after.status, before.status, 'Game working directory changed during Scan/Verify/Audit');
  assert.deepEqual(after.sourceHashes, before.sourceHashes, 'Game source bytes changed during Scan/Verify/Audit');
}

export function assertIndexCommit(index: ArchitectureIndex, expectedSha: string, before: ReadOnlyState): void {
  assert.match(index.metadata.gitHead, shaPattern, 'Index HEAD must be nonempty and readable');
  assert.equal(index.metadata.gitHead, expectedSha, 'Index SHA does not match dispatched game SHA');
  assert.equal(index.metadata.gitHead, before.head, 'Index SHA does not match attested checkout');
  assert.equal(index.metadata.gitDirty, false, 'Index reports a dirty game checkout');
  assert.equal(index.metadata.gitStatusHash, contentHash(''), 'Index Git status must be confirmed clean');
  assert.equal(index.metadata.scopeId, projectScope, 'Unexpected index scope');
  assert.ok(!index.diagnostics.some(item => item.code === 'git-unavailable'), 'Index reports unavailable Git metadata');
  assert.ok(index.files.length > 0, 'An empty index is not a successful game scan');
}

interface ReferenceEntry { path: string; sha256: string }
export interface ReferenceManifest { unityVersion: string; references: ReferenceEntry[]; defines?: string[] }
export async function prepareReferences(manifestPath: string, gameRoot: string, toolRoot = TOOL_ROOT) {
  const resolved = await realpath(manifestPath);
  assert.ok(isWithin(toolRoot, resolved) && !isWithin(gameRoot, resolved), 'Reference manifest must be prepared on the tool side');
  const bytes = await readFile(resolved); assert.ok(bytes.length <= 1024 * 1024, 'Reference manifest exceeds 1 MiB');
  const raw: ReferenceManifest = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  assert.ok(raw && typeof raw === 'object' && /^[0-9]+\.[0-9]+\.[0-9]+[abfp][0-9]+$/.test(raw.unityVersion), 'Reference manifest requires an exact Unity editor version');
  const gameVersion = await readAuthorized(gameRoot, 'ProjectSettings/ProjectVersion.txt');
  assert.equal(/^m_EditorVersion:\s*(\S+)\s*$/m.exec(gameVersion.toString('utf8'))?.[1], raw.unityVersion, 'Unity references version differs from the game checkout');
  assert.ok(Array.isArray(raw.references) && raw.references.length > 0 && raw.references.length <= 512, 'Unity metadata references are required; missing references block the snapshot');
  assert.ok(raw.defines === undefined || (Array.isArray(raw.defines) && raw.defines.every(value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value))), 'Invalid C# preprocessor defines');
  const references: string[] = [], fingerprints: Array<{ file: string; sha256: string }> = [];
  const names = new Set<string>();
  for (const entry of raw.references) {
    assert.ok(entry && typeof entry.path === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256), 'Invalid reference entry or SHA256');
    const file = await realpath(path.resolve(path.dirname(resolved), entry.path));
    assert.ok(isWithin(toolRoot, file) && !isWithin(gameRoot, file), 'Reference DLL must stay on the tool side');
    const name = path.basename(file);
    assert.equal(path.extname(file).toLowerCase(), '.dll', 'References must be assembly metadata DLLs');
    assert.ok(!names.has(name.toLowerCase()), 'Duplicate assembly name in references'); names.add(name.toLowerCase());
    const reference = await readFile(file);
    assert.equal(contentHash(reference), entry.sha256, `Reference fingerprint mismatch: ${name}`);
    references.push(file); fingerprints.push({ file: name, sha256: entry.sha256 });
  }
  assert.ok(names.has('unityengine.coremodule.dll'), 'UnityEngine.CoreModule.dll is required; Unity stubs are prohibited');
  assert.ok(!names.has('unityengine.dll'), 'Do not combine the UnityEngine aggregate DLL with module metadata');
  return { references, defines: raw.defines ?? [], unityVersion: raw.unityVersion,
    referenceFingerprint: contentHash(JSON.stringify({ unityVersion: raw.unityVersion, fingerprints, defines: raw.defines ?? [] })), fingerprints };
}

async function humanModelHashes(root: string): Promise<Array<[string, string]>> {
  const result: Array<[string, string]> = [];
  const visit = async (directory: string) => {
    let entries; try { entries = await readdir(path.join(root, directory), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      assert.ok(!entry.isSymbolicLink(), 'Human model files must not be symbolic links');
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(relative);
      else if (entry.isFile()) result.push([relative, contentHash(await readAuthorized(root, relative, 16 * 1024 * 1024))]);
    }
  };
  await visit('architecture/models/game-demo-02'); await visit('architecture/semantics/game-demo-02');
  return result;
}

async function executeStage(name: string, args: string[], logDirectory: string): Promise<void> {
  const stdout: Buffer[] = [], stderr: Buffer[] = []; let size = 0;
  const log = async () => { await writeFile(path.join(logDirectory, `${name}.stdout.log`), Buffer.concat(stdout)); await writeFile(path.join(logDirectory, `${name}.stderr.log`), Buffer.concat(stderr)); };
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', ...args], { cwd: TOOL_ROOT, shell: false, windowsHide: true,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { child.kill(); reject(new Error(`${name} exceeded 15 minutes`)); }, 15 * 60 * 1000);
      const collect = (destination: Buffer[]) => (chunk: Buffer) => { size += chunk.length; if (size > 32 * 1024 * 1024) { child.kill(); reject(new Error(`${name} log budget exceeded`)); } else destination.push(chunk); };
      child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${name} failed (${code}); see preserved diagnostics`)); });
    });
  } finally { await log(); }
}

export async function runSnapshot(input: SnapshotInput): Promise<string> {
  const toolRoot = await realpath(TOOL_ROOT), gameRoot = await realpath(input.gameRoot);
  assert.ok(!isWithin(toolRoot, gameRoot) && !isWithin(gameRoot, toolRoot), 'Game and tool checkouts must be disjoint');
  assert.equal((await git(toolRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim(), input.toolSha, 'Actual tool SHA differs from run SHA');
  await git(toolRoot, ['diff', '--quiet', 'HEAD', '--']);
  // This branch is checked independently of the dispatch payload. Authorization additionally verifies GitHub main protection and the successful source run.
  await git(toolRoot, ['merge-base', '--is-ancestor', input.toolSha, 'refs/remotes/origin/main']);
  const references = await prepareReferences(input.unityReferences, gameRoot, toolRoot);
  const output = path.join(toolRoot, '.ci-output', input.gameSha, `${input.runId}-${input.runAttempt}`);
  assert.ok(!await lstat(output).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }), 'Output exists; commit/run/attempt evidence must never be overwritten');
  await ensureCacheDirectory(output, toolRoot);
  const evidence = await ensureCacheDirectory(path.join(output, 'index-evidence'), toolRoot);
  const logs = await ensureCacheDirectory(path.join(evidence, 'logs'), toolRoot);
  const configPath = path.join(output, 'config.json');
  const config = { cacheDir: path.join(output, 'cache'), python: input.python, dotnet: input.dotnet,
    projects: [{ ...projectSettings, root: gameRoot, references: references.references, defines: references.defines }] };
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  const before = await captureReadOnlyState(gameRoot, input.gameSha, config.projects[0]);
  const modelBefore = await humanModelHashes(toolRoot);
  await writeFile(path.join(evidence, 'read-only-before.json'), JSON.stringify({ ...before, humanModels: modelBefore }, null, 2) + '\n');
  let failure: unknown; let readOnlyVerified = false;
  try {
    console.log(`CI snapshot: ${input.gameSha}; ${input.runUrl}`);
    const scopeArgs = ['--config', configPath, '--project', 'game-demo-02', '--worktree', 'primary'];
    await executeStage('scan', ['apps/server/src/cli.ts', 'scan', '--full', ...scopeArgs], logs);
    await executeStage('verify', ['apps/server/src/cli.ts', 'verify', ...scopeArgs], logs);
    await executeStage('audit', ['Tools/audit-evidence.ts', ...scopeArgs], logs);
    const manager = new IndexManager(await loadConfig(configPath));
    let index: ArchitectureIndex;
    try {
      await manager.initialize(); const scope = manager.scope(projectScope);
      const value: unknown = JSON.parse((await readFile(path.join(scope.cachePath, 'lastgood.json'))).toString('utf8'));
      validateIndex(value); index = value; assertIndexCommit(index, input.gameSha, before);
      assert.equal(canonical(index.metadata.rootPath), canonical(gameRoot), 'Index root differs from attested checkout');
      for (const name of ['architecture.json', 'semantics.json']) await copyFile(path.join(scope.cachePath, name), path.join(evidence, name));
    } finally { await manager.close(); }
    const auditPath = path.join(output, 'cache', 'evidence-audit', 'game-demo-02-primary.json');
    const audit: EvidenceAuditReport = JSON.parse(await readFile(auditPath, 'utf8'));
    assert.equal(audit.snapshot.gitHead, input.gameSha, 'Audit SHA differs from requested game SHA');
    assert.equal(audit.snapshot.sourceRevision, index.metadata.revision, 'Audit and index revisions differ');
    assert.ok(['consistent', 'gaps'].includes(audit.result), 'Audit is invalid or incomplete');
    const semanticDiagnostics = index.diagnostics.filter(item => item.code.startsWith('CS_') && item.severity !== 'info');
    const limitations = [...index.metadata.coverage.limitations,
      'CI snapshot evidence only. No local cache installation/import contract is provided; copying this package over .cache is unsupported.',
      'Human responsibilities, explanations and reviews were read unchanged; stale mappings and pending reviews remain pending.',
      'This scan parses target source and reads assembly metadata; it executes no target Python, target assembly or game build.',
      'Remote Fast checks do not establish Unity Full. Daily Full is landscape only; portrait validation belongs to Release.',
      ...(semanticDiagnostics.length ? [`Partial C# semantic context: ${semanticDiagnostics.length} compiler/context warnings are preserved in index diagnostics; this is not a successful Unity compilation.`] : ['Configured Unity metadata was available; actual Unity assembly-by-assembly compilation was not performed.'])];
    await writeFile(path.join(evidence, 'index.json'), JSON.stringify(index));
    await copyFile(auditPath, path.join(evidence, 'audit.json'));
    await writeFile(path.join(evidence, 'references.json'), JSON.stringify({ unityVersion: references.unityVersion, defines: references.defines, references: references.fingerprints }, null, 2));
    for (const [relative] of modelBefore) {
      const destination = path.join(evidence, 'human-models', relative);
      await mkdir(path.dirname(destination), { recursive: true }); await copyFile(path.join(toolRoot, relative), destination);
    }
    await writeFile(path.join(evidence, 'manifest.json'), JSON.stringify({ schemaVersion: '1.0.0', kind: 'ci-snapshot-evidence', outcome: 'pending-read-only-verification',
      tool: { repository: TOOL_REPOSITORY, sha: input.toolSha }, game: { repository: GAME_REPOSITORY, sha: input.gameSha },
      dispatch: { contractVersion: input.contractVersion, sourceRef: input.sourceRef },
      sourceRun: { id: input.sourceRunId, attempt: input.sourceRunAttempt, url: input.sourceRunUrl, attemptUrl: `${input.sourceRunUrl}/attempts/${input.sourceRunAttempt}` }, targetRun: { id: input.runId, attempt: input.runAttempt, url: input.runUrl },
      index: { revision: index.metadata.revision, analyzerVersion: index.metadata.analyzerVersion, schemaVersion: index.metadata.schemaVersion,
        generatedAt: index.metadata.generatedAt, configFingerprint: index.metadata.configFingerprint, compilationFingerprint: index.metadata.compilationFingerprint,
        referenceFingerprint: references.referenceFingerprint, unityVersion: references.unityVersion, sourceFingerprint: before.sourceFingerprint },
      semanticCoverage: semanticDiagnostics.length ? 'partial-semantic-context' : 'configured-static-analysis', semanticDiagnostics,
      auditResult: audit.result, reviews: audit.coverage.reviews, humanModelFingerprint: contentHash(JSON.stringify(modelBefore)),
      limitations, access: 'Must remain within the source game repository audience. Contains game source excerpts. Never publish to public Pages or Releases.' }, null, 2) + '\n');
  } catch (error) { failure = error; }
  // Run even after a failed parser/verification/audit. A clean Git flag alone cannot establish the read-only boundary.
  try {
    const after = await captureReadOnlyState(gameRoot, input.gameSha, config.projects[0]);
    const modelAfter = await humanModelHashes(toolRoot);
    await writeFile(path.join(evidence, 'read-only-after.json'), JSON.stringify({ ...after, humanModels: modelAfter }, null, 2) + '\n');
    assertReadOnlyState(before, after); assert.deepEqual(modelAfter, modelBefore, 'Scan/Audit changed human explanations, anchors or reviews');
    await git(toolRoot, ['diff', '--quiet', 'HEAD', '--']); readOnlyVerified = true;
  } catch (error) { failure = new AggregateError(failure ? [failure, error] : [error], 'Read-only boundary could not be confirmed'); }
  if (failure) {
    // Failed Audit may already have a valuable report. Preserve diagnostics under an explicit failed/ prefix without turning the job green.
    const failed = await ensureCacheDirectory(path.join(evidence, 'failed'), toolRoot);
    const scopeCache = path.join(output, 'cache', contentHash(projectScope + '|' + canonical(gameRoot)).slice(0, 24));
    for (const [source, destination] of [
      [path.join(scopeCache, 'lastgood.json'), 'index.json'], [path.join(scopeCache, 'architecture.json'), 'architecture.json'],
      [path.join(scopeCache, 'semantics.json'), 'semantics.json'], [path.join(output, 'cache/evidence-audit/game-demo-02-primary.json'), 'audit.json'],
    ]) {
      try { await copyFile(source, path.join(failed, destination)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AggregateError([failure, error], 'Could not preserve failed snapshot diagnostics'); }
    }
    const manifestFile = path.join(evidence, 'manifest.json');
    let manifest: Record<string, unknown>;
    try { manifest = JSON.parse(await readFile(manifestFile, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      manifest = { schemaVersion: '1.0.0', kind: 'ci-snapshot-evidence', incomplete: true,
        tool: { repository: TOOL_REPOSITORY, sha: input.toolSha }, game: { repository: GAME_REPOSITORY, sha: input.gameSha },
        dispatch: { contractVersion: input.contractVersion, sourceRef: input.sourceRef },
        sourceRun: { id: input.sourceRunId, attempt: input.sourceRunAttempt, url: input.sourceRunUrl, attemptUrl: `${input.sourceRunUrl}/attempts/${input.sourceRunAttempt}` }, targetRun: { id: input.runId, attempt: input.runAttempt, url: input.runUrl } }; }
    await writeFile(manifestFile, JSON.stringify({ ...manifest, outcome: 'failed', readOnlyVerified }, null, 2) + '\n');
    await writeFile(path.join(evidence, 'failure.json'), JSON.stringify({ outcome: 'failed', message: failure instanceof Error ? failure.message : String(failure), runUrl: input.runUrl }, null, 2) + '\n');
    throw failure;
  }
  const manifestFile = path.join(evidence, 'manifest.json');
  const manifest: unknown = JSON.parse(await readFile(manifestFile, 'utf8'));
  await writeFile(manifestFile, JSON.stringify({ ...manifest as Record<string, unknown>, outcome: 'success', readOnlyVerified: true }, null, 2) + '\n');
  console.log(JSON.stringify({ outcome: 'success', evidence, runUrl: input.runUrl }));
  return evidence;
}

if (process.argv[1] && canonical(fileURLToPath(import.meta.url)) === canonical(path.resolve(process.argv[1]))) {
  runSnapshot(snapshotInput(process.env)).catch(error => { console.error(error); process.exitCode = 1; });
}

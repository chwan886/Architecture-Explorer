import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { link, open, realpath, unlink } from 'node:fs/promises';
import type { LoadedConfig } from '../../indexer/src/config.ts';
import { withFileLock } from '../../indexer/src/file-lock.ts';
import { canonical, createFilePolicy, ensureCacheDirectory, isWithin, readAuthorized } from '../../indexer/src/security.ts';
import { ANALYZER_VERSION, SCHEMA_VERSION, contentHash } from '../../schema/src/index.ts';
import { validateIndex } from '../../schema/src/validate.ts';
import { validateModel } from '../../architecture-model/src/validation.ts';
import type { SemanticDefinitions } from '../../semantic-model/src/types.ts';
import { SEMANTIC_SCHEMA_VERSION } from '../../semantic-model/src/types.ts';
import { loadContentPack } from './content-pack.ts';
import { buildCandidateDefinitions } from './seed.ts';

export interface SeedOptions { worktreeId?: string; contentPackDirectory?: string; dryRun?: boolean }
export interface SeedResult {
  projectId: string; scopeId: string; definitions: SemanticDefinitions; written: boolean;
  reason: 'no-model' | 'no-flows' | 'dry-run' | 'created'; outputPath?: string;
}
const decoder = new TextDecoder('utf-8', { fatal: true });
const parse = (bytes: Buffer): unknown => JSON.parse(decoder.decode(bytes).replace(/^\uFEFF/, ''));

/** Import an initial rule seed from the authorized saved snapshot. Existing
 * definitions and all human overlays remain untouched. There is no scan,
 * target execution, implicit content directory, or default project selection. */
export async function seedSemanticDefinitions(config: LoadedConfig, projectId: string, options: SeedOptions = {}): Promise<SeedResult> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(projectId)) throw new Error('Project ID is not authorized');
  const project = config.projects.find(item => item.id === projectId);
  if (!project) throw new Error('Project ID is not authorized');
  const worktreeId = options.worktreeId ?? 'primary';
  const selected = [project.root, ...(project.worktrees ?? [])].find(root =>
    (canonical(root) === canonical(project.root) ? 'primary' : `wt-${contentHash(canonical(root)).slice(0, 12)}`) === worktreeId);
  if (!selected) throw new Error('Worktree ID is not authorized');
  const sourceRoot = await realpath(selected), toolRoot = await realpath(config.toolRoot);
  const scopeId = `${projectId}:${worktreeId}`;
  const relativeOutput = `architecture/semantics/${projectId}/definitions.json`;
  const outputPath = path.join(toolRoot, relativeOutput);
  const allRoots = await Promise.all(config.projects.flatMap(item => [item.root, ...(item.worktrees ?? [])]).map(root => realpath(root)));
  if (allRoots.some(root => isWithin(root, outputPath))) throw new Error('Semantic definitions cannot be written inside any analysis target');
  const pack = await loadContentPack(options.contentPackDirectory);
  if (pack?.projectId && pack.projectId !== projectId) throw new Error('Content pack project does not match');
  const empty = (reason: 'no-model' | 'no-flows'): SeedResult => {
    if (pack?.flows.length) throw new Error('Content pack references flows but no authored flows are available');
    return { projectId, scopeId, written: false, reason, definitions: { schemaVersion: SEMANTIC_SCHEMA_VERSION, projectId, flows: [] } };
  };
  const modelPath = `architecture/models/${projectId}/model.json`;
  let modelBytes: Buffer;
  try { modelBytes = await readAuthorized(toolRoot, modelPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty('no-model'); throw error; }
  const model = parse(modelBytes); validateModel(model);
  if (model.projectId !== projectId) throw new Error('Architecture model project does not match');
  if (!model.flows.length) return empty('no-flows');
  if (!isWithin(toolRoot, config.cacheDir) || canonical(toolRoot) === canonical(config.cacheDir)) throw new Error('Saved index cache must be inside the tool directory');
  const cacheKey = contentHash(scopeId + '|' + canonical(sourceRoot)).slice(0, 24);
  const indexPath = path.relative(toolRoot, path.join(config.cacheDir, cacheKey, 'lastgood.json')).replaceAll('\\', '/');
  const indexBytes = await readAuthorized(toolRoot, indexPath, 256 * 1024 * 1024);
  const index = parse(indexBytes); validateIndex(index);
  const metadata = index.metadata;
  if (metadata.projectId !== projectId || metadata.scopeId !== scopeId || metadata.worktreeId !== worktreeId || canonical(metadata.rootPath) !== canonical(sourceRoot))
    throw new Error('Saved index does not match the authorized project and worktree');
  if (metadata.schemaVersion !== SCHEMA_VERSION || metadata.analyzerVersion !== ANALYZER_VERSION || metadata.configFingerprint !== contentHash(config.fingerprint + '|' + scopeId))
    throw new Error('Saved index version or configuration is stale; scan the project first');
  const paths = new Set<string>();
  const anchors = new Map(model.anchors.map(anchor => [anchor.id, anchor]));
  for (const flow of model.flows) for (const step of flow.steps) {
    for (const id of step.anchorIds) paths.add(anchors.get(id)!.filePath);
    if (step.selector) for (const node of index.nodes) if (node.qualifiedName === step.selector.qualifiedName && node.filePath) paths.add(node.filePath);
  }
  if (paths.size > 50000) throw new Error('Seed source budget exceeds 50,000 files');
  const policy = createFilePolicy(project.include, project.exclude);
  const files = new Map(index.files.map(file => [file.path, file.hash]));
  const sourceTexts: Record<string, string> = {};
  let totalBytes = 0;
  for (const sourcePath of paths) {
    if (!policy.included(sourcePath) || !files.has(sourcePath)) throw new Error('Seed source is outside the current index and configured allowlist');
    const bytes = await readAuthorized(sourceRoot, sourcePath);
    if ((totalBytes += bytes.length) > 256 * 1024 * 1024) throw new Error('Seed source budget exceeds 256 MiB');
    const source = decoder.decode(bytes);
    if (source.includes('\0') || contentHash(source) !== files.get(sourcePath)) throw new Error('Seed source is stale or not text; scan the project first');
    sourceTexts[sourcePath] = source;
  }
  const definitions = buildCandidateDefinitions(index, model, sourceTexts, pack);
  const bytes = Buffer.from(JSON.stringify(definitions, null, 2) + '\n');
  if (bytes.length > 2 * 1024 * 1024) throw new Error('Semantic definitions exceed the 2 MiB store limit');
  if (options.dryRun) return { projectId, scopeId, definitions, written: false, reason: 'dry-run', outputPath };
  const directory = await ensureCacheDirectory(path.dirname(outputPath), toolRoot);
  return withFileLock({ toolRoot, lockPath: path.join(directory, 'definitions.json.lock'), locked: () => new Error('Another seed import is active or its lock owner cannot be verified') }, async () => {
    const temporary = path.join(directory, `definitions.${randomUUID()}.tmp`);
    try {
      // Recheck the exact inputs before publication, rather than combining a
      // fresh model with an earlier index or silently accepting source drift.
      if (!modelBytes.equals(await readAuthorized(toolRoot, modelPath)) || !indexBytes.equals(await readAuthorized(toolRoot, indexPath, 256 * 1024 * 1024)))
        throw new Error('Model or index changed during seed generation; retry');
      for (const sourcePath of paths) if (decoder.decode(await readAuthorized(sourceRoot, sourcePath)) !== sourceTexts[sourcePath])
        throw new Error('Source changed during seed generation; scan and retry');
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      // Linking an initialized file publishes the complete artifact atomically
      // while refusing EEXIST, including simultaneous non-cooperating writers.
      try { await link(temporary, path.join(directory, 'definitions.json')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Semantic definitions already exist; import never overwrites curated content');
        throw error;
      }
      return { projectId, scopeId, definitions, written: true, reason: 'created', outputPath };
    } finally {
      await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
  });
}

import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { open, rename, unlink, writeFile } from 'node:fs/promises';
import Ajv from 'ajv';
import { IndexManager, loadConfig, graph } from '../packages/indexer/src/index.ts';
import { authorizedFile, ensureCacheDirectory, relativeSourcePath } from '../packages/indexer/src/security.ts';
import { contentHash, type ArchitectureIndex, type ArchitectureNode, type EdgeKind, type Evidence } from '../packages/schema/src/index.ts';
import { validateIndex } from '../packages/schema/src/validate.ts';
import type { SymbolSelector } from '../packages/architecture-model/src/types.ts';
import modelSchema from '../packages/architecture-model/model.schema.json';

type StaticConfidence = 'static-confirmed' | 'inferred';
export interface StoryDefinition {
  schemaVersion: '1.0'; id: string; projectId?: string; worktreeId?: string;
  nodes: Array<{ id: string; selector: SymbolSelector & { label?: string } }>;
  edges: Array<{ id: string; from: string; to: string; kind: EdgeKind; confidence?: StaticConfidence[]; minCount?: number }>;
  graphs?: Array<{ id: string; root: string; view: 'architecture' | 'calls' | 'data' | 'impact'; requiredKinds: EdgeKind[]; depth?: number; limit?: number }>;
}
export interface StoryServices {
  evidence(id: string): Promise<{ evidence: Evidence; stale: boolean; revision: string }>;
  verify(): Promise<{ valid: boolean; reasons: string[]; revision?: string }>;
  isCurrent(): boolean;
}

const kinds: EdgeKind[] = ['contains', 'inherits', 'implements', 'references', 'imports', 'calls', 'reads', 'writes', 'initializes', 'passes', 'returns', 'subscribes', 'unsubscribes', 'publishes', 'contract-mapping'];
const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' };
const reference = { type: 'string', minLength: 1, maxLength: 64 };
const kind = { type: 'string', enum: kinds };
const ajv = new Ajv({ strict: true, allErrors: true });
const check = ajv.compile<StoryDefinition>({
  type: 'object', additionalProperties: false, required: ['schemaVersion', 'id', 'nodes', 'edges'], definitions: modelSchema.definitions,
  properties: {
    schemaVersion: { const: '1.0' }, id, projectId: id, worktreeId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
    nodes: { type: 'array', minItems: 1, maxItems: 80, items: { type: 'object', additionalProperties: false, required: ['id', 'selector'], properties: {
      id, selector: { ...modelSchema.definitions.Selector, properties: { ...modelSchema.definitions.Selector.properties, label: { $ref: '#/definitions/Text' } } },
    } } },
    edges: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', additionalProperties: false, required: ['id', 'from', 'to', 'kind'], properties: {
      id, from: reference, to: reference, kind, minCount: { type: 'integer', minimum: 1, maximum: 1000 },
      confidence: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: ['static-confirmed', 'inferred'] } },
    } } },
    graphs: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['id', 'root', 'view', 'requiredKinds'], properties: {
      id, root: reference, view: { enum: ['architecture', 'calls', 'data', 'impact'] }, depth: { type: 'integer', minimum: 1, maximum: 5 }, limit: { type: 'integer', minimum: 1, maximum: 200 },
      requiredKinds: { type: 'array', minItems: 1, uniqueItems: true, items: kind },
    } } },
  },
});

export function validateStoryDefinition(value: unknown): asserts value is StoryDefinition {
  assert.ok(check(value), `Invalid acceptance story: ${ajv.errorsText(check.errors?.slice(0, 4))}`);
  const nodes = new Set(value.nodes.map(node => node.id));
  assert.equal(nodes.size, value.nodes.length, 'Story node IDs must be unique');
  assert.equal(new Set(value.edges.map(edge => edge.id)).size, value.edges.length, 'Story edge check IDs must be unique');
  assert.equal(new Set(value.graphs?.map(item => item.id)).size, value.graphs?.length ?? 0, 'Story graph check IDs must be unique');
  for (const node of value.nodes) for (const file of [node.selector.filePath, node.selector.filePathPrefix?.replace(/\/$/, '')]) if (file) relativeSourcePath(file);
  for (const edge of value.edges) assert.ok(nodes.has(edge.from) && nodes.has(edge.to), `Unknown story endpoint: ${edge.id}`);
  for (const item of value.graphs ?? []) assert.ok(nodes.has(item.root), `Unknown story graph root: ${item.id}`);
}

function selected(node: ArchitectureNode, selector: StoryDefinition['nodes'][number]['selector']) {
  const prefix = selector.filePathPrefix?.replace(/\/$/, '');
  return (!selector.language || selector.language === node.language) && (!selector.kinds || selector.kinds.includes(node.kind))
    && (!selector.qualifiedName || selector.qualifiedName === node.qualifiedName)
    && (!selector.qualifiedNamePrefix || node.qualifiedName.startsWith(selector.qualifiedNamePrefix))
    && (!selector.filePath || selector.filePath === node.filePath)
    && (!prefix || node.filePath === prefix || !!node.filePath?.startsWith(prefix + '/')) && (!selector.label || selector.label === node.label);
}

/** Configured raw facts and current evidence do not establish execution order
 * or cross-language data transfer, even when endpoint names happen to match. */
export async function validateStory(value: unknown, index: ArchitectureIndex, services: StoryServices) {
  validateStoryDefinition(value); validateIndex(index);
  if (value.projectId) assert.equal(value.projectId, index.metadata.projectId, 'Story project differs from the authorized index');
  if (value.worktreeId) assert.equal(value.worktreeId, index.metadata.worktreeId, 'Story worktree differs from the authorized index');
  const current = () => assert.ok(services.isCurrent(), 'Index snapshot changed during story validation');
  current();
  const nodes = new Map<string, ArchitectureNode>();
  for (const requested of value.nodes) {
    const matches = index.nodes.filter(node => selected(node, requested.selector));
    assert.equal(matches.length, 1, `Story selector ${requested.id} must resolve to exactly one node; found ${matches.length}`);
    nodes.set(requested.id, matches[0]);
  }
  const byPair = new Map<string, typeof index.edges>();
  for (const edge of index.edges) {
    const key = `${edge.source}|${edge.kind}|${edge.target}`;
    const members = byPair.get(key) ?? []; members.push(edge); byPair.set(key, members);
  }
  const edgeChecks = value.edges.map(expected => {
    const source = nodes.get(expected.from)!, target = nodes.get(expected.to)!, accepted = expected.confidence ?? ['static-confirmed'];
    const matches = (byPair.get(`${source.id}|${expected.kind}|${target.id}`) ?? []).filter(edge => accepted.includes(edge.confidence as StaticConfidence));
    assert.ok(matches.length >= (expected.minCount ?? 1), `Story edge ${expected.id} is missing: ${expected.kind} ${expected.from} -> ${expected.to}`);
    assert.ok(matches.every(edge => edge.evidenceIds.length > 0), `Story edge ${expected.id} requires actual source evidence`);
    return { expected, source, target, matches };
  });
  const evidence = new Map(index.evidence.map(item => [item.id, item]));
  const evidenceIds = new Set(edgeChecks.flatMap(item => item.matches.flatMap(edge => edge.evidenceIds)));
  assert.ok(evidenceIds.size <= 4096, 'Acceptance story exceeds its 4096-evidence read budget; narrow its selectors');
  for (const evidenceId of evidenceIds) {
    const expected = evidence.get(evidenceId)!, source = await services.evidence(evidenceId);
    assert.equal(source.stale, false, `Story evidence is stale: ${evidenceId}`);
    assert.equal(source.revision, index.metadata.revision, `Story evidence belongs to another snapshot: ${evidenceId}`);
    assert.deepEqual(source.evidence, expected, `Story evidence metadata changed: ${evidenceId}`);
    current();
  }
  const graphs = (value.graphs ?? []).map(expected => {
    const result = graph(index, { rootId: nodes.get(expected.root)!.id, view: expected.view, depth: expected.depth ?? 1, limit: expected.limit ?? 80 });
    assert.equal(result.revision, index.metadata.revision);
    for (const kind of expected.requiredKinds) assert.ok(result.edges.some(edge => edge.kind === kind), `Graph check ${expected.id} does not display ${kind}${result.truncated ? ' within its display budget' : ''}`);
    return { id: expected.id, nodes: result.nodes.length, edges: result.edges.length, truncated: result.truncated };
  });
  const verification = await services.verify();
  assert.equal(verification.valid, true, `Index/source verification failed: ${verification.reasons.join('; ')}`);
  if (verification.revision) assert.equal(verification.revision, index.metadata.revision, 'Verification used another snapshot');
  current();
  return { checkedAt: new Date().toISOString(), storyId: value.id, scope: index.metadata.scopeId, metadata: index.metadata,
    counts: { nodes: index.nodes.length, edges: index.edges.length, evidence: index.evidence.length, diagnostics: index.diagnostics.length, checkedEvidence: evidenceIds.size },
    proofs: edgeChecks.map(({ expected, source, target, matches }) => ({ id: expected.id, kind: expected.kind, source: source.qualifiedName, target: target.qualifiedName,
      edges: matches.map(edge => ({ id: edge.id, confidence: edge.confidence, rule: edge.rule, evidence: edge.evidenceIds.map(id => {
        const item = evidence.get(id)!; return { id, file: item.filePath, line: item.startLine, endLine: item.endLine };
      }) })) })), graphs, cacheVerification: verification,
    boundary: 'Static source facts and current evidence only. Candidate imports remain inferred. No target execution, runtime order, or cross-language value transfer is established.' };
}

export function parseStoryArguments(args: string[]) {
  const options = new Map<string, string>(), usage = 'Usage: tsx Tools/validate-story.ts --config file --story file.json [--project id] [--worktree id]';
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!key.startsWith('--')) { assert.ok(!options.has('--project'), usage); options.set('--project', key); continue; }
    assert.ok(['--config', '--story', '--project', '--worktree'].includes(key) && args[index + 1] && !args[index + 1].startsWith('--'), usage);
    assert.ok(!options.has(key), `Duplicate option: ${key}`); options.set(key, args[++index]);
  }
  assert.ok(options.has('--config') && options.has('--story'), usage);
  return options;
}

export async function readStoryDefinition(filePath: string): Promise<unknown> {
  const absolute = path.resolve(filePath), source = await authorizedFile(path.dirname(absolute), path.basename(absolute));
  const file = await open(source, 'r'), maximum = 2 * 1024 * 1024;
  try {
    const info = await file.stat();
    assert.ok(info.isFile(), 'Story definition must be a regular file');
    assert.ok(info.size <= maximum, 'Story definition exceeds 2 MiB');
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await file.read(bytes, length, bytes.length - length, null);
      if (!chunk.bytesRead) break;
      length += chunk.bytesRead;
    }
    assert.ok(length <= maximum, 'Story definition exceeds 2 MiB');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } finally { await file.close(); }
}

export async function runStoryCli(args = process.argv.slice(2)) {
  const options = parseStoryArguments(args), definition = await readStoryDefinition(options.get('--story')!); validateStoryDefinition(definition);
  const config = await loadConfig(options.get('--config')), project = options.get('--project') ?? definition.projectId;
  assert.ok(project, 'Choose an explicit --project or story.projectId');
  const worktree = options.get('--worktree') ?? definition.worktreeId ?? 'primary', manager = new IndexManager(config);
  if (definition.projectId) assert.equal(project, definition.projectId, 'CLI project conflicts with the story scope');
  if (definition.worktreeId) assert.equal(worktree, definition.worktreeId, 'CLI worktree conflicts with the story scope');
  try {
    await manager.initialize(); const runtime = manager.scope(`${project}:${worktree}`);
    await manager.requestScan(runtime.id); assert.equal(runtime.status.state, 'synced', runtime.status.message);
    const index = runtime.index!;
    const report = await validateStory(definition, index, { evidence: id => manager.evidence(runtime.id, id), verify: () => manager.verify(runtime.id), isCurrent: () => runtime.index === index });
    const directory = await ensureCacheDirectory(config.cacheDir, config.toolRoot);
    const destination = path.join(directory, `validation-story-${definition.id}-${contentHash(runtime.id).slice(0, 12)}.json`), temporary = `${destination}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); await rename(temporary, destination); }
    finally { await unlink(temporary).catch(() => {}); }
    console.log(JSON.stringify({ report: destination, ...report }, null, 2)); return report;
  } finally { await manager.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runStoryCli().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

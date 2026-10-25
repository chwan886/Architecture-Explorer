import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ANALYZER_VERSION, SCHEMA_VERSION, contentHash, type AnalyzerResult, type ArchitectureIndex } from '../packages/schema/src/index.ts';
import { validateIndex } from '../packages/schema/src/validate.ts';
import { validateModel } from '../packages/architecture-model/src/validation.ts';
import type { ArchitectureModel } from '../packages/architecture-model/src/types.ts';
import type { LoadedConfig } from '../packages/indexer/src/config.ts';
import { canonical } from '../packages/indexer/src/security.ts';
import { buildCandidateDefinitions } from '../packages/semantic-content/src/seed.ts';
import { loadContentPack } from '../packages/semantic-content/src/content-pack.ts';
import { validateContentPack, type SemanticContentPack } from '../packages/semantic-content/src/seed-explanations.ts';
import { seedSemanticDefinitions } from '../packages/semantic-content/src/import.ts';
import { parseSeedArguments } from '../packages/semantic-content/seed.ts';
import { buildSemanticProjection, semanticRevision } from '../packages/semantic-model/src/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = 'def receive(value):\n    return value\n\ndef reply(value):\n    return receive(value)\n';
const sourcePath = 'handlers.py';
const pack: SemanticContentPack = { schemaVersion: '1.0.0', flows: [{ sourceFlowId: 'request-flow',
  title: 'External presentation', steps: [{ sourceStepId: 'receive', text: { purpose: 'External candidate purpose' },
    controls: [{ kind: 'async', description: 'Candidate asynchronous boundary' }] }],
  groups: [{ id: 'input-summary', stepIds: ['receive'], text: { title: 'Input' } }, { id: 'output-summary', stepIds: ['reply'] }] }] };
const clone = <T>(value: T): T => structuredClone(value);

async function fixture(t: test.TestContext, projectId = 'alpha-lab') {
  await mkdir(path.join(root, '.tmp'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.tmp/semantic-seed-'));
  assert.ok(directory.startsWith(path.join(root, '.tmp') + path.sep));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const toolRoot = path.join(directory, 'tool'), projectRoot = path.join(directory, 'project'), worktreeRoot = path.join(directory, 'feature');
  await Promise.all([mkdir(toolRoot), mkdir(projectRoot), mkdir(worktreeRoot)]);
  await writeFile(path.join(projectRoot, sourcePath), source);
  await writeFile(path.join(worktreeRoot, sourcePath), source);
  const scopeId = `${projectId}:primary`;
  const result: AnalyzerResult = JSON.parse(execFileSync(process.env.EXPLORER_PYTHON ?? 'python', ['-B', path.join(root, 'analyzers/python/analyze.py')],
    { input: JSON.stringify({ scopeId, files: [{ path: sourcePath, content: source, hash: contentHash(source) }] }), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  const config: LoadedConfig = { toolRoot, cacheDir: path.join(toolRoot, '.cache'), configPath: path.join(toolRoot, 'config.json'), fingerprint: 'synthetic-seed-config', port: 4310,
    projects: [{ id: projectId, name: 'Synthetic project', root: projectRoot, worktrees: [worktreeRoot], include: ['**/*.py'], exclude: [] }] };
  const index: ArchitectureIndex = { ...result, files: [{ path: sourcePath, hash: contentHash(source), size: Buffer.byteLength(source), language: 'python' }], flows: [],
    metadata: { schemaVersion: SCHEMA_VERSION, analyzerVersion: ANALYZER_VERSION, projectId, projectName: 'Synthetic project', worktreeId: 'primary', scopeId,
      rootPath: projectRoot, gitHead: '', gitBranch: '', gitDirty: false, gitStatusHash: contentHash(''), generatedAt: '2026-01-01T00:00:00.000Z',
      configFingerprint: contentHash(config.fingerprint + '|' + scopeId), compilationFingerprint: '', revision: contentHash('synthetic-snapshot'),
      fileCount: 1, durationMs: 0, changedFiles: 1, reusedFiles: 0, coverage: { languages: ['python'], limitations: [] } } };
  const model: ArchitectureModel = { schemaVersion: '1.0.0', projectId, name: 'Synthetic request model', systems: [], modules: [], memberships: [], reviews: [],
    anchors: [{ id: 'receive-anchor', filePath: sourcePath, startLine: 1, endLine: 2, expectedFileHash: contentHash(source), quote: source.split('\n').slice(0, 2).join('\n'), description: 'First declaration' },
      { id: 'reply-anchor', filePath: sourcePath, startLine: 4, endLine: 5, expectedFileHash: contentHash(source), quote: source.split('\n').slice(3, 5).join('\n'), description: 'Second declaration' }],
    flows: [{ id: 'request-flow', name: 'Synthetic request', description: 'An authored candidate request narrative', trigger: 'Request', systemIds: [], lanes: [{ id: 'source', name: 'Source' }],
      steps: ['receive', 'reply'].map((id, phase) => ({ id, laneId: 'source', phase, name: id, description: `Synthetic ${id} step`, anchorIds: [`${id}-anchor`], reads: ['value'], writes: ['result'],
        selector: { language: 'python', kinds: ['function'], qualifiedName: `handlers.${id}`, filePath: sourcePath }, ...(phase === 0 ? { condition: 'An input value is present' } : {}) })),
      transitions: [{ id: 'candidate-order', source: 'receive', target: 'reply', basis: 'narrative', anchorIds: [], limitations: ['Candidate order only'] }], limitations: ['No runtime collection'] }] };
  validateIndex(index); validateModel(model);
  const modelPath = path.join(toolRoot, 'architecture/models', projectId, 'model.json');
  const indexPath = path.join(config.cacheDir, contentHash(scopeId + '|' + canonical(projectRoot)).slice(0, 24), 'lastgood.json');
  const save = async () => {
    await mkdir(path.dirname(modelPath), { recursive: true }); await writeFile(modelPath, JSON.stringify(model));
    await mkdir(path.dirname(indexPath), { recursive: true }); await writeFile(indexPath, JSON.stringify(index));
  };
  const packDirectory = path.join(directory, 'external-pack'); await mkdir(packDirectory);
  const packPath = path.join(packDirectory, 'content-pack.json'); await writeFile(packPath, JSON.stringify(pack));
  return { directory, config, projectId, projectRoot, worktreeRoot, toolRoot, index, model, modelPath, indexPath, packDirectory, packPath, save };
}

test('generic seeds cover every source flow for two unrelated project IDs without any content pack', async t => {
  for (const id of ['alpha-lab', 'beta-sample']) {
    const f = await fixture(t, id);
    const before = clone(f.model);
    const definitions = buildCandidateDefinitions(f.index, f.model, { [sourcePath]: source });
    assert.equal(definitions.projectId, id);
    assert.deepEqual(definitions.flows.map(flow => flow.sourceFlowId), f.model.flows.map(flow => flow.id));
    const flow = definitions.flows[0];
    assert.deepEqual(flow.groups.flatMap(group => group.childIds), ['receive', 'reply']);
    assert.ok([...flow.steps, ...flow.groups].every(node => node.origin === 'rule-generated'));
    assert.deepEqual(flow.steps[0].controls, [{ kind: 'condition', description: 'An input value is present', anchorIds: ['receive-anchor'] }]);
    for (const step of flow.steps) {
      assert.equal(step.bindings.length, 1); assert.deepEqual(step.sourceStepIds, [step.id]);
      assert.equal(step.bindings[0].selector?.qualifiedName, `handlers.${step.id}`);
      assert.match(step.bindings[0].expectedDeclarationHash!, /^[a-f0-9]{64}$/);
    }
    assert.deepEqual(f.model, before);
    assert.equal(await loadContentPack(), undefined);
    assert.deepEqual(await readdir(f.toolRoot), [], 'no default content or private model directory is consulted or created');
  }
});

test('an explicit external data pack changes presentation while retaining source mapping and model controls', async t => {
  const f = await fixture(t);
  const loaded = await loadContentPack(f.packDirectory); assert.deepEqual(loaded, pack);
  const plain = buildCandidateDefinitions(f.index, f.model, { [sourcePath]: source });
  const adapted = buildCandidateDefinitions(f.index, f.model, { [sourcePath]: source }, loaded);
  const flow = adapted.flows[0];
  assert.equal(flow.title, 'External presentation'); assert.equal(flow.steps[0].purpose, 'External candidate purpose');
  assert.deepEqual(flow.steps.map(step => step.bindings), plain.flows[0].steps.map(step => step.bindings));
  assert.equal(flow.steps[0].controls[0].kind, 'condition'); assert.equal(flow.steps[0].controls[1].kind, 'async');
  assert.deepEqual(flow.steps[0].controls[1].anchorIds, ['receive-anchor']);
  assert.equal(flow.groups.length, 2); assert.equal(flow.steps[0].origin, 'rule-generated');
  const projection = buildSemanticProjection(f.index, f.model, adapted, { schemaVersion: '1.0.0', scopeId: f.index.metadata.scopeId,
    baseDefinitionRevision: semanticRevision(adapted), flowOverrides: [], reviews: [], history: [] }, { sourceTexts: { [sourcePath]: source } });
  const resolved = projection.flows[0];
  assert.equal(resolved.reviewState, 'pending');
  assert.ok(resolved.detailNodes.every(node => node.reviewState === 'pending'));
  assert.ok(resolved.detailEdges.every(edge => edge.verification === 'unverified' && !edge.paths.length), 'presentation cannot promote candidate narrative order');
  assert.ok(resolved.codeEdges.every(edge => f.index.edges.some(original => original.id === edge.id)), 'no source relationship is synthesized');
  flow.steps[0].inputs.push('new draft'); assert.deepEqual(loaded, pack, 'builder does not mutate the external pack');
  const example = await loadContentPack(path.join(root, 'examples/content-pack'));
  assert.equal(buildCandidateDefinitions(f.index, f.model, { [sourcePath]: source }, example).flows[0].groups.length, 1);
});

test('data pack schema rejects code, source, unsafe IDs, unknown fields and invalid versions', () => {
  const invalid: unknown[] = [
    { ...clone(pack), schemaVersion: '2.0.0' }, { ...clone(pack), projectId: '../escape' },
    { ...clone(pack), module: './execute.js' },
    { schemaVersion: '1.0.0', flows: [{ sourceFlowId: 'request-flow', steps: [{ sourceStepId: 'receive', selector: { filePath: '../secret' } }] }] },
    { schemaVersion: '1.0.0', flows: [{ sourceFlowId: 'request-flow', steps: [{ sourceStepId: 'receive', text: { quote: 'source' } }] }] },
    { ...clone(pack), flows: [pack.flows[0], pack.flows[0]] },
  ];
  for (const value of invalid) assert.throws(() => validateContentPack(value));
});

test('adapters reject foreign projects, missing flows or steps, invalid group partitions and foreign anchors', async t => {
  const f = await fixture(t);
  const invalid: SemanticContentPack[] = [
    { ...clone(pack), projectId: 'other-project' },
    { schemaVersion: '1.0.0', flows: [{ sourceFlowId: 'missing' }] },
    { schemaVersion: '1.0.0', flows: [{ sourceFlowId: 'request-flow', steps: [{ sourceStepId: 'missing' }] }] },
    { schemaVersion: '1.0.0', flows: [{ sourceFlowId: 'request-flow', groups: [{ id: 'g', stepIds: ['receive'] }] }] },
    { schemaVersion: '1.0.0', flows: [{ sourceFlowId: 'request-flow', groups: [{ id: 'g', stepIds: ['receive', 'missing'] }] }] },
    { schemaVersion: '1.0.0', flows: [{ sourceFlowId: 'request-flow', steps: [{ sourceStepId: 'receive', controls: [{ kind: 'loop', description: 'Bad anchor', anchorIds: ['reply-anchor'] }] }] }] },
  ];
  for (const value of invalid) assert.throws(() => buildCandidateDefinitions(f.index, f.model, { [sourcePath]: source }, value));
});

test('pack loader fails closed for missing manifests, malformed UTF-8, oversize and package file links', async t => {
  const f = await fixture(t);
  await assert.rejects(loadContentPack(path.join(f.directory, 'missing')));
  await assert.rejects(loadContentPack(''));
  await writeFile(f.packPath, Buffer.from([0xff, 0xfe])); await assert.rejects(loadContentPack(f.packDirectory));
  await writeFile(f.packPath, ' '.repeat(512 * 1024 + 1)); await assert.rejects(loadContentPack(f.packDirectory), /限制|limit/);
  await rm(f.packPath);
  const outside = path.join(f.directory, 'outside.json'); await writeFile(outside, JSON.stringify(pack));
  await symlink(outside, f.packPath); await assert.rejects(loadContentPack(f.packDirectory), /符号链接|link/);
});

test('projects without an authored model or flows return an explicit empty result and create nothing', async t => {
  const f = await fixture(t);
  const missing = await seedSemanticDefinitions(f.config, f.projectId);
  assert.equal(missing.reason, 'no-model'); assert.equal(missing.written, false); assert.deepEqual(missing.definitions.flows, []);
  assert.deepEqual(await readdir(f.toolRoot), []);
  await assert.rejects(seedSemanticDefinitions(f.config, f.projectId, { contentPackDirectory: f.packDirectory }), /no authored flows/);
  f.model.flows = []; await f.save(); await rm(f.config.cacheDir, { recursive: true });
  const empty = await seedSemanticDefinitions(f.config, f.projectId);
  assert.equal(empty.reason, 'no-flows'); assert.equal(empty.written, false);
  await assert.rejects(readFile(path.join(f.toolRoot, 'architecture/semantics', f.projectId, 'definitions.json')), { code: 'ENOENT' });
});

test('import publishes a complete seed once, supports dry-run, and never overwrites existing definitions', async t => {
  const f = await fixture(t, 'beta-sample'); await f.save();
  const before = await readFile(path.join(f.projectRoot, sourcePath), 'utf8');
  const preview = await seedSemanticDefinitions(f.config, f.projectId, { contentPackDirectory: f.packDirectory, dryRun: true });
  assert.equal(preview.reason, 'dry-run'); assert.equal(preview.written, false);
  await assert.rejects(readFile(preview.outputPath!), { code: 'ENOENT' });
  const result = await seedSemanticDefinitions(f.config, f.projectId, { contentPackDirectory: f.packDirectory });
  assert.equal(result.reason, 'created'); assert.equal(result.written, true);
  const stored = await readFile(result.outputPath!, 'utf8'); assert.deepEqual(JSON.parse(stored), result.definitions);
  await assert.rejects(seedSemanticDefinitions(f.config, f.projectId), /already exist/);
  assert.equal(await readFile(result.outputPath!, 'utf8'), stored);
  assert.deepEqual(await readdir(path.dirname(result.outputPath!)), ['definitions.json'], 'no locks or partial files remain');
  assert.equal(await readFile(path.join(f.projectRoot, sourcePath), 'utf8'), before);
  assert.deepEqual(await readdir(f.projectRoot), [sourcePath]);
});

test('concurrent imports publish one complete winner and release their locks', async t => {
  const f = await fixture(t); await f.save();
  const outcomes = await Promise.allSettled([seedSemanticDefinitions(f.config, f.projectId), seedSemanticDefinitions(f.config, f.projectId)]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  const output = path.join(f.toolRoot, 'architecture/semantics', f.projectId, 'definitions.json');
  assert.equal(JSON.parse(await readFile(output, 'utf8')).flows[0].steps.length, 2);
  assert.deepEqual(await readdir(path.dirname(output)), ['definitions.json']);
});

test('explicit authorized worktrees use their own saved snapshot and current source', async t => {
  const f = await fixture(t);
  await f.save();
  const worktreeId = `wt-${contentHash(canonical(f.worktreeRoot)).slice(0, 12)}`;
  const scopeId = `${f.projectId}:${worktreeId}`;
  const result: AnalyzerResult = JSON.parse(execFileSync(process.env.EXPLORER_PYTHON ?? 'python', ['-B', path.join(root, 'analyzers/python/analyze.py')],
    { input: JSON.stringify({ scopeId, files: [{ path: sourcePath, content: source, hash: contentHash(source) }] }), encoding: 'utf8' }));
  const feature: ArchitectureIndex = { ...clone(f.index), ...result, metadata: { ...f.index.metadata, scopeId, worktreeId, rootPath: f.worktreeRoot,
    configFingerprint: contentHash(f.config.fingerprint + '|' + scopeId) } };
  const cachePath = path.join(f.config.cacheDir, contentHash(scopeId + '|' + canonical(f.worktreeRoot)).slice(0, 24), 'lastgood.json');
  await mkdir(path.dirname(cachePath), { recursive: true }); await writeFile(cachePath, JSON.stringify(feature));
  const preview = await seedSemanticDefinitions(f.config, f.projectId, { worktreeId, dryRun: true });
  assert.equal(preview.scopeId, scopeId); assert.equal(preview.definitions.flows[0].steps.length, 2);
  await writeFile(path.join(f.worktreeRoot, sourcePath), source + '# feature drift\n');
  await assert.rejects(seedSemanticDefinitions(f.config, f.projectId, { worktreeId, dryRun: true }), /stale/);
  assert.equal((await seedSemanticDefinitions(f.config, f.projectId, { dryRun: true })).reason, 'dry-run', 'primary remains independently valid');
});

test('saved snapshot authorization rejects stale versions, foreign scope, excluded sources and target writes', async t => {
  const f = await fixture(t); await f.save();
  await assert.rejects(seedSemanticDefinitions(f.config, '../escape'));
  await assert.rejects(seedSemanticDefinitions(f.config, f.projectId, { worktreeId: '../escape' }));
  const baseline = clone(f.index.metadata);
  for (const patch of [{ analyzerVersion: '0.0.0' }, { scopeId: 'foreign:primary' }, { configFingerprint: 'old' }, { worktreeId: 'foreign' }]) {
    Object.assign(f.index.metadata, baseline, patch); await f.save();
    await assert.rejects(seedSemanticDefinitions(f.config, f.projectId));
  }
  Object.assign(f.index.metadata, baseline); await f.save();
  await writeFile(path.join(f.projectRoot, sourcePath), source + '# drift\n');
  await assert.rejects(seedSemanticDefinitions(f.config, f.projectId), /stale/);
  await writeFile(path.join(f.projectRoot, sourcePath), source);
  f.config.projects[0].exclude = ['**/*.py']; await assert.rejects(seedSemanticDefinitions(f.config, f.projectId), /allowlist/);
  f.config.projects[0].exclude = [];
  f.config.projects.push({ id: 'tool-as-target', name: 'Target boundary', root: f.toolRoot, include: ['**'], exclude: [] });
  await assert.rejects(seedSemanticDefinitions(f.config, f.projectId), /inside any analysis target/);
});

test('builder rejects stale or fabricated anchors and ambiguous or broad implementation selectors', async t => {
  const f = await fixture(t);
  const model = clone(f.model);
  model.anchors[0].quote = 'fabricated\nsource';
  assert.throws(() => buildCandidateDefinitions(f.index, model, { [sourcePath]: source }), /quote/);
  assert.throws(() => buildCandidateDefinitions(f.index, f.model, { [sourcePath]: source + '# drift' }), /declaration|stale/);
  const broad = clone(f.model); broad.flows[0].steps[0].selector = { qualifiedNamePrefix: 'handlers' };
  assert.throws(() => buildCandidateDefinitions(f.index, broad, { [sourcePath]: source }), /exact/);
  const duplicate = clone(f.index), node = duplicate.nodes.find(item => item.qualifiedName === 'handlers.receive')!;
  duplicate.nodes.push({ ...node, id: 'duplicate-procedure' });
  assert.throws(() => buildCandidateDefinitions(duplicate, f.model, { [sourcePath]: source }), /one procedure/);
  const narrative = clone(f.model); delete narrative.flows[0].steps[0].selector;
  assert.deepEqual(buildCandidateDefinitions(f.index, narrative, { [sourcePath]: source }).flows[0].steps[0].bindings, []);
});

test('CLI requires an explicit project and help runs without any configured project or content directory', async t => {
  const f = await fixture(t);
  assert.throws(() => parseSeedArguments([]), /explicit/);
  assert.throws(() => parseSeedArguments(['--project', 'alpha-lab', '--output', '../elsewhere']), /Unknown/);
  assert.throws(() => parseSeedArguments(['--project', 'alpha-lab', '--project', 'beta-sample']), /Duplicate/);
  assert.deepEqual(parseSeedArguments(['--project', 'beta-sample', '--dry-run']), { projectId: 'beta-sample', dryRun: true });
  const help = execFileSync(process.execPath, ['--import', 'tsx', path.join(root, 'packages/semantic-content/seed.ts'), '--help'],
    { cwd: f.directory, env: { ...process.env, EXPLORER_CONFIG: path.join(f.directory, 'does-not-exist.json') }, encoding: 'utf8' });
  assert.match(help, /--content-pack DIRECTORY/);
});

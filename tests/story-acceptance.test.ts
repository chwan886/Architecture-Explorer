import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { ANALYZER_VERSION, SCHEMA_VERSION, contentHash, type ArchitectureIndex } from '../packages/schema/src/index.ts';
import { TOOL_ROOT } from '../packages/indexer/src/config.ts';
import { parseStoryArguments, readStoryDefinition, validateStory, validateStoryDefinition, type StoryDefinition, type StoryServices } from '../Tools/validate-story.ts';

function fixture() {
  const source = 'def receive(value):\n    return save(value)\n\ndef save(value):\n    value["state"] = value["state"]\n    return value\n';
  const hash = contentHash(source), file = 'src/actions.py';
  const index: ArchitectureIndex = {
    metadata: { schemaVersion: SCHEMA_VERSION, analyzerVersion: ANALYZER_VERSION, projectId: 'story-fixture', projectName: 'Synthetic story', worktreeId: 'primary', scopeId: 'story-fixture:primary', rootPath: '/synthetic-story', gitHead: '', gitBranch: '', gitDirty: false, gitStatusHash: '', generatedAt: '2026-01-01T00:00:00Z', configFingerprint: 'fixture', compilationFingerprint: 'fixture', revision: 'revision-one', fileCount: 1, durationMs: 0, changedFiles: 1, reusedFiles: 0, coverage: { languages: ['python'], limitations: [] } },
    nodes: [
      { id: 'receive', kind: 'function', label: 'receive', qualifiedName: 'src.actions.receive', language: 'python', filePath: file, evidenceIds: ['receive-proof'] },
      { id: 'save', kind: 'function', label: 'save', qualifiedName: 'src.actions.save', language: 'python', filePath: file, evidenceIds: ['save-proof'] },
      { id: 'state', kind: 'data', label: "value['state']", qualifiedName: "src.actions.save::value['state']", language: 'python', filePath: file, evidenceIds: ['save-proof'] },
    ],
    edges: [
      { id: 'call', source: 'receive', target: 'save', kind: 'calls', confidence: 'static-confirmed', evidenceIds: ['receive-proof', 'call-proof'], rule: 'fixture.call' },
      { id: 'write', source: 'save', target: 'state', kind: 'writes', confidence: 'static-confirmed', evidenceIds: ['save-proof'], rule: 'fixture.write' },
      { id: 'read', source: 'save', target: 'state', kind: 'reads', confidence: 'static-confirmed', evidenceIds: ['save-proof'], rule: 'fixture.read' },
    ],
    files: [{ path: file, hash, size: Buffer.byteLength(source), language: 'python' }], flows: [], diagnostics: [],
    evidence: [['receive-proof', 1], ['call-proof', 2], ['save-proof', 5]].map(([id, line]) => ({ id: String(id), filePath: file, fileHash: hash, startLine: Number(line), endLine: Number(line), startColumn: 1, endColumn: 5, rule: 'fixture.source' })),
  };
  const story: StoryDefinition = { schemaVersion: '1.0', id: 'synthetic-story', projectId: 'story-fixture',
    nodes: index.nodes.map(node => ({ id: node.id, selector: { qualifiedName: node.qualifiedName, filePath: file } })),
    edges: [{ id: 'dispatch', from: 'receive', to: 'save', kind: 'calls' }, { id: 'store', from: 'save', to: 'state', kind: 'writes' }],
    graphs: [{ id: 'state-access', root: 'state', view: 'data', requiredKinds: ['reads', 'writes'] }],
  };
  const reads: string[] = [];
  const services: StoryServices = {
    async evidence(id) { reads.push(id); return { evidence: index.evidence.find(item => item.id === id)!, stale: false, revision: index.metadata.revision }; },
    async verify() { return { valid: true, reasons: [], revision: index.metadata.revision }; },
    isCurrent: () => true,
  };
  return { source, index, story, services, reads };
}

test('configured acceptance checks every proof, data graph and source verification without embedding source text', async () => {
  const f = fixture(), report = await validateStory(f.story, f.index, f.services);
  assert.deepEqual(f.reads.sort(), f.index.evidence.map(item => item.id).sort());
  assert.equal(report.proofs.length, 2);
  assert.equal(report.counts.checkedEvidence, 3);
  assert.ok(report.graphs[0].edges >= 2);
  assert.equal(report.cacheVerification.valid, true);
  assert.ok(!JSON.stringify(report).includes('def receive'));
  assert.match(report.boundary, /No target execution/);
});

test('story selectors and raw relationships must resolve uniquely within the declared scope', async () => {
  const f = fixture();
  const ambiguous = structuredClone(f.index); ambiguous.nodes.push({ ...ambiguous.nodes[0], id: 'second-receive' });
  await assert.rejects(validateStory(f.story, ambiguous, f.services), /exactly one node/);
  const missing = structuredClone(f.index); missing.edges = missing.edges.filter(edge => edge.id !== 'call');
  await assert.rejects(validateStory(f.story, missing, f.services), /dispatch is missing/);
  await assert.rejects(validateStory({ ...f.story, projectId: 'other' }, f.index, f.services), /Story project differs/);
  await assert.rejects(validateStory({ ...f.story, worktreeId: 'other' }, f.index, f.services), /Story worktree differs/);
  assert.equal(f.reads.length, 0);
});

test('inferred relationships need explicit acceptance and never become statically confirmed', async () => {
  const f = fixture(); f.index.edges[0].confidence = 'inferred';
  await assert.rejects(validateStory(f.story, f.index, f.services), /dispatch is missing/);
  f.story.edges[0].confidence = ['inferred'];
  const report = await validateStory(f.story, f.index, f.services);
  assert.equal(report.proofs[0].edges[0].confidence, 'inferred');
  const empty = fixture(); empty.index.edges[0].evidenceIds = [];
  await assert.rejects(validateStory(empty.story, empty.index, empty.services), /缺少证据|source evidence/);
});

test('stale, changed and mixed evidence metadata fail before a successful report', async () => {
  for (const mutate of [
    (item: Awaited<ReturnType<StoryServices['evidence']>>) => { item.stale = true; },
    (item: Awaited<ReturnType<StoryServices['evidence']>>) => { item.revision = 'revision-two'; },
    (item: Awaited<ReturnType<StoryServices['evidence']>>) => { item.evidence.startLine++; },
    (item: Awaited<ReturnType<StoryServices['evidence']>>) => { item.evidence.rule = 'another.rule'; },
  ]) {
    const f = fixture(), original = f.services.evidence;
    f.services.evidence = async id => { const result = structuredClone(await original(id)); mutate(result); return result; };
    await assert.rejects(validateStory(f.story, f.index, f.services));
  }
  const changed = fixture(); changed.services.isCurrent = () => changed.reads.length === 0;
  await assert.rejects(validateStory(changed.story, changed.index, changed.services), /snapshot changed/);
  const verification = fixture(); verification.services.verify = async () => ({ valid: false, reasons: ['source changed'] });
  await assert.rejects(validateStory(verification.story, verification.index, verification.services), /source changed/);
});

test('stories reject unsafe or unknown settings and commands require explicit config and story', () => {
  const f = fixture();
  for (const value of [{ ...f.story, output: '../outside' }, { ...f.story, id: '../escape' }, { ...f.story, nodes: [{ id: 'bad', selector: {} }] },
    { ...f.story, nodes: [...f.story.nodes, f.story.nodes[0]] }, { ...f.story, edges: [{ ...f.story.edges[0], to: 'missing' }] }]) assert.throws(() => validateStoryDefinition(value));
  assert.throws(() => parseStoryArguments([]), /Usage/);
  assert.throws(() => parseStoryArguments(['--story', 'story.json']), /Usage/);
  assert.throws(() => parseStoryArguments(['--config', 'config.json', '--story', 'story.json', '--output', '../outside']), /Usage/);
  const parsed = parseStoryArguments(['story-fixture', '--config', 'config.json', '--story', 'story.json']);
  assert.equal(parsed.get('--project'), 'story-fixture');
  for (const entry of ['validate-story.ts', 'validate-hp.ts']) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(TOOL_ROOT, 'Tools', entry)], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage/);
  }
});

test('story input is bounded before reading and only regular JSON files are accepted', async t => {
  const base = path.join(TOOL_ROOT, '.tmp'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'story-input-'));
  t.after(async () => { assert.ok(directory.startsWith(base + path.sep)); await rm(directory, { recursive: true, force: true }); });
  const oversized = path.join(directory, 'large.json'), file = await open(oversized, 'w');
  try { await file.truncate(2 * 1024 * 1024 + 1); } finally { await file.close(); }
  await assert.rejects(readStoryDefinition(oversized), /exceeds 2 MiB/);
  await assert.rejects(readStoryDefinition(directory), /regular file|普通文件|EISDIR|EACCES/);
  const normal = path.join(directory, 'story.json'), linked = path.join(directory, 'linked.json');
  await writeFile(normal, JSON.stringify(fixture().story));
  await symlink(normal, linked, 'file');
  await assert.rejects(readStoryDefinition(linked), /符号链接|目录联接/);
});

test('real CLI and compatibility entry validate a self-contained Python story without executing its source', { timeout: 30000 }, async t => {
  const base = path.join(TOOL_ROOT, '.tmp'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'story-cli-')), target = path.join(directory, 'target');
  await mkdir(path.join(target, 'src'), { recursive: true });
  t.after(async () => { assert.ok(directory.startsWith(base + path.sep)); await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  execFileSync('git', ['init', '--initial-branch=main', target], { stdio: 'ignore', windowsHide: true });
  const f = fixture(), source = "raise RuntimeError('acceptance must never execute indexed source')\n" + f.source;
  const sourcePath = path.join(target, 'src/actions.py'); await writeFile(sourcePath, source);
  const configPath = path.join(directory, 'config.json'), storyPath = path.join(directory, 'story.json');
  await writeFile(configPath, JSON.stringify({ cacheDir: './cache', python: process.env.EXPLORER_PYTHON ?? 'python', projects: [{ id: 'story-fixture', name: 'Synthetic acceptance', root: './target', include: ['**/*.py'], exclude: [] }] }));
  await writeFile(storyPath, JSON.stringify(f.story));
  for (const entry of ['validate-story.ts', 'validate-hp.ts']) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(TOOL_ROOT, 'Tools', entry), 'story-fixture', '--config', configPath, '--story', storyPath], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.storyId, f.story.id);
    assert.equal(report.scope, 'story-fixture:primary');
    assert.equal(report.proofs.length, 2);
    assert.equal(report.cacheVerification.valid, true);
    assert.ok(report.report.startsWith(path.join(directory, 'cache') + path.sep));
    assert.equal(JSON.parse(await readFile(report.report, 'utf8')).storyId, f.story.id);
  }
  assert.equal(await readFile(sourcePath, 'utf8'), source);
  assert.ok((await readdir(path.join(directory, 'cache'))).some(file => file.startsWith('validation-story-')));
});

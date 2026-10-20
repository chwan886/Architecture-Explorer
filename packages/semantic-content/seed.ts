import assert from 'node:assert/strict';
import path from 'node:path';
import { open } from 'node:fs/promises';
import { loadConfig } from '../indexer/src/config.ts';
import { canonical, createFilePolicy, ensureCacheDirectory, readAuthorized } from '../indexer/src/security.ts';
import { contentHash } from '../schema/src/index.ts';
import { validateIndex } from '../schema/src/validate.ts';
import { validateModel } from '../architecture-model/src/index.ts';
import { validateDefinitions } from '../semantic-model/src/validation.ts';
import { buildCandidateDefinitions } from './src/seed.ts';

const config = await loadConfig();
const projectId = process.argv[2] ?? 'game-demo-02';
const project = config.projects.find(item => item.id === projectId);
assert.ok(project, '项目没有配置授权');
const scopeId = `${projectId}:primary`;
const key = contentHash(scopeId + '|' + canonical(project.root)).slice(0, 24);
const decoder = new TextDecoder('utf-8', { fatal: true });
const index: unknown = JSON.parse(decoder.decode(await readAuthorized(config.toolRoot, path.relative(config.toolRoot, path.join(config.cacheDir, key, 'lastgood.json')).replaceAll('\\', '/'), 256 * 1024 * 1024)));
validateIndex(index);
assert.equal(index.metadata.scopeId, scopeId);
assert.equal(canonical(index.metadata.rootPath), canonical(project.root));
assert.equal(index.metadata.configFingerprint, contentHash(config.fingerprint + '|' + scopeId), '配置已变化，请先同步索引');
const model: unknown = JSON.parse(decoder.decode(await readAuthorized(config.toolRoot, `architecture/models/${projectId}/model.json`)));
validateModel(model);
const paths = new Set(model.flows.flatMap(flow => flow.steps.flatMap(step => index.nodes.filter(node => node.qualifiedName === step.selector?.qualifiedName).flatMap(node => node.filePath ?? []))));
const sourceTexts: Record<string, string> = {};
const policy = createFilePolicy(project.include, project.exclude);
for (const sourcePath of paths) {
  assert.ok(policy.included(sourcePath) && index.files.some(file => file.path === sourcePath), '源码不在当前索引与配置白名单');
  sourceTexts[sourcePath] = decoder.decode(await readAuthorized(project.root, sourcePath));
}
const definitions = buildCandidateDefinitions(index, model, sourceTexts);
validateDefinitions(definitions);
const directory = await ensureCacheDirectory(path.join(config.toolRoot, 'architecture/semantics', projectId), config.toolRoot);
// Initial seeds are never silently overwritten after human curation.
const handle = await open(path.join(directory, 'definitions.json'), 'wx');
try { await handle.writeFile(JSON.stringify(definitions, null, 2) + '\n'); } finally { await handle.close(); }
console.log(JSON.stringify({ projectId, flows: definitions.flows.map(flow => ({ id: flow.id, groups: flow.groups.length, steps: flow.steps.length, bindings: flow.steps.flatMap(step => step.bindings).length })) }));

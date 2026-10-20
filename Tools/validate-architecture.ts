import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../packages/indexer/src/config.ts';
import { canonical, createFilePolicy, ensureCacheDirectory, readAuthorized } from '../packages/indexer/src/security.ts';
import { buildProjection, modelRevision, validateModel } from '../packages/architecture-model/src/index.ts';
import type { ArchitectureModel, SymbolSelector } from '../packages/architecture-model/src/types.ts';
import { contentHash, fileId, type ArchitectureIndex, type ArchitectureNode, type Confidence } from '../packages/schema/src/index.ts';
import { validateIndex } from '../packages/schema/src/validate.ts';

// Pure, read-only verification of the saved index and current authorized anchor files.
// No IndexManager, scanner, target execution, Git operations or scope lock is used.
const args = process.argv.slice(2);
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  assert.ok(['--config', '--project', '--worktree'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--'),
    '用法：tsx Tools/validate-architecture.ts [--config 文件] [--project ID] [--worktree primary|wt-ID]');
  assert.ok(!options.has(args[i]), `重复参数：${args[i]}`);
  options.set(args[i], args[i + 1]);
}
const config = await loadConfig(options.get('--config'));
const projectId = options.get('--project') ?? config.projects[0].id;
const project = config.projects.find(item => item.id === projectId);
assert.ok(project, '项目不在配置授权列表');
const worktreeId = options.get('--worktree') ?? 'primary';
const authorizedRoots = [project.root, ...(project.worktrees ?? [])];
const root = authorizedRoots.find(candidate => (canonical(candidate) === canonical(project.root) ? 'primary' : `wt-${contentHash(canonical(candidate)).slice(0, 12)}`) === worktreeId);
assert.ok(root, '工作目录不在配置明确授权列表');
const scopeId = `${projectId}:${worktreeId}`;
const cacheKey = contentHash(scopeId + '|' + canonical(root)).slice(0, 24);
const cachePath = path.join(config.cacheDir, cacheKey, 'lastgood.json');
const relativeToolPath = (absolute: string) => path.relative(config.toolRoot, absolute).replaceAll('\\', '/');
const decoder = new TextDecoder('utf-8', { fatal: true });
const indexValue: unknown = JSON.parse(decoder.decode(await readAuthorized(config.toolRoot, relativeToolPath(cachePath), 256 * 1024 * 1024)));
validateIndex(indexValue);
const index: ArchitectureIndex = indexValue;
assert.equal(index.metadata.projectId, projectId);
assert.equal(index.metadata.worktreeId, worktreeId);
assert.equal(index.metadata.scopeId, scopeId);
assert.equal(canonical(index.metadata.rootPath), canonical(root), '缓存源根与授权工作目录不一致');
assert.equal(index.metadata.configFingerprint, contentHash(config.fingerprint + '|' + scopeId), '配置已变化，请先用正常索引命令同步');
const modelPath = `architecture/models/${projectId}/model.json`;
const modelBytes = await readAuthorized(config.toolRoot, modelPath);
const modelValue: unknown = JSON.parse(decoder.decode(modelBytes));
validateModel(modelValue);
const model: ArchitectureModel = modelValue;
assert.equal(model.projectId, projectId);

const files = new Map(index.files.map(file => [file.path, file]));
const nodes = new Map(index.nodes.map(node => [node.id, node]));
const edges = new Map(index.edges.map(edge => [edge.id, edge]));
const evidence = new Map(index.evidence.map(item => [item.id, item]));
const anchors = new Map(model.anchors.map(anchor => [anchor.id, anchor]));
const policy = createFilePolicy(project.include, project.exclude);
const sourceTexts = new Map<string, { text: string; rawHash: string }>();
const anchorChecks = [];
for (const anchor of model.anchors) {
  assert.ok(policy.included(anchor.filePath), `锚点越过配置 include/exclude：${anchor.id}`);
  assert.equal(files.get(anchor.filePath)?.hash, anchor.expectedFileHash, `索引锚点哈希失效：${anchor.id}`);
  let source = sourceTexts.get(anchor.filePath);
  if (!source) {
    const bytes = await readAuthorized(root, anchor.filePath);
    source = { text: decoder.decode(bytes), rawHash: contentHash(bytes) };
    sourceTexts.set(anchor.filePath, source);
  }
  assert.equal(contentHash(source.text), anchor.expectedFileHash, `当前源码内容已变化：${anchor.id}`);
  const quote = source.text.split(/\r?\n/).slice(anchor.startLine - 1, anchor.endLine).join('\n');
  assert.equal(quote, anchor.quote.replaceAll('\r\n', '\n'), `完整行 quote 不匹配：${anchor.id}`);
  assert.ok(anchor.endLine - anchor.startLine < 80, `锚点超过预览预算：${anchor.id}`);
  assert.ok(nodes.has(fileId(scopeId, anchor.filePath)), `锚点未关联当前 Scope 的真实文件节点：${anchor.id}`);
  anchorChecks.push({ id: anchor.id, filePath: anchor.filePath, startLine: anchor.startLine, endLine: anchor.endLine,
    contentHash: anchor.expectedFileHash, rawBytesHash: source.rawHash, rawBytesEqualContentHash: source.rawHash === anchor.expectedFileHash });
}

function select(selector: SymbolSelector): ArchitectureNode[] {
  const prefix = selector.filePathPrefix?.replace(/\/$/, '');
  return index.nodes.filter(node => !!node.filePath && files.has(node.filePath) && !['project', 'system', 'module'].includes(node.kind)
    && (!selector.language || node.language === selector.language)
    && (!selector.kinds || selector.kinds.includes(node.kind))
    && (!selector.qualifiedName || node.qualifiedName === selector.qualifiedName)
    && (!selector.qualifiedNamePrefix || node.qualifiedName.startsWith(selector.qualifiedNamePrefix))
    && (!selector.filePath || node.filePath === selector.filePath)
    && (!prefix || node.filePath === prefix || node.filePath.startsWith(prefix + '/')));
}
for (const item of [...model.memberships, ...model.flows.flatMap(flow => flow.steps.filter(step => step.selector))]) {
  const matched = select(item.selector!);
  assert.ok(matched.length, `选择器没有真实源码目标：${item.id}`);
  for (const node of matched) assert.ok(policy.included(node.filePath!), `选择器包含未授权文件：${item.id}`);
}
const projection = buildProjection(index, model);
assert.equal(projection.metadata.scopeId, scopeId);
assert.equal(projection.metadata.sourceRevision, index.metadata.revision);
assert.equal(projection.metadata.modelRevision, modelRevision(model));
assert.ok(projection.entities.every(entity => entity.resolution === 'resolved'), '存在变更、缺失或冲突的系统/模块');
assert.ok(projection.memberships.every(rule => rule.resolution === 'resolved'), '存在变更、缺失或冲突的归属');
assert.ok(!projection.diagnostics.some(diagnostic => diagnostic.severity === 'error' || ['flow-call-unverified', 'flow-order-unverified'].includes(diagnostic.code)), '声明的调用/源码顺序无法验证');

const flowChecks = projection.flows.map(flow => {
  const steps = new Map(flow.steps.map(step => [step.id, step]));
  const proofs = flow.transitions.map(transition => {
    const from = steps.get(transition.source)!;
    const to = steps.get(transition.target)!;
    if (transition.basis === 'static-call') {
      assert.equal(transition.verification, 'static-confirmed', transition.id);
      assert.ok(transition.memberEdgeIds.every(id => edges.get(id)?.kind === 'calls' && edges.get(id)?.confidence === 'static-confirmed'), transition.id);
      const sourceIds = new Set(select(from.selector!).map(node => node.id));
      const targetIds = new Set(select(to.selector!).map(node => node.id));
      assert.ok(transition.memberEdgeIds.some(id => {
        const edge = edges.get(id);
        return edge?.kind === 'calls' && edge.confidence === 'static-confirmed' && sourceIds.has(edge.source) && targetIds.has(edge.target);
      }), `静态调用必须直接连接两个精确步骤符号：${transition.id}`);
    } else if (transition.basis === 'source-order') {
      assert.equal(transition.verification, 'source-supported', transition.id);
      assert.deepEqual(from.selector, to.selector, '源码顺序只用于同一被选方法中的局部语句');
      const roots = select(from.selector!);
      const before = transition.anchorIds.filter(id => from.anchorIds.includes(id)).map(id => anchors.get(id)!);
      const after = transition.anchorIds.filter(id => to.anchorIds.includes(id)).map(id => anchors.get(id)!);
      assert.ok(before.some(a => after.some(b => a.filePath === b.filePath && a.endLine < b.startLine && roots.some(node =>
        ['method', 'function'].includes(node.kind) && node.filePath === a.filePath && node.evidenceIds.some(id => {
          const declaration = evidence.get(id);
          return declaration && declaration.filePath === a.filePath && declaration.startLine <= a.startLine && declaration.endLine >= b.endLine;
        })))), `源码顺序锚点必须位于同一真实过程声明范围内：${transition.id}`);
    } else assert.equal(transition.verification, 'unverified', transition.id);
    assert.ok(transition.memberEdgeIds.every(id => edges.has(id)), transition.id);
    return { id: transition.id, basis: transition.basis, verification: transition.verification, memberEdgeIds: transition.memberEdgeIds };
  });
  return { id: flow.id, steps: flow.steps.length, reviewState: flow.reviewState,
    verificationCounts: { staticConfirmed: proofs.filter(proof => proof.verification === 'static-confirmed').length,
      sourceSupported: proofs.filter(proof => proof.verification === 'source-supported').length,
      unverified: proofs.filter(proof => proof.verification === 'unverified').length }, proofs };
});

let aggregateMembers = 0;
for (const relation of [...projection.relations, ...projection.technicalRelations]) {
  const counts: Record<Confidence, number> = { 'static-confirmed': 0, 'runtime-verified': 0, inferred: 0 };
  assert.equal(new Set(relation.memberEdgeIds).size, relation.memberEdgeIds.length, relation.id);
  assert.equal(relation.totalMembers, relation.memberEdgeIds.length, relation.id);
  const pendingOwners: boolean[] = [];
  for (const id of relation.memberEdgeIds) {
    const edge = edges.get(id); assert.ok(edge, `聚合成员不是当前原始关系：${id}`);
    assert.ok(nodes.has(edge.source) && nodes.has(edge.target), id);
    counts[edge.confidence]++;
    if (relation.level !== 'technical') {
      const ownerGroups = [edge.source, edge.target].map(nodeId => projection.ownership[nodeId]?.filter(owner => owner.role === 'owner' && owner.resolution === 'resolved' && owner.reviewState !== 'rejected') ?? []);
      assert.ok(ownerGroups.every(owners => owners.length > 0), `参与/共用归属不得制造聚合线：${id}`);
      assert.ok(ownerGroups.every(owners => new Set(owners.map(owner => `${owner.systemId}|${owner.moduleId}`)).size === 1), `冲突归属不得制造聚合线：${id}`);
      for (const owners of ownerGroups) pendingOwners.push(owners.some(owner => owner.reviewState !== 'confirmed'));
      const endpoints = ownerGroups.map(owners => {
        const owner = owners[0];
        return projection.entities.find(entity => entity.id === (relation.level === 'system' ? owner.systemId : owner.moduleId))?.nodeId;
      });
      assert.deepEqual(endpoints, [relation.source, relation.target], relation.id);
    }
  }
  assert.deepEqual(relation.confidenceCounts, counts, relation.id);
  if (relation.level !== 'technical') assert.equal(relation.membershipPending, pendingOwners.some(Boolean), relation.id);
  assert.equal(relation.condition, undefined, '聚合线不得继承单个成员分支条件');
  assert.equal(relation.dispatch, undefined, '聚合线不得继承单个成员调度类型');
  aggregateMembers += relation.totalMembers;
}

// Verify that report conclusions still refer to the model snapshot just validated.
assert.equal(contentHash(await readAuthorized(config.toolRoot, modelPath)), contentHash(modelBytes), '模型在验证期间变化，请重试');
const report = {
  checkedAt: new Date().toISOString(), mode: 'saved-index-and-current-anchor-files', metadata: projection.metadata,
  indexGeneratedAt: index.metadata.generatedAt,
  counts: { systems: model.systems.length, businessCandidates: model.systems.filter(system => system.kind === 'business').length,
    modules: model.modules.length, memberships: model.memberships.length, anchors: model.anchors.length, flows: model.flows.length,
    systemRelations: projection.relations.filter(relation => relation.level === 'system').length,
    aggregateMemberOccurrences: aggregateMembers, unclassifiedSourceNodes: projection.unclassifiedNodeIds.length,
    checkedSourceFiles: sourceTexts.size },
  entities: projection.entities.map(entity => ({ id: entity.id, name: entity.name, resolution: entity.resolution, reviewState: entity.reviewState })),
  reviewDecisions: model.reviews.length,
  membershipReviews: projection.memberships.reduce<Record<string, number>>((counts, rule) => { counts[rule.reviewState] = (counts[rule.reviewState] ?? 0) + 1; return counts; }, {}),
  flowChecks, anchorChecks, diagnostics: projection.diagnostics,
  boundary: '只读使用配置授权工作目录及已有索引；仅重新读取锚点文件验证当前内容，未执行全项目扫描、目标程序或Git操作。业务归属/流程复核状态独立于原始关系可信度；未验证顺序不代表运行时执行链。',
};
const reportDirectory = await ensureCacheDirectory(config.cacheDir, config.toolRoot);
const reportName = `validation-architecture-${projectId}-${worktreeId}.json`;
const temporary = path.join(reportDirectory, `${reportName}.${randomUUID()}.tmp`);
try { await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); await rename(temporary, path.join(reportDirectory, reportName)); }
finally { await unlink(temporary).catch(() => {}); }
console.log(JSON.stringify({ report: path.join(reportDirectory, reportName), metadata: report.metadata, counts: report.counts,
  reviewDecisions: report.reviewDecisions, flowChecks: flowChecks.map(({ proofs, ...summary }) => summary), diagnostics: projection.diagnostics }, null, 2));

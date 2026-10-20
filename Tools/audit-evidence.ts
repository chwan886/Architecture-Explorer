import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { IndexManager, loadConfig } from '../packages/indexer/src/index.ts';
import { canonical, createFilePolicy, ensureCacheDirectory, isWithin, readAuthorized } from '../packages/indexer/src/security.ts';
import { validateIndex } from '../packages/schema/src/validate.ts';
import { contentHash, type ArchitectureIndex } from '../packages/schema/src/index.ts';
import { ArchitectureService } from '../apps/server/src/architecture.ts';
import { SemanticService } from '../apps/server/src/semantics.ts';
import { auditEvidence, type AuditSourceFile, type EvidenceAuditInput } from '../packages/evidence-audit/src/index.ts';

// Deliberately no output-path option and no scanner/watch/target execution API.
// Reads authorized saved snapshots and their current indexed source files only.
const args = process.argv.slice(2), options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  assert.ok(['--config', '--project', '--worktree', '--max-findings', '--max-items'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--'),
    '用法：tsx Tools/audit-evidence.ts [--config 文件] [--project ID] [--worktree primary|wt-ID] [--max-findings 500] [--max-items 1000000]');
  assert.ok(!options.has(args[i]), `重复参数：${args[i]}`); options.set(args[i], args[i + 1]);
}
const budget = (name: string, fallback: number, max: number) => {
  const value = options.get(name); if (value === undefined) return fallback;
  assert.match(value, /^\d+$/, `${name} 必须为非负整数`);
  const parsed = Number(value); assert.ok(Number.isSafeInteger(parsed) && parsed <= max, `${name} 超过支持预算 ${max}`); return parsed;
};
const config = await loadConfig(options.get('--config'));
const projectId = options.get('--project') ?? config.projects[0].id;
const project = config.projects.find(item => item.id === projectId); assert.ok(project, '项目未被配置授权');
const worktreeId = options.get('--worktree') ?? 'primary';
assert.match(worktreeId, /^(primary|wt-[a-f0-9]{12})$/, 'Worktree ID 格式无效');
const scopeId = `${projectId}:${worktreeId}`;
const relativeToolPath = (absolute: string) => path.relative(config.toolRoot, absolute).replaceAll('\\', '/');
const decoder = new TextDecoder('utf-8', { fatal: true });
// Even accidental future scan calls fail instead of running a target parser here.
const manager = new IndexManager(config, { worker: async () => { throw new Error('证据审计命令禁止启动源码扫描器'); } });
try {
  await manager.initialize();
  const scope = manager.scope(scopeId); assert.ok(scope.index, '尚无当前配置下的有效索引，请先通过正常扫描命令生成');
  assert.ok(scope.worktree.authorized, '工作目录未被明确授权');
  await ensureCacheDirectory(scope.cachePath, config.toolRoot);
  const lastgood = path.join(scope.cachePath, 'lastgood.json');
  const initialIndexBytes = await readAuthorized(config.toolRoot, relativeToolPath(lastgood), 256 * 1024 * 1024);
  const savedIndex: unknown = JSON.parse(decoder.decode(initialIndexBytes)); validateIndex(savedIndex);
  const index: ArchitectureIndex = savedIndex;
  assert.equal(index.metadata.scopeId, scopeId); assert.equal(index.metadata.projectId, projectId); assert.equal(index.metadata.worktreeId, worktreeId);
  assert.equal(canonical(index.metadata.rootPath), canonical(scope.worktree.path));
  assert.equal(index.metadata.configFingerprint, contentHash(config.fingerprint + '|' + scopeId), '扫描配置已变化，请先同步索引');
  scope.index = index;
  const architectureService = new ArchitectureService(manager), semanticService = new SemanticService(manager, architectureService);
  const serviceErrors: NonNullable<EvidenceAuditInput['serviceErrors']> = [];
  let architecture: EvidenceAuditInput['architecture'], semantic: EvidenceAuditInput['semantic'];
  try { const current = await architectureService.current(scope); architecture = { model: current.model, projection: current.projection }; }
  catch (error) { serviceErrors.push({ service: 'architecture', message: error instanceof Error ? error.message : String(error) }); }
  try { semantic = (await semanticService.current(scope)).projection; }
  catch (error) { serviceErrors.push({ service: 'semantic', message: error instanceof Error ? error.message : String(error) }); }
  const policy = createFilePolicy(project.include, project.exclude);
  const sourceFiles: Record<string, AuditSourceFile> = {};
  let bytes = 0;
  assert.ok(index.files.length <= 50000, '索引超出 50,000 文件预算；请收窄 include');
  for (const file of index.files) {
    try {
      assert.ok(policy.included(file.path), '索引文件不符合当前 include/exclude 授权');
      const buffer = await readAuthorized(scope.worktree.path, file.path);
      bytes += buffer.length; assert.ok(bytes <= 256 * 1024 * 1024, '当前文件读取超过 256 MiB 预算');
      sourceFiles[file.path] = { content: decoder.decode(buffer) };
    } catch (error) {
      sourceFiles[file.path] = { error: error instanceof Error ? error.message : String(error) };
      if (bytes > 256 * 1024 * 1024) throw error;
    }
  }
  assert.equal(contentHash(await readAuthorized(config.toolRoot, relativeToolPath(lastgood), 256 * 1024 * 1024)), contentHash(initialIndexBytes), '索引在审计期间更新，请重跑以避免混合快照');
  const currentModel = await architectureService.model(projectId);
  if (architecture) assert.equal(currentModel.modelRevision, architecture.projection.metadata.modelRevision, '架构模型在审计期间更新，请重跑');
  const envelope = await semanticService.store.read(projectId, scopeId);
  if (semantic) {
    assert.equal(envelope.definitionRevision, semantic.metadata.definitionRevision, '解释定义在审计期间更新，请重跑');
    assert.equal(envelope.overlayRevision, semantic.metadata.overlayRevision, '人工解释在审计期间更新，请重跑');
  }
  const report = auditEvidence({ index, architecture, semantic, sourceFiles, serviceErrors,
    limits: { maxFindings: budget('--max-findings', 500, 10000), maxItems: budget('--max-items', 1000000, 5000000) } });
  const directory = path.join(config.cacheDir, 'evidence-audit');
  assert.ok(config.projects.every(item => [item.root, ...(item.worktrees ?? [])].every(root => !isWithin(root, directory))), '审计报告不能写入分析目标');
  const reportDirectory = await ensureCacheDirectory(directory, config.toolRoot);
  const reportPath = path.join(reportDirectory, `${projectId}-${worktreeId}.json`);
  const temporary = path.join(reportDirectory, `${projectId}-${worktreeId}.${randomUUID()}.tmp`);
  try { await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); await rename(temporary, reportPath); }
  finally { await unlink(temporary).catch(() => {}); }
  console.log(JSON.stringify({ report: reportPath, result: report.result, snapshot: report.snapshot, coverage: report.coverage, totals: report.totals,
    truncation: report.truncation, nextActions: report.groups.flows.map(({ sampleFindingIds: _samples, ...item }) => item) }, null, 2));
  if (report.result === 'invalid' || report.result === 'incomplete') process.exitCode = 1;
} finally { await manager.close(); }

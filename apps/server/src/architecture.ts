import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { contentHash, type ArchitectureIndex } from '../../../packages/schema/src/index.ts';
import type { IndexManager, ScopeRuntime } from '../../../packages/indexer/src/indexer.ts';
import { AccessError, authorizedFile, ensureCacheDirectory, readAuthorized } from '../../../packages/indexer/src/security.ts';
import { architectureView, buildProjection, entityDetail, modelRevision, ownership, relationMembers, reviewFingerprint, validateModel } from '../../../packages/architecture-model/src/index.ts';
import type { ArchitectureModel, ArchitectureProjection, ModelEnvelope, RelationCategory, ReviewDecision, SourceAnchor } from '../../../packages/architecture-model/src/types.ts';

const failure = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const categories = new Set<RelationCategory>(['dependency', 'call', 'interface', 'data-access', 'event', 'resource', 'initialization']);
const decoder = new TextDecoder('utf-8', { fatal: true });
interface Context { index: ArchitectureIndex; model: ArchitectureModel; projection: ArchitectureProjection }
export class ArchitectureService {
  private projections = new Map<string, Promise<Context>>();
  constructor(readonly manager: IndexManager) {}

  private modelPath(projectId: string) {
    if (!this.manager.config.projects.some(project => project.id === projectId)) throw new AccessError('项目未授权');
    return `architecture/models/${projectId}/model.json`;
  }
  async model(projectId: string): Promise<ModelEnvelope> {
    const relative = this.modelPath(projectId);
    let model: ArchitectureModel;
    try {
      const value = await readAuthorized(this.manager.config.toolRoot, relative, 1024 * 1024);
      model = JSON.parse(decoder.decode(value)); validateModel(model);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw failure(`架构模型读取失败：${error instanceof Error ? error.message : String(error)}`);
      model = { schemaVersion: '1.0.0', projectId, name: '尚未定义业务系统', systems: [], modules: [], memberships: [], anchors: [], flows: [], reviews: [] };
    }
    if (model.projectId !== projectId) throw failure('架构模型的 projectId 与授权项目不一致');
    return { model, modelRevision: modelRevision(model) };
  }
  async current(scope: ScopeRuntime): Promise<Context> {
    const index = scope.index;
    if (!index) throw failure('源码索引尚未就绪', 409);
    const envelope = await this.model(scope.project.id);
    const key = `${scope.id}|${index.metadata.revision}|${envelope.modelRevision}`;
    const cached = this.projections.get(key);
    if (cached) {
      const context = await cached;
      if (context.index === index) return context;
      if (this.projections.get(key) === cached) this.projections.delete(key);
      return this.current(scope);
    }
    // Keep the latest projection per worktree; completed older requests retain
    // their own snapshot without keeping many full source indexes alive here.
    for (const previous of this.projections.keys()) if (previous.startsWith(`${scope.id}|`)) this.projections.delete(previous);
    const pending = (async () => {
      const texts = new Map<string, string>();
      for (const anchor of envelope.model.anchors) {
        if (!index.files.some(file => file.path === anchor.filePath && file.hash === anchor.expectedFileHash)) continue;
        let text = texts.get(anchor.filePath);
        if (text === undefined) { text = decoder.decode(await readAuthorized(scope.worktree.path, anchor.filePath)); texts.set(anchor.filePath, text); }
        if (contentHash(text) !== anchor.expectedFileHash) throw failure('源码正在变化，请等待索引同步后重新读取架构', 409);
        this.verifyQuote(anchor, text);
      }
      const projection = buildProjection(index, envelope.model);
      if (scope.index?.metadata.revision !== index.metadata.revision) throw failure('源码索引版本已变化，请重新载入', 409);
      // A derived snapshot is isolated by the same authorized worktree as its index.
      // On restart it is recomputed from validated facts/model rather than trusting disk JSON.
      const directory = await ensureCacheDirectory(scope.cachePath, this.manager.config.toolRoot);
      const temporary = path.join(directory, `architecture.${randomUUID()}.tmp`);
      try { await writeFile(temporary, JSON.stringify(projection), { flag: 'wx' }); await rename(temporary, path.join(directory, 'architecture.json')); }
      finally { await unlink(temporary).catch(() => {}); }
      if (scope.index?.metadata.revision !== index.metadata.revision) throw failure('源码索引版本已变化，请重新载入', 409);
      return { index, model: envelope.model, projection };
    })();
    this.projections.set(key, pending);
    pending.catch(() => { if (this.projections.get(key) === pending) this.projections.delete(key); });
    while (this.projections.size > 16) this.projections.delete(this.projections.keys().next().value!);
    return pending;
  }
  requireVersion(context: Context, version?: string) {
    if (version && version !== context.projection.metadata.viewRevision) throw failure('架构视图版本已变化，请重新载入后查看证据或修改归属', 409);
  }
  private async validateAnchors(scope: ScopeRuntime, model: ArchitectureModel, previous: ArchitectureModel) {
    const old = new Map(previous.anchors.map(anchor => [anchor.id, JSON.stringify(anchor)]));
    const files = new Map(scope.index?.files.map(file => [file.path, file]));
    const texts = new Map<string, string>();
    for (const anchor of model.anchors) {
      if (old.get(anchor.id) === JSON.stringify(anchor)) continue;
      if (!files.has(anchor.filePath)) throw failure(`锚点文件不在当前授权索引：${anchor.filePath}`);
      let content = texts.get(anchor.filePath);
      if (content === undefined) { content = decoder.decode(await readAuthorized(scope.worktree.path, anchor.filePath)); texts.set(anchor.filePath, content); }
      if (contentHash(content) !== anchor.expectedFileHash || files.get(anchor.filePath)!.hash !== anchor.expectedFileHash) throw failure(`锚点源码哈希已变化：${anchor.id}`, 409);
      this.verifyQuote(anchor, content);
    }
  }
  private verifyQuote(anchor: SourceAnchor, content: string) {
    const lines = content.split(/\r?\n/);
    if (anchor.endLine > lines.length || anchor.endLine - anchor.startLine > 80 || lines.slice(anchor.startLine - 1, anchor.endLine).join('\n') !== anchor.quote.replaceAll('\r\n', '\n')) {
      throw failure(`源码锚点行范围或 quote 不匹配：${anchor.id}`);
    }
  }
  async save(scope: ScopeRuntime, expected: string, transform: (model: ArchitectureModel) => ArchitectureModel): Promise<ModelEnvelope> {
    const relative = this.modelPath(scope.project.id);
    const directory = await ensureCacheDirectory(path.dirname(path.join(this.manager.config.toolRoot, relative)), this.manager.config.toolRoot);
    const lockPath = path.join(directory, 'model.lock'); const token = `${process.pid}:${randomUUID()}`;
    let lock;
    try { lock = await open(lockPath, 'wx'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw failure('另一个窗口或进程正在保存模型，请稍后重试', 409); throw error; }
    const temporary = path.join(directory, `model.${randomUUID()}.tmp`);
    try {
      await lock.writeFile(token); await lock.close();
      const previous = await this.model(scope.project.id);
      if (expected !== previous.modelRevision) throw failure('架构模型已被其他窗口修改；保留当前草稿，请重新读取后合并', 409);
      const model = transform(structuredClone(previous.model)); validateModel(model);
      if (model.projectId !== scope.project.id) throw failure('不能更换模型授权项目');
      await this.validateAnchors(scope, model, previous.model);
      // Recheck final path to reject a symlink introduced before replacement.
      try { await authorizedFile(this.manager.config.toolRoot, relative); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await writeFile(temporary, JSON.stringify(model, null, 2) + '\n', { flag: 'wx' });
      await rename(temporary, path.join(directory, 'model.json'));
      this.projections.clear();
      const revision = modelRevision(model);
      this.manager.emit('architecture-model', { projectId: scope.project.id, modelRevision: revision });
      return { model, modelRevision: revision };
    } finally {
      await lock.close().catch(() => {}); await unlink(temporary).catch(() => {});
      if (await readFile(lockPath, 'utf8').catch(() => '') === token) await unlink(lockPath);
    }
  }
  async review(scope: ScopeRuntime, input: { expectedModelRevision: string; viewRevision: string; targetType: ReviewDecision['targetType']; targetId: string; decision: 'confirmed' | 'rejected' | 'pending' }) {
    const context = await this.current(scope); this.requireVersion(context, input.viewRevision);
    const fingerprint = reviewFingerprint(context.projection, input.targetType, input.targetId);
    if (!fingerprint) throw failure('复核目标不存在', 404);
    if (input.decision === 'confirmed') {
      const fileSet = new Set<string>();
      if (input.targetType === 'membership') {
        const item = context.projection.memberships.find(item => item.id === input.targetId);
        if (!item || item.resolution !== 'resolved') throw failure('无法确认未解析、冲突或源码已变化的归属', 409);
        const ids = new Set(item.nodeIds); context.index.nodes.forEach(node => { if (ids.has(node.id) && node.filePath) fileSet.add(node.filePath); });
      } else if (input.targetType === 'system') {
        const item = context.projection.entities.find(item => item.entityKind === 'system' && item.id === input.targetId);
        if (!item || item.resolution !== 'resolved') throw failure('系统源码依据需要先复核', 409);
        const ids = new Set(item.memberNodeIds); context.index.nodes.forEach(node => { if (ids.has(node.id) && node.filePath) fileSet.add(node.filePath); });
      } else {
        const flow = context.projection.flows.find(item => item.id === input.targetId);
        if (!flow || flow.steps.some(step => step.resolution !== 'resolved')) throw failure('流程有无法定位或变化的步骤，不能确认', 409);
        for (const step of flow.steps) for (const id of step.evidenceIds) { const item = context.projection.evidence.find(item => item.id === id) || context.index.evidence.find(item => item.id === id); if (item) fileSet.add(item.filePath); }
      }
      for (const file of fileSet) {
        const content = decoder.decode(await readAuthorized(scope.worktree.path, file));
        if (contentHash(content) !== context.index.files.find(item => item.path === file)?.hash) throw failure('源码已变化，请等待索引同步后再确认', 409);
      }
    }
    return this.save(scope, input.expectedModelRevision, model => {
      if (scope.index?.metadata.revision !== context.index.metadata.revision) throw failure('源码版本已变化，请重新复核', 409);
      model.reviews = model.reviews.filter(review => !(review.targetType === input.targetType && review.targetId === input.targetId && review.scopeId === scope.id));
      if (input.decision !== 'pending') model.reviews.push({ targetType: input.targetType, targetId: input.targetId, scopeId: scope.id, fingerprint, decision: input.decision, reviewedAt: new Date().toISOString() });
      return model;
    });
  }
  async evidence(scope: ScopeRuntime, id: string, version?: string) {
    const context = await this.current(scope); this.requireVersion(context, version);
    if (context.index.evidence.some(item => item.id === id)) {
      const result = await this.manager.evidence(scope.id, id);
      if (scope.index?.metadata.revision !== context.index.metadata.revision || result.revision !== context.index.metadata.revision) throw failure('源码索引版本已变化，请重新载入', 409);
      return result;
    }
    const evidence = context.projection.evidence.find(item => item.id === id);
    if (!evidence || !context.index.files.some(file => file.path === evidence.filePath && file.hash === evidence.fileHash)) throw failure('证据不属于当前授权索引', 404);
    const content = decoder.decode(await readAuthorized(scope.worktree.path, evidence.filePath));
    if (contentHash(content) !== evidence.fileHash) return { evidence, content: '源码已变化；请等待索引同步并复核架构锚点。', stale: true, revision: context.index.metadata.revision };
    const anchor = context.model.anchors.find(anchor => anchor.filePath === evidence.filePath && anchor.expectedFileHash === evidence.fileHash && anchor.startLine === evidence.startLine && anchor.endLine === evidence.endLine);
    if (anchor) this.verifyQuote(anchor, content);
    if (scope.index?.metadata.revision !== context.index.metadata.revision) throw failure('源码索引版本已变化，请重新载入', 409);
    const lines = content.split(/\r?\n/); const start = Math.max(0, evidence.startLine - 5); const end = Math.min(lines.length, evidence.endLine + 4, start + 100);
    return { evidence, content: lines.slice(start, end).join('\n'), contextStartLine: start + 1, stale: false, revision: context.index.metadata.revision };
  }
}

export function registerArchitectureRoutes(app: FastifyInstance, manager: IndexManager) {
  const service = new ArchitectureService(manager);
  const parameter = (request: FastifyRequest, name: string) => { const value = (request.query as Record<string, unknown>)?.[name]; if (value === undefined || value === '') return undefined; if (typeof value !== 'string' || value.length > 1024) throw failure(`无效的 ${name}`); return value; };
  const scope = (request: FastifyRequest) => manager.scope(parameter(request, 'scope'));
  const context = async (request: FastifyRequest) => { const value = await service.current(scope(request)); service.requireVersion(value, parameter(request, 'viewRevision')); return value; };
  app.get('/api/architecture', async request => { const value = await context(request); const perspective = parameter(request, 'perspective') ?? 'business'; if (perspective !== 'business' && perspective !== 'technical') throw failure('不支持的架构视角'); const category = parameter(request, 'category'); if (category && !categories.has(category as RelationCategory)) throw failure('不支持的关系类别'); return architectureView(value.projection, value.index, perspective, parameter(request, 'rootId'), category as RelationCategory | undefined); });
  app.get<{ Params: { id: string } }>('/api/architecture/entities/:id', async request => { const value = await context(request); return entityDetail(value.projection, value.index, request.params.id); });
  app.get<{ Params: { id: string } }>('/api/architecture/relations/:id', async request => { const value = await context(request); const integer = (key: string, fallback: number, max: number) => { const input = parameter(request, key); const n = input === undefined ? fallback : Number(input); if (!Number.isInteger(n) || n < (key === 'offset' ? 0 : 1) || n > max) throw failure(`无效的 ${key}`); return n; }; return relationMembers(value.projection, value.index, request.params.id, integer('offset', 0, 50000), integer('limit', 30, 100)); });
  app.get('/api/architecture/flows', async request => { const value = await context(request); return { metadata: value.projection.metadata, flows: value.projection.flows }; });
  app.get('/api/architecture/ownership', async request => { const value = await context(request); const id = parameter(request, 'nodeId'); if (!id || !value.index.nodes.some(node => node.id === id)) throw failure('代码节点不存在', 404); return ownership(value.projection, id); });
  app.get('/api/architecture/unclassified', async request => {
    const value = await context(request);
    const offset = Number(parameter(request, 'offset') ?? 0), limit = Number(parameter(request, 'limit') ?? 30);
    if (!Number.isInteger(offset) || offset < 0 || offset > 50000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw failure('待分类分页参数越界');
    const ids = new Set(value.projection.unclassifiedNodeIds.slice(offset, offset + limit));
    return { metadata: value.projection.metadata, nodes: value.index.nodes.filter(node => ids.has(node.id)), offset, total: value.projection.unclassifiedNodeIds.length, truncated: offset + ids.size < value.projection.unclassifiedNodeIds.length };
  });
  app.get<{ Params: { id: string } }>('/api/architecture/evidence/:id', async request => service.evidence(scope(request), request.params.id, parameter(request, 'viewRevision')));
  app.get('/api/architecture/model', async request => service.model(scope(request).project.id));
  app.put('/api/architecture/model', { bodyLimit: 512 * 1024, schema: { body: { type: 'object', additionalProperties: false, required: ['expectedRevision', 'model'], properties: { expectedRevision: { type: 'string', maxLength: 128 }, model: { type: 'object' } } } } }, async request => { const body = request.body as { expectedRevision: string; model: ArchitectureModel }; return service.save(scope(request), body.expectedRevision, () => body.model); });
  app.post('/api/architecture/review', { schema: { body: { type: 'object', additionalProperties: false, required: ['expectedModelRevision', 'viewRevision', 'targetType', 'targetId', 'decision'], properties: { expectedModelRevision: { type: 'string', maxLength: 128 }, viewRevision: { type: 'string', maxLength: 128 }, targetType: { enum: ['system', 'membership', 'flow'] }, targetId: { type: 'string', maxLength: 128 }, decision: { enum: ['confirmed', 'rejected', 'pending'] } } } } }, async request => service.review(scope(request), request.body as Parameters<ArchitectureService['review']>[1]));
  return service;
}

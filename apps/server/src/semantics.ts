import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IndexManager, ScopeRuntime } from '../../../packages/indexer/src/indexer.ts';
import { AccessError, createFilePolicy, ensureCacheDirectory, readAuthorized } from '../../../packages/indexer/src/security.ts';
import { contentHash, type ArchitectureIndex } from '../../../packages/schema/src/index.ts';
import { modelRevision } from '../../../packages/architecture-model/src/index.ts';
import type { ArchitectureModel } from '../../../packages/architecture-model/src/types.ts';
import { buildSemanticProjection, semanticBundle, semanticMetadata, semanticReverse, semanticReviewFingerprint, validateDefinitions } from '../../../packages/semantic-model/src/index.ts';
import { canonicalJson } from '../../../packages/architecture-model/src/validation.ts';
import { SEMANTIC_GENERATOR_VERSION, type SemanticDefinitionEnvelope, type SemanticEditorEnvelope, type SemanticFlowDefinition, type SemanticProjection } from '../../../packages/semantic-model/src/types.ts';
import { SemanticStore } from './semantic-store.ts';
import type { ArchitectureService } from './architecture.ts';
import { generateCandidateFlow } from '../../../packages/semantic-content/src/index.ts';

const failure = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const decoder = new TextDecoder('utf-8', { fatal: true });
interface Context { index: ArchitectureIndex; model: ArchitectureModel; envelope: SemanticDefinitionEnvelope; projection: SemanticProjection }
interface ReviewInput { expectedOverlayRevision: string; viewRevision: string; flowId: string; targetType: 'flow' | 'node' | 'edge'; targetId: string; decision: 'confirmed' | 'rejected' | 'pending' }

export class SemanticService {
  readonly store: SemanticStore;
  private pending = new Map<string, Promise<Context>>();
  private previous = new Map<string, SemanticProjection>();
  constructor(readonly manager: IndexManager, readonly architecture: ArchitectureService) { this.store = new SemanticStore(manager.config); }

  private checkSnapshot(scope: ScopeRuntime, context: Pick<Context, 'index'>) {
    if (scope.index !== context.index || scope.index.metadata.revision !== context.index.metadata.revision) throw failure('源码索引已变化，请重新载入语义视图', 409);
  }
  requireVersion(context: Context, revision?: string) {
    if (revision && revision !== context.projection.metadata.viewRevision) throw failure('解释视图版本已变化；请重新载入，当前草稿不会被覆盖', 409);
  }
  private async sourceTexts(scope: ScopeRuntime, index: ArchitectureIndex, model: ArchitectureModel, envelope: SemanticDefinitionEnvelope) {
    // Only current indexed, configured files are eligible. No path supplied by
    // the browser can turn this into an arbitrary filesystem reader.
    const paths = new Set(model.anchors.map(anchor => anchor.filePath));
    for (const flow of envelope.effectiveFlows) for (const step of flow.steps) for (const binding of step.bindings) {
      const selector = binding.selector ?? model.flows.find(item => item.id === flow.sourceFlowId)?.steps.find(item => item.id === binding.sourceStepId)?.selector;
      if (!selector) continue;
      for (const node of index.nodes) {
        if (selector.filePath && selector.filePath !== node.filePath) continue;
        if (selector.filePathPrefix) { const prefix = selector.filePathPrefix.replace(/\/$/, ''); if (node.filePath !== prefix && !node.filePath?.startsWith(prefix + '/')) continue; }
        if (selector.qualifiedName && selector.qualifiedName !== node.qualifiedName) continue;
        if (selector.qualifiedNamePrefix && !node.qualifiedName.startsWith(selector.qualifiedNamePrefix)) continue;
        if (selector.language && selector.language !== node.language) continue;
        if (selector.kinds && !selector.kinds.includes(node.kind)) continue;
        if (node.filePath) paths.add(node.filePath);
      }
    }
    const policy = createFilePolicy(scope.project.include, scope.project.exclude);
    const files = new Map(index.files.map(file => [file.path, file.hash]));
    const texts: Record<string, string> = {};
    for (const relative of paths) {
      const expected = files.get(relative); if (!expected || !policy.included(relative)) continue;
      const content = decoder.decode(await readAuthorized(scope.worktree.path, relative));
      if (contentHash(content) !== expected) throw failure('源码正在变化，请等待索引同步后核验解释', 409);
      texts[relative] = content;
    }
    this.checkSnapshot(scope, { index }); return texts;
  }
  async current(scope: ScopeRuntime, force = false): Promise<Context> {
    const index = scope.index; if (!index) throw failure('源码索引尚未就绪', 409);
    const [architecture, envelope] = await Promise.all([this.architecture.model(scope.project.id), this.store.read(scope.project.id, scope.id)]);
    this.checkSnapshot(scope, { index });
    const key = [scope.id, index.metadata.revision, architecture.modelRevision, envelope.definitionRevision, envelope.overlayRevision].join('|');
    const cached = this.pending.get(key);
    if (!force && cached) {
      const context = await cached;
      if (context.index === index) return context;
      if (this.pending.get(key) === cached) this.pending.delete(key);
      return this.current(scope);
    }
    for (const id of this.pending.keys()) if (id.startsWith(scope.id + '|')) this.pending.delete(id);
    const task = (async () => {
      const texts = await this.sourceTexts(scope, index, architecture.model, envelope);
      let projection: SemanticProjection;
      try { projection = buildSemanticProjection(index, architecture.model, envelope.definitions, envelope.overlay, { sourceTexts: texts, previous: this.previous.get(scope.id) }); }
      catch (error) { throw failure(`语义映射校验失败：${error instanceof Error ? error.message : String(error)}`); }
      this.checkSnapshot(scope, { index });
      const directory = await ensureCacheDirectory(scope.cachePath, this.manager.config.toolRoot);
      const temporary = path.join(directory, `semantics.${randomUUID()}.tmp`);
      try { await writeFile(temporary, JSON.stringify(projection), { flag: 'wx' }); await rename(temporary, path.join(directory, 'semantics.json')); }
      finally { await unlink(temporary).catch(() => {}); }
      this.checkSnapshot(scope, { index });
      this.previous.set(scope.id, projection);
      return { index, model: architecture.model, envelope, projection };
    })();
    this.pending.set(key, task); task.catch(() => { if (this.pending.get(key) === task) this.pending.delete(key); });
    return task;
  }
  private async live(scope: ScopeRuntime, context: Context) {
    this.checkSnapshot(scope, context);
    const [currentModel, currentEnvelope] = await Promise.all([this.architecture.model(scope.project.id), this.store.read(scope.project.id, scope.id)]);
    if (currentModel.modelRevision !== modelRevision(context.model) || currentEnvelope.definitionRevision !== context.envelope.definitionRevision || currentEnvelope.overlayRevision !== context.envelope.overlayRevision) throw failure('解释或架构定义已变化，请保留草稿并重新载入', 409);
    await this.sourceTexts(scope, context.index, context.model, context.envelope);
    this.checkSnapshot(scope, context);
  }
  async editorModel(scope: ScopeRuntime): Promise<SemanticEditorEnvelope> {
    const context = await this.current(scope);
    await this.live(scope, context);
    return { ...context.envelope, metadata: context.projection.metadata };
  }
  async save(scope: ScopeRuntime, input: { expectedOverlayRevision: string; viewRevision: string; flow: SemanticFlowDefinition }): Promise<SemanticEditorEnvelope> {
    const context = await this.current(scope); this.requireVersion(context, input.viewRevision);
    validateDefinitions({ schemaVersion: '1.0.0', projectId: scope.project.id, flows: [input.flow] });
    const existing = context.envelope.effectiveFlows.find(flow => flow.id === input.flow.id);
    if (!existing || existing.sourceFlowId !== input.flow.sourceFlowId) throw failure('只能维护当前真实流程的解释；不能更换流程源', 400);
    const source = context.model.flows.find(flow => flow.id === existing.sourceFlowId)!;
    if (input.flow.steps.some(step => step.sourceStepIds.some(id => !source.steps.some(item => item.id === id)))) throw failure('解释步骤引用了不存在的源流程步骤');
    const factShape = (step: SemanticFlowDefinition['steps'][number]) => ({ id: step.id, sourceStepIds: step.sourceStepIds, controls: step.controls,
      bindings: step.bindings.map(({ expectedDeclarationHash: _baseline, ...binding }) => binding) });
    if (input.flow.steps.length !== existing.steps.length || input.flow.steps.some(step => {
      const original = existing.steps.find(item => item.id === step.id);
      return !original || canonicalJson(factShape(step)) !== canonicalJson(factShape(original));
    })) throw failure('解释维护不能删除详细步骤、控制边界或改写实现绑定；请在原架构模型中修正事实映射');
    const resolved = context.projection.flows.find(flow => flow.id === existing.id)!;
    for (const step of input.flow.steps) for (const binding of step.bindings) {
      const original = existing.steps.find(item => item.id === step.id)!.bindings.find(item => item.id === binding.id)!;
      if (binding.expectedDeclarationHash !== original.expectedDeclarationHash) {
        const current = resolved.detailNodes.find(item => item.id === step.id)?.bindings.find(item => item.id === binding.id);
        if (!binding.expectedDeclarationHash || current?.codeNodeIds.length !== 1 || current.declarationHash !== binding.expectedDeclarationHash || current.anchorsValid === false || ['ambiguous', 'missing', 'conflict'].includes(current.status)) throw failure('新源码基准必须来自当前唯一绑定声明，且原锚点有效；不能按名称猜测或伪造哈希');
      }
    }
    await this.live(scope, context);
    const result = this.changed(scope, await this.store.save(scope.project.id, scope.id, input.expectedOverlayRevision, overlay => {
      this.checkSnapshot(scope, context);
      const flow = structuredClone(input.flow);
      // Text authorship is independent of the immutable source facts.
      const before = new Map([...existing.groups, ...existing.steps].map(node => [node.id, JSON.stringify(node)]));
      for (const node of [...flow.groups, ...flow.steps]) if (JSON.stringify(node) !== before.get(node.id)) node.origin = 'human-edited';
      overlay.flowOverrides = [...overlay.flowOverrides.filter(item => item.id !== flow.id), flow];
      return overlay;
    }, () => this.live(scope, context)));
    return { ...result, metadata: semanticMetadata(context.index, context.model, result.definitions, result.overlay) };
  }
  private changed(scope: ScopeRuntime, result: SemanticDefinitionEnvelope) {
    for (const key of this.pending.keys()) if (key.startsWith(scope.id + '|')) this.pending.delete(key);
    this.manager.emit('semantic-model', { scopeId: scope.id, overlayRevision: result.overlayRevision }); return result;
  }
  async review(scope: ScopeRuntime, input: ReviewInput) {
    const context = await this.current(scope); this.requireVersion(context, input.viewRevision);
    const fingerprint = semanticReviewFingerprint(context.projection, input.flowId, input.targetType, input.targetId);
    if (!fingerprint) throw failure('解释复核目标不存在', 404);
    const flow = context.projection.flows.find(flow => flow.id === input.flowId)!;
    if (input.decision === 'confirmed') {
      if (input.targetType === 'flow' && flow.diagnostics.some(item => /semantic-source-(step|transition)-(unmapped|missing|removed)/.test(item.code))) throw failure('源流程存在未映射或已删除的步骤/关系，需先维护解释覆盖范围', 409);
      const status = input.targetType === 'flow' ? ([...flow.summaryNodes, ...flow.detailNodes, ...flow.summaryEdges, ...flow.detailEdges].every(item => item.status === 'current') ? 'current' : 'stale')
        : input.targetType === 'node' ? [...flow.summaryNodes, ...flow.detailNodes].find(item => item.id === input.targetId)?.status : [...flow.summaryEdges, ...flow.detailEdges].find(item => item.id === input.targetId)?.status;
      if (status !== 'current') throw failure('解释包含变化、缺失或歧义映射，请先核对源码并修正映射', 409);
    }
    await this.live(scope, context);
    return this.changed(scope, await this.store.save(scope.project.id, scope.id, input.expectedOverlayRevision, overlay => {
      this.checkSnapshot(scope, context);
      overlay.reviews = overlay.reviews.filter(item => !(item.flowId === input.flowId && item.targetType === input.targetType && item.targetId === input.targetId));
      if (input.decision !== 'pending') overlay.reviews.push({ flowId: input.flowId, targetType: input.targetType, targetId: input.targetId, fingerprint, decision: input.decision, reviewedAt: new Date().toISOString() });
      return overlay;
    }, () => this.live(scope, context)));
  }
  async evidence(scope: ScopeRuntime, id: string, version?: string) {
    const context = await this.current(scope); this.requireVersion(context, version);
    const item = context.projection.flows.flatMap(flow => flow.evidence).find(item => item.id === id);
    if (!item) throw failure('证据不属于此流程快照', 404);
    if (context.index.evidence.some(item => item.id === id)) {
      const result = await this.manager.evidence(scope.id, id); this.checkSnapshot(scope, context);
      if (result.revision !== context.index.metadata.revision) throw failure('源码证据版本已变化', 409); return result;
    }
    const policy = createFilePolicy(scope.project.include, scope.project.exclude);
    if (!policy.included(item.filePath) || !context.index.files.some(file => file.path === item.filePath && file.hash === item.fileHash)) throw failure('证据不属于当前授权索引', 404);
    const content = decoder.decode(await readAuthorized(scope.worktree.path, item.filePath)); this.checkSnapshot(scope, context);
    if (contentHash(content) !== item.fileHash) return { evidence: item, content: '源码已变化；请等待索引同步并重新审核解释。', stale: true, revision: context.index.metadata.revision };
    const lines = content.split(/\r?\n/); const start = Math.max(0, item.startLine - 5); const end = Math.min(lines.length, item.endLine + 4, start + 100);
    return { evidence: item, content: lines.slice(start, end).join('\n'), contextStartLine: start + 1, stale: false, revision: context.index.metadata.revision };
  }
}

export function registerSemanticRoutes(app: FastifyInstance, manager: IndexManager, architecture: ArchitectureService) {
  const service = new SemanticService(manager, architecture);
  const parameter = (request: FastifyRequest, name: string) => { const value = (request.query as Record<string, unknown>)?.[name]; if (value === undefined || value === '') return undefined; if (typeof value !== 'string' || value.length > 1024) throw failure(`无效的 ${name}`); return value; };
  const scope = (request: FastifyRequest) => manager.scope(parameter(request, 'scope'));
  const context = async (request: FastifyRequest) => { const current = await service.current(scope(request)); service.requireVersion(current, parameter(request, 'viewRevision')); return current; };
  app.get('/api/semantics', async request => semanticBundle((await context(request)).projection, parameter(request, 'flowId')));
  app.get('/api/semantics/model', async request => service.editorModel(scope(request)));
  app.get('/api/semantics/reverse', async request => { const current = await context(request); return semanticReverse(current.projection, { nodeId: parameter(request, 'nodeId'), edgeId: parameter(request, 'edgeId') }); });
  app.get<{ Params: { id: string } }>('/api/semantics/evidence/:id', async request => service.evidence(scope(request), request.params.id, parameter(request, 'viewRevision')));
  const revision = { type: 'string', minLength: 1, maxLength: 128 };
  app.put('/api/semantics/model', { bodyLimit: 512 * 1024, schema: { body: { type: 'object', additionalProperties: false, required: ['expectedOverlayRevision', 'viewRevision', 'flow'], properties: { expectedOverlayRevision: revision, viewRevision: revision, flow: { type: 'object' } } } } }, async request => service.save(scope(request), request.body as Parameters<SemanticService['save']>[1]));
  app.post('/api/semantics/review', { schema: { body: { type: 'object', additionalProperties: false, required: ['expectedOverlayRevision', 'viewRevision', 'flowId', 'targetType', 'targetId', 'decision'], properties: { expectedOverlayRevision: revision, viewRevision: revision, flowId: revision, targetId: revision, targetType: { enum: ['flow', 'node', 'edge'] }, decision: { enum: ['confirmed', 'rejected', 'pending'] } } } } }, async request => service.review(scope(request), request.body as ReviewInput));
  for (const action of ['rebuild', 'generate'] as const) app.post(`/api/semantics/${action}`, { schema: { body: { type: 'object', additionalProperties: false, required: ['flowId', 'viewRevision'], properties: { flowId: revision, viewRevision: revision, ...(action === 'generate' ? { nodeId: revision } : {}) } } } }, async request => {
    const input = request.body as { flowId: string; viewRevision: string; nodeId?: string };
    const runtime = scope(request); const current = await service.current(runtime); service.requireVersion(current, input.viewRevision);
    if (!current.projection.flows.some(flow => flow.id === input.flowId)) throw failure('业务流程不存在', 404);
    if (action === 'rebuild') return semanticBundle((await service.current(runtime, true)).projection, input.flowId);
    const original = current.envelope.effectiveFlows.find(flow => flow.id === input.flowId)!;
    const candidate = generateCandidateFlow(original);
    if (input.nodeId && ![...original.groups, ...original.steps].some(node => node.id === input.nodeId)) throw failure('解释节点不存在', 404);
    const flow = !input.nodeId ? candidate : { ...original, groups: original.groups.map(node => node.id === input.nodeId ? candidate.groups.find(item => item.id === node.id)! : node), steps: original.steps.map(node => node.id === input.nodeId ? candidate.steps.find(item => item.id === node.id)! : node) };
    return { metadata: current.projection.metadata, flow, generatorVersion: SEMANTIC_GENERATOR_VERSION, origin: 'rule-generated' };
  });
  return service;
}

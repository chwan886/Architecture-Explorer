import { contentHash, stableId, type ArchitectureIndex, type ArchitectureNode, type ArchitectureEdge, type Evidence, type EdgeKind, type Confidence } from '../../schema/src/index.ts';
import { graph as sourceGraph } from '../../indexer/src/graph.ts';
import { canonicalJson, modelRevision, validateModel } from './validation.ts';
import { hasSourcePositionSupport } from './source-order.ts';
import { MODEL_SCHEMA_VERSION, PROJECTION_VERSION, type ArchitectureModel, type ArchitectureProjection, type ArchitectureView, type ArchitectureEntityDetail, type RelationMembers, type OwnershipResult, type SymbolSelector, type ReviewState, type ResolvedEntity, type ResolvedMembership, type OwnershipEntry, type ProjectedRelation, type RelationCategory, type ResolvedBusinessFlow, type ReviewDecision, type Perspective, type ArchitectureDiagnostic } from './types.ts';
export { validateModel, modelRevision, MODEL_SCHEMA_VERSION, PROJECTION_VERSION };
export { hasSourcePositionSupport };
export type * from './types.ts';

const categories: RelationCategory[] = ['dependency', 'call', 'interface', 'data-access', 'event', 'resource', 'initialization'];
const excludedKinds = new Set(['project', 'system', 'module']);
const dataKinds = new Set(['field', 'property', 'parameter', 'data']);
const maximumGraphNodes = 80;
interface Owner { systemId: string; moduleId: string; membershipIds: string[]; pending: boolean }
interface AnchorState { evidence?: Evidence; currentHash?: string; valid: boolean; missing: boolean }
interface Context {
  index: ArchitectureIndex; model: ArchitectureModel; nodes: Map<string, ArchitectureNode>; edges: Map<string, ArchitectureEdge>;
  evidence: Map<string, Evidence>; children: Map<string, ArchitectureNode[]>; files: Map<string, string>;
  byName: Map<string, ArchitectureNode[]>; byPath: Map<string, ArchitectureNode[]>;
  selectorCache: Map<string, ArchitectureNode[]>; anchors: Map<string, AnchorState>;
  entityById: Map<string, ResolvedEntity>; entityByNodeId: Map<string, ResolvedEntity>;
  ownerByNode: Map<string, Owner>; outgoing: Map<string, ArchitectureEdge[]>;
  components: Map<string, ArchitectureNode[]>; derived: Map<string, ProjectedRelation[]>;
}
const contexts = new WeakMap<ArchitectureProjection, Context>();
const projections = new WeakMap<ArchitectureIndex, Map<string, ArchitectureProjection>>();
const error = (message: string, statusCode = 404): never => { throw Object.assign(new Error(message), { statusCode }); };
const hash = (value: unknown) => contentHash(canonicalJson(value));
const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)];
const sorted = (values: Iterable<string>) => unique(values).sort();
function ctxFor(projection: ArchitectureProjection, index?: ArchitectureIndex): Context {
  const ctx = contexts.get(projection);
  if (!ctx) return error('投影上下文不存在，请重新读取当前架构', 409);
  if (index && (index !== ctx.index || index.metadata.scopeId !== projection.metadata.scopeId || index.metadata.revision !== projection.metadata.sourceRevision))
    return error('索引 Scope 或版本与架构投影不一致', 409);
  return ctx;
}
function categoryOf(edge: ArchitectureEdge, nodes: Map<string, ArchitectureNode>): RelationCategory {
  if (edge.kind === 'calls') return 'call';
  if (edge.kind === 'inherits' || edge.kind === 'implements') return 'interface';
  if (['reads', 'writes', 'passes', 'returns'].includes(edge.kind)) return 'data-access';
  if (edge.kind === 'initializes') return 'initialization';
  if (['publishes', 'subscribes', 'unsubscribes'].includes(edge.kind)) return 'event';
  const target = nodes.get(edge.target);
  if (target?.kind === 'resource' || (target?.kind === 'file' && ['unity', 'json'].includes(target.language))) return 'resource';
  return 'dependency';
}
function select(ctx: Context, selector: SymbolSelector, expand = false): ArchitectureNode[] {
  const key = canonicalJson(selector) + '|' + expand;
  const cached = ctx.selectorCache.get(key); if (cached) return cached;
  const candidates = selector.qualifiedName ? ctx.byName.get(selector.qualifiedName) ?? []
    : selector.filePath ? ctx.byPath.get(selector.filePath) ?? [] : [...ctx.nodes.values()];
  const prefix = selector.filePathPrefix?.replace(/\/$/, '');
  const matches = candidates.filter(node => !!node.filePath && ctx.files.has(node.filePath) && !excludedKinds.has(node.kind)
    && (!selector.language || node.language === selector.language)
    && (!selector.kinds || selector.kinds.includes(node.kind))
    && (!selector.qualifiedName || node.qualifiedName === selector.qualifiedName)
    && (!selector.qualifiedNamePrefix || node.qualifiedName.startsWith(selector.qualifiedNamePrefix))
    && (!selector.filePath || node.filePath === selector.filePath)
    && (!prefix || node.filePath === prefix || node.filePath.startsWith(prefix + '/')));
  const results = new Map(matches.map(node => [node.id, node]));
  if (expand) {
    const pending = matches.map(node => node.id);
    while (pending.length) {
      const id = pending.pop()!;
      for (const child of ctx.children.get(id) ?? []) {
        if (results.has(child.id) || !child.filePath || !ctx.files.has(child.filePath)) continue;
        results.set(child.id, child); pending.push(child.id);
      }
    }
  }
  const result = [...results.values()].sort((a, b) => a.id.localeCompare(b.id));
  ctx.selectorCache.set(key, result); return result;
}
function review(model: ArchitectureModel, scopeId: string, type: ReviewDecision['targetType'], id: string, fingerprint: string): ReviewState {
  const decisions = model.reviews.filter(r => r.scopeId === scopeId && r.targetType === type && r.targetId === id);
  const matched = decisions.filter(r => r.fingerprint === fingerprint).sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt));
  if (matched[0]) return matched[0].decision;
  return decisions.length ? 'needs-review' : 'pending';
}
function anchorBasis(ctx: Context, ids: string[]) {
  return ids.map(id => { const a = ctx.model.anchors.find(item => item.id === id)!; const state = ctx.anchors.get(id)!;
    return { definition: a, currentHash: state.currentHash ?? null, valid: state.valid }; });
}
function nodeBasis(ctx: Context, nodeIds: string[]) {
  return nodeIds.map(id => { const node = ctx.nodes.get(id)!; return { id, name: node.qualifiedName, kind: node.kind,
    signature: node.signature, filePath: node.filePath, fileHash: node.filePath ? ctx.files.get(node.filePath) : undefined }; });
}
function anchorsEvidence(ctx: Context, ids: string[]): string[] { return ids.flatMap(id => ctx.anchors.get(id)?.evidence?.id ?? []); }
function anchorResolution(ctx: Context, ids: string[]): 'resolved' | 'changed' | 'missing' {
  if (ids.some(id => ctx.anchors.get(id)?.missing)) return 'missing';
  return ids.some(id => !ctx.anchors.get(id)?.valid) ? 'changed' : 'resolved';
}
function entityNode(entity: ResolvedEntity): ArchitectureNode {
  return { id: entity.nodeId, kind: entity.entityKind, label: entity.name, qualifiedName: entity.name, language: 'unknown',
    summary: entity.responsibility, evidenceIds: entity.evidenceIds };
}
function relationId(ctx: Context, level: ProjectedRelation['level'], source: string, target: string, context: string) {
  const id = stableId(ctx.index.metadata.scopeId, 'architecture-relation', `${level}|${context}|${source}|${target}`);
  return context.startsWith('components:') || context.startsWith('technical:') ? id + '~context=' + encodeURIComponent(context) : id;
}
function summarize(ctx: Context, source: string, target: string, level: ProjectedRelation['level'], raw: ArchitectureEdge[], memberships: string[], pending: boolean, context: string, selectedCategory?: RelationCategory): ProjectedRelation {
  const members = [...new Map(raw.filter(e => !selectedCategory || categoryOf(e, ctx.nodes) === selectedCategory).map(e => [e.id, e])).values()];
  if (level !== 'technical') {
    // Filters can remove the only edge involving a pending ownership rule.
    // Recompute provenance as well as counts from the remaining raw members.
    memberships = []; pending = false;
    for (const edge of members) for (const id of [edge.source, edge.target]) {
      const owner = ctx.ownerByNode.get(id); if (!owner) continue;
      memberships.push(...owner.membershipIds); pending ||= owner.pending;
    }
  }
  const counts: Record<Confidence, number> = { 'static-confirmed': 0, 'runtime-verified': 0, inferred: 0 };
  for (const edge of members) counts[edge.confidence]++;
  const confidence: Confidence = counts.inferred ? 'inferred' : counts['static-confirmed'] ? 'static-confirmed' : 'runtime-verified';
  const actualCategories = sorted(members.map(edge => categoryOf(edge, ctx.nodes))) as RelationCategory[];
  const nodeIds = sorted(members.flatMap(e => [e.source, e.target]));
  return { id: relationId(ctx, level, source, target, context) + (selectedCategory ? '~category=' + selectedCategory : ''),
    source, target, kind: 'references', confidence, rule: level === 'technical' ? 'architecture:technical-member-summary' : 'architecture:owner-member-summary',
    evidenceIds: sorted(members.flatMap(e => e.evidenceIds)), level, category: selectedCategory ?? actualCategories[0] ?? 'dependency', categories: actualCategories,
    kinds: sorted(members.map(e => e.kind)) as EdgeKind[], memberEdgeIds: members.map(e => e.id).sort(), memberNodeIds: nodeIds,
    membershipIds: sorted(memberships), dataNodeIds: nodeIds.filter(id => dataKinds.has(ctx.nodes.get(id)?.kind ?? '')),
    confidenceCounts: counts, totalMembers: members.length, membershipPending: pending,
    limitations: unique([...(level === 'technical' ? ['技术结构聚合，不等同于业务职责。'] : ['owner 归属产生的系统/模块关系；人工归属与底层静态证据分别审核。']),
      '一条汇总线可能包含多类调用/引用，方向不代表完整运行时数据传递；展开查看原始成员、条件和证据。',
      ...(pending ? ['部分 owner 归属尚未人工确认。'] : []), ...members.flatMap(e => e.limitations ?? [])]) };
}
function buildOwnerRelations(ctx: Context): ProjectedRelation[] {
  const groups = new Map<string, { source: string; target: string; level: 'system' | 'module'; members: ArchitectureEdge[]; memberships: Set<string>; pending: boolean }>();
  for (const edge of ctx.index.edges) {
    if (edge.kind === 'contains') continue;
    const a = ctx.ownerByNode.get(edge.source), b = ctx.ownerByNode.get(edge.target);
    if (!a || !b) continue;
    for (const level of ['system', 'module'] as const) {
      const sourceId = level === 'system' ? a.systemId : a.moduleId;
      const targetId = level === 'system' ? b.systemId : b.moduleId;
      if (sourceId === targetId) continue;
      const source = ctx.entityById.get(sourceId)!.nodeId, target = ctx.entityById.get(targetId)!.nodeId;
      const key = `${level}|${source}|${target}`;
      let group = groups.get(key);
      if (!group) { group = { source, target, level, members: [], memberships: new Set(), pending: false }; groups.set(key, group); }
      group.members.push(edge); for (const id of [...a.membershipIds, ...b.membershipIds]) group.memberships.add(id);
      group.pending ||= a.pending || b.pending;
    }
  }
  return [...groups.values()].map(g => summarize(ctx, g.source, g.target, g.level, g.members, [...g.memberships], g.pending, 'business'));
}
function visibleRelations(ctx: Context, visible: ArchitectureNode[], context: string): ProjectedRelation[] {
  const cached = ctx.derived.get(context); if (cached) return cached;
  const visibleIds = new Set(visible.map(n => n.id)); const owner = new Map<string, string | undefined>();
  const visibleOwner = (id: string): string | undefined => {
    if (owner.has(id)) return owner.get(id);
    let current: string | undefined = id; const trail: string[] = []; const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current); trail.push(current);
      if (visibleIds.has(current)) { for (const i of trail) owner.set(i, current); return current; }
      current = ctx.nodes.get(current)?.parentId;
    }
    for (const i of trail) owner.set(i, undefined); return undefined;
  };
  const pairs = new Map<string, { source: string; target: string; members: ArchitectureEdge[] }>();
  for (const edge of ctx.index.edges) {
    if (edge.kind === 'contains') continue;
    const source = visibleOwner(edge.source), target = visibleOwner(edge.target);
    if (!source || !target || source === target) continue;
    const key = source + '|' + target; let pair = pairs.get(key);
    if (!pair) { pair = { source, target, members: [] }; pairs.set(key, pair); }
    pair.members.push(edge);
  }
  const relations = [...pairs.values()].map(p => summarize(ctx, p.source, p.target, 'technical', p.members, [], false, context));
  ctx.derived.set(context, relations); return relations;
}
function filteredRelations(ctx: Context, relations: ProjectedRelation[], category?: string): ProjectedRelation[] {
  if (!category) return relations;
  if (!categories.includes(category as RelationCategory)) return error('不支持的架构关系类别', 400);
  return relations.filter(r => r.categories.includes(category as RelationCategory)).map(r => {
    const raw = r.memberEdgeIds.map(id => ctx.edges.get(id)!).filter(Boolean);
    const result = summarize(ctx, r.source, r.target, r.level, raw, r.membershipIds, r.membershipPending, 'unused', category as RelationCategory);
    return { ...result, id: r.id + '~category=' + category };
  });
}
function componentNodes(ctx: Context, entity: ResolvedEntity): ArchitectureNode[] {
  const cached = ctx.components.get(entity.id); if (cached) return cached;
  const members = new Set(entity.memberNodeIds);
  const preferred = entity.memberNodeIds.map(id => ctx.nodes.get(id)!).filter(node => {
    if (['class', 'interface', 'struct', 'enum', 'resource'].includes(node.kind)) return true;
    if (node.kind === 'function' || node.kind === 'method') {
      let parent = node.parentId; const seen = new Set<string>();
      while (parent && !seen.has(parent)) { seen.add(parent); const p = ctx.nodes.get(parent); if (!p) break;
        if (members.has(parent) && ['class', 'struct', 'interface', 'function', 'method'].includes(p.kind)) return false;
        parent = p.parentId;
      }
      return true;
    }
    return node.kind === 'file' && !['csharp', 'python'].includes(node.language);
  });
  const result = (preferred.length ? preferred : entity.memberNodeIds.map(id => ctx.nodes.get(id)!).filter(n => !excludedKinds.has(n.kind) && n.kind !== 'parameter'))
    .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
  ctx.components.set(entity.id, result); return result;
}

export function buildProjection(index: ArchitectureIndex, model: ArchitectureModel): ArchitectureProjection {
  validateModel(model);
  if (index.metadata.projectId !== model.projectId) return error('业务模型与当前授权项目不匹配', 400);
  const revision = modelRevision(model);
  let cache = projections.get(index); if (!cache) { cache = new Map(); projections.set(index, cache); }
  const cacheKey = revision + '|' + index.metadata.scopeId + '|' + index.metadata.revision;
  const cached = cache.get(cacheKey); if (cached) return cached;
  model = structuredClone(model);
  const ctx: Context = { index, model, nodes: new Map(index.nodes.map(n => [n.id, n])), edges: new Map(index.edges.map(e => [e.id, e])),
    evidence: new Map(index.evidence.map(e => [e.id, e])), children: new Map(), files: new Map(index.files.map(f => [f.path, f.hash])),
    byName: new Map(), byPath: new Map(), selectorCache: new Map(), anchors: new Map(), entityById: new Map(), entityByNodeId: new Map(),
    ownerByNode: new Map(), outgoing: new Map(), components: new Map(), derived: new Map() };
  for (const node of index.nodes) {
    const name = ctx.byName.get(node.qualifiedName) ?? []; name.push(node); ctx.byName.set(node.qualifiedName, name);
    if (node.filePath) { const entries = ctx.byPath.get(node.filePath) ?? []; entries.push(node); ctx.byPath.set(node.filePath, entries); }
    if (node.parentId) { const entries = ctx.children.get(node.parentId) ?? []; entries.push(node); ctx.children.set(node.parentId, entries); }
  }
  for (const edge of index.edges) { const entries = ctx.outgoing.get(edge.source) ?? []; entries.push(edge); ctx.outgoing.set(edge.source, entries); }
  const diagnostics: ArchitectureDiagnostic[] = [];
  const diagnostic = (code: string, message: string, targetId?: string) => diagnostics.push({ id: stableId(index.metadata.scopeId, 'architecture-diagnostic', `${code}|${targetId ?? ''}|${message}`), code, message, targetId, severity: 'warning' });
  const modelAnchors = new Map(model.anchors.map(anchor => [anchor.id, anchor]));
  for (const anchor of model.anchors) {
    const currentHash = ctx.files.get(anchor.filePath);
    const valid = currentHash === anchor.expectedFileHash;
    const evidence: Evidence | undefined = valid ? { id: stableId(index.metadata.scopeId, 'architecture-evidence', `${anchor.id}|${anchor.expectedFileHash}|${anchor.startLine}|${anchor.endLine}|${anchor.quote}`),
      filePath: anchor.filePath, startLine: anchor.startLine, startColumn: 1, endLine: anchor.endLine,
      endColumn: (anchor.quote.split(/\r?\n/).at(-1)?.length ?? 0) + 1, fileHash: currentHash!, rule: 'architecture:curated-source-anchor', excerpt: anchor.quote } : undefined;
    ctx.anchors.set(anchor.id, { currentHash, valid, missing: !currentHash, evidence });
    if (evidence) ctx.evidence.set(evidence.id, evidence);
    else diagnostic('anchor-needs-review', currentHash ? '源码锚点的文件哈希已变化；旧行范围及引文未用于当前证据。' : '源码锚点文件不在当前授权索引中，未读取或复用旧证据。', anchor.id);
  }
  const memberships: ResolvedMembership[] = model.memberships.map(rule => {
    const matched = select(ctx, rule.selector, true);
    const ambiguous = !!rule.selector.qualifiedName && matched.filter(n => n.qualifiedName === rule.selector.qualifiedName).length > 1;
    const resolution = !matched.length ? 'missing' : ambiguous ? 'ambiguous' : anchorResolution(ctx, rule.anchorIds);
    const fingerprint = hash({ scope: index.metadata.scopeId, rule, members: nodeBasis(ctx, matched.map(n => n.id)), anchors: anchorBasis(ctx, rule.anchorIds) });
    let reviewState = review(model, index.metadata.scopeId, 'membership', rule.id, fingerprint);
    if (resolution !== 'resolved' && reviewState !== 'rejected') reviewState = 'needs-review';
    if (!matched.length) diagnostic('membership-missing', '归属规则没有匹配到当前授权源码；保留人工定义等待复核。', rule.id);
    if (ambiguous) diagnostic('membership-ambiguous', '精确符号选择器匹配多个源码身份，请增加签名/文件/类型限制。', rule.id);
    return { ...rule, nodeIds: matched.map(n => n.id), resolution, reviewState, fingerprint,
      evidenceIds: sorted([...anchorsEvidence(ctx, rule.anchorIds), ...matched.flatMap(n => n.evidenceIds)]) };
  });
  const entities: ResolvedEntity[] = [];
  for (const system of model.systems) {
    const rules = memberships.filter(m => m.systemId === system.id);
    const members = sorted(rules.filter(m => m.reviewState !== 'rejected').flatMap(m => m.nodeIds));
    const fingerprint = hash({ scope: index.metadata.scopeId, system, modules: model.modules.filter(m => m.systemId === system.id).map(m => ({ definition: m, anchors: anchorBasis(ctx, m.anchorIds) })),
      members: rules.map(m => [m.id, m.fingerprint]).sort(), anchors: anchorBasis(ctx, system.anchorIds) });
    const resolution = anchorResolution(ctx, system.anchorIds);
    let reviewState = review(model, index.metadata.scopeId, 'system', system.id, fingerprint);
    if (resolution !== 'resolved' && reviewState !== 'rejected') reviewState = 'needs-review';
    const entity: ResolvedEntity = { id: system.id, nodeId: stableId(index.metadata.scopeId, 'architecture-entity', system.id), entityKind: 'system',
      name: system.name, responsibility: system.responsibility, systemKind: system.kind, inputs: system.inputs, outputs: system.outputs,
      features: system.features, keyData: system.keyData, memberNodeIds: members, membershipIds: rules.map(m => m.id),
      evidenceIds: sorted([...anchorsEvidence(ctx, system.anchorIds), ...rules.flatMap(m => m.evidenceIds)]),
      flowIds: model.flows.filter(f => f.systemIds.includes(system.id)).map(f => f.id), reviewState, resolution, fingerprint };
    entities.push(entity); ctx.entityById.set(entity.id, entity); ctx.entityByNodeId.set(entity.nodeId, entity);
  }
  for (const module of model.modules) {
    const rules = memberships.filter(m => m.moduleId === module.id); const parent = ctx.entityById.get(module.systemId)!;
    const resolution = anchorResolution(ctx, module.anchorIds);
    const entity: ResolvedEntity = { id: module.id, nodeId: stableId(index.metadata.scopeId, 'architecture-entity', module.id), entityKind: 'module',
      name: module.name, responsibility: module.responsibility, systemId: module.systemId, inputs: module.inputs, outputs: module.outputs,
      features: [], keyData: [], memberNodeIds: sorted(rules.filter(m => m.reviewState !== 'rejected').flatMap(m => m.nodeIds)), membershipIds: rules.map(m => m.id),
      evidenceIds: sorted([...anchorsEvidence(ctx, module.anchorIds), ...rules.flatMap(m => m.evidenceIds)]),
      flowIds: model.flows.filter(f => f.steps.some(s => s.moduleId === module.id)).map(f => f.id),
      reviewState: resolution === 'resolved' ? parent.reviewState : 'needs-review', resolution,
      fingerprint: hash({ scope: index.metadata.scopeId, module, members: rules.map(m => [m.id, m.fingerprint]).sort(), anchors: anchorBasis(ctx, module.anchorIds) }) };
    entities.push(entity); ctx.entityById.set(entity.id, entity); ctx.entityByNodeId.set(entity.nodeId, entity);
  }
  const ownership: Record<string, OwnershipEntry[]> = Object.create(null);
  for (const membership of memberships) for (const id of membership.nodeIds) {
    const list = ownership[id] ??= [];
    list.push({ systemId: membership.systemId, systemName: ctx.entityById.get(membership.systemId)!.name,
      moduleId: membership.moduleId, moduleName: ctx.entityById.get(membership.moduleId)!.name,
      membershipId: membership.id, role: membership.role, reviewState: membership.reviewState, resolution: membership.resolution });
  }
  const conflictingRules = new Set<string>();
  for (const [id, entries] of Object.entries(ownership)) {
    const owners = entries.filter(e => e.role === 'owner' && e.reviewState !== 'rejected' && ['resolved', 'changed'].includes(e.resolution) && ctx.entityById.get(e.systemId)!.reviewState !== 'rejected');
    const destinations = new Set(owners.map(o => o.systemId + '|' + o.moduleId));
    if (destinations.size > 1) { for (const owner of owners) { owner.resolution = 'conflict'; conflictingRules.add(owner.membershipId); } continue; }
    if (owners.length) ctx.ownerByNode.set(id, { systemId: owners[0].systemId, moduleId: owners[0].moduleId,
      membershipIds: owners.map(o => o.membershipId), pending: owners.some(o => o.reviewState !== 'confirmed') });
  }
  for (const membership of memberships) if (conflictingRules.has(membership.id)) {
    membership.resolution = 'conflict'; membership.reviewState = 'needs-review';
    diagnostic('ownership-conflict', '同一源码实体存在不同主要 owner；冲突实体不生成系统/模块连线。', membership.id);
  }
  for (const entries of Object.values(ownership)) for (const entry of entries) if (entry.resolution === 'conflict') entry.reviewState = 'needs-review';
  for (const entity of entities) if (entity.membershipIds.some(id => conflictingRules.has(id))) {
    entity.resolution = 'conflict'; if (entity.reviewState !== 'rejected') entity.reviewState = 'needs-review';
  }
  const relations = buildOwnerRelations(ctx);
  const technicalNodes = index.nodes.filter(n => n.kind === 'module' && n.language === 'csharp');
  for (const system of index.nodes.filter(n => n.kind === 'system')) {
    if ((ctx.children.get(system.id) ?? []).some(n => n.kind === 'module' && n.language === 'csharp')) continue;
    technicalNodes.push(system);
  }
  const technicalRelations = visibleRelations(ctx, technicalNodes, 'technical');
  const flows: ResolvedBusinessFlow[] = model.flows.map(flow => {
    const steps = flow.steps.map(step => {
      const nodes = step.selector ? select(ctx, step.selector, true) : [];
      const ambiguous = !!step.selector?.qualifiedName && nodes.filter(n => n.qualifiedName === step.selector!.qualifiedName).length > 1;
      const resolution = step.selector && !nodes.length ? 'missing' as const : ambiguous ? 'ambiguous' as const : anchorResolution(ctx, step.anchorIds);
      if (ambiguous) diagnostic('flow-step-ambiguous', '流程步骤的精确符号选择器匹配多个身份；未将任一候选冒充确定执行步骤。', step.id);
      return { ...step, nodeIds: nodes.map(n => n.id), evidenceIds: unique([...anchorsEvidence(ctx, step.anchorIds), ...nodes.flatMap(n => n.evidenceIds)]), resolution };
    });
    const byStep = new Map(steps.map(s => [s.id, s]));
    const transitions = flow.transitions.map(transition => {
      const from = byStep.get(transition.source)!, to = byStep.get(transition.target)!;
      const targets = new Set(to.nodeIds); const calls: ArchitectureEdge[] = [];
      if (transition.basis === 'static-call' && from.resolution !== 'ambiguous' && to.resolution !== 'ambiguous') for (const id of from.nodeIds)
        for (const edge of ctx.outgoing.get(id) ?? []) if (edge.kind === 'calls' && targets.has(edge.target) && edge.confidence === 'static-confirmed') calls.push(edge);
      const transitionAnchors = transition.anchorIds.map(id => ctx.anchors.get(id)!).filter(a => a.valid && a.evidence).map(a => a.evidence!);
      const ordered = hasSourcePositionSupport(ctx.files, modelAnchors, transition, from, to);
      const verification = transition.basis === 'static-call' && calls.length ? 'static-confirmed' as const
        : ordered ? 'source-supported' as const : 'unverified' as const;
      if (transition.basis === 'static-call' && !calls.length) diagnostic('flow-call-unverified', '流程步骤之间没有当前索引确认的真实 calls 边；顺序未验证。', transition.id);
      if (transition.basis === 'source-order' && verification === 'unverified') diagnostic('flow-order-unverified', '源码顺序缺少当前有效的同文件双端锚点；未按行号猜测执行顺序。', transition.id);
      return { ...transition, memberEdgeIds: sorted(calls.map(e => e.id)), evidenceIds: unique([...transitionAnchors.map(e => e.id), ...calls.flatMap(e => e.evidenceIds)]), verification,
        limitations: unique([...transition.limitations, verification === 'static-confirmed' ? '静态调用边不证明运行时必然执行或跨请求时间顺序。' : verification === 'source-supported' ? '源码位置支持叙述顺序；不证明控制流、调用栈或运行时执行顺序。' : '这是协议、请求边界或人工叙述顺序，未获得运行时或完整控制流验证。']) };
    });
    const fingerprint = hash({ scope: index.metadata.scopeId, flow, steps: steps.map(s => ({ id: s.id, members: nodeBasis(ctx, s.nodeIds), anchors: anchorBasis(ctx, s.anchorIds) })),
      transitions: transitions.map(t => ({ id: t.id, edges: t.memberEdgeIds, evidence: t.evidenceIds, anchors: anchorBasis(ctx, t.anchorIds), verification: t.verification })) });
    return { ...flow, steps, transitions, fingerprint, reviewState: review(model, index.metadata.scopeId, 'flow', flow.id, fingerprint) };
  });
  const unclassifiedNodeIds = index.nodes.filter(n => !!n.filePath && ctx.files.has(n.filePath) && !excludedKinds.has(n.kind) && n.kind !== 'parameter' && !ctx.ownerByNode.has(n.id)).map(n => n.id);
  if (unclassifiedNodeIds.length) diagnostic('unclassified-source', `${unclassifiedNodeIds.length} 个源码实体尚无唯一有效 owner；participant/shared 不冒充主要归属。`);
  const projection: ArchitectureProjection = { metadata: { scopeId: index.metadata.scopeId, projectId: model.projectId,
    sourceRevision: index.metadata.revision, modelRevision: revision,
    viewRevision: hash({ scope: index.metadata.scopeId, source: index.metadata.revision, model: revision, projection: PROJECTION_VERSION }), projectionVersion: PROJECTION_VERSION },
    entities, memberships, relations, technicalNodes, technicalRelations, ownership, flows, evidence: [...ctx.evidence.values()], diagnostics, unclassifiedNodeIds };
  contexts.set(projection, ctx); cache.set(cacheKey, projection);
  while (cache.size > 4) cache.delete(cache.keys().next().value!);
  return projection;
}

export function architectureView(projection: ArchitectureProjection, index: ArchitectureIndex, perspective: Perspective, rootId?: string, category?: string): ArchitectureView {
  const ctx = ctxFor(projection, index);
  if (category && !categories.includes(category as RelationCategory)) return error('不支持的架构关系类别', 400);
  const breadcrumbs: { id?: string; name: string }[] = [{ name: index.metadata.projectName }];
  let nodes: ArchitectureNode[]; let relations: ProjectedRelation[]; let entities: ResolvedEntity[] = []; let total = 0;
  if (perspective === 'technical') {
    if (!rootId) { nodes = projection.technicalNodes.slice(0, maximumGraphNodes); total = projection.technicalNodes.length; relations = projection.technicalRelations; }
    else {
      const raw = sourceGraph(index, { rootId, view: 'architecture', limit: maximumGraphNodes }); nodes = raw.nodes; total = raw.totalNodes;
      relations = visibleRelations(ctx, nodes, 'technical:' + rootId);
      const current = ctx.nodes.get(rootId)!; breadcrumbs.push({ id: current.id, name: current.label });
    }
  } else if (perspective === 'business') {
    if (!rootId) { entities = projection.entities.filter(e => e.entityKind === 'system'); nodes = entities.slice(0, maximumGraphNodes).map(entityNode); total = entities.length;
      relations = projection.relations.filter(r => r.level === 'system'); }
    else {
      const entity = ctx.entityById.get(rootId) ?? ctx.entityByNodeId.get(rootId); if (!entity) return error('业务系统或模块不存在');
      if (entity.entityKind === 'system') {
        entities = projection.entities.filter(e => e.systemId === entity.id); nodes = entities.slice(0, maximumGraphNodes).map(entityNode); total = entities.length;
        const visible = new Set(nodes.map(n => n.id)); relations = projection.relations.filter(r => r.level === 'module' && visible.has(r.source) && visible.has(r.target));
        breadcrumbs.push({ id: entity.id, name: entity.name });
      } else {
        const parent = ctx.entityById.get(entity.systemId!)!; breadcrumbs.push({ id: parent.id, name: parent.name }, { id: entity.id, name: entity.name });
        const components = componentNodes(ctx, entity); nodes = components.slice(0, maximumGraphNodes); total = components.length;
        relations = visibleRelations(ctx, nodes, 'components:' + entity.id);
      }
    }
  } else return error('不支持的架构视角', 400);
  const visible = new Set(nodes.map(n => n.id));
  relations = filteredRelations(ctx, relations.filter(r => visible.has(r.source) && visible.has(r.target)), category);
  return { metadata: projection.metadata, perspective, rootId, entities, relations, breadcrumbs, diagnostics: projection.diagnostics,
    unclassifiedCount: projection.unclassifiedNodeIds.length, available: perspective === 'technical' || projection.entities.length > 0,
    graph: { nodes, edges: relations, rootId, totalNodes: total, truncated: total > nodes.length, revision: projection.metadata.viewRevision } };
}

export function entityDetail(projection: ArchitectureProjection, index: ArchitectureIndex, id: string): ArchitectureEntityDetail {
  const ctx = ctxFor(projection, index); const entity = ctx.entityById.get(id) ?? ctx.entityByNodeId.get(id); if (!entity) return error('业务定义不存在于当前投影');
  const components = componentNodes(ctx, entity);
  const definition = entity.entityKind === 'system' ? ctx.model.systems.find(item => item.id === entity.id)! : ctx.model.modules.find(item => item.id === entity.id)!;
  // Show the definition's explicit source anchors before incidental declarations.
  // All items remain the same current-hash evidence; ordering does not promote
  // curated ownership or narrative claims to compiler-confirmed relationships.
  const evidenceIds = unique([...anchorsEvidence(ctx, definition.anchorIds),
    ...entity.evidenceIds.filter(id => ctx.evidence.get(id)?.rule === 'architecture:curated-source-anchor'), ...entity.evidenceIds]);
  return { metadata: projection.metadata, entity, modules: projection.entities.filter(e => e.systemId === entity.id), components: components.slice(0, 200), totalComponents: components.length,
    memberships: projection.memberships.filter(m => entity.membershipIds.includes(m.id)), relations: projection.relations.filter(r => r.source === entity.nodeId || r.target === entity.nodeId),
    evidence: evidenceIds.slice(0, 200).map(id => ctx.evidence.get(id)!).filter(Boolean), flows: projection.flows.filter(f => entity.flowIds.includes(f.id)) };
}

export function relationMembers(projection: ArchitectureProjection, index: ArchitectureIndex, id: string, offset = 0, limit = 50): RelationMembers {
  const ctx = ctxFor(projection, index);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) return error('成员分页参数越界', 400);
  const parts = id.split('~category='); if (parts.length > 2) return error('关系 ID 无效', 400);
  const category = parts[1]; if (category && !categories.includes(category as RelationCategory)) return error('关系类别无效', 400);
  let base = [...projection.relations, ...projection.technicalRelations].find(r => r.id === parts[0]);
  if (!base) {
    const marker = parts[0].indexOf('~context=');
    if (marker >= 0) {
      let context: string; try { context = decodeURIComponent(parts[0].slice(marker + 9)); } catch { return error('关系上下文编码无效', 400); }
      if (context.startsWith('components:')) architectureView(projection, index, 'business', context.slice(11));
      else if (context.startsWith('technical:')) architectureView(projection, index, 'technical', context.slice(10));
      base = ctx.derived.get(context)?.find(r => r.id === parts[0]);
    }
  }
  if (!base) return error('关系不存在于当前 Scope 与投影');
  const relation = category ? filteredRelations(ctx, [base], category)[0] : base;
  if (!relation || relation.id !== id) return error('筛选关系不存在');
  const edges = relation.memberEdgeIds.slice(offset, offset + limit).map(key => ctx.edges.get(key)!).filter(Boolean);
  const nodeIds = new Set(edges.flatMap(e => [e.source, e.target])); const evidenceIds = new Set(edges.flatMap(e => e.evidenceIds));
  return { metadata: projection.metadata, relation, edges, nodes: [...nodeIds].map(key => ctx.nodes.get(key)!).filter(Boolean),
    evidence: projection.evidence.filter(e => evidenceIds.has(e.id)), offset, total: relation.totalMembers, truncated: offset + edges.length < relation.totalMembers };
}

export function ownership(projection: ArchitectureProjection, nodeId: string): OwnershipResult {
  const ctx = ctxFor(projection); if (!ctx.nodes.has(nodeId)) return error('代码节点不属于当前 Scope');
  return { metadata: projection.metadata, nodeId, owners: projection.ownership[nodeId] ?? [],
    flowIds: projection.flows.filter(f => f.steps.some(s => s.nodeIds.includes(nodeId))).map(f => f.id) };
}

export function reviewFingerprint(projection: ArchitectureProjection, targetType: ReviewDecision['targetType'], id: string): string {
  const ctx = ctxFor(projection);
  const target = targetType === 'system' ? ctx.entityById.get(id) : targetType === 'membership' ? projection.memberships.find(m => m.id === id)
    : targetType === 'flow' ? projection.flows.find(f => f.id === id) : undefined;
  if (!target || (targetType === 'system' && 'entityKind' in target && target.entityKind !== 'system')) return error('审核目标不存在', 400);
  return target.fingerprint;
}

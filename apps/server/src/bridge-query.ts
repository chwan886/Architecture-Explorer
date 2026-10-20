import { randomUUID } from 'node:crypto';
import { graph, nodeDetail, search } from '../../../packages/indexer/src/graph.ts';
import type { IndexManager, ScopeRuntime } from '../../../packages/indexer/src/indexer.ts';
import { canonical, createFilePolicy, readAuthorized } from '../../../packages/indexer/src/security.ts';
import { contentHash, stableId, type ArchitectureEdge, type ArchitectureIndex, type ArchitectureNode, type EdgeKind, type Evidence, type GraphResult } from '../../../packages/schema/src/index.ts';
import { architectureView, entityDetail, ownership, relationMembers } from '../../../packages/architecture-model/src/index.ts';
import { canonicalJson } from '../../../packages/architecture-model/src/validation.ts';
import type { ArchitectureView, ProjectedRelation, ResolvedEntity } from '../../../packages/architecture-model/src/types.ts';
import { semanticBundle, semanticReverse } from '../../../packages/semantic-model/src/index.ts';
import type { ResolvedSemanticFlow, SemanticNode } from '../../../packages/semantic-model/src/types.ts';
import { controlError, validateEntityRef, validatePresentation } from '../../../packages/control-protocol/src/index.ts';
import type { AnalysisPresentation, EntityRef, EvidenceContent, QueryService, ResolvedPresentation, SnapshotDescriptor, Verification } from '../../../packages/control-protocol/src/types.ts';
import type { ArchitectureService } from './architecture.ts';
import type { SemanticService } from './semantics.ts';

interface CallPath { id: string; nodeIds: string[]; edgeIds: string[]; verification: Verification; limitations: string[] }
interface FactLookup { nodes: Map<string, ArchitectureNode>; edges: Map<string, ArchitectureEdge>; outgoing: Map<string, ArchitectureEdge[]>; incoming: Map<string, ArchitectureEdge[]> }
const factLookups = new WeakMap<ArchitectureIndex, FactLookup>();
const proofLookups = new WeakMap<object, WeakMap<object, Map<string, Evidence>>>();
interface Snapshot {
  descriptor: SnapshotDescriptor; scope: ScopeRuntime; index: ArchitectureIndex; policy: string;
  architecture: Awaited<ReturnType<ArchitectureService['current']>>;
  semantic: Awaited<ReturnType<SemanticService['current']>>;
  nodes: Map<string, ArchitectureNode>; edges: Map<string, ArchitectureEdge>; evidence: Map<string, Evidence>;
  outgoing: Map<string, ArchitectureEdge[]>; incoming: Map<string, ArchitectureEdge[]>; paths: Map<string, CallPath>;
}
const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)];
const decoder = new TextDecoder('utf-8', { fatal: true });
const allKinds = new Set<EdgeKind>(['contains', 'inherits', 'implements', 'references', 'imports', 'calls', 'reads', 'writes', 'initializes', 'passes', 'returns', 'subscribes', 'unsubscribes', 'publishes', 'contract-mapping']);
const fail = (code: string, message: string, status = 400): never => { throw controlError(code, message, status); };
function argumentsOnly(args: Record<string, unknown>, allowed: string[]) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !allowed.includes(key))) fail('INVALID_ARGUMENT', '查询包含未知或无效参数');
}
function string(args: Record<string, unknown>, key: string, required = true, maximum = 1024): string | undefined {
  const value = args[key]; if (!required && value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) return fail('INVALID_ARGUMENT', `${key} 必须为1–${maximum}字符的字符串`);
  return value;
}
function integer(args: Record<string, unknown>, key: string, fallback: number, maximum: number) {
  const value = args[key] ?? fallback; if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum) return fail('INVALID_ARGUMENT', `${key} 必须为1–${maximum}的整数`); return value;
}

export class BridgeQueryService implements QueryService {
  private readonly snapshots = new Map<string, Snapshot>();
  constructor(readonly manager: IndexManager, readonly architectureService: ArchitectureService, readonly semanticService: SemanticService) {}

  private policy(scope: ScopeRuntime) {
    const project = this.manager.config.projects.find(project => project.id === scope.project.id);
    if (!project) return fail('STALE_SNAPSHOT', '项目授权已变化，请重新开始分析', 409);
    return contentHash(canonicalJson({ config: this.manager.config.fingerprint, project, scope: scope.id, root: canonical(scope.worktree.path) }));
  }
  private check(snapshot: Snapshot) {
    if (Date.now() >= Date.parse(snapshot.descriptor.expiresAt) || this.snapshots.get(snapshot.descriptor.snapshotId) !== snapshot)
      return fail('STALE_SNAPSHOT', '分析快照已过期或被回收，请重新开始分析', 409);
    let current: ScopeRuntime;
    try { current = this.manager.scope(snapshot.descriptor.scopeId); } catch { return fail('STALE_SNAPSHOT', '工作目录授权已变化', 409); }
    if (current !== snapshot.scope || current.index !== snapshot.index || current.index.metadata.revision !== snapshot.descriptor.indexSnapshotId || this.policy(current) !== snapshot.policy)
      return fail('STALE_SNAPSHOT', '源码索引或授权配置已变化，请重新开始分析', 409);
    snapshot.descriptor.indexState = current.status.state;
    const policy = createFilePolicy(current.project.include, current.project.exclude);
    if (snapshot.index.files.some(file => !policy.included(file.path))) return fail('STALE_SNAPSHOT', '源码授权范围已收窄', 409);
  }
  private async live(snapshot: Snapshot) {
    this.check(snapshot);
    let values: [Awaited<ReturnType<ArchitectureService['model']>>, Awaited<ReturnType<SemanticService['store']['read']>>];
    try { values = await Promise.all([this.architectureService.model(snapshot.descriptor.projectId), this.semanticService.store.read(snapshot.descriptor.projectId, snapshot.descriptor.scopeId)]); }
    catch { this.check(snapshot); return fail('STALE_SNAPSHOT', '当前架构或解释定义已变化或不可读取，请重新开始分析', 409); }
    const [architecture, semantic] = values;
    this.check(snapshot);
    if (architecture.modelRevision !== snapshot.descriptor.architectureRevision || semantic.definitionRevision !== snapshot.semantic.envelope.definitionRevision || semantic.overlayRevision !== snapshot.semantic.envelope.overlayRevision)
      return fail('STALE_SNAPSHOT', '架构模型或解释定义已变化，请重新开始分析', 409);
  }
  private async snapshot(id: string) {
    const snapshot = this.snapshots.get(id); if (!snapshot) return fail('STALE_SNAPSHOT', '快照不存在、已过期或服务已重启', 409);
    await this.live(snapshot); this.check(snapshot); return snapshot;
  }
  private codeNode(snapshot: Snapshot, id: string) { return snapshot.nodes.get(id) ?? fail('UNKNOWN_REFERENCE', '代码节点不属于当前快照', 404); }
  private codeEdge(snapshot: Snapshot, id: string) { return snapshot.edges.get(id) ?? fail('UNKNOWN_REFERENCE', '原始代码关系不属于当前快照；聚合线不能作为调用证明', 404); }
  private flow(snapshot: Snapshot, id: string) { return snapshot.semantic.projection.flows.find(flow => flow.id === id) ?? fail('UNKNOWN_FLOW', '此快照没有该语义流程；不能将任意代码链冒充现有业务流程', 404); }
  private entity(snapshot: Snapshot, id: string) { return snapshot.architecture.projection.entities.find(entity => entity.id === id || entity.nodeId === id) ?? fail('UNKNOWN_REFERENCE', '业务实体不属于当前快照', 404); }
  private relation(snapshot: Snapshot, id: string): ProjectedRelation {
    try { return relationMembers(snapshot.architecture.projection, snapshot.index, id, 0, 1).relation; }
    catch { return fail('UNKNOWN_REFERENCE', '业务或技术汇总关系不属于当前投影', 404); }
  }
  private nodeRef(snapshot: Snapshot, ref: EntityRef) {
    validateEntityRef(ref);
    if (ref.layer === 'code') return this.codeNode(snapshot, ref.id);
    if (ref.layer === 'architecture') return this.entity(snapshot, ref.id);
    const flow = this.flow(snapshot, ref.flowId!);
    return [...flow.summaryNodes, ...flow.detailNodes].find(node => node.id === ref.id) ?? fail('UNKNOWN_REFERENCE', '语义节点不属于明确指定的流程', 404);
  }
  private edgeRef(snapshot: Snapshot, ref: EntityRef) {
    validateEntityRef(ref);
    if (ref.layer === 'code') return this.codeEdge(snapshot, ref.id);
    if (ref.layer === 'architecture') return this.relation(snapshot, ref.id);
    const flow = this.flow(snapshot, ref.flowId!);
    return [...flow.summaryEdges, ...flow.detailEdges].find(edge => edge.id === ref.id) ?? fail('UNKNOWN_REFERENCE', '语义关系不属于明确指定的流程', 404);
  }
  private async begin(projectId: string, worktreeId: string) {
    if (!this.manager.config.projects.some(project => project.id === projectId)) return fail('UNAUTHORIZED_SCOPE', '项目未授权', 403);
    let scope: ScopeRuntime;
    try { scope = this.manager.scope(`${projectId}:${worktreeId}`); } catch { return fail('UNAUTHORIZED_SCOPE', 'Worktree未明确授权', 403); }
    const index = scope.index; if (!index) return fail('INDEX_NOT_READY', '尚无有效源码索引，请先通过正常索引命令生成', 409);
    const policy = this.policy(scope);
    let contexts: [Snapshot['architecture'], Snapshot['semantic']];
    try { contexts = await Promise.all([this.architectureService.current(scope), this.semanticService.current(scope)]); }
    catch (error) {
      if (scope.index !== index || this.policy(scope) !== policy || (error as { statusCode?: number }).statusCode === 409) return fail('STALE_SNAPSHOT', '建立分析上下文期间源码或模型发生变化，请重试', 409);
      return fail('QUERY_UNAVAILABLE', `当前上下文无法通过验证：${error instanceof Error ? error.message.slice(0, 2000) : String(error)}`, 400);
    }
    if (scope.index !== index || this.policy(scope) !== policy) return fail('STALE_SNAPSHOT', '建立分析上下文期间源码或配置发生变化', 409);
    const [architecture, semantic] = contexts;
    if (architecture.index !== index || semantic.index !== index || architecture.projection.metadata.modelRevision !== semantic.projection.metadata.architectureRevision)
      return fail('STALE_SNAPSHOT', '架构与解释不属于同一当前索引和模型版本', 409);
    const descriptor: SnapshotDescriptor = { snapshotId: randomUUID(), projectId, worktreeId, scopeId: scope.id, indexSnapshotId: index.metadata.revision,
      architectureRevision: architecture.projection.metadata.modelRevision, semanticViewRevision: semantic.projection.metadata.viewRevision,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), indexState: scope.status.state };
    let lookup = factLookups.get(index);
    if (!lookup) { lookup = { nodes: new Map(index.nodes.map(node => [node.id, node])), edges: new Map(index.edges.map(edge => [edge.id, edge])), outgoing: new Map(), incoming: new Map() };
      for (const edge of index.edges) { const outgoing = lookup.outgoing.get(edge.source) ?? []; outgoing.push(edge); lookup.outgoing.set(edge.source, outgoing); const incoming = lookup.incoming.get(edge.target) ?? []; incoming.push(edge); lookup.incoming.set(edge.target, incoming); }
      factLookups.set(index, lookup);
    }
    let bySemantic = proofLookups.get(architecture.projection); if (!bySemantic) { bySemantic = new WeakMap(); proofLookups.set(architecture.projection, bySemantic); }
    let evidence = bySemantic.get(semantic.projection); if (!evidence) { evidence = new Map([...index.evidence, ...architecture.projection.evidence, ...semantic.projection.flows.flatMap(flow => flow.evidence)].map(item => [item.id, item])); bySemantic.set(semantic.projection, evidence); }
    const snapshot: Snapshot = { descriptor, scope, index, policy, architecture, semantic, ...lookup, evidence, paths: new Map() };
    for (const [id, old] of this.snapshots) if (Date.now() >= Date.parse(old.descriptor.expiresAt)) this.snapshots.delete(id);
    this.snapshots.set(descriptor.snapshotId, snapshot);
    while (this.snapshots.size > 16) this.snapshots.delete(this.snapshots.keys().next().value!);
    try { await this.live(snapshot); } catch (error) { this.snapshots.delete(descriptor.snapshotId); throw error; }
    this.check(snapshot); return descriptor;
  }
  private callPaths(snapshot: Snapshot, sourceNodeId: string, targetNodeId: string, maxDepth: number, limit: number) {
    this.codeNode(snapshot, sourceNodeId); this.codeNode(snapshot, targetNodeId);
    const queue = [{ nodeIds: [sourceNodeId], edgeIds: [] as string[] }], paths: CallPath[] = []; let visits = 0, truncated = false;
    search: while (queue.length) {
      const path = queue.shift()!;
      for (const edge of snapshot.outgoing.get(path.nodeIds.at(-1)!) ?? []) {
        if (edge.kind !== 'calls' || path.nodeIds.includes(edge.target) && edge.target !== targetNodeId) continue;
        if (++visits > 200) { truncated = true; break search; }
        const next = { nodeIds: [...path.nodeIds, edge.target], edgeIds: [...path.edgeIds, edge.id] };
        if (edge.target === targetNodeId) {
          const members = next.edgeIds.map(id => snapshot.edges.get(id)!);
          const result: CallPath = { id: stableId(snapshot.descriptor.scopeId, 'bridge-call-path', snapshot.descriptor.snapshotId + '|' + next.edgeIds.join('|')), ...next,
            verification: members.some(edge => edge.confidence === 'inferred') ? 'inferred' : 'static-confirmed',
            limitations: unique(['逐跳静态符号可达，不证明某次运行时执行栈、条件可满足性或完整数据流。', ...members.flatMap(edge => edge.limitations ?? []), ...members.flatMap(edge => edge.condition ? [`单跳条件（未验证路径可满足性）：${edge.condition}`] : []), ...members.flatMap(edge => edge.dispatch ? [`调用分发：${edge.dispatch}`] : [])]) };
          paths.push(result); snapshot.paths.set(result.id, result);
          if (paths.length >= limit) { truncated = true; break search; }
        }
        if (next.edgeIds.length < maxDepth && !path.nodeIds.includes(edge.target)) queue.push(next);
        else if ((snapshot.outgoing.get(edge.target) ?? []).some(edge => edge.kind === 'calls')) truncated = true;
      }
    }
    while (snapshot.paths.size > 512) snapshot.paths.delete(snapshot.paths.keys().next().value!);
    return { metadata: snapshot.descriptor, paths, truncated };
  }
  private async evidence(snapshot: Snapshot, id: string): Promise<EvidenceContent> {
    this.check(snapshot);
    const evidence = snapshot.evidence.get(id); if (!evidence) return fail('UNKNOWN_EVIDENCE', '证据不属于当前快照', 404);
    if (!snapshot.index.files.some(file => file.path === evidence.filePath && file.hash === evidence.fileHash) || !createFilePolicy(snapshot.scope.project.include, snapshot.scope.project.exclude).included(evidence.filePath))
      return fail('UNKNOWN_EVIDENCE', '证据文件不在当前授权索引范围', 404);
    let bytes: Buffer;
    try { bytes = await readAuthorized(snapshot.scope.worktree.path, evidence.filePath); }
    catch { this.check(snapshot); return fail('STALE_SNAPSHOT', '源码文件不再可安全读取，请等待索引同步后重新开始分析', 409); }
    this.check(snapshot);
    let content: string;
    try { content = decoder.decode(bytes); } catch { return fail('STALE_SNAPSHOT', '源码编码已变化，请等待索引同步后重新开始分析', 409); }
    if (contentHash(content) !== evidence.fileHash) return fail('STALE_SNAPSHOT', '源码内容已变化，请等待索引同步并重新开始分析', 409);
    await this.live(snapshot); this.check(snapshot);
    const lines = content.split(/\r?\n/), start = Math.max(0, evidence.startLine - 5), end = Math.min(lines.length, evidence.endLine + 4, start + 100);
    return { evidence, content: lines.slice(start, end).join('\n').slice(0, 20000), contextStartLine: start + 1, stale: false, revision: snapshot.descriptor.indexSnapshotId };
  }

  async dispatch(operation: string, args: Record<string, unknown>): Promise<unknown> {
    if (operation === 'get_capabilities') { argumentsOnly(args, []); return { protocolVersion: '1.0', currentSnapshotsOnly: true, snapshotTtlSeconds: 600, maximumHandles: 16, maximumCallDepth: 4, maximumCallVisits: 200, maximumPresentationNodes: 80, runtimeCollector: false,
      supportedPresentationTargets: { systems: ['explanation'], technical: ['explanation'], code: ['code'], flow: ['explanation', 'code', 'compare'] }, semanticGranularities: ['simple', 'detailed'],
      uiControl: { requiresBrowserAllow: true, requiresAttachedSession: true, successRequiresPresentedReceipt: true, note: '浏览器需明确允许联动并attach会话；提交或收到命令不等于已经呈现。' },
      operations: ['get_capabilities', 'list_projects', 'list_worktrees', 'begin_analysis', 'search_architecture', 'get_node_details', 'get_related_graph', 'get_call_paths', 'get_flow', 'get_source_evidence', 'semantic_reverse'], limitations: ['调用路径为静态符号可达；反射、动态分发、跨请求和运行时数据流没有完整证明。', '索引、模型或授权范围变化后旧快照立即失效；不提供历史源码回放。'] }; }
    if (operation === 'list_projects') { argumentsOnly(args, []); return { projects: this.manager.config.projects.map(project => ({ id: project.id, name: project.name })) }; }
    if (operation === 'list_worktrees') {
      argumentsOnly(args, ['projectId']); const projectId = string(args, 'projectId')!;
      if (!this.manager.config.projects.some(project => project.id === projectId)) return fail('UNAUTHORIZED_SCOPE', '项目未授权', 403);
      return { worktrees: (this.manager.worktrees.get(projectId) ?? []).filter(worktree => worktree.authorized && this.manager.scopes.has(`${projectId}:${worktree.id}`)).map(worktree => ({ ...worktree, scopeId: `${projectId}:${worktree.id}`, status: this.manager.scopes.get(`${projectId}:${worktree.id}`)!.status })) };
    }
    if (operation === 'begin_analysis') { argumentsOnly(args, ['projectId', 'worktreeId']); return this.begin(string(args, 'projectId')!, string(args, 'worktreeId')!); }
    const allowed: Record<string, string[]> = { search_architecture: ['query', 'limit'], get_node_details: ['ref'], get_related_graph: ['nodeId', 'view', 'direction', 'depth', 'limit', 'kinds'], get_call_paths: ['sourceNodeId', 'targetNodeId', 'maxDepth', 'limit'], get_flow: ['flowId'], get_source_evidence: ['evidenceId'], semantic_reverse: ['nodeId', 'edgeId'] };
    if (!Object.hasOwn(allowed, operation)) return fail('UNSUPPORTED_OPERATION', '未开放此查询操作', 404);
    argumentsOnly(args, ['snapshotId', ...allowed[operation]]);
    const snapshot = await this.snapshot(string(args, 'snapshotId')!); this.check(snapshot);
    let result: unknown;
    if (operation === 'search_architecture') {
      const query = string(args, 'query', true, 512)!, limit = integer(args, 'limit', 30, 100), normalized = query.trim().toLocaleLowerCase();
      const matches: { ref: EntityRef; label: string; kind: string; summary?: string; evidenceIds: string[] }[] = search(snapshot.index, query, 100).nodes.map(node => ({ ref: { layer: 'code', id: node.id }, label: node.label, kind: node.kind, summary: node.summary, evidenceIds: node.evidenceIds }));
      for (const entity of snapshot.architecture.projection.entities) if ((entity.name + ' ' + entity.responsibility).toLocaleLowerCase().includes(normalized)) matches.push({ ref: { layer: 'architecture', id: entity.id }, label: entity.name, kind: entity.entityKind, summary: entity.responsibility, evidenceIds: entity.evidenceIds });
      for (const flow of snapshot.semantic.projection.flows) for (const node of [...flow.summaryNodes, ...flow.detailNodes]) if ((node.title + ' ' + node.summary).toLocaleLowerCase().includes(normalized)) matches.push({ ref: { layer: 'semantic', flowId: flow.id, id: node.id }, label: node.title, kind: 'semantic-' + node.level, summary: node.summary, evidenceIds: node.evidenceIds });
      matches.sort((a, b) => Number(b.label.toLocaleLowerCase() === normalized) - Number(a.label.toLocaleLowerCase() === normalized));
      result = { metadata: snapshot.descriptor, matches: matches.slice(0, limit).map(match => ({ ...match, evidenceIds: match.evidenceIds.slice(0, 12), evidenceCount: match.evidenceIds.length, evidenceTruncated: match.evidenceIds.length > 12 })), truncated: matches.length > limit || matches.filter(match => match.ref.layer === 'code').length === 100 };
    } else if (operation === 'get_node_details') {
      validateEntityRef(args.ref); const ref = args.ref; this.nodeRef(snapshot, ref);
      const detail = ref.layer === 'code' ? nodeDetail(snapshot.index, ref.id) : ref.layer === 'architecture' ? entityDetail(snapshot.architecture.projection, snapshot.index, ref.id) : (() => { const flow = this.flow(snapshot, ref.flowId!); const node = [...flow.summaryNodes, ...flow.detailNodes].find(node => node.id === ref.id)!; return { node, edges: [...flow.summaryEdges, ...flow.detailEdges].filter(edge => edge.source === node.id || edge.target === node.id), codeNodes: flow.codeNodes.filter(code => [...node.codeNodeIds, ...node.contextNodeIds].includes(code.id)), evidence: flow.evidence.filter(item => node.evidenceIds.includes(item.id)) }; })();
      result = { metadata: snapshot.descriptor, detail };
    } else if (operation === 'get_related_graph') {
      const nodeId = string(args, 'nodeId')!, view = string(args, 'view')!, direction = string(args, 'direction', false);
      this.codeNode(snapshot, nodeId); if (!['calls', 'data', 'impact', 'structure'].includes(view) || direction && !['up', 'down', 'both'].includes(direction)) return fail('INVALID_ARGUMENT', '不支持的图视角或方向');
      const kinds = args.kinds; if (kinds !== undefined && (!Array.isArray(kinds) || kinds.length > allKinds.size || kinds.some(kind => typeof kind !== 'string' || !allKinds.has(kind as EdgeKind)))) return fail('INVALID_ARGUMENT', '不支持的关系类别');
      result = { metadata: snapshot.descriptor, graph: graph(snapshot.index, { rootId: nodeId, view: view === 'structure' ? 'architecture' : view as 'calls' | 'data' | 'impact', direction: direction as 'up' | 'down' | 'both' | undefined, depth: integer(args, 'depth', 1, 5), limit: integer(args, 'limit', 80, 200), kinds: kinds as EdgeKind[] | undefined }) };
    } else if (operation === 'get_call_paths') result = this.callPaths(snapshot, string(args, 'sourceNodeId')!, string(args, 'targetNodeId')!, integer(args, 'maxDepth', 4, 4), integer(args, 'limit', 10, 50));
    else if (operation === 'get_flow') { const flowId = string(args, 'flowId', false); if (flowId) this.flow(snapshot, flowId); result = { metadata: snapshot.descriptor, bundle: semanticBundle(snapshot.semantic.projection, flowId) }; }
    else if (operation === 'get_source_evidence') result = { metadata: snapshot.descriptor, ...(await this.evidence(snapshot, string(args, 'evidenceId')!)) };
    else {
      const nodeId = string(args, 'nodeId', false), edgeId = string(args, 'edgeId', false); if (!nodeId && !edgeId) return fail('INVALID_ARGUMENT', '反向映射需要 nodeId 或 edgeId');
      if (nodeId) this.codeNode(snapshot, nodeId); if (edgeId) this.codeEdge(snapshot, edgeId);
      result = { ...semanticReverse(snapshot.semantic.projection, { nodeId, edgeId }), metadata: snapshot.descriptor };
    }
    await this.live(snapshot); this.check(snapshot); return result;
  }

  private sourceOrder(snapshot: Snapshot, evidenceIds: string[]) {
    const evidence = evidenceIds.map(id => snapshot.evidence.get(id)!);
    return evidence.some(a => evidence.some(b => a.filePath === b.filePath && a.endLine < b.startLine && snapshot.index.nodes.some(node => ['method', 'function'].includes(node.kind) && node.evidenceIds.some(id => {
      const declaration = snapshot.evidence.get(id); return declaration && ['csharp.declaration', 'csharp.lambda-declaration', 'python.declaration'].includes(declaration.rule) && declaration.filePath === a.filePath && declaration.startLine <= a.startLine && declaration.endLine >= b.endLine;
    }))));
  }
  private codeGraph(snapshot: Snapshot, explicitNodes: Set<string>, explicitEdges: Set<string>): GraphResult {
    for (const id of explicitEdges) { const edge = this.codeEdge(snapshot, id); explicitNodes.add(edge.source); explicitNodes.add(edge.target); }
    if (explicitNodes.size > 80 || explicitEdges.size > 200) return fail('PRESENTATION_TOO_LARGE', '明确请求的代码图超过80节点/200关系预算');
    const visible = new Set(explicitNodes); let truncated = false;
    const neighborhoodLimit = Math.min(80, Math.max(16, explicitNodes.size));
    // An explicit path is already a complete requested subgraph. Expanding all
    // incidental reads/writes here would bury a three-hop explanation in noise.
    if (!explicitEdges.size) for (const id of explicitNodes) for (const edge of [...snapshot.outgoing.get(id) ?? [], ...snapshot.incoming.get(id) ?? []]) {
      if (edge.kind === 'contains') continue;
      const other = edge.source === id ? edge.target : edge.source;
      if (!visible.has(other)) { if (visible.size >= neighborhoodLimit) { truncated = true; continue; } visible.add(other); }
    }
    const required = [...explicitEdges].map(id => this.codeEdge(snapshot, id)), candidates = snapshot.index.edges.filter(edge => edge.kind !== 'contains' && visible.has(edge.source) && visible.has(edge.target) && !explicitEdges.has(edge.id));
    const edges = [...required, ...candidates.slice(0, 200 - required.length)]; truncated ||= candidates.length + required.length > edges.length;
    return { nodes: [...visible].map(id => this.codeNode(snapshot, id)), edges, totalNodes: visible.size, truncated, revision: snapshot.descriptor.indexSnapshotId };
  }
  async resolve(presentation: AnalysisPresentation): Promise<ResolvedPresentation> {
    validatePresentation(presentation);
    const snapshot = await this.snapshot(presentation.snapshotId); this.check(snapshot);
    if (presentation.projectId !== snapshot.descriptor.projectId || presentation.worktreeId !== snapshot.descriptor.worktreeId || presentation.indexSnapshotId !== snapshot.descriptor.indexSnapshotId) return fail('STALE_SNAPSHOT', '展示的项目、Worktree或索引版本与快照不一致', 409);
    if (presentation.targetView === 'code' && presentation.viewMode !== 'code' || ['systems', 'technical'].includes(presentation.targetView) && presentation.viewMode !== 'explanation') return fail('UNSUPPORTED_PRESENTATION', '代码目标仅支持code模式，系统/技术架构仅支持explanation模式；三模式切换需要已有flow');
    const nodeRefs = [...(presentation.focusNodeId ? [presentation.focusNodeId] : []), ...presentation.highlightedNodeIds], edgeRefs = presentation.highlightedEdgeIds;
    for (const ref of nodeRefs) this.nodeRef(snapshot, ref); for (const ref of edgeRefs) this.edgeRef(snapshot, ref);
    const highlights: ResolvedPresentation['highlights'] = { codeNodeIds: [], codeEdgeIds: [], semanticNodeIds: [], semanticEdgeIds: [], architectureNodeIds: [], architectureEdgeIds: [] };
    const codeNodes = new Set<string>(), codeEdges = new Set<string>(), proofIds = new Set(presentation.evidenceIds);
    for (const ref of nodeRefs) {
      if (ref.layer === 'code') { codeNodes.add(ref.id); highlights.codeNodeIds.push(ref.id); }
      else if (ref.layer === 'architecture') highlights.architectureNodeIds.push(this.entity(snapshot, ref.id).nodeId);
      else highlights.semanticNodeIds.push(ref.id);
    }
    for (const ref of edgeRefs) {
      if (ref.layer === 'code') { codeEdges.add(ref.id); highlights.codeEdgeIds.push(ref.id); }
      else if (ref.layer === 'architecture') highlights.architectureEdgeIds.push(ref.id);
      else highlights.semanticEdgeIds.push(ref.id);
    }
    const selectedFlow = presentation.flowId ? this.flow(snapshot, presentation.flowId) : undefined;
    for (const step of presentation.orderedSteps) {
      for (const id of step.codeNodeIds) { this.codeNode(snapshot, id); codeNodes.add(id); }
      for (const id of step.codeEdgeIds) { this.codeEdge(snapshot, id); codeEdges.add(id); }
      for (const id of step.evidenceIds) proofIds.add(id);
      if (step.semanticNodeId && ![...selectedFlow!.summaryNodes, ...selectedFlow!.detailNodes].some(node => node.id === step.semanticNodeId)) return fail('UNKNOWN_REFERENCE', '阅读步骤的语义引用不属于当前流程', 404);
      const path = step.pathId ? snapshot.paths.get(step.pathId) : undefined;
      if (step.pathId && !path) return fail('UNKNOWN_PATH', '路径未经此快照的调用查询注册，或已超过保留预算', 404);
      if (path) {
        if (step.codeNodeIds.some(id => !path.nodeIds.includes(id)) || step.codeEdgeIds.some(id => !path.edgeIds.includes(id))) return fail('INVALID_PATH', '阅读步骤引用不属于指定调用路径');
        path.nodeIds.forEach(id => codeNodes.add(id)); path.edgeIds.forEach(id => codeEdges.add(id));
      }
      if (step.orderBasis === 'call-path' && !path) return fail('INVALID_PATH', '调用顺序必须由服务器注册的真实路径支持');
      if (path && step.verification === 'static-confirmed' && path.verification !== 'static-confirmed') return fail('UNSUPPORTED_CLAIM', '推断调用路径不能升级为静态确认');
      if (step.verification === 'static-confirmed' && !(path?.verification === 'static-confirmed' || step.codeEdgeIds.length && step.codeEdgeIds.every(id => this.codeEdge(snapshot, id).confidence === 'static-confirmed'))) return fail('UNSUPPORTED_CLAIM', '文字或实体声明不能单独证明静态关系');
      if (step.verification === 'source-supported' || step.orderBasis === 'source-supported') {
        for (const id of step.evidenceIds) if (!snapshot.evidence.has(id)) return fail('UNKNOWN_EVIDENCE', '源码顺序引用不存在的证据', 404);
        if (!this.sourceOrder(snapshot, step.evidenceIds)) return fail('UNSUPPORTED_CLAIM', '源码支持需要同一真实过程范围内有序的双端证据');
      }
    }
    for (const id of proofIds) if (!snapshot.evidence.has(id)) return fail('UNKNOWN_EVIDENCE', '展示引用了不属于当前快照的证据', 404);
    const warnings = unique([...presentation.warnings, '解释文字与阅读顺序不等于已验证的业务执行流程；人工说明不提升底层事实可信度。', ...(snapshot.scope.status.state !== 'synced' ? [`索引状态为${snapshot.scope.status.state}；当前使用最后有效索引，需关注同步或分析错误。`] : [])]);
    let result: ResolvedPresentation = { presentation: structuredClone(presentation), snapshot: snapshot.descriptor, highlights, warnings };
    if (presentation.targetView === 'code') {
      if ([...nodeRefs, ...edgeRefs].some(ref => ref.layer !== 'code')) return fail('UNSUPPORTED_PRESENTATION', '代码展示的焦点和高亮只接受原始代码引用');
      if (!codeNodes.size && !codeEdges.size) return fail('EMPTY_PRESENTATION', '代码展示至少需要一个明确代码端点或原始关系');
      result.codeGraph = this.codeGraph(snapshot, codeNodes, codeEdges);
      if (result.codeGraph.truncated) warnings.push('有限邻域或连线达到显示预算；所有明确请求端点与原始关系均保留。');
    } else if (presentation.targetView === 'flow') {
      const flow = selectedFlow!;
      if ([...nodeRefs, ...edgeRefs].some(ref => ref.layer === 'architecture' || ref.layer === 'semantic' && ref.flowId !== flow.id)) return fail('UNSUPPORTED_PRESENTATION', '流程展示不能混入其他业务层级或其他流程的引用');
      if (presentation.viewMode === 'explanation' && [...nodeRefs, ...edgeRefs].some(ref => ref.layer === 'code') || presentation.viewMode === 'code' && [...nodeRefs, ...edgeRefs].some(ref => ref.layer === 'semantic')) return fail('UNSUPPORTED_PRESENTATION', '所请求的焦点或高亮位于当前模式隐藏的画布，请使用compare模式');
      if ([...codeNodes].some(id => !flow.codeNodes.some(node => node.id === id)) || [...codeEdges].some(id => !flow.codeEdges.some(edge => edge.id === id))) return fail('UNMAPPED_REFERENCE', '代码引用不在此流程的真实映射内，请使用代码展示');
      if ([...proofIds].some(id => !flow.evidence.some(item => item.id === id))) return fail('UNMAPPED_REFERENCE', '证据不属于所选流程的真实源码映射，请使用代码展示');
      if ([...codeNodes].some(id => !flow.codeGraph.nodes.some(node => node.id === id)) || [...codeEdges].some(id => !flow.codeGraph.edges.some(edge => edge.id === id))) return fail('PRESENTATION_TOO_LARGE', '所选流程引用被现有画布预算隐藏，请改用局部代码展示');
      result.semantic = semanticBundle(snapshot.semantic.projection, flow.id);
      for (const ref of nodeRefs.filter(ref => ref.layer === 'semantic')) { const node = [...flow.summaryNodes, ...flow.detailNodes].find(node => node.id === ref.id)!; highlights.codeNodeIds.push(...node.codeNodeIds); }
      for (const ref of edgeRefs.filter(ref => ref.layer === 'semantic')) { const edge = [...flow.summaryEdges, ...flow.detailEdges].find(edge => edge.id === ref.id)!; highlights.codeEdgeIds.push(...edge.codeEdgeIds); highlights.codeNodeIds.push(...edge.paths.flatMap(path => path.nodeIds)); }
      for (const id of codeNodes) highlights.semanticNodeIds.push(...flow.reverseNodes[id] ?? []);
      for (const id of codeEdges) highlights.semanticEdgeIds.push(...flow.reverseEdges[id] ?? []);
      if (highlights.codeNodeIds.some(id => !flow.codeGraph.nodes.some(node => node.id === id)) || highlights.codeEdgeIds.some(id => !flow.codeGraph.edges.some(edge => edge.id === id))) return fail('PRESENTATION_TOO_LARGE', '语义选择包含预算隐藏的代码映射，请展开局部代码展示');
      warnings.push(...flow.limitations);
    } else {
      if ([...nodeRefs, ...edgeRefs].some(ref => ref.layer === 'semantic')) return fail('UNSUPPORTED_PRESENTATION', '系统和技术视角不接受隐藏的语义流程引用');
      const projection = snapshot.architecture.projection, perspective = presentation.targetView === 'systems' ? 'business' : 'technical';
      const primary = presentation.focusNodeId ?? nodeRefs[0]; let rootId: string | undefined;
      if (perspective === 'business') {
        if (primary?.layer === 'architecture') { const entity = this.entity(snapshot, primary.id); rootId = entity.entityKind === 'module' ? entity.systemId : undefined; }
        else if (primary?.layer === 'code') {
          const owners = ownership(projection, primary.id).owners.filter(owner => owner.role === 'owner' && owner.reviewState !== 'rejected' && owner.resolution === 'resolved');
          if (!owners.length || new Set(owners.map(owner => owner.moduleId)).size !== 1) return fail('UNPRESENTABLE_REFERENCE', '代码实体没有唯一可呈现的业务模块，请使用代码视角'); rootId = owners[0].moduleId;
        } else if (edgeRefs[0]?.layer === 'architecture') { const relation = this.relation(snapshot, edgeRefs[0].id); if (relation.level === 'module') rootId = this.entity(snapshot, relation.source).systemId; }
      } else {
        if ([...nodeRefs, ...edgeRefs].some(ref => ref.layer === 'architecture')) return fail('UNSUPPORTED_PRESENTATION', '技术视角使用原始技术节点引用');
        if (primary?.layer === 'code') { const root = architectureView(projection, snapshot.index, 'technical'); if (!root.graph.nodes.some(node => node.id === primary.id)) rootId = this.codeNode(snapshot, primary.id).parentId; }
      }
      const view = architectureView(projection, snapshot.index, perspective, rootId), visibleNodes = new Set(view.graph.nodes.map(node => node.id)), visibleEdges = new Set(view.graph.edges.map(edge => edge.id));
      for (const ref of nodeRefs) { const id = ref.layer === 'architecture' ? this.entity(snapshot, ref.id).nodeId : ref.id; if (!visibleNodes.has(id)) return fail('UNPRESENTABLE_REFERENCE', '所选引用不能在同一现有架构层级中呈现，请拆分展示'); highlights.architectureNodeIds.push(id); }
      for (const id of codeNodes) if (!visibleNodes.has(id)) return fail('UNPRESENTABLE_REFERENCE', '阅读步骤包含当前架构层级隐藏的代码，请使用代码视角');
      for (const ref of edgeRefs) {
        if (ref.layer === 'architecture') { if (!visibleEdges.has(ref.id)) return fail('UNPRESENTABLE_REFERENCE', '汇总关系不属于当前可见层级'); }
        else { const relation = view.relations.find(relation => relation.memberEdgeIds.includes(ref.id)); if (!relation) return fail('UNPRESENTABLE_REFERENCE', '原始关系没有当前可见汇总映射'); highlights.architectureEdgeIds.push(relation.id); }
      }
      for (const id of codeEdges) if (!view.relations.some(relation => relation.memberEdgeIds.includes(id))) return fail('UNPRESENTABLE_REFERENCE', '阅读步骤的原始边未在当前层级呈现');
      result.architecture = view;
    }
    for (const key of Object.keys(highlights) as (keyof typeof highlights)[]) highlights[key] = unique(highlights[key]);
    const selectedEdges = unique([...codeEdges].map(id => this.codeEdge(snapshot, id)).concat(result.codeGraph?.edges ?? result.architecture?.graph.edges ?? result.semantic?.flow?.codeEdges ?? []));
    if (selectedEdges.some(edge => edge.confidence === 'inferred')) warnings.push('当前选择包含推断关系，未升级为静态确认或运行时证明。');
    if (selectedEdges.some(edge => edge.dispatch && !['direct', 'static'].includes(edge.dispatch))) warnings.push('部分调用存在动态或虚分发；图中保留静态声明目标，实际运行时接收者仍有限制。');
    warnings.push(...selectedEdges.flatMap(edge => edge.limitations ?? [])); result.warnings = unique(warnings);
    // Evidence IDs describe the whole analysis, not a pinned preview. A changed
    // focus must not keep an unrelated earlier step's source under its details.
    let preview = [...proofIds][0];
    if (preview && presentation.focusNodeId) {
      const focus = presentation.focusNodeId, own = this.nodeRef(snapshot, focus).evidenceIds;
      const related = new Set([...own, ...(focus.layer === 'code' ? (snapshot.outgoing.get(focus.id) || []).filter(edge => edge.kind !== 'contains').flatMap(edge => edge.evidenceIds) : [])]);
      preview = [...proofIds].find(id => related.has(id)) ?? own[0];
    }
    if (preview) { this.check(snapshot); result.evidence = await this.evidence(snapshot, preview); this.check(snapshot); }
    await this.live(snapshot); this.check(snapshot); return result;
  }
}

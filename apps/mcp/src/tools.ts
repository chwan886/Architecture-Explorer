import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { entityRefSchema, presentationSchema, validatePresentation } from '../../../packages/control-protocol/src/index.ts';
import type { AnalysisPresentation, SnapshotDescriptor, EntityRef } from '../../../packages/control-protocol/src/types.ts';
import type { BridgeClient } from './client.ts';
import type { SemanticBundle, SemanticNode, SemanticEdge } from '../../../packages/semantic-model/src/types.ts';

type Schema = Record<string, unknown>;
const id: Schema = { type: 'string', minLength: 1, maxLength: 256 };
const text = (maxLength = 2000): Schema => ({ type: 'string', minLength: 1, maxLength });
const integer = (maximum: number): Schema => ({ type: 'integer', minimum: 1, maximum });
const strings = (maxItems = 80): Schema => ({ type: 'array', maxItems, uniqueItems: true, items: id });
const refs: Schema = { type: 'array', maxItems: 80, items: entityRefSchema };
const enumeration = (...values: string[]): Schema => ({ type: 'string', enum: values });
const object = (properties: Record<string, Schema>, required: string[] = Object.keys(properties)): Tool['inputSchema'] => ({ type: 'object', additionalProperties: false, properties, required });
const revision: Schema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const cas = { bindingId: id, expectedUserRevision: revision, expectedControlRevision: revision };
const queryTools: Array<[string, string, Tool['inputSchema']]> = [
  ['get_capabilities', '读取实际支持的视图、查询预算和验证边界；未实现的能力不会伪装成功。', object({})],
  ['list_projects', '列出配置授权的只读分析目标。没有任意路径或项目注册能力。', object({})],
  ['list_worktrees', '列出已注册工作区、分支、HEAD 和索引状态。', object({ projectId: id })],
  ['begin_analysis', '开始当前快照查询。保存返回的 snapshotId、indexSnapshotId 和项目/工作区 ID；后续查询必须使用此句柄。句柄过期或源码/模型变化后须重新开始。', object({ projectId: id, worktreeId: id })],
  ['search_architecture', '按符号、中文模块/语义标题关键词搜索真实实体，非向量语义搜索。使用返回的 layer/id/flowId，禁止猜测 ID。', object({ snapshotId: id, query: text(300), limit: integer(100) }, ['snapshotId', 'query'])],
  ['get_node_details', '读取同一快照节点、上下游与证据。semantic 引用必须携带 flowId。', object({ snapshotId: id, ref: entityRefSchema })],
  ['get_related_graph', '获取有限邻域。邻域图不代表连续执行路径，静态字段读写不代表已验证运行时数据流。', object({ snapshotId: id, nodeId: id, view: enumeration('calls', 'data', 'impact', 'structure'), direction: enumeration('both', 'up', 'down'), depth: integer(4), limit: integer(80), kinds: strings(20) }, ['snapshotId', 'nodeId', 'view'])],
  ['get_call_paths', '查询有向真实调用路径，最多4跳/200访问；只使用服务器返回的 pathId。动态回调不会补造连接。调用路径仍不是完整运行时执行顺序。', object({ snapshotId: id, sourceNodeId: id, targetNodeId: id, maxDepth: integer(4), limit: integer(50) }, ['snapshotId', 'sourceNodeId', 'targetNodeId'])],
  ['get_flow', '列出现有业务流程或读取指定语义流程。包含简洁/详细步骤、代码映射及未确认连线；保留原验证状态。', object({ snapshotId: id, flowId: id }, ['snapshotId'])],
  ['get_source_evidence', '只读取索引中已知 evidenceId 的授权源码片段，禁止任意路径读取。源码变化会拒绝旧证据。', object({ snapshotId: id, evidenceId: id })],
  ['semantic_reverse', '由代码节点或边反查关联的业务解释步骤，允许一对多映射。', object({ snapshotId: id, nodeId: id, edgeId: id }, ['snapshotId'])],
];
const controlTools: Array<[string, string, Tool['inputSchema']]> = [
  ['list_view_sessions', '查询网站文档会话、是否已允许联动与 userRevision/controlRevision。多标签页时明确选择目标；不会自动夺取控制。', object({})],
  ['attach_view_session', '绑定一个用户已在网页点击“允许 Codex 联动”的会话。返回 bindingId 与版本。用户手动操作后须重新确认意图并显式使用新版本，禁止盲目重试覆盖。', object({ sessionId: id })],
  ['get_presentation_status', '查询展示回执。pending/received 不是网页呈现成功；只有 presented 且 actual 实体一致才能声称已展示。', object({ commandId: id })],
  ['present_analysis', '提交严格 AnalysisPresentation。必须只引用当前查询实际存在的实体/边/证据。orderedSteps 默认阅读顺序，不能把普通引用宣称执行顺序。离线可保存最近请求；在线控制必须给绑定与CAS版本。提交后查询回执确认实际呈现。', object({ presentation: presentationSchema, ...cas, commandId: id }, ['presentation'])],
  ['open_architecture', '打开指定快照的系统、技术、代码或已有流程视图。不会启动 Shell/浏览器；返回本机 openUrl，网页开启且允许联动后可恢复。在线控制需绑定与CAS版本。', object({ snapshotId: id, title: text(200), summary: text(), targetView: enumeration('systems', 'technical', 'flow', 'code'), flowId: id, viewMode: enumeration('explanation', 'code', 'compare'), semanticGranularity: enumeration('simple', 'detailed'), focusNodeId: entityRefSchema, highlightedNodeIds: refs, highlightedEdgeIds: refs, ...cas }, ['snapshotId', 'targetView'])],
  ['show_flow', '展示现有真实语义流程，保留候选解释与未验证关系。不能凭描述新造业务流程。可选焦点、高亮、粒度；在线控制需绑定与CAS版本。', object({ snapshotId: id, flowId: id, title: text(200), viewMode: enumeration('explanation', 'code', 'compare'), semanticGranularity: enumeration('simple', 'detailed'), focusNodeId: entityRefSchema, highlightedNodeIds: refs, highlightedEdgeIds: refs, ...cas }, ['snapshotId', 'flowId'])],
  ['highlight_nodes', '基于本 stdio 会话提交过的 basePresentationId 更新高亮；保留流程/焦点。所有 ID 严格验证，不静默忽略。使用明确CAS版本。', object({ basePresentationId: id, ...cas, nodeIds: refs, edgeIds: refs }, ['basePresentationId', ...Object.keys(cas), 'nodeIds'])],
  ['focus_node', '在已提交的展示中定位真实实体，并将该节点加入高亮。不自动更换流程或猜测代码映射。', object({ basePresentationId: id, ...cas, ref: entityRefSchema })],
  ['set_view_mode', '在已提交展示中切换业务解释、代码、对照或简洁/详细粒度，保留当前流程与映射焦点；视图不支持时明确失败。', object({ basePresentationId: id, ...cas, viewMode: enumeration('explanation', 'code', 'compare'), semanticGranularity: enumeration('simple', 'detailed') }, ['basePresentationId', ...Object.keys(cas), 'viewMode'])],
  ['clear_highlights', '按CAS清除当前联动高亮，保留网页人工浏览上下文；返回 clear 回执，不冒充浏览器已呈现。用户可在网页随时退出联动。', object({ ...cas, commandId: id }, Object.keys(cas))],
];
export const MCP_INSTRUCTIONS = '这是 Architecture Explorer 本地只读架构查询和网页导航服务，无 Shell、游戏写入或AI API。先 list_projects → list_worktrees → begin_analysis；同一次分析始终使用同一 snapshotId。用 search_architecture/get_flow 获取真实ID，get_source_evidence核对证据；区别静态调用、依赖、候选解释、未验证顺序。展示前 list_view_sessions 并 attach 用户已允许的明确会话，在线控制传递该会话 userRevision/controlRevision；每次等待 get_presentation_status 的 presented 回执，禁止把 pending 当作成功。人工操作引起版本冲突时停止旧指令，不刷新版本重试覆盖。系统/技术、语义、代码ID带layer，语义引用带flowId。无证据则只展示部分真实路径并解释缺口。不得修改用户Codex配置或分析目标。';

export class ExplorerTools {
  readonly definitions: Tool[];
  private readonly validators = new Map<string, ReturnType<Ajv['compile']>>();
  private readonly snapshots = new Map<string, SnapshotDescriptor>();
  private readonly presentations = new Map<string, AnalysisPresentation>();
  private readonly semanticFocus = new Map<string, EntityRef>();
  constructor(private readonly bridge: Pick<BridgeClient, 'query' | 'control'>) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    this.definitions = [...queryTools, ...controlTools].map(([name, description, inputSchema]) => ({ name, description, inputSchema,
      annotations: { readOnlyHint: queryTools.some(entry => entry[0] === name) || ['list_view_sessions', 'get_presentation_status'].includes(name), destructiveHint: false, idempotentHint: name !== 'begin_analysis' && (queryTools.some(entry => entry[0] === name) || ['list_view_sessions', 'get_presentation_status'].includes(name)), openWorldHint: false } }));
    for (const tool of this.definitions) this.validators.set(tool.name, ajv.compile(tool.inputSchema));
  }
  private error(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
  private async submit(presentation: AnalysisPresentation, args: Record<string, unknown>, preferredFocus?: EntityRef) {
    validatePresentation(presentation);
    if (args.bindingId !== undefined && (args.expectedUserRevision === undefined || args.expectedControlRevision === undefined)) this.error('REVISION_REQUIRED', '在线展示需要明确 userRevision 与 controlRevision');
    const control: Record<string, unknown> = { presentation };
    for (const key of ['bindingId', 'expectedUserRevision', 'expectedControlRevision', 'commandId']) if (args[key] !== undefined) control[key] = args[key];
    const result = await this.bridge.control('submit', control);
    this.presentations.set(presentation.presentationId, structuredClone(presentation));
    const semantic = preferredFocus ?? (presentation.focusNodeId?.layer === 'semantic' ? presentation.focusNodeId : undefined);
    if (semantic) this.semanticFocus.set(presentation.presentationId, structuredClone(semantic));
    while (this.presentations.size > 32) { const oldest = this.presentations.keys().next().value!; this.presentations.delete(oldest); this.semanticFocus.delete(oldest); }
    return result;
  }
  private create(args: Record<string, unknown>, targetView: AnalysisPresentation['targetView']): AnalysisPresentation {
    if (targetView !== 'flow' && args.semanticGranularity !== undefined) return this.error('UNSUPPORTED_PRESENTATION', '简洁/详细粒度仅适用于已有业务语义流程；此架构目标没有对应粒度视图');
    const snapshot = this.snapshots.get(args.snapshotId as string);
    if (!snapshot) return this.error('SNAPSHOT_REQUIRED', '请先在本 MCP 会话调用 begin_analysis，再使用返回的 snapshotId');
    return { schemaVersion: '1.0', presentationId: randomUUID(), projectId: snapshot.projectId, worktreeId: snapshot.worktreeId,
      indexSnapshotId: snapshot.indexSnapshotId, snapshotId: snapshot.snapshotId, title: (args.title as string) ?? (targetView === 'flow' ? '业务流程分析' : '架构探索'),
      summary: (args.summary as string) ?? '基于当前索引的只读展示；静态关系不代表已验证的完整运行时顺序。', targetView,
      viewMode: (args.viewMode as AnalysisPresentation['viewMode']) ?? (targetView === 'code' ? 'code' : 'explanation'),
      semanticGranularity: (args.semanticGranularity as AnalysisPresentation['semanticGranularity']) ?? 'simple',
      ...(args.focusNodeId ? { focusNodeId: args.focusNodeId as EntityRef } : {}),
      highlightedNodeIds: (args.highlightedNodeIds as EntityRef[]) ?? [], highlightedEdgeIds: (args.highlightedEdgeIds as EntityRef[]) ?? [],
      ...(args.flowId ? { flowId: args.flowId as string } : {}), orderedSteps: [], evidenceIds: [], warnings: [], createdAt: new Date().toISOString() };
  }
  private async mapMode(presentation: AnalysisPresentation, preferredFocus?: EntityRef) {
    if (presentation.targetView !== 'flow' || presentation.viewMode === 'compare') return;
    const { bundle } = await this.bridge.query('get_flow', { snapshotId: presentation.snapshotId, flowId: presentation.flowId }) as { bundle: SemanticBundle };
    const flow = bundle.flow; if (!flow) return this.error('UNKNOWN_FLOW', '当前快照没有指定流程');
    const nodes = [...flow.summaryNodes, ...flow.detailNodes], edges = [...flow.summaryEdges, ...flow.detailEdges];
    const unique = (values: EntityRef[]) => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
    const semantic = (id: string): EntityRef => ({ layer: 'semantic', id, flowId: flow.id });
    const code = (id: string): EntityRef => ({ layer: 'code', id });
    const visibleNodes = (values: SemanticNode[]) => {
      if (presentation.semanticGranularity === 'simple') return values.map(node => node.parentId ? nodes.find(parent => parent.id === node.parentId)! : node);
      return values.flatMap(node => node.level === 'summary' ? flow.detailNodes.filter(child => node.childIds.includes(child.id)) : [node]);
    };
    const visibleEdges = (values: SemanticEdge[]) => {
      if (presentation.semanticGranularity === 'simple') return values.flatMap(edge => edge.level === 'summary' ? [edge] : flow.summaryEdges.filter(parent => parent.sourceTransitionIds.some(id => edge.sourceTransitionIds.includes(id))));
      return values.flatMap(edge => edge.level === 'detail' ? [edge] : flow.detailEdges.filter(child => child.sourceTransitionIds.some(id => edge.sourceTransitionIds.includes(id))));
    };
    const map = (ref: EntityRef, edge: boolean): EntityRef[] => {
      if (presentation.viewMode === 'code') {
        if (ref.layer === 'code') return [ref];
        if (ref.layer !== 'semantic' || ref.flowId !== flow.id) return this.error('UNMAPPED_REFERENCE', '视图切换引用不属于当前流程');
        const ids = edge ? edges.find(item => item.id === ref.id)?.codeEdgeIds : nodes.find(item => item.id === ref.id)?.codeNodeIds;
        if (!ids?.length) return this.error('UNMAPPED_REFERENCE', '当前逻辑没有可验证的代码映射，不能伪装已定位具体实现');
        return ids.map(code);
      }
      if (ref.layer === 'architecture' || ref.layer === 'semantic' && ref.flowId !== flow.id) return this.error('UNMAPPED_REFERENCE', '视图切换引用不属于当前流程');
      const ids = ref.layer === 'semantic' ? [ref.id] : (edge ? flow.reverseEdges[ref.id] : flow.reverseNodes[ref.id]) ?? [];
      const visible = edge ? visibleEdges(edges.filter(item => ids.includes(item.id))) : visibleNodes(nodes.filter(item => ids.includes(item.id)));
      if (!visible.length) return this.error('UNMAPPED_REFERENCE', '代码实体没有当前粒度可呈现的解释映射；请保留代码或使用对照模式');
      return visible.map(item => semantic(item.id));
    };
    const focus = presentation.focusNodeId ? map(presentation.focusNodeId, false) : [];
    presentation.highlightedNodeIds = unique([...presentation.highlightedNodeIds.flatMap(ref => map(ref, false)), ...focus]);
    presentation.highlightedEdgeIds = unique(presentation.highlightedEdgeIds.flatMap(ref => map(ref, true)));
    const preferred = presentation.viewMode === 'explanation' && preferredFocus?.layer === 'semantic' ? map(preferredFocus, false) : [];
    presentation.focusNodeId = preferred.find(candidate => focus.some(ref => ref.id === candidate.id && ref.layer === candidate.layer && ref.flowId === candidate.flowId)) ?? focus[0];
  }
  async invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    const validate = this.validators.get(name);
    if (!validate) return this.error('UNKNOWN_TOOL', '没有此 MCP 工具');
    if (!validate(args)) return this.error('INVALID_ARGUMENTS', '工具参数不符合严格格式：' + validate.errors?.map(error => `${error.instancePath || '/'} ${error.message}`).join('; '));
    if (queryTools.some(tool => tool[0] === name)) {
      const result = await this.bridge.query(name, args);
      if (name === 'begin_analysis') {
        const snapshot = result as SnapshotDescriptor; this.snapshots.set(snapshot.snapshotId, snapshot);
        while (this.snapshots.size > 16) this.snapshots.delete(this.snapshots.keys().next().value!);
      }
      return result;
    }
    if (name === 'list_view_sessions' || name === 'attach_view_session') return this.bridge.control(name, args);
    if (name === 'get_presentation_status') return this.bridge.control('status', args);
    if (name === 'clear_highlights') return this.bridge.control('clear', args);
    if (name === 'present_analysis') return this.submit(args.presentation as unknown as AnalysisPresentation, args);
    if (name === 'open_architecture') return this.submit(this.create(args, args.targetView as AnalysisPresentation['targetView']), args);
    if (name === 'show_flow') return this.submit(this.create(args, 'flow'), args);
    const previous = this.presentations.get(args.basePresentationId as string);
    if (!previous) return this.error('PRESENTATION_REQUIRED', 'basePresentationId 必须来自本 MCP 会话已成功提交的展示；请先 open_architecture/show_flow/present_analysis');
    const presentation = { ...structuredClone(previous), presentationId: randomUUID(), createdAt: new Date().toISOString() };
    let preferredFocus = this.semanticFocus.get(previous.presentationId);
    if (name === 'highlight_nodes') { presentation.highlightedNodeIds = args.nodeIds as EntityRef[]; presentation.highlightedEdgeIds = (args.edgeIds as EntityRef[]) ?? []; }
    if (name === 'focus_node') { presentation.focusNodeId = args.ref as EntityRef; if (presentation.focusNodeId.layer === 'semantic') preferredFocus = presentation.focusNodeId; if (!presentation.highlightedNodeIds.some(ref => JSON.stringify(ref) === JSON.stringify(args.ref))) presentation.highlightedNodeIds.push(args.ref as EntityRef); }
    if (name === 'set_view_mode') { if (presentation.targetView !== 'flow' && args.semanticGranularity !== undefined) return this.error('UNSUPPORTED_PRESENTATION', '此目标不支持语义粒度切换，请选择已有业务流程'); presentation.viewMode = args.viewMode as AnalysisPresentation['viewMode']; if (args.semanticGranularity) presentation.semanticGranularity = args.semanticGranularity as AnalysisPresentation['semanticGranularity']; await this.mapMode(presentation, preferredFocus); }
    return this.submit(presentation, args, preferredFocus);
  }
  async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      const result = await this.invoke(name, args);
      const value = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : { result };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      const value = { error: { code: failure.code ?? 'LOCAL_MCP_ERROR', message: failure.message ?? '本地 MCP 调用失败' } };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    }
  }
}

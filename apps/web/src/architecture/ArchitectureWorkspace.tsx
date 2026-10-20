import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Blocks, Box, Braces, Check, ChevronDown, ChevronRight, Code2, FileCode2, Filter, GitBranch, Info, Layers3, LayoutGrid, ListFilter, Loader2, Network, PanelBottomClose, PanelBottomOpen, RefreshCw, Search, ShieldCheck, TriangleAlert, Workflow, X } from 'lucide-react';
import type { ArchitectureEdge, ArchitectureNode, Evidence } from '../../../../packages/schema/src/index';
import type { ArchitectureEntityDetail, ArchitectureRoute, ArchitectureView, ModelEnvelope, OpenCodeRequest, ProjectedRelation, ProjectionMetadata, RelationMembers, ResolvedBusinessFlow, ResolvedEntity, ResolvedFlowStep, ResolvedFlowTransition, ResolvedMembership } from '../../../../packages/architecture-model/src/types';
import type { EvidenceContent } from '../api';
import GraphCanvas from '../GraphCanvas';
import SourcePreview from '../SourcePreview';
import { confidenceLabels, edgeLabels, nodeLabels } from '../labels';
import { ArchitectureApiError, apiMessage, architectureRequest, checkMetadata } from './client';
import { basisLabels, categoryLabels, resolutionLabels, reviewLabels, roleLabels, verificationLabels } from './labels';
import FlowBoard from './FlowBoard';
import ModelEditor from './ModelEditor';

export interface ArchitectureWorkspaceProps {
  scope: string; revision?: string; route: ArchitectureRoute;
  onRouteChange: (route: ArchitectureRoute) => void; onOpenCode: (request: OpenCodeRequest) => void;
}
type Selection = { type: 'entity'; id: string } | { type: 'relation'; id: string } | { type: 'step' | 'transition'; id: string; flowId: string } | { type: 'technical' | 'unclassified'; id: string };
interface HistoryEntry { route: ArchitectureRoute; selection?: Selection; evidenceId: string; category: string; sourceOpen?: boolean; overviewMode?: 'summary' | 'all' }
interface WorkspaceSnapshot extends HistoryEntry { history: HistoryEntry[]; sourceOpen: boolean }
const workspaceMemory = new Map<string, WorkspaceSnapshot>();
interface FlowsEnvelope { metadata: ProjectionMetadata; flows: ResolvedBusinessFlow[] }
interface UnclassifiedResult { metadata: ProjectionMetadata; nodes: ArchitectureNode[]; offset: number; total: number; truncated: boolean }
const routeKey = (route: ArchitectureRoute) => `${route.perspective}:${route.rootId || ''}:${route.flowId || ''}`;
const selectionKey = (selection?: Selection) => selection ? `${selection.type}:${selection.id}` : '';

function ErrorNotice({ error, onReload }: { error: string; onReload?: () => void }) {
  return <div className="arch-error" role="alert"><TriangleAlert size={14} /><div><span>{error.slice(0, 250)}{error.length > 250 ? '…' : ''}</span>{error.length > 250 && <details><summary>查看完整错误</summary><pre>{error}</pre></details>}</div>{onReload && <button onClick={onReload}>重新载入</button>}</div>;
}
function ReviewBadge({ state }: { state: ResolvedEntity['reviewState'] }) { return <span className={`arch-review ${state}`}>{reviewLabels[state]}</span>; }
function TextList({ items, empty = '尚未定义' }: { items: string[]; empty?: string }) { return items.length ? <ul className="arch-text-list">{items.map((text, index) => <li key={index}>{text}</li>)}</ul> : <p className="arch-muted">{empty}</p>; }

export default function ArchitectureWorkspace({ scope, revision, route, onRouteChange, onOpenCode }: ArchitectureWorkspaceProps) {
  const initialSnapshot = useRef(workspaceMemory.get(`${scope}:${routeKey(route)}`));
  const [view, setView] = useState<ArchitectureView>();
  const [flowsEnvelope, setFlowsEnvelope] = useState<FlowsEnvelope>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [reload, setReload] = useState(0);
  const [category, setCategory] = useState(initialSnapshot.current?.category || '');
  const [search, setSearch] = useState('');
  const [overviewMode, setOverviewMode] = useState<'summary' | 'all'>(initialSnapshot.current?.overviewMode || 'summary');
  const [componentLimit, setComponentLimit] = useState(12);
  const [evidenceLimit, setEvidenceLimit] = useState(10);
  const [membershipsOpen, setMembershipsOpen] = useState(false);
  const [selection, setSelection] = useState<Selection | undefined>(initialSnapshot.current?.selection || (route.perspective === 'business' && route.rootId ? { type: 'entity', id: route.rootId } : undefined));
  const [selectionEpoch, setSelectionEpoch] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>(initialSnapshot.current?.history || []);
  const [detail, setDetail] = useState<ArchitectureEntityDetail>();
  const [members, setMembers] = useState<RelationMembers>();
  const [unclassified, setUnclassified] = useState<UnclassifiedResult>();
  const [unclassifiedOffset, setUnclassifiedOffset] = useState(0);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [memberOffset, setMemberOffset] = useState(0);
  const [memberEdge, setMemberEdge] = useState<ArchitectureEdge>();
  const [evidenceId, setEvidenceId] = useState('');
  const [source, setSource] = useState<EvidenceContent>();
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const [sourceEpoch, setSourceEpoch] = useState(0);
  const [sourceOpen, setSourceOpen] = useState(initialSnapshot.current?.sourceOpen || false);
  const [rootPath, setRootPath] = useState('');
  const [layoutToken, setLayoutToken] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  const [reviewBusy, setReviewBusy] = useState('');
  const [reviewError, setReviewError] = useState('');
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const routeRef = useRef(routeKey(route)); routeRef.current = routeKey(route);
  const selectionRef = useRef(selectionKey(selection)); selectionRef.current = selectionKey(selection);
  const viewSequence = useRef(0), detailSequence = useRef(0), sourceSequence = useRef(0);
  const previousScope = useRef(scope);
  const restoration = useRef<HistoryEntry | undefined>(initialSnapshot.current);
  const loadedRoute = useRef(routeKey(route));
  const loadedContext = useRef('');
  const metadata = route.perspective === 'flows' ? flowsEnvelope?.metadata : view?.metadata;
  const metadataRef = useRef(metadata); metadataRef.current = metadata;
  const currentFlow = flowsEnvelope?.flows.find(flow => flow.id === (route.flowId || flowsEnvelope.flows[0]?.id));
  const selectedStep = selection?.type === 'step' ? currentFlow?.steps.find(step => step.id === selection.id) : undefined;
  const selectedTransition = selection?.type === 'transition' ? currentFlow?.transitions.find(item => item.id === selection.id) : undefined;
  const selectedEntity = conflict ? undefined : detail?.entity || (selection?.type === 'entity' ? view?.entities.find(entity => entity.id === selection.id) : undefined);
  const technicalNode = selection?.type === 'technical' ? view?.graph.nodes.find(node => node.id === selection.id) : undefined;
  const names = useMemo(() => new Map([...(view?.entities.map(entity => [entity.nodeId, entity.name] as const) || []), ...(members?.nodes.map(node => [node.id, node.label] as const) || [])]), [view, members]);
  const relation = conflict ? undefined : members?.relation || (selection?.type === 'relation' ? view?.relations.find(item => item.id === selection.id) : undefined);
  const evidence: Evidence[] = selection?.type === 'relation' ? members?.evidence || [] : detail?.evidence || [];
  const selectedEvidenceIds = selectedStep?.evidenceIds || selectedTransition?.evidenceIds || evidence.map(item => item.id);

  const clearEvidence = useCallback(() => { sourceSequence.current++; setEvidenceId(''); setSource(undefined); setSourceBusy(false); setSourceError(''); setMemberEdge(undefined); }, []);
  const select = useCallback((next?: Selection) => { detailSequence.current++; selectionRef.current = selectionKey(next); setSelection(next); setSelectionEpoch(value => value + 1); setDetail(undefined); setMembers(undefined); setUnclassified(undefined); setDetailBusy(false); setDetailError(''); setReviewError(''); setMemberOffset(0); setUnclassifiedOffset(0); setComponentLimit(12); setEvidenceLimit(10); setMembershipsOpen(false); clearEvidence(); }, [clearEvidence]);
  const activateEvidence = useCallback((id: string, reveal = true) => { sourceSequence.current++; setEvidenceId(id); setSource(undefined); setSourceError(''); setSourceBusy(!!id); setSourceEpoch(value => value + 1); if (reveal) setSourceOpen(true); }, []);
  const fail = useCallback((failure: unknown, sink: (message: string) => void) => {
    const message = apiMessage(failure); sink(message);
    if (failure instanceof ArchitectureApiError && failure.status === 409) { setConflict(true); setDetail(undefined); setMembers(undefined); setUnclassified(undefined); clearEvidence(); }
  }, [clearEvidence]);
  const refresh = () => { setConflict(false); setReviewError(''); setReload(value => value + 1); };
  const navigate = (next: ArchitectureRoute) => { setHistory(current => [...current, { route, selection, evidenceId, category, sourceOpen, overviewMode }].slice(-40)); restoration.current = undefined; select(next.perspective === 'business' && next.rootId ? { type: 'entity', id: next.rootId } : undefined); onRouteChange(next); };
  const back = () => { const entry = history.at(-1); if (!entry) return; restoration.current = entry; select(entry.selection); setCategory(entry.category); setOverviewMode(entry.overviewMode || 'summary'); setSourceOpen(entry.sourceOpen || false); setHistory(current => current.slice(0, -1)); onRouteChange(entry.route); };

  useEffect(() => {
    if (previousScope.current === scope) return;
    previousScope.current = scope; setHistory([]); restoration.current = undefined; select(); setCategory(''); setSearch(''); setOverviewMode('summary'); setEditorOpen(false); setView(undefined); setFlowsEnvelope(undefined); setRootPath('');
    if (route.rootId || route.flowId) onRouteChange({ perspective: route.perspective });
  }, [scope, select, route, onRouteChange]);

  useEffect(() => {
    const key = `${scope}:${routeKey(route)}`;
    workspaceMemory.delete(key); workspaceMemory.set(key, { route, selection, evidenceId, category, history, sourceOpen, overviewMode });
    while (workspaceMemory.size > 24) workspaceMemory.delete(workspaceMemory.keys().next().value!);
  }, [scope, route, selection, evidenceId, category, history, sourceOpen, overviewMode]);

  useEffect(() => {
    if (!scope) return;
    const sequence = ++viewSequence.current, requestedRoute = routeKey(route);
    loadedContext.current = '';
    const abort = new AbortController(); setLoading(true); setError(''); setConflict(false); setView(undefined); setFlowsEnvelope(undefined); setDetail(undefined); setMembers(undefined); setUnclassified(undefined); clearEvidence();
    const restored = restoration.current && routeKey(restoration.current.route) === requestedRoute ? restoration.current : undefined;
    if (restored) { selectionRef.current = selectionKey(restored.selection); setSelection(restored.selection); }
    else if (loadedRoute.current !== requestedRoute) select(route.perspective === 'business' && route.rootId ? { type: 'entity', id: route.rootId } : undefined);
    loadedRoute.current = requestedRoute;
    const active = () => !abort.signal.aborted && sequence === viewSequence.current && scopeRef.current === scope && routeRef.current === requestedRoute;
    const promise = route.perspective === 'flows'
      ? architectureRequest<FlowsEnvelope>(scope, '/flows', {}, { signal: abort.signal }).then(value => { if (!active()) return; checkMetadata(value.metadata, scope); loadedContext.current = requestedRoute; setFlowsEnvelope(value); })
      : architectureRequest<ArchitectureView>(scope, '', { perspective: route.perspective, rootId: route.rootId, category }, { signal: abort.signal }).then(value => { if (!active()) return; checkMetadata(value.metadata, scope); loadedContext.current = requestedRoute; setView(value); });
    promise.catch(failure => { if (active()) fail(failure, setError); }).finally(() => { if (active()) setLoading(false); });
    return () => abort.abort();
  }, [scope, revision, route.perspective, route.rootId, route.flowId, category, reload, clearEvidence, fail]);

  useEffect(() => {
    let alive = true; setRootPath('');
    fetch(`/api/summary?scope=${encodeURIComponent(scope)}`).then(response => response.ok ? response.json() : undefined).then(value => { if (alive && scopeRef.current === scope && value?.metadata?.scopeId === scope) setRootPath(value.metadata.rootPath); }).catch(() => { /* Evidence remains readable without an IDE link. */ });
    return () => { alive = false; };
  }, [scope]);

  useEffect(() => {
    if (!scope || !metadata || !selection || conflict || loadedContext.current !== routeRef.current) return;
    const sequence = ++detailSequence.current, key = selectionKey(selection), requestedView = metadata.viewRevision;
    const abort = new AbortController(); setDetailBusy(true); setDetailError(''); setDetail(undefined); setMembers(undefined);
    const active = () => !abort.signal.aborted && sequence === detailSequence.current && scopeRef.current === scope && selectionRef.current === key && metadataRef.current?.viewRevision === requestedView && loadedContext.current === routeRef.current;
    const finishEvidence = (ids: string[]) => {
      const preferred = restoration.current?.evidenceId;
      restoration.current = undefined;
      activateEvidence(preferred && ids.includes(preferred) ? preferred : ids[0] || '', false);
    };
    const request = selection.type === 'entity'
      ? architectureRequest<ArchitectureEntityDetail>(scope, `/entities/${encodeURIComponent(selection.id)}`, { viewRevision: requestedView }, { signal: abort.signal }).then(value => { if (!active()) return; checkMetadata(value.metadata, scope, requestedView); setDetail(value); finishEvidence(value.evidence.map(item => item.id)); })
      : selection.type === 'relation'
        ? architectureRequest<RelationMembers>(scope, `/relations/${encodeURIComponent(selection.id)}`, { viewRevision: requestedView, offset: memberOffset, limit: 25 }, { signal: abort.signal }).then(value => { if (!active()) return; checkMetadata(value.metadata, scope, requestedView); setMembers(value); finishEvidence(value.relation.evidenceIds.length ? value.relation.evidenceIds : value.evidence.map(item => item.id)); })
        : selection.type === 'unclassified'
          ? architectureRequest<UnclassifiedResult>(scope, '/unclassified', { viewRevision: requestedView, offset: unclassifiedOffset, limit: 30 }, { signal: abort.signal }).then(value => { if (!active()) return; checkMetadata(value.metadata, scope, requestedView); setUnclassified(value); finishEvidence([]); })
        : Promise.resolve().then(() => {
          if (!active()) return;
          if ((selection.type === 'step' && !selectedStep) || (selection.type === 'transition' && !selectedTransition) || (selection.type === 'technical' && !technicalNode)) throw new ArchitectureApiError(404, '当前选择已不在此版本的视图中。请清除选择，或从左侧重新定位。');
          finishEvidence(selectedStep?.evidenceIds || selectedTransition?.evidenceIds || []);
        });
    request.catch(failure => { if (active()) fail(failure, setDetailError); }).finally(() => { if (active()) setDetailBusy(false); });
    return () => abort.abort();
  }, [scope, metadata?.viewRevision, selectionKey(selection), selectionEpoch, memberOffset, unclassifiedOffset, conflict, activateEvidence, fail]);

  useEffect(() => {
    if (!scope || !metadata || !evidenceId || conflict) return;
    const sequence = ++sourceSequence.current, key = selectionKey(selection), requestedView = metadata.viewRevision;
    const abort = new AbortController(); setSourceBusy(true); setSourceError('');
    const active = () => !abort.signal.aborted && sequence === sourceSequence.current && scopeRef.current === scope && selectionRef.current === key && metadataRef.current?.viewRevision === requestedView;
    const requestedSourceRevision = metadata.sourceRevision;
    architectureRequest<EvidenceContent>(scope, `/evidence/${encodeURIComponent(evidenceId)}`, { viewRevision: requestedView }, { signal: abort.signal }).then(value => {
      if (!active()) return;
      if (value.evidence.id !== evidenceId || value.revision !== requestedSourceRevision) throw new ArchitectureApiError(409, '源码证据身份或索引版本与当前架构不一致。旧源码已清除，请重新载入架构视图。');
      setSource(value);
    }).catch(failure => { if (active()) fail(failure, setSourceError); }).finally(() => { if (active()) setSourceBusy(false); });
    return () => abort.abort();
  }, [scope, metadata?.viewRevision, evidenceId, sourceEpoch, conflict, selectionKey(selection), fail]);

  const review = async (targetType: 'system' | 'membership' | 'flow', targetId: string, decision: 'confirmed' | 'rejected' | 'pending') => {
    if (!metadata || conflict || reviewBusy) return;
    const requestScope = scope; const requestedView = metadata.viewRevision; setReviewBusy(`${targetType}:${targetId}`); setReviewError('');
    try {
      await architectureRequest<ModelEnvelope>(scope, '/review', {}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedModelRevision: metadata.modelRevision, viewRevision: requestedView, targetType, targetId, decision }) });
      if (scopeRef.current === requestScope && metadataRef.current?.viewRevision === requestedView) refresh();
    } catch (failure) { if (scopeRef.current === requestScope) fail(failure, setReviewError); }
    finally { if (scopeRef.current === requestScope) setReviewBusy(''); }
  };
  const reviewControls = (targetType: 'system' | 'membership' | 'flow', id: string, state: ResolvedEntity['reviewState']) => <div className="arch-review-actions"><button disabled={!!reviewBusy || conflict || state === 'confirmed'} onClick={() => void review(targetType, id, 'confirmed')}><Check size={12} />确认{targetType === 'membership' ? '此条归属' : targetType === 'flow' ? '流程说明' : '系统定义'}</button><button disabled={!!reviewBusy || conflict || state === 'rejected'} onClick={() => void review(targetType, id, 'rejected')}><X size={12} />拒绝</button>{(state === 'confirmed' || state === 'rejected') && <button disabled={!!reviewBusy || conflict} onClick={() => void review(targetType, id, 'pending')}>撤回复核</button>}{reviewBusy === `${targetType}:${id}` && <Loader2 size={12} className="spin" />}</div>;
  const openEntity = (entity: ResolvedEntity) => navigate({ perspective: 'business', rootId: entity.id });
  const openCode = (nodeId: string, mode: OpenCodeRequest['mode'] = 'symbol') => onOpenCode({ nodeId, mode });
  const selectGraphNode = (node: ArchitectureNode) => { const entity = view?.entities.find(item => item.nodeId === node.id); select(entity ? { type: 'entity', id: entity.id } : { type: 'technical', id: node.id }); };
  const enterGraphNode = (node: ArchitectureNode) => { const entity = view?.entities.find(item => item.nodeId === node.id); if (entity) openEntity(entity); else openCode(node.id, ['method', 'function', 'field', 'property', 'data', 'parameter', 'event'].includes(node.kind) ? 'symbol' : 'structure'); };
  const graphSelectedId = selection?.type === 'entity' ? view?.entities.find(entity => entity.id === selection.id)?.nodeId : selection?.type === 'technical' ? selection.id : undefined;
  const selectedName = selectedEntity?.name || technicalNode?.label || selectedStep?.name || (selection?.type === 'unclassified' ? '待分类源码实体' : selectedTransition ? '步骤关系' : relation ? '系统协作关系' : '架构详情');
  const visibleEntities = view?.entities.filter(entity => `${entity.name} ${entity.responsibility}`.toLowerCase().includes(search.toLowerCase())) || [];
  const allFlows = flowsEnvelope?.flows || detail?.flows || [];
  const selectedFlowStepIds = selectedTransition ? [...new Set([...(currentFlow?.steps.find(step => step.id === selectedTransition.source)?.nodeIds || []), ...(currentFlow?.steps.find(step => step.id === selectedTransition.target)?.nodeIds || [])])] : selectedStep?.nodeIds || [];
  const graphPresentations = Object.fromEntries((view?.entities || []).map(entity => [entity.nodeId, { kindLabel: entity.entityKind === 'system' ? entity.systemKind === 'legacy' ? '旧路径' : entity.systemKind === 'support' ? '共享支撑' : '业务系统' : '职责模块', summary: entity.responsibility, badge: entity.reviewState === 'confirmed' ? '已确认' : entity.reviewState === 'needs-review' ? '待复核' : entity.reviewState === 'rejected' ? '已拒绝' : '候选', footer: `${entity.memberNodeIds.length} 个代码实体` }]));
  const graphEdgeLabels = Object.fromEntries((view?.relations || []).map(item => [item.id, `${categoryLabels[item.category || item.categories[0]]} · ${item.totalMembers}${item.categories.length > 1 ? ` +${item.categories.length - 1}` : ''}`]));
  const businessOverview = route.perspective === 'business' && !route.rootId;
  const coreNodeIds = new Set(view?.entities.filter(entity => entity.entityKind === 'system' && entity.systemKind === 'business').map(entity => entity.nodeId));
  const summaryRelations = view?.relations.filter(item => coreNodeIds.has(item.source) && coreNodeIds.has(item.target)).sort((a, b) => b.totalMembers - a.totalMembers || a.id.localeCompare(b.id)).slice(0, 5) || [];
  const summaryRelationIds = new Set(summaryRelations.map(item => item.id));
  const summaryActive = businessOverview && overviewMode === 'summary';
  const displayGraph = view && summaryActive ? { ...view.graph, nodes: view.graph.nodes.filter(node => coreNodeIds.has(node.id)), edges: view.graph.edges.filter(edge => summaryRelationIds.has(edge.id)), totalNodes: coreNodeIds.size, truncated: false } : view?.graph;
  const useGrid = summaryActive || (route.perspective === 'business' && !!route.rootId && !!view?.entities.length && view.entities.every(entity => entity.entityKind === 'module') && view.graph.nodes.length <= 8);

  const evidenceButtons = (ids = selectedEvidenceIds) => <div className="arch-evidence-list">{ids.map(id => { const item = evidence.find(item => item.id === id) || (source?.evidence.id === id ? source.evidence : undefined); return <button key={id} className={evidenceId === id ? 'active' : ''} onClick={() => activateEvidence(id)}><FileCode2 size={13} /><span>{item ? item.filePath.replaceAll('\\', '/').split('/').slice(-2).join('/') : '查看源码锚点'}<small>{item ? `L${item.startLine}–${item.endLine} · ${item.rule}` : id}</small></span><ArrowUpRight size={11} /></button>; })}{ids.length === 0 && <p className="arch-muted">此项没有可读取的源码证据。不会补造关系或执行顺序。</p>}</div>;
  const membershipRows = (items: ResolvedMembership[]) => <div className="arch-memberships">{items.map(item => <details key={item.id} className="arch-membership"><summary><span className={`arch-review ${item.reviewState}`}>{reviewLabels[item.reviewState]}</span><strong>{roleLabels[item.role]}</strong><span>{item.nodeIds.length} 符号</span><ChevronDown size={12} /></summary><p className={`arch-resolution ${item.resolution}`}>{resolutionLabels[item.resolution]} · {item.origin === 'curated' ? '人工规则' : item.origin === 'suggested' ? '建议归属' : '匹配规则'}</p><code>{JSON.stringify(item.selector, null, 2)}</code>{reviewControls('membership', item.id, item.reviewState)}<p className="arch-muted">仅复核这一条成员归属，不影响其他规则。</p></details>)}</div>;

  return <section className="architecture-workspace" data-scope={scope} data-view-revision={metadata?.viewRevision || ''} data-architecture-root={route.rootId || ''} data-selection-id={selection?.id || ''}>
    <header className="arch-toolbar"><div className="arch-breadcrumbs"><button aria-label="返回上一架构视图" title="返回上一架构视图" disabled={!history.length} onClick={back}><ArrowLeft size={15} /></button><button onClick={() => navigate({ perspective: route.perspective === 'flows' ? 'flows' : route.perspective })}>{route.perspective === 'business' ? '业务架构' : route.perspective === 'technical' ? '技术架构' : '业务流程'}</button>{view?.breadcrumbs.filter(crumb => !!crumb.id).map(crumb => <span key={crumb.id}><ChevronRight size={11} /><button onClick={() => navigate({ perspective: route.perspective, rootId: crumb.id })}>{crumb.name}</button></span>)}{currentFlow && <span><ChevronRight size={11} />{currentFlow.name}</span>}</div><div className="arch-toolbar-actions"><button onClick={() => setEditorOpen(true)}><Braces size={13} />模型</button><button aria-label="重新载入架构模型" title="重新载入架构与复核状态" onClick={refresh}><RefreshCw size={14} className={loading ? 'spin' : ''} /></button><button aria-label={sourceOpen ? '收起架构源码证据' : '展开架构源码证据'} title="切换源码证据面板" onClick={() => setSourceOpen(value => !value)}>{sourceOpen ? <PanelBottomClose size={15} /> : <PanelBottomOpen size={15} />}</button></div></header>
    <div className="arch-perspective-heading"><div><span className="arch-eyebrow">{route.perspective === 'business' ? route.rootId ? 'L2 / L3 · 从职责到组件' : 'L1 · 从系统理解项目' : route.perspective === 'technical' ? '程序集与源码组织' : '跨组件流程 · 逐段举证'}</span><h1>{route.perspective === 'flows' ? '理解系统如何协作' : route.perspective === 'technical' ? '技术架构' : route.rootId ? view?.breadcrumbs.at(-1)?.name || '系统内部' : '项目系统全景'}</h1></div><div className="arch-header-stats">{metadata && <span title={`源码 ${metadata.sourceRevision}\n模型 ${metadata.modelRevision}\n视图 ${metadata.viewRevision}`}><ShieldCheck size={12} />源码与模型独立版本</span>}{route.perspective !== 'flows' && <span>{displayGraph?.nodes.length || 0} 个可见节点 · {view?.relations.length || 0} 组关系</span>}</div></div>
    <div className="arch-trust-strip"><Info size={13} /><span>{route.perspective === 'technical' ? '技术分组来自程序集与源码结构。进入代码页可继续查看类、方法与真实读写。' : route.perspective === 'flows' ? '阶段泳道表达可阅读的流程说明；源码支持、静态调用和未验证顺序分别标记。' : '业务定义与成员归属分别复核。候选归属的汇总边保留“待复核”标记，底层源码可信度不会被升级。'}</span></div>
    {(error || conflict) && <ErrorNotice error={conflict ? '当前架构视图已过期。旧详情与源码已清除，请重新载入后继续；模型编辑草稿仍被保留。' : error} onReload={refresh} />}
    <div className={`arch-work-grid ${conflict ? 'is-stale' : ''}`}>
      <aside className="arch-navigation"><div className="arch-navigation-title">{route.perspective === 'flows' ? '可探索的流程' : route.perspective === 'technical' ? '技术入口' : '职责地图'}</div>{route.perspective === 'flows' ? <nav>{flowsEnvelope?.flows.map(flow => <button key={flow.id} className={currentFlow?.id === flow.id ? 'active' : ''} onClick={() => navigate({ perspective: 'flows', flowId: flow.id })}><Workflow size={14} /><span>{flow.name}<small>{reviewLabels[flow.reviewState]}</small></span></button>)}</nav> : <><label className="arch-nav-search"><Search size={12} /><input aria-label="筛选架构实体" value={search} onChange={event => setSearch(event.target.value)} placeholder="筛选职责与模块…" /></label><nav>{(['business', 'support', 'legacy'] as const).map(kind => { const items = visibleEntities.filter(entity => route.perspective === 'technical' || entity.entityKind === 'module' ? kind === 'business' : entity.systemKind === kind); return items.length > 0 && <section key={kind}><h3>{route.perspective === 'technical' ? '程序集与源码' : route.rootId ? '模块与组件' : kind === 'business' ? '核心业务系统' : kind === 'support' ? '共享支撑' : '旧路径 / 独立试验'}</h3>{items.map(entity => <button key={entity.id} className={selection?.type === 'entity' && selection.id === entity.id ? 'active' : ''} onClick={() => select({ type: 'entity', id: entity.id })} onDoubleClick={() => openEntity(entity)} title="单击查看详情，双击进入"><Layers3 size={14} /><span>{entity.name}<small>{reviewLabels[entity.reviewState]}</small></span><ChevronRight size={11} /></button>)}</section>; })}{route.perspective === 'technical' && !view?.entities.length && view?.graph.nodes.filter(node => node.label.toLowerCase().includes(search.toLowerCase())).map(node => <button key={node.id} onClick={() => selectGraphNode(node)}><Blocks size={14} /><span>{node.label}<small>{nodeLabels[node.kind]}</small></span></button>)}</nav><div className="arch-nav-foot"><ShieldCheck size={13} /><span>只读分析目标代码<small>模型与决策保存在工具仓库</small></span></div></>}</aside>
      <main className="arch-main">
        {route.perspective !== 'flows' && <div className="arch-graph-tools"><span><Network size={13} />{route.perspective === 'technical' ? '技术依赖' : route.rootId ? '模块协作与组件入口' : '系统协作'}</span>{businessOverview && <div className="arch-overview-toggle" role="group" aria-label="业务地图显示范围"><button className={overviewMode === 'summary' ? 'active' : ''} aria-pressed={overviewMode === 'summary'} onClick={() => setOverviewMode('summary')}>核心摘要 {summaryRelations.length}/{view?.relations.length || 0}</button><button className={overviewMode === 'all' ? 'active' : ''} aria-pressed={overviewMode === 'all'} onClick={() => setOverviewMode('all')}>全部</button></div>}<label><Filter size={12} /><select aria-label="架构关系类别" value={category} onChange={event => { select(); setCategory(event.target.value); }}><option value="">全部关系</option>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><ChevronDown size={10} /></label><button title="重新整理架构布局" aria-label="架构自动布局" disabled={!view?.graph.nodes.length} onClick={() => setLayoutToken(value => value + 1)}><LayoutGrid size={14} /></button></div>}
        {summaryActive && <div className="arch-summary-note"><Info size={12} /><span>仅展示 {coreNodeIds.size} 个核心业务系统及最强 {summaryRelations.length}/{view?.relations.length || 0} 组关系。共享支撑、旧路径保留在左栏；切换“全部”查看完整地图。</span></div>}<div className="arch-main-content">{loading ? <div className="arch-empty"><Loader2 size={28} className="spin" /><h2>读取当前架构</h2><p>将源码事实、职责模型和独立复核状态对齐到同一视图版本。</p></div> : error ? <div className="arch-empty"><TriangleAlert size={27} /><h2>架构 API 暂不可用</h2><p>错误信息保留在上方。服务就绪后重新载入，不会使用演示关系替代。</p><button className="arch-primary" onClick={refresh}>重新载入</button></div> : route.perspective === 'flows' ? currentFlow ? <FlowBoard flow={currentFlow} selectedId={selection?.id} onStep={step => select({ type: 'step', id: step.id, flowId: currentFlow.id })} onTransition={transition => select({ type: 'transition', id: transition.id, flowId: currentFlow.id })} onOpenCode={nodeId => openCode(nodeId)} /> : <div className="arch-empty"><Workflow size={29} /><h2>尚未定义可用流程</h2><p>添加有源码锚点的流程定义后，阶段泳道会在此呈现。</p><button onClick={() => setEditorOpen(true)}>打开模型编辑器</button></div> : displayGraph?.nodes.length ? <GraphCanvas graph={displayGraph} selectedId={graphSelectedId} onSelect={selectGraphNode} onEnter={enterGraphNode} onRelation={edge => select({ type: 'relation', id: edge.id })} layoutToken={layoutToken} view={`systems:${route.perspective}`} onFocusHandled={() => {}} cardPresentations={graphPresentations} edgeLabelOverrides={graphEdgeLabels} pendingEdgeIds={new Set((view?.relations || []).filter(item => item.membershipPending).map(item => item.id))} nodeSize={route.perspective === 'business' && view && view.entities.length > 0 ? useGrid ? { width: 240, height: 132 } : { width: 252, height: 150 } : undefined} layoutMode={useGrid ? 'grid' : 'elk'} /> : <div className="arch-empty"><Layers3 size={30} /><h2>{view?.available === false ? '尚无业务架构模型' : route.rootId ? '此模块进入代码层探索' : '当前范围没有架构节点'}</h2><p>{route.rootId ? '在右侧查看组件、输入输出和源码，使用组件入口打开现有代码地图。' : '技术架构仍可查看程序集和源码结构。业务模型需要明确的职责、归属及源码证据。'}</p>{view?.available === false && <button onClick={() => navigate({ perspective: 'technical' })}>查看技术架构</button>}</div>}</div>
        {view && !loading && <div className="arch-view-foot"><span><ShieldCheck size={11} />源 {view.metadata.sourceRevision.slice(0, 8)} · 模型 {view.metadata.modelRevision.slice(0, 8)}</span><button onClick={() => select({ type: 'unclassified', id: 'unclassified' })}>{view.unclassifiedCount} 个实体尚未归类 · 查看</button><span>{view.diagnostics.length} 条诊断</span></div>}
      </main>
      <aside className="arch-inspector" aria-label="架构节点详情"><header><span>{selectedName}</span>{selection && <button title="清除架构选择" aria-label="清除架构选择" onClick={() => select()}><X size={14} /></button>}</header><div className="arch-inspector-scroll">
        {detailBusy && <div className="arch-inline-loading"><Loader2 size={14} className="spin" />对齐当前视图详情…</div>}{detailError && <ErrorNotice error={detailError} onReload={refresh} />}{reviewError && <ErrorNotice error={reviewError} onReload={conflict ? refresh : undefined} />}
        {selectedEntity && <><div className="arch-inspector-overview"><div><span className="arch-eyebrow">{selectedEntity.entityKind === 'system' ? '系统定义' : '模块职责'}</span><ReviewBadge state={selectedEntity.reviewState} /></div><h2>{selectedEntity.name}</h2><p>{selectedEntity.responsibility}</p><span className={`arch-resolution ${selectedEntity.resolution}`}>{resolutionLabels[selectedEntity.resolution]}</span>{selectedEntity.entityKind === 'system' && <>{reviewControls('system', selectedEntity.id, selectedEntity.reviewState)}<p className="arch-review-explainer">确认仅作用于系统定义，成员归属需逐条复核。</p></>}<button className="arch-inspector-enter" onClick={() => openEntity(selectedEntity)}><Layers3 size={13} />{selectedEntity.entityKind === 'system' ? '进入系统：模块与协作' : '进入模块：组件与源码'}<ArrowRight size={13} /></button></div>
          {selectedEntity.features.length > 0 && <section><h3>功能边界</h3><TextList items={selectedEntity.features} /></section>}<section className="arch-io"><div><h3>输入</h3><TextList items={selectedEntity.inputs} /></div><div><h3>输出</h3><TextList items={selectedEntity.outputs} /></div></section>{selectedEntity.keyData.length > 0 && <section><h3>关键数据</h3><TextList items={selectedEntity.keyData} /></section>}
          {detail && <>
            {detail.modules.length > 0 && <section><h3>模块<span>{detail.modules.length}</span></h3>{detail.modules.map(module => <button className="arch-module-link" key={module.id} onClick={() => openEntity(module)}><Blocks size={14} /><span>{module.name}<small>{module.responsibility}</small></span><ChevronRight size={12} /></button>)}</section>}
            <section><h3>相关流程</h3>{detail.flows.map(flow => <button className="arch-module-link" key={flow.id} onClick={() => navigate({ perspective: 'flows', flowId: flow.id })}><Workflow size={13} /><span>{flow.name}<small>{reviewLabels[flow.reviewState]}</small></span><ChevronRight size={12} /></button>)}{!detail.flows.length && <p className="arch-muted">没有明确关联的流程定义。</p>}</section>
            <section><h3>代码组件<span>{detail.totalComponents}</span></h3>{detail.components.slice(0, componentLimit).map(node => <button className="arch-code-link" key={node.id} onClick={() => openCode(node.id, ['method', 'function', 'field', 'property', 'data'].includes(node.kind) ? 'symbol' : 'structure')}><Code2 size={13} /><span>{node.label}<small>{nodeLabels[node.kind]} · {node.filePath || node.qualifiedName}</small></span><ArrowUpRight size={12} /></button>)}{detail.components.length > 12 && <button className="arch-show-more" onClick={() => setComponentLimit(componentLimit === 12 ? detail.components.length : 12)}>{componentLimit === 12 ? `展开其余 ${detail.components.length - 12} 个组件` : '收起到前 12 个组件'}</button>}{detail.components.length < detail.totalComponents && <p className="arch-muted">API 当前返回 {detail.components.length}/{detail.totalComponents} 个组件。进入代码页继续逐层探索。</p>}</section>
            {detail.relations.length > 0 && <section><details className="arch-details-disclosure"><summary>全部协作关系 <span>{detail.relations.length}</span><ChevronDown size={12} /></summary>{detail.relations.map(item => <button className="arch-module-link" key={item.id} onClick={() => select({ type: 'relation', id: item.id })}><Network size={13} /><span>{names.get(item.source) || '源组件'} → {names.get(item.target) || '目标组件'}<small>{item.categories.map(category => categoryLabels[category]).join('、')} · {item.totalMembers} 条底层关系{item.membershipPending ? ' · 归属待复核' : ''}</small></span><ChevronRight size={12} /></button>)}</details></section>}
            <section><details className="arch-details-disclosure" open={membershipsOpen} onToggle={event => setMembershipsOpen(event.currentTarget.open)}><summary>成员归属规则 <span>{detail.memberships.length}</span><small>独立复核</small><ChevronDown size={12} /></summary>{membershipsOpen && <>{membershipRows(detail.memberships)}{!detail.memberships.length && <p className="arch-muted">没有配置成员归属；不据此制造系统连线。</p>}</>}</details></section>
            <section><h3>源码锚点<span>{detail.evidence.length}</span></h3>{evidenceButtons(detail.evidence.slice(0, evidenceLimit).map(item => item.id))}{detail.evidence.length > 10 && <button className="arch-show-more" onClick={() => setEvidenceLimit(evidenceLimit === 10 ? detail.evidence.length : 10)}>{evidenceLimit === 10 ? `显示其余 ${detail.evidence.length - 10} 条证据` : '收起到前 10 条证据'}</button>}</section>
          </>}
        </>}
        {relation && <><div className="arch-inspector-overview"><span className="arch-eyebrow">汇总关系 · 每条保留原始成员</span><h2>{names.get(relation.source) || '源系统'}<ArrowRight size={17} />{names.get(relation.target) || '目标系统'}</h2><p>{relation.totalMembers} 条底层关系；{relation.categories.map(item => categoryLabels[item]).join('、')}</p>{relation.membershipPending && <span className="arch-review pending">成员归属待复核</span>}<div className="arch-confidence-counts"><span>静态确认 <b>{relation.confidenceCounts['static-confirmed']}</b></span><span>运行验证 <b>{relation.confidenceCounts['runtime-verified']}</b></span><span>有据推断 <b>{relation.confidenceCounts.inferred}</b></span></div><p className="arch-review-explainer">汇总只表示至少存在这些底层关系，不表示系统内任意组件相互调用。读写引用不等于运行时数据传递。</p></div><section><h3>成员关系<span>{members?.total ?? relation.totalMembers}</span></h3>{members?.edges.map(edge => <div className={`arch-member-edge ${memberEdge?.id === edge.id ? 'active' : ''}`} key={edge.id}><button onClick={() => { setMemberEdge(edge); activateEvidence(edge.evidenceIds[0] || ''); }}><span>{edgeLabels[edge.kind]}<em>{confidenceLabels[edge.confidence]}</em></span><strong>{names.get(edge.source) || edge.source}<ArrowRight size={10} />{names.get(edge.target) || edge.target}</strong><small>{edge.condition || edge.rule}</small></button><div><button onClick={() => openCode(edge.source)}>源符号 <ArrowUpRight size={10} /></button><button onClick={() => openCode(edge.target)}>目标符号 <ArrowUpRight size={10} /></button></div></div>)}{members && members.total > 25 && <div className="arch-pagination"><button disabled={memberOffset === 0 || detailBusy} onClick={() => { clearEvidence(); setMemberOffset(value => Math.max(0, value - 25)); }}><ArrowLeft size={12} />上一页</button><span>{memberOffset + 1}–{Math.min(memberOffset + members.edges.length, members.total)} / {members.total}</span><button disabled={memberOffset + members.edges.length >= members.total || detailBusy} onClick={() => { clearEvidence(); setMemberOffset(value => value + 25); }}>下一页<ArrowRight size={12} /></button></div>}</section>{memberEdge && <section><h3>当前成员证据</h3><p className="arch-muted">{memberEdge.rule}</p>{memberEdge.limitations?.map((text, index) => <p className="arch-warning-text" key={index}>{text}</p>)}{evidenceButtons(memberEdge.evidenceIds)}</section>}</>}
        {(selectedStep || selectedTransition) && <><div className="arch-inspector-overview"><span className="arch-eyebrow">{selectedStep ? '流程步骤' : '步骤之间的关系'}</span><h2>{selectedStep?.name || `${currentFlow?.steps.find(step => step.id === selectedTransition?.source)?.name || ''} → ${currentFlow?.steps.find(step => step.id === selectedTransition?.target)?.name || ''}`}</h2><p>{selectedStep?.description || (selectedTransition && basisLabels[selectedTransition.basis])}</p>{selectedStep && <span className={`arch-resolution ${selectedStep.resolution}`}>{resolutionLabels[selectedStep.resolution]}</span>}{selectedTransition && <span className={`arch-transition-status ${selectedTransition.verification}`}>{verificationLabels[selectedTransition.verification]}</span>}</div>{selectedStep && <><section><h3>读取</h3><TextList items={selectedStep.reads} /></section><section><h3>修改</h3><TextList items={selectedStep.writes} /></section></>}{(selectedStep?.condition || selectedTransition?.condition) && <section><h3>分支条件</h3><p>{selectedStep?.condition || selectedTransition?.condition}</p></section>}<section><h3>关联代码<span>{selectedFlowStepIds.length}</span></h3>{selectedFlowStepIds.map(nodeId => <button className="arch-code-link" key={nodeId} onClick={() => openCode(nodeId)}><Code2 size={13} /><span>打开源码符号<small>{nodeId}</small></span><ArrowUpRight size={12} /></button>)}</section><section><h3>顺序与证据限制</h3>{selectedTransition && <><p className="arch-muted">{selectedTransition.memberEdgeIds.length} 条真实调用成员</p><TextList items={selectedTransition.limitations} empty="未声明额外限制；验证范围仍以上方标记为准。" /></>}{evidenceButtons()}</section></>}
        {selection?.type === 'unclassified' && <><div className="arch-inspector-overview"><span className="arch-eyebrow">待分类 · 保留原始代码事实</span><h2>待分类源码实体</h2><p>这些实体当前没有有效的业务所有者归属；不会被强行塞进某个系统，也不会用于制造跨系统连线。</p><button className="arch-inspector-enter" onClick={() => setEditorOpen(true)}><Braces size={13} />编辑归属规则<ArrowUpRight size={13} /></button></div><section><h3>源码实体<span>{unclassified?.total ?? view?.unclassifiedCount ?? 0}</span></h3>{unclassified?.nodes.map(node => <button className="arch-code-link" key={node.id} onClick={() => openCode(node.id, ['method', 'function', 'field', 'property', 'data', 'parameter'].includes(node.kind) ? 'symbol' : 'structure')}><Code2 size={13} /><span>{node.label}<small>{nodeLabels[node.kind]} · {node.filePath || node.qualifiedName}</small></span><ArrowUpRight size={12} /></button>)}{unclassified?.total === 0 && <p className="arch-muted">当前配置范围内的实体均已有归属。</p>}{unclassified && unclassified.total > 30 && <div className="arch-pagination"><button disabled={unclassifiedOffset === 0 || detailBusy} onClick={() => setUnclassifiedOffset(value => Math.max(0, value - 30))}><ArrowLeft size={12} />上一页</button><span>{unclassifiedOffset + 1}–{Math.min(unclassifiedOffset + unclassified.nodes.length, unclassified.total)} / {unclassified.total}</span><button disabled={unclassifiedOffset + unclassified.nodes.length >= unclassified.total || detailBusy} onClick={() => setUnclassifiedOffset(value => value + 30)}>下一页<ArrowRight size={12} /></button></div>}</section></>}{technicalNode && <div className="arch-inspector-overview"><span className="arch-eyebrow">技术结构 · {nodeLabels[technicalNode.kind]}</span><h2>{technicalNode.label}</h2><p>{technicalNode.summary || technicalNode.qualifiedName}</p><p className="arch-muted">技术分组表示源码与程序集组织，不自动等同于业务系统归属。</p><button className="arch-inspector-enter" onClick={() => openCode(technicalNode.id, 'structure')}><Code2 size={13} />进入代码地图<ArrowUpRight size={13} /></button></div>}
        {!selection && currentFlow && <><div className="arch-inspector-overview"><span className="arch-eyebrow">流程定义复核</span><h2>{currentFlow.name}</h2><ReviewBadge state={currentFlow.reviewState} /><p>{currentFlow.description}</p>{reviewControls('flow', currentFlow.id, currentFlow.reviewState)}<p className="arch-review-explainer">确认流程说明不会把未验证的跨请求、协议或叙述顺序变为运行时事实。</p></div><section><h3>分析限制</h3><TextList items={currentFlow.limitations} /><p className="arch-muted">点击阶段泳道中的步骤或下方步骤关系查看具体源码证据。</p></section></>}
        {!selection && !currentFlow && <div className="arch-inspector-empty"><div><Layers3 size={27} /></div><h3>从职责理解代码</h3><p>选择一个系统，查看职责、输入输出和独立归属复核；双击进入模块与真实组件。</p><span><ShieldCheck size={13} />候选状态明确可见</span><span><GitBranch size={13} />系统连线保留全部成员</span><span><Code2 size={13} />每层均可进入代码地图</span></div>}
        {view?.diagnostics.length ? <section><h3>投影诊断<span>{view.diagnostics.length}</span></h3>{view.diagnostics.slice(0, 30).map(item => <div className={`arch-diagnostic ${item.severity}`} key={item.id}><TriangleAlert size={12} /><span><strong>{item.code}</strong>{item.message}</span></div>)}{view.diagnostics.length > 30 && <p className="arch-muted">显示前 30 条；模型编辑器中的校验会保留完整错误。</p>}</section> : null}
      </div></aside>
    </div>
    {sourceOpen && <section className="arch-source-panel" aria-label="架构源码证据"><header><span><FileCode2 size={13} />源码证据{evidenceId && <small>{memberEdge ? edgeLabels[memberEdge.kind] : '当前选择'}</small>}</span><span className="arch-source-readonly"><ShieldCheck size={11} />当前授权工作区 · 只读</span><button aria-label="关闭架构源码面板" onClick={() => setSourceOpen(false)}><ChevronDown size={14} /></button></header><div className="arch-source-content">{sourceBusy ? <div className="arch-source-empty"><Loader2 size={15} className="spin" />读取当前视图的源码证据…</div> : sourceError ? <ErrorNotice error={sourceError} onReload={conflict ? refresh : () => activateEvidence(evidenceId)} /> : source ? <SourcePreview source={source} rootPath={rootPath} /> : <div className="arch-source-empty"><FileCode2 size={19} />选择源码锚点、原始关系或流程步骤，查看真实文件与行号。不存在证据时保持为空。</div>}</div></section>}
    {editorOpen && <ModelEditor key={scope} scope={scope} onClose={() => setEditorOpen(false)} onSaved={() => refresh()} />}
  </section>;
}

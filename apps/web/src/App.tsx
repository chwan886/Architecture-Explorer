import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { Activity, ArrowDownLeft, ArrowLeft, ArrowRight, ArrowUpRight, Bookmark, BookmarkCheck, Box, Braces, Check, ChevronDown, ChevronRight, ChevronsUpDown, Circle, Clock3, Code2, Command, FileCode2, FileSearch, Folder, GitBranch, GitFork, Info, Layers3, LayoutGrid, Loader2, Maximize2, PanelBottomClose, PanelBottomOpen, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, RefreshCw, Route, Search, ShieldCheck, SlidersHorizontal, Sparkles, Target, TriangleAlert, Workflow, X } from 'lucide-react';
import type { ArchitectureEdge, ArchitectureNode, Diagnostic, Evidence, GraphResult, IndexStatus, WorktreeInfo } from '../../../packages/schema/src/index';
import { graphPath, request } from './api';
import SourcePreview from './SourcePreview';
import type { EvidenceContent, NodeDetails, Project, Summary } from './api';
import { confidenceLabels, edgeLabels, expandableKinds, formatTime, nodeLabels, shortPath } from './labels';
import { applySelectionResponse, isCurrentSelectionRequest } from './selection';
import type { SelectionRequest } from './selection';
import type { ArchitectureRoute, OpenCodeRequest, OwnershipResult } from '../../../packages/architecture-model/src/types';
import type { SemanticLocation, SemanticReverseResult } from '../../../packages/semantic-model/src/types';
import type { ControlCommand } from '../../../packages/control-protocol/src/types';
import useLinkController from './control/useLinkController';
import LinkBar from './control/LinkBar';
import FloatingProgress from './control/FloatingProgress';
import { presentationIsCurrent } from './control/progress';
const IntegrationWorkspace = lazy(() => import('./control/IntegrationWorkspace'));
const GraphCanvas = lazy(() => import('./GraphCanvas'));
const ArchitectureWorkspace = lazy(() => import('./architecture/ArchitectureWorkspace'));
const SemanticWorkspace = lazy(() => import('./semantics/SemanticWorkspace'));
const DeliveryWorkspace = lazy(() => import('./delivery/DeliveryWorkspace'));

type View = 'architecture' | 'calls' | 'data' | 'impact';
type BottomTab = 'source' | 'relations' | 'warnings';
type PrimaryPage = 'overview' | 'technical' | 'flows' | 'code' | 'delivery';
type Location = { root?: ArchitectureNode; view: View; focus?: ArchitectureNode };
type SelectionPresentation = { evidenceId: string; activeRelation?: ArchitectureEdge; bottomTab: BottomTab; revision?: string };
type HistoryEntry = SelectionPresentation & { location: Location; selected?: ArchitectureNode; direction: string; depth: number; confidence: string; relationKind: string; limit: number };
type SavedNode = { id: string; label: string; kind: ArchitectureNode['kind'] };

const views: { id: View; label: string; icon: typeof LayoutGrid }[] = [{ id: 'architecture', label: '架构地图', icon: LayoutGrid }, { id: 'calls', label: '调用链', icon: GitFork }, { id: 'data', label: '数据读写', icon: Workflow }, { id: 'impact', label: '修改影响', icon: Route }];
const statusLabels = { empty: '尚未索引', analyzing: '正在分析', synced: '已同步', stale: '索引过期', failed: '分析失败' };
const EMPTY_GRAPH: GraphResult = { nodes: [], edges: [], totalNodes: 0, truncated: false, revision: '' };

function loadSaved(key: string): SavedNode[] { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; } }
function saveNodes(key: string, nodes: SavedNode[]) { try { localStorage.setItem(key, JSON.stringify(nodes)); } catch { /* browser storage may be unavailable */ } }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function StatusIcon({ state }: { state?: string }) { return state === 'analyzing' ? <Loader2 size={13} className="spin" /> : state === 'synced' ? <Check size={13} /> : state === 'failed' || state === 'stale' ? <TriangleAlert size={13} /> : <Circle size={10} />; }
function StateCard({ title, description, busy, action, onAction }: { title: string; description: string; busy?: boolean; action?: string; onAction?: () => void }) {
  return <div className="state-card">{busy ? <Loader2 size={30} className="spin state-symbol" /> : <FileSearch size={32} className="state-symbol" />}<h2>{title}</h2><p>{description.length > 220 ? `${description.slice(0, 220)}…` : description}</p>{description.length > 220 && <details className="state-error-details"><summary>查看完整说明</summary><pre>{description}</pre></details>}{action && <button className="primary-button" onClick={onAction}><RefreshCw size={14} />{action}</button>}</div>;
}

function TreeBranch({ node, scope, revision, activeId, openPath, onEnter, level = 0 }: { node: ArchitectureNode; scope: string; revision?: string; activeId?: string; openPath: string[]; onEnter: (node: ArchitectureNode) => void; level?: number }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<GraphResult>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const expandable = expandableKinds.has(node.kind);
  useEffect(() => { if (openPath.includes(node.id) && expandable) setOpen(true); }, [openPath.join('|'), node.id, expandable]);
  useEffect(() => {
    if (!open || !expandable) return;
    let alive = true; setLoading(true); setError('');
    request<GraphResult>(graphPath({ rootId: node.id, view: 'architecture', direction: 'both', depth: 1, limit: 80, kinds: '', confidence: '' }), scope)
      .then(value => { if (alive) setChildren(value); }).catch(error => { if (alive) setError(errorMessage(error)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, node.id, scope, revision]);
  return <div className="tree-branch"><div className={`tree-branch-row ${activeId === node.id ? 'active' : ''}`} style={{ paddingLeft: 3 + level * 11 }}>
    {expandable ? <button className="tree-disclosure" aria-label={`${open ? '折叠' : '展开'} ${node.label}`} aria-expanded={open} onClick={() => setOpen(value => !value)}>{loading ? <Loader2 size={11} className="spin" /> : open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}</button> : <span className="tree-leaf-spacer" />}
    <button className="tree-branch-link" title={node.qualifiedName} onClick={() => onEnter(node)}>{node.kind === 'file' ? <FileCode2 size={13} /> : expandable ? <Folder size={13} /> : <Box size={12} />}<span>{node.label}</span>{level === 0 && <small>{nodeLabels[node.kind]}</small>}</button>
  </div>{open && <div role="group">{error ? <div className="tree-branch-message warning-text" title={error}>读取失败，折叠后可重试。</div> : children?.nodes.map(child => <TreeBranch key={child.id} node={child} scope={scope} revision={revision} activeId={activeId} openPath={openPath} onEnter={onEnter} level={level + 1} />)}{!loading && children && children.nodes.length === 0 && <div className="tree-branch-message">没有下一层实体</div>}{children?.truncated && <button className="tree-branch-message text-button" onClick={() => onEnter(node)}>更多实体请在画布中展开</button>}</div>}</div>;
}

export default function App() {
  const [primaryPage, setPrimaryPage] = useState<PrimaryPage>(() => { const page = new URLSearchParams(window.location.search).get('page'); return page === 'code' || page === 'delivery' ? page : 'overview'; });
  const [architectureRoute, setArchitectureRoute] = useState<ArchitectureRoute>({ perspective: 'business' });
  const [returnPage, setReturnPage] = useState<Exclude<PrimaryPage, 'code'>>();
  const [owners, setOwners] = useState<OwnershipResult>();
  const [ownershipError, setOwnershipError] = useState('');
  const [modelRefresh, setModelRefresh] = useState('');
  const [semanticRefresh, setSemanticRefresh] = useState('');
  const [semanticLocation, setSemanticLocation] = useState<SemanticLocation>({});
  const [semanticMatches, setSemanticMatches] = useState<SemanticReverseResult>();
  const [semanticReverseError, setSemanticReverseError] = useState('');
  const [legacyFlows, setLegacyFlows] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [worktreeId, setWorktreeId] = useState('');
  const [bootstrapError, setBootstrapError] = useState('');
  const [bootstrapLoading, setBootstrapLoading] = useState(true);
  const [connectionLost, setConnectionLost] = useState(false);
  const [status, setStatus] = useState<IndexStatus>();
  const [summary, setSummary] = useState<Summary>();
  const [graph, setGraph] = useState<GraphResult>(EMPTY_GRAPH);
  const [graphView, setGraphView] = useState<View>('architecture');
  const [rootNodes, setRootNodes] = useState<ArchitectureNode[]>([]);
  const [graphLoading, setGraphLoading] = useState(false);
  const [codeNavigationPending, setCodeNavigationPending] = useState(false);
  const [graphError, setGraphError] = useState('');
  const [selected, setSelected] = useState<ArchitectureNode>();
  const [selectionEpoch, setSelectionEpoch] = useState(0);
  const [details, setDetails] = useState<NodeDetails>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [location, setLocation] = useState<Location>({ view: 'architecture' });
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [direction, setDirection] = useState('both');
  const [depth, setDepth] = useState(1);
  const [confidence, setConfidence] = useState('');
  const [relationKind, setRelationKind] = useState('');
  const [limit, setLimit] = useState(80);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [layoutToken, setLayoutToken] = useState(0);
  const [focusRequest, setFocusRequest] = useState<{ id: string; token: number }>();
  const focusSequence = useRef(0);
  const navigationSequence = useRef(0);
  const [refreshToken, setRefreshToken] = useState(0);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<ArchitectureNode[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  const [treeFilter, setTreeFilter] = useState('');
  const [favorites, setFavorites] = useState<SavedNode[]>([]);
  const [recent, setRecent] = useState<SavedNode[]>([]);
  const [evidenceId, setEvidenceId] = useState('');
  const [source, setSource] = useState<EvidenceContent>();
  const [sourceEpoch, setSourceEpoch] = useState(0);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const [activeRelation, setActiveRelation] = useState<ArchitectureEdge>();
  const [bottomTab, setBottomTab] = useState<BottomTab>('source');
  const [bottomOpen, setBottomOpen] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [leftWidth, setLeftWidth] = useState(242);
  const [rightWidth, setRightWidth] = useState(338);
  const [bottomHeight, setBottomHeight] = useState(222);
  const [scanPending, setScanPending] = useState(false);
  const [scanError, setScanError] = useState('');
  const [notice, setNotice] = useState('');
  const [controlPresentation, setControlPresentation] = useState<ControlCommand>();
  const [controlHighlights, setControlHighlights] = useState(false), [controlStale, setControlStale] = useState('');
  const [progressOpenToken, setProgressOpenToken] = useState(0);
  const controlledProject = useRef<{ projectId: string; worktreeId: string; worktrees: WorktreeInfo[] } | undefined>(undefined);
  const gesture = useRef<{ at: number; kind: string; target: EventTarget | null }>({ at: 0, kind: '', target: null });
  const searchRef = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const scope = projectId && worktreeId ? `${projectId}:${worktreeId}` : '';
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const selectedIdRef = useRef(selected?.id);
  selectedIdRef.current = selected?.id;
  const detailSequenceRef = useRef(0);
  const detailRequestRef = useRef<SelectionRequest>({ scopeId: '', nodeId: '', sequence: 0 });
  const sourceSequenceRef = useRef(0);
  const evidenceIdRef = useRef(evidenceId);
  evidenceIdRef.current = evidenceId;
  const pendingPresentationRef = useRef<{ scopeId: string; nodeId: string; presentation: SelectionPresentation } | undefined>(undefined);
  const resetSelection = useCallback((node?: ArchitectureNode, presentation?: SelectionPresentation) => {
    selectedIdRef.current = node?.id;
    detailRequestRef.current = { scopeId: scope, nodeId: node?.id || '', sequence: ++detailSequenceRef.current };
    sourceSequenceRef.current++;
    evidenceIdRef.current = '';
    pendingPresentationRef.current = node && presentation ? { scopeId: scope, nodeId: node.id, presentation } : undefined;
    setSelected(node); setDetails(undefined); setEvidenceId(''); setSource(undefined);
    setDetailError(''); setSourceError(''); setDetailLoading(!!node); setSourceLoading(false);
    setActiveRelation(undefined); setSelectionEpoch(value => value + 1);
    if (presentation) setBottomTab(presentation.bottomTab);
  }, [scope]);
  const currentProject = projects.find(p => p.id === projectId);
  const currentWorktree = worktrees.find(w => w.id === worktreeId);
  const selectedSaved = selected ? { id: selected.id, label: selected.label, kind: selected.kind } : undefined;
  const favorite = !!selected && favorites.some(n => n.id === selected.id);
  const diagnostics = summary?.diagnostics || [];
  const ownerLinks = owners?.owners.filter((owner, index, list) => list.findIndex(item => item.systemId === owner.systemId && item.moduleId === owner.moduleId && item.role === owner.role && item.reviewState === owner.reviewState && item.resolution === owner.resolution) === index) || [];
  const bridge = useLinkController({ scopeId: scope, label: `${currentProject?.name || 'Architecture Explorer'} · ${currentWorktree?.branch || currentWorktree?.id || '本机页面'}`,
    onClear: message => { setControlHighlights(false); if (/过期|更新|失效/.test(message)) setControlStale(message); },
    onApply: async (command, isCurrent) => {
      const { projectId: targetProject, worktreeId: targetWorktree, scopeId: targetScope } = command.resolved.snapshot;
      if (targetScope !== `${targetProject}:${targetWorktree}`) throw new Error('联动目标作用域不一致。');
      const available = projects.length ? projects : (await request<{ projects: Project[] }>('/projects')).projects;
      if (!available.some(project => project.id === targetProject)) throw new Error('联动目标项目未授权。');
      const target = await request<{ worktrees: WorktreeInfo[] }>(`/projects/${encodeURIComponent(targetProject)}/worktrees`);
      if (!target.worktrees.some(worktree => worktree.id === targetWorktree && worktree.authorized)) throw new Error('联动目标 Worktree 未授权。');
      if (!isCurrent()) return;
      if (projectId !== targetProject) controlledProject.current = { projectId: targetProject, worktreeId: targetWorktree, worktrees: target.worktrees };
      navigationSequence.current++; setCodeNavigationPending(false); setProjects(available); setProjectId(targetProject); setWorktrees(target.worktrees); setWorktreeId(targetWorktree);
      setPrimaryPage(command.resolved.presentation.targetView === 'flow' ? 'flows' : command.resolved.presentation.targetView === 'systems' ? 'overview' : command.resolved.presentation.targetView === 'technical' ? 'technical' : 'code');
      setControlPresentation(command); setControlHighlights(true); setControlStale(''); setSearchOpen(false);
    },
  });

  useEffect(() => {
    let alive = true;
    request<{ projects: Project[] }>('/projects').then(result => { if (!alive) return; setProjects(result.projects); setProjectId(current => result.projects.some(project => project.id === current) ? current : result.projects[0]?.id || ''); setBootstrapError(''); }).catch(error => { if (alive) setBootstrapError(errorMessage(error)); }).finally(() => { if (alive) setBootstrapLoading(false); });
    return () => { alive = false; };
  }, [refreshToken]);

  useEffect(() => {
    if (!projectId) return;
    const requested = controlledProject.current;
    if (requested?.projectId === projectId) { controlledProject.current = undefined; setWorktrees(requested.worktrees); setWorktreeId(requested.worktreeId); setBootstrapError(''); return; }
    let alive = true; setWorktreeId(''); setWorktrees([]); setSummary(undefined); setStatus(undefined);
    request<{ worktrees: WorktreeInfo[] }>(`/projects/${encodeURIComponent(projectId)}/worktrees`).then(result => { if (!alive) return; setWorktrees(result.worktrees); setWorktreeId(result.worktrees.find(w => w.authorized)?.id || ''); setBootstrapError(''); }).catch(error => { if (alive) setBootstrapError(errorMessage(error)); });
    return () => { alive = false; };
  }, [projectId]);

  useEffect(() => {
    setCodeNavigationPending(false);
    setSemanticLocation({}); setSemanticMatches(undefined); setSemanticReverseError(''); setLegacyFlows(false);
    navigationSequence.current++; resetSelection(); setArchitectureRoute({ perspective: primaryPage === 'technical' ? 'technical' : primaryPage === 'flows' ? 'flows' : 'business' }); setReturnPage(undefined); setOwners(undefined); setOwnershipError(''); setLocation({ view: 'architecture' }); setHistory([]); setGraph(EMPTY_GRAPH); setGraphView('architecture'); setRootNodes([]); setSummary(undefined); setStatus(undefined); setGraphError(''); setScanError(''); setSearch(''); setFocusRequest(undefined);
    setFavorites(scope ? loadSaved(`ae:favorites:${scope}`) : []); setRecent(scope ? loadSaved(`ae:recent:${scope}`) : []);
    if (!scope) return;
    let alive = true;
    request<IndexStatus>('/status', scope).then(value => { if (alive) setStatus(value); }).catch(error => { if (alive) setBootstrapError(errorMessage(error)); });
    const stream = new EventSource(`/api/events?scope=${encodeURIComponent(scope)}`);
    stream.addEventListener?.('architecture-model', event => { try { const value = JSON.parse((event as MessageEvent).data) as { scopeId: string; modelRevision: string }; if (alive && value.scopeId === scope) { setModelRefresh(value.modelRevision); bridge.invalidate(scope, 'architecture', value.modelRevision); } } catch { /* malformed architecture refresh */ } });
    stream.addEventListener?.('semantic-model', event => { try { const value = JSON.parse((event as MessageEvent).data) as { scopeId: string; overlayRevision: string }; if (alive && value.scopeId === scope) { setSemanticRefresh(value.overlayRevision); bridge.invalidate(scope, 'semantic', value.overlayRevision); } } catch { /* malformed semantic refresh */ } });
    stream.onopen = () => { if (alive) setConnectionLost(false); };
    stream.onmessage = event => { try { const value = JSON.parse(event.data) as IndexStatus; if (alive && value.scopeId === scope) { setStatus(value); setConnectionLost(false); bridge.invalidate(scope, 'index', value.revision); } } catch { /* ignore malformed event; HTTP state remains available */ } };
    stream.onerror = () => { if (alive) setConnectionLost(true); };
    return () => { alive = false; stream.close(); };
  }, [scope]);

  useEffect(() => { if (scope && refreshToken > 0) request<IndexStatus>('/status', scope).then(setStatus).catch(error => setBootstrapError(errorMessage(error))); }, [scope, refreshToken]);

  useEffect(() => {
    if (!scope || !status || status.state === 'empty' || (status.state === 'analyzing' && !status.revision)) return;
    let alive = true;
    request<Summary>('/summary', scope).then(value => { if (!alive) return; setSummary(value); setBootstrapError(''); }).catch(error => { if (alive && status.state !== 'analyzing') setGraphError(errorMessage(error)); });
    return () => { alive = false; };
  }, [scope, status?.revision, status?.state, refreshToken]);

  useEffect(() => {
    if (!scope || !summary) return;
    let alive = true;
    request<GraphResult>(graphPath({ view: 'architecture', direction: 'both', depth: 1, limit: 80, kinds: '', confidence: '' }), scope).then(value => { if (alive) setRootNodes(value.nodes); }).catch(() => { /* main graph displays the concrete error */ });
    return () => { alive = false; };
  }, [scope, summary?.metadata.revision]);

  useEffect(() => {
    if (primaryPage !== 'code' || codeNavigationPending || !scope || !summary || (location.view !== 'architecture' && !location.focus)) return;
    let alive = true; const navigation = navigationSequence.current; setGraphLoading(true); setGraphError('');
    request<GraphResult>(graphPath({ rootId: location.view === 'architecture' ? location.root?.id : location.focus?.id, view: location.view, direction, depth, limit, kinds: relationKind, confidence }), scope)
      .then(value => { if (alive && navigationSequence.current === navigation && scopeRef.current === scope) { setGraph(value); setGraphView(location.view); } }).catch(error => { if (alive && navigationSequence.current === navigation) setGraphError(errorMessage(error)); }).finally(() => { if (alive && navigationSequence.current === navigation) setGraphLoading(false); });
    return () => { alive = false; };
  }, [scope, summary?.metadata.revision, location, direction, depth, limit, relationKind, confidence, refreshToken, primaryPage, codeNavigationPending]);

  const selectNode = useCallback((node: ArchitectureNode) => {
    if (selectedIdRef.current !== node.id || detailRequestRef.current.scopeId !== scope) {
      resetSelection(node);
    } else setSelected(node);
    setInspectorOpen(true);
    setRecent(current => { const next = [{ id: node.id, label: node.label, kind: node.kind }, ...current.filter(n => n.id !== node.id)].slice(0, 8); saveNodes(`ae:recent:${scope}`, next); return next; });
  }, [scope, resetSelection]);

  useEffect(() => {
    if (!scope || !selected) return;
    let alive = true; setDetailLoading(true); setDetailError(''); setDetails(undefined); setEvidenceId(''); setSource(undefined); setSourceError('');
    sourceSequenceRef.current++; evidenceIdRef.current = '';
    const stamp: SelectionRequest = { scopeId: scope, nodeId: selected.id, sequence: ++detailSequenceRef.current };
    detailRequestRef.current = stamp;
    const isCurrent = () => alive && scopeRef.current === stamp.scopeId && selectedIdRef.current === stamp.nodeId && isCurrentSelectionRequest(stamp, detailRequestRef.current);
    request<NodeDetails>(`/nodes/${encodeURIComponent(selected.id)}`, scope).then(value => {
      if (!isCurrent()) return;
      if (value.node.id !== stamp.nodeId) throw new Error('返回的符号与当前选择不一致，请重新读取索引。');
      setDetails(value);
      setSelected(current => scopeRef.current === stamp.scopeId ? applySelectionResponse(current, value.node, stamp, detailRequestRef.current) : current);
      const pending = pendingPresentationRef.current;
      const presentation = pending?.scopeId === scope && pending.nodeId === selected.id ? pending.presentation : undefined;
      const relation = presentation?.activeRelation;
      const currentRelation = relation && [...value.incoming, ...value.outgoing].find(edge => edge.id === relation.id);
      const validRelation = relation && (relation.source === selected.id || relation.target === selected.id) ? currentRelation || (presentation?.revision === value.revision ? relation : undefined) : undefined;
      const preferred = presentation?.evidenceId;
      const nextEvidence = preferred && (value.evidence.some(item => item.id === preferred) || validRelation?.evidenceIds.includes(preferred)) ? preferred : validRelation?.evidenceIds[0] || value.evidence[0]?.id || '';
      evidenceIdRef.current = nextEvidence; setEvidenceId(nextEvidence); setActiveRelation(validRelation);
      pendingPresentationRef.current = undefined;
    }).catch(error => { if (isCurrent()) setDetailError(errorMessage(error)); }).finally(() => { if (isCurrent()) setDetailLoading(false); });
    return () => { alive = false; };
  }, [scope, selected?.id, selectionEpoch, summary?.metadata.revision]);

  useEffect(() => {
    if (!scope || !selected || !details || details.node.id !== selected.id || !evidenceId) return;
    const nodeId = selected.id; const sequence = ++sourceSequenceRef.current;
    let alive = true; setSource(undefined); setSourceLoading(true); setSourceError('');
    const isCurrent = () => alive && scopeRef.current === scope && selectedIdRef.current === nodeId && evidenceIdRef.current === evidenceId && sourceSequenceRef.current === sequence;
    request<EvidenceContent>(`/evidence/${encodeURIComponent(evidenceId)}`, scope).then(value => { if (!isCurrent()) return; if (value.evidence.id !== evidenceId) throw new Error('返回的源码证据与当前选择不一致。'); if (value.revision !== details.revision) throw new Error('索引版本已变化，等待符号详情同步后重新读取证据。'); setSource(value); }).catch(error => { if (isCurrent()) { setSource(undefined); setSourceError(errorMessage(error)); } }).finally(() => { if (isCurrent()) setSourceLoading(false); });
    return () => { alive = false; };
  }, [scope, selected?.id, evidenceId, sourceEpoch, details?.revision, summary?.metadata.revision]);

  useEffect(() => {
    setOwners(undefined); setOwnershipError('');
    if (!scope || !selected || primaryPage !== 'code') return;
    let alive = true;
    request<OwnershipResult>(`/architecture/ownership?nodeId=${encodeURIComponent(selected.id)}`, scope).then(value => { if (!alive) return; if (value.nodeId !== selected.id || value.metadata.scopeId !== scope || (summary && value.metadata.sourceRevision !== summary.metadata.revision)) throw new Error('归属与当前源码版本不一致，请等待索引同步。'); setOwners(value); }).catch(error => { if (alive) setOwnershipError(errorMessage(error)); });
    return () => { alive = false; };
  }, [scope, selected?.id, primaryPage, summary?.metadata.revision, modelRefresh]);

  useEffect(() => {
    setSemanticMatches(undefined); setSemanticReverseError('');
    if (!scope || !selected || primaryPage !== 'code') return;
    let alive = true;
    const query = new URLSearchParams({ nodeId: selected.id, ...(activeRelation ? { edgeId: activeRelation.id } : {}) });
    request<SemanticReverseResult>(`/semantics/reverse?${query}`, scope).then(value => {
      if (!alive) return;
      if (value.metadata.scopeId !== scope || (summary && value.metadata.sourceRevision !== summary.metadata.revision)) throw new Error('解释与代码快照不一致，请等待同步。');
      setSemanticMatches(value);
    }).catch(error => { if (alive) setSemanticReverseError(errorMessage(error)); });
    return () => { alive = false; };
  }, [scope, selected?.id, activeRelation?.id, primaryPage, summary?.metadata.revision, modelRefresh, semanticRefresh]);

  useEffect(() => {
    if (!scope || !search.trim()) { setSearchResults([]); setSearchLoading(false); setSearchError(''); return; }
    let alive = true; setSearchLoading(true); setSearchError('');
    const timer = window.setTimeout(() => {
      request<{ nodes: ArchitectureNode[] }>(`/search?q=${encodeURIComponent(search.trim())}&limit=30`, scope).then(value => { if (alive) { setSearchResults(value.nodes); setSearchIndex(0); } }).catch(error => { if (alive) setSearchError(errorMessage(error)); }).finally(() => { if (alive) setSearchLoading(false); });
    }, 180);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [search, scope]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus(); setSearchOpen(true); }
      if (event.key === 'Escape') { setSearchOpen(false); setFiltersOpen(false); }
    };
    window.addEventListener('keydown', keyDown); return () => window.removeEventListener('keydown', keyDown);
  }, []);

  useEffect(() => {
    const pointerDown = (event: PointerEvent) => { if (!searchContainerRef.current?.contains(event.target as HTMLElement)) setSearchOpen(false); };
    document.addEventListener('pointerdown', pointerDown);
    return () => document.removeEventListener('pointerdown', pointerDown);
  }, []);

  useEffect(() => { if (searchOpen) document.getElementById(`search-result-${searchIndex}`)?.scrollIntoView({ block: 'nearest' }); }, [searchIndex, searchOpen]);

  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 4500); return () => window.clearTimeout(timer); }, [notice]);

  const captureHistory = (): HistoryEntry => ({ location, selected, evidenceId, activeRelation, bottomTab, revision: summary?.metadata.revision, direction, depth, confidence, relationKind, limit });
  const pushHistory = (entry: HistoryEntry) => setHistory(current => [...current, entry].slice(-40));
  const navigate = (next: Location, node = next.focus ?? next.root, previous = captureHistory()) => {
    navigationSequence.current++; pushHistory(previous); setGraph(EMPTY_GRAPH); setGraphLoading(true); setFocusRequest(undefined);
    if (node) selectNode(node); else resetSelection();
    setLocation({ ...next }); setLimit(80); setRelationKind('');
  };
  const goBack = () => {
    const previous = history.at(-1); if (!previous) return;
    navigationSequence.current++; setGraph(EMPTY_GRAPH); setGraphLoading(true); setFocusRequest(undefined);
    resetSelection(previous.selected, previous); setLocation({ ...previous.location });
    setDirection(previous.direction); setDepth(previous.depth); setConfidence(previous.confidence); setRelationKind(previous.relationKind); setLimit(previous.limit); setHistory(current => current.slice(0, -1));
  };
  const enterNode = (node: ArchitectureNode, previous = captureHistory()) => { if (expandableKinds.has(node.kind)) navigate({ view: 'architecture', root: node }, node, previous); else navigate({ view: ['field', 'property', 'parameter', 'data'].includes(node.kind) ? 'data' : 'calls', focus: node }, node, previous); };
  const switchView = (view: View) => { if (view === location.view) return; if (view !== 'architecture' && !selected) { setNotice('请先选择一个节点，再探索其关系。'); return; } navigate(view === 'architecture' ? { view, root: location.root } : { ...location, view, focus: selected }, selected); };
  const locateNode = (node: ArchitectureNode) => {
    setCodeNavigationPending(false);
    if (primaryPage !== 'code') { setReturnPage(primaryPage); setPrimaryPage('code'); }
    const previous = captureHistory(); const navigationAtSearch = ++navigationSequence.current;
    selectNode(node); setSearchOpen(false); setSearch(''); setFocusRequest({ id: node.id, token: ++focusSequence.current });
    if (graph.nodes.some(n => n.id === node.id)) { if (previous.selected?.id !== node.id) pushHistory(previous); return; }
    setGraph(EMPTY_GRAPH); setGraphLoading(true);
    // A symbol's parent is the smallest architecture projection that contains it.
    if (node.parentId) { const requestedScope = scope; request<NodeDetails>(`/nodes/${encodeURIComponent(node.parentId)}`, scope).then(value => { if (scopeRef.current === requestedScope && selectedIdRef.current === node.id && navigationSequence.current === navigationAtSearch) { navigate({ view: 'architecture', root: value.node }, node, previous); setFocusRequest({ id: node.id, token: ++focusSequence.current }); } }).catch(error => { if (scopeRef.current === requestedScope && selectedIdRef.current === node.id && navigationSequence.current === navigationAtSearch) { setGraphError(errorMessage(error)); setGraphLoading(false); } }); }
    else navigate({ view: 'architecture' }, node, previous);
  };
  const openArchitectureCode = (intent: OpenCodeRequest, expectedRevision?: string) => {
    const requestedScope = scope; const previous = captureHistory(); const sequence = ++navigationSequence.current;
    if (primaryPage !== 'code') setReturnPage(primaryPage);
    setPrimaryPage('code'); setCodeNavigationPending(true); resetSelection(); setGraph(EMPTY_GRAPH); setGraphLoading(true); setGraphError('');
    request<NodeDetails>(`/nodes/${encodeURIComponent(intent.nodeId)}`, scope).then(value => {
      if (scopeRef.current !== requestedScope || navigationSequence.current !== sequence) return;
      if (expectedRevision && value.revision !== expectedRevision) { setCodeNavigationPending(false); setGraphLoading(false); setGraphError('源码索引已更新，原演示证据不再匹配。请重新分析后定位。'); return; }
      setCodeNavigationPending(false); enterNode(value.node, previous);
      if (intent.evidenceId && value.evidence.some(item => item.id === intent.evidenceId)) resetSelection(value.node, { evidenceId: intent.evidenceId, bottomTab: 'source', revision: value.revision });
    }).catch(error => { if (scopeRef.current === requestedScope && navigationSequence.current === sequence) { setCodeNavigationPending(false); setNotice(errorMessage(error)); } });
  };
  const changePrimaryPage = (page: PrimaryPage) => {
    setControlPresentation(undefined);
    navigationSequence.current++; setCodeNavigationPending(false); setPrimaryPage(page); setSearchOpen(false);
    if (page !== 'code' && page !== 'delivery') setArchitectureRoute(current => ({ ...current, perspective: page === 'overview' ? 'business' : page === 'technical' ? 'technical' : 'flows', rootId: undefined }));
  };
  const openOwner = (systemId: string, moduleId?: string) => { navigationSequence.current++; setArchitectureRoute({ perspective: 'business', rootId: moduleId || systemId }); setPrimaryPage('overview'); };
  const changeArchitectureRoute = (next: ArchitectureRoute) => { navigationSequence.current++; setArchitectureRoute(next); if (next.perspective === 'flows') { if (!(primaryPage === 'flows' && legacyFlows)) setLegacyFlows(false); setSemanticLocation(current => next.flowId && next.flowId !== current.flowId ? { flowId: next.flowId } : current); } setPrimaryPage(next.perspective === 'technical' ? 'technical' : next.perspective === 'flows' ? 'flows' : 'overview'); };
  const openSemanticMatch = (flowId: string, nodeId?: string, hasEdge = false) => { navigationSequence.current++; setLegacyFlows(false); setSemanticLocation({ flowId, mode: 'compare', level: 'detailed', nodeId, codeNodeId: selected?.id, codeEdgeId: hasEdge ? activeRelation?.id : undefined }); setPrimaryPage('flows'); };
  const openSaved = (saved: SavedNode) => { const requestedScope = scope; const navigationAtOpen = ++navigationSequence.current; request<NodeDetails>(`/nodes/${encodeURIComponent(saved.id)}`, scope).then(value => { if (scopeRef.current === requestedScope && navigationSequence.current === navigationAtOpen) locateNode(value.node); }).catch(() => { if (scopeRef.current === requestedScope && navigationSequence.current === navigationAtOpen) setNotice('此节点已不存在于当前索引。可重新搜索，或取消收藏。'); }); };
  const toggleFavorite = () => { if (!selectedSaved) return; const next = favorite ? favorites.filter(n => n.id !== selectedSaved.id) : [...favorites, selectedSaved]; setFavorites(next); saveNodes(`ae:favorites:${scope}`, next); };
  const scan = async (full = true) => { if (!scope || scanPending) return; setScanPending(true); setScanError(''); try { await request('/scan', undefined, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope, full }) }); setStatus(current => current ? { ...current, state: 'analyzing', message: '已提交扫描请求' } : current); setNotice(full ? '已提交完整扫描。旧索引会保留到新索引验证通过。' : '已提交索引校验。'); } catch (error) { setScanError(errorMessage(error)); } finally { setScanPending(false); } };
  const activateEvidence = (id: string) => { sourceSequenceRef.current++; evidenceIdRef.current = id; setSource(undefined); setSourceError(''); setEvidenceId(id); setSourceEpoch(value => value + 1); setSourceLoading(!!id); setBottomOpen(true); setBottomTab('source'); };
  const showEvidence = (evidence: Evidence) => { setActiveRelation(undefined); activateEvidence(evidence.id); };
  const showRelation = (edge: ArchitectureEdge) => {
    const owner = selected && (edge.source === selected.id || edge.target === selected.id) ? selected : graph.nodes.find(node => node.id === edge.source);
    if (!owner) return;
    if (owner.id !== selectedIdRef.current) { selectNode(owner); pendingPresentationRef.current = { scopeId: scope, nodeId: owner.id, presentation: { evidenceId: edge.evidenceIds[0] || '', activeRelation: edge, bottomTab: 'source', revision: graph.revision } }; }
    else { setActiveRelation(edge); activateEvidence(edge.evidenceIds[0] || ''); }
    setBottomOpen(true); setBottomTab(edge.evidenceIds.length ? 'source' : 'relations');
  };
  const resize = (event: ReactPointerEvent, kind: 'left' | 'right' | 'bottom') => {
    event.preventDefault(); const start = kind === 'bottom' ? event.clientY : event.clientX; const initial = kind === 'left' ? leftWidth : kind === 'right' ? rightWidth : bottomHeight;
    const move = (e: PointerEvent) => { const delta = (kind === 'bottom' ? e.clientY : e.clientX) - start; const value = initial + delta * (kind === 'left' ? 1 : -1); if (kind === 'left') setLeftWidth(Math.max(190, Math.min(370, value))); else if (kind === 'right') setRightWidth(Math.max(270, Math.min(480, value))); else setBottomHeight(Math.max(130, Math.min(window.innerHeight * .55, value))); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.style.cursor = ''; document.body.style.userSelect = ''; };
    document.body.style.cursor = kind === 'bottom' ? 'row-resize' : 'col-resize'; document.body.style.userSelect = 'none'; window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const related = new Map(details?.relatedNodes.map(n => [n.id, n]));
  const relationships = details ? [...details.incoming, ...details.outgoing] : [];
  const appStyle = { '--sidebar-width': `${leftWidth}px`, '--inspector-width': `${rightWidth}px`, '--bottom-height': `${bottomHeight}px` } as CSSProperties;
  const state = status?.state || 'empty';
  const branch = summary?.metadata.gitBranch || currentWorktree?.branch || '非 Git 项目';
  const revision = summary?.metadata.revision;

  const userInteraction = (target: EventTarget | null, kind: 'pointer' | 'click' | 'key' | 'wheel' | 'input' | 'drag') => {
    if (target instanceof Element && target.closest('[data-control-automatic="true"]')) return;
    const identity = target instanceof Element ? target.closest('button,input,textarea,select,a') || target.closest('.canvas-surface,.semantic-canvas') || target : target;
    const now = Date.now(), previous = gesture.current, same = previous.target === identity;
    if (same && ((kind === 'click' && previous.kind === 'pointer' && now - previous.at < 500) || (kind === 'input' && previous.kind === 'key' && now - previous.at < 80) || ((kind === 'wheel' || kind === 'drag') && previous.kind === kind && now - previous.at < 120))) return;
    gesture.current = { at: now, kind, target: identity }; bridge.markUserAction();
  };
  const controlledPage = controlPresentation && controlPresentation.resolved.snapshot.scopeId === scope && (controlPresentation.resolved.presentation.targetView === 'flow' ? 'flows' : controlPresentation.resolved.presentation.targetView === 'systems' ? 'overview' : controlPresentation.resolved.presentation.targetView === 'technical' ? 'technical' : 'code') === primaryPage;
  return <div className={`explorer-app has-primary-navigation ${sidebarOpen ? '' : 'sidebar-hidden'} ${inspectorOpen ? '' : 'inspector-hidden'}`} style={appStyle} onPointerDownCapture={event => userInteraction(event.target, 'pointer')} onPointerMoveCapture={event => { if (event.buttons) userInteraction(event.target, 'drag'); }} onClickCapture={event => userInteraction(event.target, 'click')} onKeyDownCapture={event => { if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) userInteraction(event.target, 'key'); }} onInputCapture={event => userInteraction(event.target, 'input')} onWheelCapture={event => userInteraction(event.target, 'wheel')}>
    <header className="topbar">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); changePrimaryPage('overview'); }} aria-label="Architecture Explorer 首页"><span className="brand-mark"><Layers3 size={21} strokeWidth={1.7} /></span><span>Architecture<span className="brand-secondary">Explorer</span></span></a>
      <div className="topbar-divider" />
      <div className="project-picker"><Folder size={14} /><select aria-label="选择项目" value={projectId} onChange={e => setProjectId(e.target.value)} disabled={!projects.length}>{!projects.length && <option>暂无项目</option>}{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><ChevronDown size={12} /></div>
      <div className="worktree-picker"><GitBranch size={13} /><select aria-label="选择 Worktree" value={worktreeId} onChange={e => setWorktreeId(e.target.value)} disabled={!worktrees.some(w => w.authorized)}>{!worktreeId && <option value="">无授权工作区</option>}{worktrees.map(w => <option key={w.id} value={w.id} disabled={!w.authorized}>{w.branch || w.id}{!w.authorized ? ' · 未授权' : ''}</option>)}</select><ChevronDown size={11} /></div>
      <div className="global-search" ref={searchContainerRef}><Search size={14} /><input ref={searchRef} value={search} aria-label="搜索代码符号或文件" role="combobox" aria-expanded={searchOpen && !!search} aria-controls="search-results" aria-activedescendant={searchOpen && searchResults.length ? `search-result-${searchIndex}` : undefined} placeholder="搜索符号、文件或路径…" onChange={e => { setSearch(e.target.value); setSearchOpen(true); }} onFocus={() => setSearchOpen(true)} onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); setSearchIndex(i => Math.min(i + 1, searchResults.length - 1)); } if (e.key === 'ArrowUp') { e.preventDefault(); setSearchIndex(i => Math.max(0, i - 1)); } if (e.key === 'Enter' && searchResults[searchIndex]) locateNode(searchResults[searchIndex]); }} /><kbd>Ctrl K</kbd>
        {searchOpen && search && <div id="search-results" className="search-results" role="listbox"><div className="search-result-heading">在当前工作区中搜索<button aria-label="关闭搜索" onClick={() => setSearchOpen(false)}><X size={13} /></button></div>{searchLoading ? <div className="search-empty"><Loader2 size={14} className="spin" />正在搜索真实索引…</div> : searchError ? <div className="search-empty warning-text">{searchError}</div> : searchResults.length ? searchResults.map((node, index) => <button id={`search-result-${index}`} role="option" aria-selected={index === searchIndex} className={index === searchIndex ? 'active' : ''} key={node.id} onClick={() => locateNode(node)} onMouseEnter={() => setSearchIndex(index)}><FileCode2 size={16} /><span><strong>{node.label}</strong><small>{node.filePath || node.qualifiedName}</small></span><em>{nodeLabels[node.kind]}</em></button>) : <div className="search-empty">没有匹配的符号。尝试文件名或更短的关键词。</div>}<div className="search-result-footer"><span>↑ ↓ 选择</span><span>Enter 定位</span><span>Esc 关闭</span></div></div>}
      </div>
      <button className={`sync-status state-${state}`} title={`${status?.message || '等待项目索引'}${connectionLost ? ' · 实时连接中断，正在重连' : ''}`} onClick={() => { changePrimaryPage('code'); setBottomOpen(true); setBottomTab('warnings'); }}><StatusIcon state={state} /><span>{statusLabels[state]}</span>{diagnostics.length > 0 && <i>{diagnostics.length}</i>}</button>
      <button className="icon-button scan-button" title="重新完整扫描当前工作区" aria-label="重新完整扫描" disabled={!scope || scanPending || state === 'analyzing'} onClick={() => void scan(true)}><RefreshCw size={15} className={scanPending || state === 'analyzing' ? 'spin' : ''} /></button>
    </header>

    <LinkBar controller={bridge} highlightsEnabled={controlHighlights && !!controlledPage} staleMessage={controlStale} onShowProgress={() => setProgressOpenToken(value => value + 1)} />
    <FloatingProgress userRevision={bridge.state.userRevision} activities={bridge.activities} command={bridge.command?.resolved.snapshot.scopeId === scope ? bridge.command : undefined} receipt={bridge.receipt} connected={bridge.connected} allowControl={bridge.state.allowControl} scopeId={scope} staleMessage={controlStale || (bridge.command?.resolved.snapshot.scopeId === scope && revision && bridge.command.resolved.snapshot.indexSnapshotId !== revision ? '当前源码索引已更新，请重新分析后查看实现。' : '')} error={bridge.error} openToken={progressOpenToken} onReconnect={bridge.reconnect} onLeave={() => void bridge.leave()} onOpenCode={(nodeId, evidenceId) => {
      const command = bridge.command;
      if (!command || !bridge.state.allowControl || !bridge.connected || !revision || command.resolved.snapshot.indexSnapshotId !== revision || !presentationIsCurrent(command, bridge.receipt, scope, controlStale, Date.now(), bridge.activities, bridge.state.userRevision)) { setNotice('演示已暂停或证据版本已变化，请重新分析后查看实现。'); return; }
      const nodes = command.resolved.semantic?.flow?.codeNodes || command.resolved.codeGraph?.nodes || [];
      const node = nodes.find(item => item.id === nodeId);
      if (!node || (evidenceId && !node.evidenceIds.includes(evidenceId))) { setNotice('该源码证据不属于当前步骤的实现，已停止定位。'); return; }
      bridge.markUserAction(); setControlPresentation(undefined); openArchitectureCode({ nodeId, evidenceId, mode: 'symbol' }, command.resolved.snapshot.indexSnapshotId);
    }} />

    <nav className="primary-navigation" aria-label="主导航">{([{id:'overview',label:'系统总览',icon:Layers3},{id:'technical',label:'技术架构',icon:LayoutGrid},{id:'flows',label:'业务流程',icon:Workflow},{id:'code',label:'代码地图',icon:Code2},{id:'delivery',label:'开发交付流程',icon:GitBranch}] as const).map(item => <button key={item.id} className={primaryPage === item.id ? 'active' : ''} aria-current={primaryPage === item.id ? 'page' : undefined} onClick={() => changePrimaryPage(item.id)}><item.icon size={14}/>{item.label}</button>)}<span className="navigation-level-note">{primaryPage === 'delivery' ? '人工维护说明 · GitHub 跳转' : primaryPage === 'code' ? 'L3 组件 · L4 方法与源码' : primaryPage === 'flows' ? '解释 · 实现 · 源码证据' : 'L1 系统 · L2 模块'}</span></nav>
    {primaryPage === 'flows' && !controlledPage && <div className="flow-origin-toggle"><span>同一源码快照 · 解释与实现双向关联</span><button aria-pressed={legacyFlows} onClick={() => { if (!legacyFlows) setArchitectureRoute(current => ({ ...current, perspective: 'flows', flowId: semanticLocation.flowId || current.flowId })); setLegacyFlows(current => !current); }}>{legacyFlows ? '返回双层语义图' : '原始流程证据'}</button></div>}
    {controlledPage && controlPresentation ? <Suspense fallback={<StateCard title="正在准备分析展示" description="校验同一快照中的图、焦点与源码证据。" busy />}><IntegrationWorkspace key={`${scope}:${controlPresentation.resolved.presentation.targetView}:${controlPresentation.resolved.presentation.flowId || ""}`} command={controlPresentation} highlightsEnabled={controlHighlights} staleMessage={controlStale} rootPath={summary?.metadata.rootPath || currentWorktree?.path || ''} onPresented={(id, actual) => void bridge.presented(id, actual)} onFailed={bridge.failed} onOpenArchitecture={rootId => { setControlPresentation(undefined); changeArchitectureRoute({ perspective: "business", rootId }); }} onReturn={() => setControlPresentation(undefined)} onOpenCode={(nodeId, evidenceId) => { setControlPresentation(undefined); openArchitectureCode({ nodeId, evidenceId, mode: 'symbol' }); }} /></Suspense> : primaryPage === 'code' ? <div className="workbench">
      <aside className="sidebar" aria-label="项目导航">
        <div className="sidebar-heading"><span>项目浏览器</span><button className="icon-button" aria-label="收起导航" title="收起导航" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={15} /></button></div>
        <button className={`project-tree-root ${!location.root && location.view === 'architecture' ? 'active' : ''}`} onClick={() => navigate({ view: 'architecture' })}><span className="project-avatar"><Layers3 size={17} /></span><span><strong>{currentProject?.name || 'Architecture Explorer'}</strong><small>{summary ? `${summary.counts.files.toLocaleString()} 个文件 · ${summary.counts.nodes.toLocaleString()} 个实体` : '等待建立源码索引'}</small></span></button>
        <div className="sidebar-filter"><Search size={12} /><input aria-label="筛选系统树" value={treeFilter} onChange={e => setTreeFilter(e.target.value)} placeholder="筛选模块…" /></div>
        <nav className="tree-scroll"><div className="section-label">系统与模块<span>{rootNodes.length}</span></div>{rootNodes.filter(n => `${n.label} ${n.filePath}`.toLowerCase().includes(treeFilter.toLowerCase())).map(node => <TreeBranch key={`${scope}:${node.id}`} node={node} scope={scope} revision={revision} activeId={location.root?.id || selected?.id} openPath={details?.parents.map(parent => parent.id) || []} onEnter={enterNode} />)}{!rootNodes.length && <div className="sidebar-empty">{state === 'analyzing' ? '正在识别项目结构…' : '完成首次扫描后显示系统树。'}</div>}
          <div className="section-label section-space"><Bookmark size={12} />收藏<span>{favorites.length}</span></div>{favorites.map(node => <div className="saved-row" key={node.id}><button className="tree-item" onClick={() => openSaved(node)}><Bookmark size={13} /><span>{node.label}</span></button><button className="remove-saved" aria-label={`取消收藏 ${node.label}`} title="取消收藏" onClick={() => { const next = favorites.filter(n => n.id !== node.id); setFavorites(next); saveNodes(`ae:favorites:${scope}`, next); }}><X size={11} /></button></div>)}{!favorites.length && <div className="sidebar-empty">在节点详情中收藏关键入口。</div>}
          <div className="section-label section-space"><Clock3 size={12} />最近查看</div>{recent.map(node => <button className="tree-item recent-item" key={node.id} onClick={() => openSaved(node)}><span className={`tiny-node-dot kind-${node.kind}`} /><span>{node.label}</span></button>)}
        </nav>
        <div className="sidebar-foot"><ShieldCheck size={14} /><span>目标代码只读<span>源码证据来自当前工作区</span></span><span className="tiny-status-dot" /></div>
      </aside>
      <div className="resize-handle resize-left" role="separator" aria-label="调整导航宽度" aria-orientation="vertical" onPointerDown={e => resize(e, 'left')} />

      <main className="main-workspace">
        <div className="workspace-titlebar"><div className="breadcrumbs">{!sidebarOpen && <button className="icon-button" aria-label="展开导航" title="展开导航" onClick={() => setSidebarOpen(true)}><PanelLeftOpen size={15} /></button>}<button className="icon-button back-button" aria-label="返回上一视图" title="返回上一视图" onClick={goBack} disabled={!history.length}><ArrowLeft size={15} /></button><button onClick={() => navigate({ view: 'architecture' })}>{currentProject?.name || '项目'}</button><ChevronRight size={11} />{location.root ? <span title={location.root.qualifiedName}>{location.root.label}</span> : <span>系统总览</span>}{location.view !== 'architecture' && <><ChevronRight size={11} /><span className="breadcrumb-focus">{location.focus?.label}</span></>}</div><div className="workspace-actions">{returnPage && <button className="return-architecture" onClick={() => { navigationSequence.current++; setPrimaryPage(returnPage); }}><ArrowLeft size={13}/>{returnPage === 'delivery' ? '返回开发交付流程' : '返回系统架构'}</button>}<button className="icon-button" title="自动整理当前图布局" aria-label="自动布局" disabled={!graph.nodes.length} onClick={() => setLayoutToken(t => t + 1)}><LayoutGrid size={15} /></button><button className="icon-button" aria-label={bottomOpen ? '收起底部面板' : '展开底部面板'} title={bottomOpen ? '收起底部面板' : '展开底部面板'} onClick={() => setBottomOpen(v => !v)}>{bottomOpen ? <PanelBottomClose size={15} /> : <PanelBottomOpen size={15} />}</button><button className="icon-button" aria-label={inspectorOpen ? '收起节点详情' : '展开节点详情'} title={inspectorOpen ? '收起节点详情' : '展开节点详情'} onClick={() => setInspectorOpen(v => !v)}>{inspectorOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}</button></div></div>
        <div className="view-toolbar"><div className="view-tabs" role="tablist" aria-label="探索模式">{views.map(({ id, label, icon: Icon }) => <button role="tab" aria-selected={location.view === id} className={location.view === id ? 'active' : ''} key={id} onClick={() => switchView(id)} title={id !== 'architecture' && !selected ? '选择节点后探索' : label}><Icon size={14} />{label}</button>)}</div><button className={`filter-toggle ${filtersOpen ? 'active' : ''}`} aria-expanded={filtersOpen} onClick={() => setFiltersOpen(v => !v)}><SlidersHorizontal size={13} /><span>筛选</span>{(confidence || relationKind || direction !== 'both' || depth !== 1) && <i className="tiny-status-dot" />}</button></div>
        {(location.view === 'data' || location.view === 'impact') && <div className="view-scope-strip"><ShieldCheck size={12} /><span>{location.view === 'data' ? '静态读写与参数引用 · 不表示完整运行时数据流或执行顺序' : '潜在修改影响 · 边表示已发现的依赖，不能证明相关功能必然受影响'}</span></div>}{filtersOpen && <div className="filter-bar">{location.view !== 'architecture' && <><label>方向<select value={direction} onChange={e => setDirection(e.target.value)}><option value="both">上游与下游</option><option value="up">上游 / 调用者</option><option value="down">下游 / 被调用</option></select></label><label>深度<select value={depth} onChange={e => setDepth(Number(e.target.value))}>{[1, 2, 3, 4, 5].map(n => <option value={n} key={n}>{n} 层</option>)}</select></label></>}<label>可信状态<select value={confidence} onChange={e => setConfidence(e.target.value)}><option value="">全部状态</option>{Object.entries(confidenceLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>关系<select value={relationKind} onChange={e => setRelationKind(e.target.value)}><option value="">全部关系</option>{Object.entries(edgeLabels).filter(([key]) => key !== 'contains').map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><button className="text-button" onClick={() => { setDirection('both'); setDepth(1); setConfidence(''); setRelationKind(''); }}>重置</button></div>}
        {(connectionLost || state === 'stale' || state === 'failed' || scanError) && <div className="inline-notice"><TriangleAlert size={13} /><span>{scanError || (state === 'failed' ? `分析失败，保留最近有效索引。${status?.message || ''}` : state === 'stale' ? '源码已变化，当前显示最近一次有效索引。' : '实时连接中断，正在重新连接。')}</span><details className="inline-error-details"><summary>详情</summary><p>{scanError || status?.message || '服务器实时连接中断。页面会自动重连；也可手动刷新状态。'}</p></details><button onClick={() => setRefreshToken(t => t + 1)}>刷新</button></div>}
        <div className="canvas-region" aria-label="交互式架构地图" data-context-node-id={location.view === 'architecture' ? location.root?.id || summary?.rootId : location.focus?.id} data-selected-node-id={selected?.id || ''} data-view={location.view}>
          {bootstrapLoading ? <StateCard title="正在连接工作区" description="读取已配置的项目及授权工作区。" busy /> : bootstrapError ? <StateCard title="无法连接项目" description={bootstrapError} action="重新连接" onAction={() => setRefreshToken(t => t + 1)} /> : !projects.length ? <StateCard title="添加你的第一个项目" description="在工具的 config/local.json 中配置项目目录和扫描范围，然后重启本地服务。浏览器不能读取任意本地目录。" /> : !scope ? <StateCard title="尚无授权工作区" description="在项目配置中明确授权要分析的 Worktree；选择工作区后，各分支会使用独立索引。" /> : !summary ? <StateCard title={state === 'analyzing' ? '正在建立项目地图' : state === 'failed' ? '首次扫描未能完成' : '从真实源码开始'} description={state === 'analyzing' ? status?.progress || status?.message || '正在解析源码，首次索引完成后会自动呈现架构。' : status?.message || '扫描项目，建立可追溯的实体、依赖与源码证据。扫描只读访问授权目录。'} busy={state === 'analyzing'} action={state === 'analyzing' ? undefined : '开始完整扫描'} onAction={() => void scan(true)} /> : graphError ? <StateCard title="图数据加载失败" description={graphError} action="重新加载" onAction={() => setRefreshToken(t => t + 1)} /> : graphLoading && !graph.nodes.length ? <StateCard title="正在读取架构" description="整理当前层级的实体与已验证关系。" busy /> : !graph.nodes.length ? <StateCard title="当前范围没有可展示的节点" description={confidence || relationKind ? '尝试放宽关系类型或可信状态筛选。' : location.view === 'architecture' ? '该节点没有已索引的下一层实体。可以返回上层或切换关系视图。' : '当前分析器未发现此范围内可证明的关系；这不代表运行时不存在依赖。'} action={history.length ? '返回上一视图' : undefined} onAction={goBack} /> : <Suspense fallback={<StateCard title="正在准备交互画布" description="载入图形引擎，所有关系来自当前真实索引。" busy />}><GraphCanvas graph={graph} selectedId={selected?.id} onSelect={selectNode} onEnter={enterNode} onRelation={showRelation} layoutToken={layoutToken} focusRequest={focusRequest} onFocusHandled={token => setFocusRequest(current => current?.token === token ? undefined : current)} view={graphView} /></Suspense>}
          {graphLoading && graph.nodes.length > 0 && <div className="graph-loading-pill"><Loader2 size={12} className="spin" />正在更新视图</div>}
          {graph.truncated && !graphLoading && <div className="truncated-notice"><Info size={13} /><span>当前展示 {graph.nodes.length} 个节点，结果已按预算截断。</span>{limit < 200 && <button onClick={() => setLimit(n => Math.min(200, n + 80))}>再加载 {Math.min(80, 200 - limit)} 个</button>}</div>}
        </div>
        {bottomOpen && <><div className="resize-handle resize-bottom" role="separator" aria-label="调整证据面板高度" aria-orientation="horizontal" onPointerDown={e => resize(e, 'bottom')} /><section className="bottom-panel" aria-label="源码与分析证据"><div className="bottom-tabs"><button className={bottomTab === 'source' ? 'active' : ''} onClick={() => setBottomTab('source')}><Code2 size={13} />源码证据</button><button className={bottomTab === 'relations' ? 'active' : ''} onClick={() => setBottomTab('relations')}><GitFork size={13} />关系详情{relationships.length > 0 && <span>{relationships.length}</span>}</button><button className={bottomTab === 'warnings' ? 'active' : ''} onClick={() => setBottomTab('warnings')}><TriangleAlert size={13} />扫描与限制{diagnostics.length > 0 && <span>{diagnostics.length}</span>}</button><div className="bottom-tab-spacer" /><span className="read-only-label"><ShieldCheck size={11} />只读</span><button className="icon-button" aria-label="收起证据面板" title="收起证据面板" onClick={() => setBottomOpen(false)}><ChevronDown size={14} /></button></div>
          <div className="bottom-content">{activeRelation && <div className="relation-context"><div><span className="relationship-kind">{edgeLabels[activeRelation.kind]}</span><span className={`confidence-badge ${activeRelation.confidence}`}>{confidenceLabels[activeRelation.confidence]}</span><strong>{activeRelation.rule}</strong><button aria-label="关闭当前关系说明" onClick={() => setActiveRelation(undefined)}><X size={12} /></button></div>{activeRelation.condition && <p>分支条件：{activeRelation.condition}</p>}{activeRelation.dispatch && <p>分发方式：{activeRelation.dispatch}</p>}{activeRelation.limitations?.map((text, index) => <p key={index}>限制：{text}</p>)}</div>}{bottomTab === 'source' ? sourceLoading ? <div className="panel-empty"><Loader2 size={15} className="spin" />读取源码证据…</div> : sourceError ? <div className="panel-empty warning-text">{sourceError}</div> : source ? <SourcePreview source={source} rootPath={summary?.metadata.rootPath || ''} nodeId={selected?.id} /> : <div className="panel-empty"><FileCode2 size={21} /><span>选择节点或关系，查看真实源码及分析规则。</span></div> : bottomTab === 'relations' ? <div className="relation-table">{relationships.length ? relationships.map(edge => <button className="relation-table-row" key={edge.id} onClick={() => showRelation(edge)}><span className="relationship-kind">{edgeLabels[edge.kind]}</span><span>{edge.source === selected?.id ? selected?.label : related.get(edge.source)?.label || edge.source}</span><ArrowRight size={12} /><span>{edge.target === selected?.id ? selected?.label : related.get(edge.target)?.label || edge.target}</span><span className={`confidence-badge ${edge.confidence}`}>{confidenceLabels[edge.confidence]}</span><small>{edge.condition || edge.rule}</small><FileCode2 size={12} /></button>) : <div className="panel-empty">选择有关系的节点查看详情。未确认的关系不会被补造。</div>}</div> : <div className="diagnostics-panel"><div className="analysis-scope-note"><Info size={15} /><div><strong>分析范围与可信边界</strong><p>{summary?.metadata.coverage.limitations.join('；') || '静态关系基于源码分析。动态分发、反射及跨语言协议仅在有明确证据时建立关系。字段读写不等同于完整运行时数据流。'}</p></div></div>{status?.message && <div className="diagnostic-row"><Activity size={13} /><span>{status.message}</span></div>}{diagnostics.slice(0, 100).map(d => <div className={`diagnostic-row severity-${d.severity}`} key={d.id}><TriangleAlert size={13} /><span><strong>{d.code}</strong> {d.message}</span><small>{d.filePath}{d.line ? `:${d.line}` : ''}</small></div>)}{diagnostics.length > 100 && <div className="diagnostic-row">为保持页面响应，当前展示前 100 条诊断；完整诊断见 /api/diagnostics。</div>}{!diagnostics.length && summary && <div className="diagnostic-row success-text"><Check size={13} />本次扫描没有额外诊断；分析范围限制仍适用。</div>}</div>}</div></section></>}
      </main>

      <div className="resize-handle resize-right" role="separator" aria-label="调整节点详情宽度" aria-orientation="vertical" onPointerDown={e => resize(e, 'right')} />
      <aside className="inspector" aria-label="节点详情" data-node-id={selected?.id || ''}><div className="inspector-heading"><span>节点详情</span><div>{selected && <button className={`icon-button ${favorite ? 'favorite-active' : ''}`} title={favorite ? '取消收藏' : '收藏节点'} aria-label={favorite ? '取消收藏节点' : '收藏节点'} onClick={toggleFavorite}>{favorite ? <BookmarkCheck size={15} /> : <Bookmark size={15} />}</button>}<button className="icon-button inspector-close" aria-label="关闭节点详情" title="关闭节点详情" onClick={() => setInspectorOpen(false)}><X size={15} /></button></div></div>
        {!selected ? <div className="inspector-placeholder"><div className="placeholder-node"><Box size={28} strokeWidth={1.3} /></div><h3>从一个节点开始</h3><p>点击画布中的模块或符号，探索它的职责、依赖与源码。</p><div><span><Search size={13} />Ctrl K 搜索代码</span><span><Target size={13} />双击逐层深入</span><span><ShieldCheck size={13} />每条关系可追溯</span></div></div> : <div className="inspector-scroll"><div className="node-overview"><div className="node-type-heading"><span className={`node-type-chip kind-${selected.kind}`}><Box size={12} />{nodeLabels[selected.kind]}</span><span>{selected.language === 'csharp' ? 'C#' : selected.language === 'unknown' ? '项目结构' : selected.language}</span></div><h1>{selected.label}</h1><p className="qualified-name">{selected.qualifiedName}</p>{selected.summary && <p className="node-summary">{selected.summary}</p>}<div className="node-file"><FileCode2 size={13} /><span>{selected.filePath || '由扫描目录结构聚合'}</span></div>{selected.signature && <code className="signature">{selected.signature}</code>}</div>
          {expandableKinds.has(selected.kind) && <button className="enter-structure-button" onClick={() => enterNode(selected)}><Layers3 size={13} />展开内部结构<ChevronRight size={13} /></button>}<div className="inspector-quick-actions"><button onClick={() => navigate({ ...location, view: 'calls', focus: selected })}><GitFork size={13} />调用链</button><button onClick={() => navigate({ ...location, view: 'data', focus: selected })}><Workflow size={13} />读写关系</button><button onClick={() => navigate({ ...location, view: 'impact', focus: selected })}><Route size={13} />影响范围</button></div>
          <div className="detail-section ownership-section"><h3>所属业务系统与模块</h3>{ownershipError ? <p className="warning-text">归属读取失败：{ownershipError}</p> : !owners ? <p className="muted">正在解析业务归属…</p> : owners.owners.length ? ownerLinks.map(owner => <button className="ownership-link" key={owner.membershipId} onClick={() => openOwner(owner.systemId, owner.moduleId)}><Layers3 size={12}/><span>{owner.systemName} / {owner.moduleName}<small>{owner.role === 'owner' ? '主要归属 · ' : owner.role === 'shared' ? '共享参与 · ' : '参与职责 · '}{owner.reviewState === 'confirmed' ? '人工确认' : owner.reviewState === 'needs-review' ? '需要复核' : owner.reviewState === 'rejected' ? '已拒绝' : '候选归属'}</small></span><ChevronRight size={12}/></button>) : <p className="muted">待分类：当前模型没有可定位的业务归属。</p>}</div>
          <div className="detail-section semantic-ownership"><h3>相关业务解释</h3>{semanticReverseError ? <p className="warning-text">{semanticReverseError}</p> : !semanticMatches ? <p className="muted">正在查找解释映射…</p> : semanticMatches.matches.length ? semanticMatches.matches.map(match => <button className="ownership-link" key={match.flowId} onClick={() => openSemanticMatch(match.flowId, match.nodeIds[0], match.edgeIds.length > 0)}><Workflow size={12}/><span>{match.flowTitle}<small>{match.nodeIds.length} 个相关步骤 · 在双层对照中查看</small></span><ChevronRight size={12}/></button>) : <p className="muted">当前两条流程中没有此实体的解释映射。</p>}</div>
          {detailLoading && <div className="inspector-loading"><Loader2 size={13} className="spin" />读取符号详情…</div>}{detailError && <div className="inspector-error">{detailError}</div>}
          {details && <><div className="detail-section"><h3>结构位置</h3><div className="parent-chain">{details.parents.map(parent => <button key={parent.id} onClick={() => enterNode(parent)}><Folder size={12} />{parent.label}<ChevronRight size={11} /></button>)}{!details.parents.length && <span className="muted">项目顶层</span>}</div></div><div className="detail-section"><h3>依赖与数据<span>{relationships.length}</span></h3><div className="dependency-metrics"><button onClick={() => { setDirection('up'); navigate({ ...location, view: 'calls', focus: selected }); }}><span><ArrowDownLeft size={13} />上游关系</span><strong>{details.incoming.filter(e => e.kind !== 'contains').length}</strong></button><button onClick={() => { setDirection('down'); navigate({ ...location, view: 'calls', focus: selected }); }}><span><ArrowUpRight size={13} />下游关系</span><strong>{details.outgoing.filter(e => e.kind !== 'contains').length}</strong></button></div>{(['reads', 'writes', 'initializes', 'passes', 'returns', 'calls', 'inherits', 'implements', 'references', 'imports', 'publishes', 'subscribes', 'unsubscribes', 'contract-mapping'] as const).map(kind => { const list = relationships.filter(edge => edge.kind === kind); return list.length > 0 && <div className="relationship-group" key={kind}><div className="relationship-group-label">{edgeLabels[kind]}<span>{list.length}</span></div>{list.slice(0, 6).map(edge => { const target = related.get(edge.source === selected.id ? edge.target : edge.source); return <button className="relationship-item" key={edge.id} onClick={() => target ? locateNode(target) : showRelation(edge)}><span className={`edge-dot ${edge.confidence}`} /><span title={target?.qualifiedName}>{target?.label || '查看关系证据'}</span><ChevronRight size={11} /></button>; })}{list.length > 6 && <button className="text-button show-all-relations" onClick={() => { setBottomTab('relations'); setBottomOpen(true); }}>查看全部 {list.length} 条</button>}</div>; })}{!relationships.filter(e => e.kind !== 'contains').length && <p className="detail-empty">当前分析范围内没有其他可确认的依赖关系。</p>}</div>
            <div className="detail-section"><h3>源码证据<span>{details.evidence.length}</span></h3>{details.evidence.slice(0, 12).map(evidence => <button className={`evidence-item ${evidenceId === evidence.id ? 'active' : ''}`} key={evidence.id} onClick={() => showEvidence(evidence)}><FileCode2 size={14} /><span><strong>{shortPath(evidence.filePath)}<small>L{evidence.startLine}{evidence.endLine !== evidence.startLine ? `–${evidence.endLine}` : ''}</small></strong><small>{evidence.rule}</small></span><ArrowUpRight size={11} /></button>)}{!details.evidence.length && <p className="detail-empty">结构聚合节点没有单一源码位置。展开后查看具体符号。</p>}</div>
            <div className="inspector-trust-note"><ShieldCheck size={14} /><p>关系依据源码证据建立。静态读写说明引用位置；潜在影响表示依赖范围，不能证明运行时必然执行。</p></div></>}
        </div>}
      </aside>
    </div> : primaryPage === 'delivery' ? <Suspense fallback={<StateCard title="正在加载开发交付流程" description="加载人工维护的阶段说明与 GitHub 入口。" busy />}><DeliveryWorkspace /></Suspense> : <Suspense fallback={<StateCard title="正在加载系统架构" description="加载系统与模块探索界面。" busy />}>{primaryPage === 'flows' && !legacyFlows ? <SemanticWorkspace scope={scope} revision={`${revision || ''}:${modelRefresh}:${semanticRefresh}`} location={semanticLocation} onLocationChange={setSemanticLocation} onOpenCode={openArchitectureCode}/> : <ArchitectureWorkspace scope={scope} revision={`${revision || ''}:${modelRefresh}`} route={architectureRoute} onRouteChange={changeArchitectureRoute} onOpenCode={openArchitectureCode} />}</Suspense>}
    <footer className="statusbar"><div><span className="statusbar-branch"><GitBranch size={11} />{branch}</span>{summary?.metadata.gitDirty && <span className="dirty-indicator">有未提交变更</span>}<span className="statusbar-head">{summary?.metadata.gitHead?.slice(0, 8)}</span></div><div><span className="index-revision" title={revision}>索引 {revision ? revision.slice(0, 8) : '—'}</span><span><Clock3 size={10} />{formatTime(summary?.metadata.generatedAt)}</span><span className="statusbar-end"><ShieldCheck size={10} />本地 · 只读分析</span></div></footer>
    {notice && <div className="toast" role="status"><Info size={15} /><span>{notice}</span><button aria-label="关闭通知" onClick={() => setNotice('')}><X size={13} /></button></div>}
  </div>;
}

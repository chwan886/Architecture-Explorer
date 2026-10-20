import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Check, Code2, Columns2, FileCode2, Filter, Layers3, LayoutGrid, ListTree, Loader2, PanelBottomClose, PanelBottomOpen, Pencil, RefreshCw, Search, ShieldCheck, Sparkles, TriangleAlert, X } from 'lucide-react';
import type { ArchitectureEdge, ArchitectureNode } from '../../../../packages/schema/src/index';
import type { OpenCodeRequest } from '../../../../packages/architecture-model/src/types';
import type { ResolvedSemanticFlow, SemanticBundle, SemanticCandidate, SemanticDefinitionEnvelope, SemanticEdge, SemanticLevel, SemanticLocation, SemanticMode, SemanticNode } from '../../../../packages/semantic-model/src/types';
import type { EvidenceContent } from '../api';
import GraphCanvas from '../GraphCanvas';
import SourcePreview from '../SourcePreview';
import { confidenceLabels, edgeLabels, nodeLabels } from '../labels';
import SemanticCanvas from './SemanticCanvas';
import SemanticEditor from './SemanticEditor';
import { checkSemanticMetadata, SemanticApiError, semanticError, semanticRequest } from './client';
import { codeMapping, visibleSemanticGraph, visibleSemanticMatches } from './graph';
import { controlLabels, modeLabels, originLabels, relationLabels, reviewLabels, statusLabels, verificationLabels } from './labels';

type Selection = { type: 'node' | 'edge' | 'code-node' | 'code-edge'; id: string };
interface Snapshot { flowId?: string; mode: SemanticMode; level: SemanticLevel; expanded: string[]; selection?: Selection; evidenceId: string; sourceOpen: boolean; search: string; relationFilter: string }
interface Memory extends Snapshot { history: Snapshot[] }
const memories = new Map<string, Memory>();
const selectionKey = (selection?: Selection) => selection ? `${selection.type}:${selection.id}` : '';
const locationKey = (location?: SemanticLocation) => JSON.stringify(location || {});
const locationSelection = (location?: SemanticLocation): Selection | undefined => location?.codeEdgeId ? { type: 'code-edge', id: location.codeEdgeId } : location?.codeNodeId ? { type: 'code-node', id: location.codeNodeId } : location?.nodeId ? { type: 'node', id: location.nodeId } : undefined;

export interface SemanticWorkspaceProps { scope: string; revision?: string; location?: SemanticLocation; onLocationChange?: (location: SemanticLocation) => void; onOpenCode: (request: OpenCodeRequest) => void }
function TextItems({ title, values }: { title: string; values: string[] }) { return values.length ? <section><h4>{title}</h4><ul>{values.map((value, index) => <li key={index}>{value}</li>)}</ul></section> : null; }
function Notice({ message, onReload }: { message: string; onReload?: () => void }) { return <div className="semantic-error" role="alert"><TriangleAlert size={14} /><div>{message.slice(0, 280)}{message.length > 280 && <details><summary>查看完整诊断</summary><pre>{message}</pre></details>}</div>{onReload && <button onClick={onReload}>重新载入</button>}</div>; }

export default function SemanticWorkspace({ scope, revision, location, onLocationChange, onOpenCode }: SemanticWorkspaceProps) {
  const initial = useRef(memories.get(`${scope}:${location?.flowId || ''}`));
  const [flowId, setFlowId] = useState(location?.flowId || initial.current?.flowId);
  const [mode, setMode] = useState<SemanticMode>(location?.mode || initial.current?.mode || 'explanation');
  const [level, setLevel] = useState<SemanticLevel>(location?.level || initial.current?.level || 'simple');
  const [expanded, setExpanded] = useState<string[]>(initial.current?.expanded || []);
  const [selection, setSelection] = useState<Selection | undefined>(locationSelection(location) || initial.current?.selection);
  const [history, setHistory] = useState<Snapshot[]>(initial.current?.history || []);
  const [search, setSearch] = useState(initial.current?.search || ''), [relationFilter, setRelationFilter] = useState(initial.current?.relationFilter || '');
  const [bundle, setBundle] = useState<SemanticBundle>(), [loading, setLoading] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState(false), [reload, setReload] = useState(0);
  const [evidenceId, setEvidenceId] = useState(initial.current?.evidenceId || ''), [sourceOpen, setSourceOpen] = useState(initial.current?.sourceOpen || false);
  const [source, setSource] = useState<EvidenceContent>(), [sourceBusy, setSourceBusy] = useState(false), [sourceError, setSourceError] = useState(''), [sourceEpoch, setSourceEpoch] = useState(0), [rootPath, setRootPath] = useState('');
  const [layoutToken, setLayoutToken] = useState(0), [batchFocus, setBatchFocus] = useState<{ ids: string[]; token: number }>(), [semanticBatchFocus, setSemanticBatchFocus] = useState<{ ids: string[]; token: number }>();
  const [editorOpen, setEditorOpen] = useState(false), [candidate, setCandidate] = useState<SemanticCandidate>(), [operation, setOperation] = useState(''), [operationError, setOperationError] = useState(''), [inspectorOpen, setInspectorOpen] = useState(true);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const selectedRef = useRef(selectionKey(selection)); selectedRef.current = selectionKey(selection);
  const bundleRef = useRef(bundle); bundleRef.current = bundle;
  const viewSequence = useRef(0), sourceSequence = useRef(0), operationSequence = useRef(0), focusToken = useRef(0), previousScope = useRef(scope);
  const notifiedLocation = useRef(locationKey(location)), restoration = useRef(false);
  const flow = bundle?.flow, metadata = bundle?.metadata;
  const ready = !!flow && !loading && !conflict && (!flowId || flow.id === flowId);
  const selectedNode = selection?.type === 'node' ? [...flow?.summaryNodes || [], ...flow?.detailNodes || []].find(node => node.id === selection.id) : undefined;
  const selectedEdge = selection?.type === 'edge' ? [...flow?.summaryEdges || [], ...flow?.detailEdges || []].find(edge => edge.id === selection.id) : undefined;
  const selectedCodeNode = selection?.type === 'code-node' ? flow?.codeNodes.find(node => node.id === selection.id) : undefined;
  const selectedCodeEdge = selection?.type === 'code-edge' ? flow?.codeEdges.find(edge => edge.id === selection.id) : undefined;
  const snapshot = (): Snapshot => ({ flowId: flowId || flow?.id, mode, level, expanded, selection, evidenceId, sourceOpen, search, relationFilter });
  const memoryRef = useRef<Memory>({ ...snapshot(), history }); memoryRef.current = { ...snapshot(), history };
  const clearSource = useCallback(() => { sourceSequence.current++; setSource(undefined); setSourceBusy(false); setSourceError(''); }, []);
  const activateEvidence = useCallback((id: string, reveal = true) => { sourceSequence.current++; setEvidenceId(id); setSource(undefined); setSourceError(''); setSourceBusy(!!id); setSourceEpoch(value => value + 1); if (reveal) setSourceOpen(true); }, []);
  const publish = (next: Partial<SemanticLocation>, selected: Selection | undefined) => {
    const value: SemanticLocation = { flowId: flowId || flow?.id, mode, level, ...(selected?.type === 'node' ? { nodeId: selected.id } : selected?.type === 'code-node' ? { codeNodeId: selected.id } : selected?.type === 'code-edge' ? { codeEdgeId: selected.id } : {}), ...next };
    notifiedLocation.current = locationKey(value); onLocationChange?.(value);
  };
  const fail = useCallback((failure: unknown, sink: (message: string) => void) => {
    sink(semanticError(failure));
    if (failure instanceof SemanticApiError && failure.status === 409) { setConflict(true); clearSource(); setCandidate(undefined); }
  }, [clearSource]);
  const refresh = () => { setConflict(false); setError(''); setOperationError(''); setReload(value => value + 1); };
  const select = (next?: Selection, remember = true) => {
    if (remember && selectionKey(next) !== selectionKey(selection)) setHistory(value => [...value, snapshot()].slice(-40));
    selectedRef.current = selectionKey(next); setSelection(next); clearSource(); setEvidenceId(''); setCandidate(undefined); setOperationError('');
    publish({}, next);
    if (flow && next?.type === 'node') {
      const node = [...flow.summaryNodes, ...flow.detailNodes].find(node => node.id === next.id);
      if (node) { const mapping = codeMapping(flow, node); setBatchFocus({ ids: [...mapping.nodeIds], token: ++focusToken.current }); }
    } else if (flow && next?.type === 'edge') {
      const edge = [...flow.summaryEdges, ...flow.detailEdges].find(edge => edge.id === next.id);
      if (edge) setBatchFocus({ ids: [...codeMapping(flow, undefined, edge).nodeIds], token: ++focusToken.current });
    } else if (flow && (next?.type === 'code-node' || next?.type === 'code-edge')) {
      const ids = next.type === 'code-node' ? flow.reverseNodes[next.id] || [] : (flow.reverseEdges[next.id] || []).flatMap(id => { const edge = [...flow.summaryEdges, ...flow.detailEdges].find(item => item.id === id); return edge ? [edge.source, edge.target] : []; });
      const visible = visibleSemanticGraph(flow, new Set(expanded));
      setSemanticBatchFocus({ ids: [...visibleSemanticMatches(flow, ids, new Set(visible.nodes.map(node => node.id)))], token: ++focusToken.current });
    }
    setInspectorOpen(true);
  };
  const restore = (entry: Snapshot) => {
    restoration.current = true; clearSource(); setFlowId(entry.flowId); setMode(entry.mode); setLevel(entry.level); setExpanded(entry.expanded); selectedRef.current = selectionKey(entry.selection); setSelection(entry.selection); setEvidenceId(entry.evidenceId); setSourceOpen(entry.sourceOpen); setSearch(entry.search); setRelationFilter(entry.relationFilter); setSourceEpoch(value => value + 1); setCandidate(undefined); setOperationError('');
    publish({ flowId: entry.flowId, mode: entry.mode, level: entry.level }, entry.selection);
  };
  const back = () => { const entry = history.at(-1); if (entry) { setHistory(value => value.slice(0, -1)); restore(entry); } };
  const switchFlow = (id: string) => { setHistory(value => [...value, snapshot()].slice(-40)); clearSource(); setFlowId(id); setSelection(undefined); selectedRef.current = ''; setEvidenceId(''); setExpanded([]); setCandidate(undefined); setSearch(''); setRelationFilter(''); publish({ flowId: id }, undefined); };
  const changeMode = (value: SemanticMode) => { setMode(value); publish({ mode: value }, selection); };
  const changeLevel = (value: SemanticLevel) => {
    setLevel(value);
    if (value === 'simple') setExpanded([]);
    else if (flow) { const group = selectedNode?.level === 'summary' ? selectedNode : flow.summaryNodes.find(node => node.childIds.includes(selectedNode?.id || '')) || flow.summaryNodes[0]; if (group) setExpanded(value => [...new Set([...value, group.id])]); }
    publish({ level: value }, selection);
  };
  const expandGroup = (id: string) => { setExpanded(value => value.includes(id) ? value.filter(item => item !== id) : [...value, id]); setLevel('detailed'); publish({ level: 'detailed' }, selection); };

  useEffect(() => {
    const identity = `${scope}:${flowId || ''}`;
    return () => { const value = memoryRef.current; const actualKey = `${scope}:${value.flowId || ''}`; memories.delete(identity); memories.set(identity, value); memories.delete(actualKey); memories.set(actualKey, value); while (memories.size > 24) memories.delete(memories.keys().next().value!); };
  }, [scope, flowId]);
  useEffect(() => {
    if (previousScope.current === scope) return;
    previousScope.current = scope; viewSequence.current++; operationSequence.current++; clearSource(); setFlowId(location?.flowId); setMode(location?.mode || 'explanation'); setLevel(location?.level || 'simple'); setExpanded([]); setSelection(locationSelection(location)); setHistory([]); setSearch(''); setRelationFilter(''); setBundle(undefined); setEvidenceId(''); setSourceOpen(false); setCandidate(undefined); setEditorOpen(false); setConflict(false); setRootPath('');
  }, [scope, clearSource]);
  useEffect(() => {
    const key = locationKey(location); if (key === notifiedLocation.current) return; notifiedLocation.current = key;
    if (!location) return;
    clearSource(); setFlowId(location.flowId); if (location.mode) setMode(location.mode); if (location.level) setLevel(location.level); const next = locationSelection(location); setSelection(next); selectedRef.current = selectionKey(next); setEvidenceId('');
  }, [location, clearSource]);
  useEffect(() => {
    const request = ++viewSequence.current, controller = new AbortController(); operationSequence.current++; clearSource(); setLoading(true); setError(''); setConflict(false); setCandidate(undefined); setOperation('');
    semanticRequest<SemanticBundle>(scope, '', { flowId }, { signal: controller.signal }).then(value => {
      if (request !== viewSequence.current || scopeRef.current !== scope) return;
      checkSemanticMetadata(value.metadata, scope); if (flowId && value.flow && value.flow.id !== flowId) throw new SemanticApiError(409, '服务器返回了不同的流程，已停止显示混合数据。'); setBundle(value);
      const active = value.flow;
      if (active && !flowId) { const current = memoryRef.current; memories.set(`${scope}:${active.id}`, { ...current, flowId: active.id }); }
      if (selection && active) {
        const exists = selection.type === 'node' ? [...active.summaryNodes, ...active.detailNodes].some(node => node.id === selection.id) : selection.type === 'edge' ? [...active.summaryEdges, ...active.detailEdges].some(edge => edge.id === selection.id) : selection.type === 'code-node' ? active.codeNodes.some(node => node.id === selection.id) : active.codeEdges.some(edge => edge.id === selection.id);
        if (!exists) { setSelection(undefined); selectedRef.current = ''; setEvidenceId(''); }
      }
    }).catch(failure => { if (!controller.signal.aborted && request === viewSequence.current && scopeRef.current === scope) fail(failure, setError); }).finally(() => { if (request === viewSequence.current && scopeRef.current === scope) setLoading(false); });
    return () => { controller.abort(); viewSequence.current++; };
  }, [scope, revision, flowId, reload, clearSource, fail]);
  useEffect(() => {
    const controller = new AbortController(); const url = new URL('/api/summary', window.location.origin); url.searchParams.set('scope', scope);
    fetch(url, { signal: controller.signal }).then(response => response.ok ? response.json() : undefined).then(value => { if (!controller.signal.aborted && scopeRef.current === scope) setRootPath(value?.metadata?.rootPath || ''); }).catch(() => {});
    return () => controller.abort();
  }, [scope]);
  const availableEvidenceIds = useMemo(() => selectedNode?.evidenceIds || selectedEdge?.evidenceIds || selectedCodeNode?.evidenceIds || selectedCodeEdge?.evidenceIds || [], [selectedNode, selectedEdge, selectedCodeNode, selectedCodeEdge]);
  useEffect(() => {
    if (!ready || !selection) return;
    if (!availableEvidenceIds.includes(evidenceId)) { clearSource(); setEvidenceId(availableEvidenceIds[0] || ''); setSourceEpoch(value => value + 1); }
    restoration.current = false;
  }, [ready, selection, availableEvidenceIds, evidenceId, clearSource]);
  useEffect(() => {
    const request = ++sourceSequence.current; if (!ready || !metadata || !evidenceId || !availableEvidenceIds.includes(evidenceId)) { setSource(undefined); setSourceBusy(false); return; }
    const controller = new AbortController(), selected = selectionKey(selection), viewRevision = metadata.viewRevision, sourceRevision = metadata.sourceRevision;
    setSource(undefined); setSourceBusy(true); setSourceError('');
    semanticRequest<EvidenceContent>(scope, `/evidence/${encodeURIComponent(evidenceId)}`, { viewRevision }, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted || request !== sourceSequence.current || scopeRef.current !== scope || selectedRef.current !== selected || bundleRef.current?.metadata.viewRevision !== viewRevision) return;
      if (value.evidence.id !== evidenceId || value.revision !== sourceRevision) throw new SemanticApiError(409, '证据与当前语义视图的源码版本不一致，请重新载入。'); setSource(value);
    }).catch(failure => { if (!controller.signal.aborted && request === sourceSequence.current && scopeRef.current === scope && selectedRef.current === selected) fail(failure, setSourceError); }).finally(() => { if (request === sourceSequence.current && scopeRef.current === scope) setSourceBusy(false); });
    return () => controller.abort();
  }, [scope, ready, metadata?.viewRevision, evidenceId, sourceEpoch, availableEvidenceIds, clearSource, fail]);

  const visible = useMemo(() => flow ? visibleSemanticGraph(flow, new Set(expanded)) : { nodes: [], edges: [], hiddenEdges: 0 }, [flow, expanded]);
  const semanticNodes = visible.nodes.filter(node => !search || `${node.title} ${node.summary}`.toLowerCase().includes(search.toLowerCase()));
  const semanticVisibleIds = new Set(semanticNodes.map(node => node.id));
  const semanticEdges = visible.edges.filter(edge => semanticVisibleIds.has(edge.source) && semanticVisibleIds.has(edge.target) && (!relationFilter || edge.verification === relationFilter));
  const reverseNodeIds = selectedCodeNode ? flow?.reverseNodes[selectedCodeNode.id] || [] : selectedCodeEdge ? [...new Set((flow?.reverseEdges[selectedCodeEdge.id] || []).flatMap(id => { const edge = [...flow?.detailEdges || [], ...flow?.summaryEdges || []].find(edge => edge.id === id); return edge ? [edge.source, edge.target] : []; }))] : [];
  const semanticHighlights = flow ? visibleSemanticMatches(flow, selectedNode ? [selectedNode.id] : selectedEdge ? [selectedEdge.source, selectedEdge.target] : reverseNodeIds, semanticVisibleIds) : new Set<string>();
  const semanticEdgeHighlights = new Set(selectedEdge ? [selectedEdge.id] : selectedCodeEdge ? flow?.reverseEdges[selectedCodeEdge.id] || [] : []);
  const mapping = flow ? codeMapping(flow, selectedNode, selectedEdge) : { nodeIds: new Set<string>(), edgeIds: new Set<string>() };
  if (selectedCodeNode) mapping.nodeIds.add(selectedCodeNode.id);
  if (selectedCodeEdge) { mapping.edgeIds.add(selectedCodeEdge.id); mapping.nodeIds.add(selectedCodeEdge.source); mapping.nodeIds.add(selectedCodeEdge.target); }
  const mappedNodes = flow?.codeNodes.filter(node => mapping.nodeIds.has(node.id)) || [];
  const outsideCanvas = mappedNodes.filter(node => !flow?.codeGraph.nodes.some(value => value.id === node.id));
  const relatedNodes = flow ? selectedCodeNode ? (flow.reverseNodes[selectedCodeNode.id] || []).map(id => flow.detailNodes.find(node => node.id === id)).filter((node): node is SemanticNode => !!node) : selectedCodeEdge ? (flow.reverseEdges[selectedCodeEdge.id] || []).map(id => flow.detailEdges.find(edge => edge.id === id)).filter((edge): edge is SemanticEdge => !!edge) : [] : [];
  const selectedTitle = selectedNode?.title || selectedEdge?.title || selectedCodeNode?.label || (selectedCodeEdge ? edgeLabels[selectedCodeEdge.kind] : '流程说明');
  const operationRequest = async (kind: 'review' | 'rebuild' | 'generate', decision?: 'confirmed' | 'rejected' | 'pending') => {
    if (!metadata || !flow || !ready) return; const request = ++operationSequence.current, selected = selectionKey(selection), expectedView = metadata.viewRevision; setOperation(kind); setOperationError('');
    try {
      if (kind === 'review') {
        const value = await semanticRequest<SemanticDefinitionEnvelope>(scope, '/review', {}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedOverlayRevision: metadata.overlayRevision, viewRevision: expectedView, flowId: flow.id, targetType: selectedNode ? 'node' : selectedEdge ? 'edge' : 'flow', targetId: selectedNode?.id || selectedEdge?.id || flow.id, decision }) });
        if (request !== operationSequence.current || scopeRef.current !== scope) return; if (value.overlay.scopeId !== scope) throw new SemanticApiError(409, '复核响应作用域不匹配。'); setReload(value => value + 1);
      } else if (kind === 'rebuild') {
        const value = await semanticRequest<SemanticBundle>(scope, '/rebuild', {}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flowId: flow.id, viewRevision: expectedView }) });
        if (request !== operationSequence.current || scopeRef.current !== scope) return; checkSemanticMetadata(value.metadata, scope); setBundle(value); clearSource(); setSourceEpoch(value => value + 1);
      } else {
        const value = await semanticRequest<SemanticCandidate>(scope, '/generate', {}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flowId: flow.id, nodeId: selectedNode?.id, viewRevision: expectedView }) });
        if (request !== operationSequence.current || scopeRef.current !== scope || selectedRef.current !== selected || bundleRef.current?.metadata.viewRevision !== expectedView) return; checkSemanticMetadata(value.metadata, scope, expectedView); if (value.origin !== 'rule-generated') throw new Error('候选来源不符合当前规则生成器。'); setCandidate(value);
      }
    } catch (failure) { if (request === operationSequence.current && scopeRef.current === scope) fail(failure, setOperationError); }
    finally { if (request === operationSequence.current && scopeRef.current === scope) setOperation(''); }
  };
  const reviewState = selectedNode?.reviewState || selectedEdge?.reviewState || flow?.reviewState;
  const allFlowEdges = flow ? [...flow.summaryEdges, ...flow.detailEdges] : [];
  const relatedEdges = selectedNode ? allFlowEdges.filter(edge => edge.source === selectedNode.id || edge.target === selectedNode.id || selectedNode.childIds.includes(edge.source) || selectedNode.childIds.includes(edge.target)) : [];
  const codeName = (id: string) => flow?.codeNodes.find(node => node.id === id)?.label || id;
  const explanationName = (id: string) => [...flow?.summaryNodes || [], ...flow?.detailNodes || []].find(node => node.id === id)?.title || id;

  return <div className={`semantic-workspace mode-${mode} ${sourceOpen ? 'source-open' : ''} ${inspectorOpen ? '' : 'inspector-collapsed'}`} data-scope={scope} data-mode={mode} data-level={level} data-expanded={expanded.join(",")} data-view-revision={metadata?.viewRevision || ''} data-selection-id={selection?.id || ''} data-selection-type={selection?.type || ''}>
    <header className="semantic-toolbar"><div className="semantic-toolbar-title"><Layers3 size={16} /><select aria-label="选择语义流程" value={flowId || flow?.id || ''} onChange={event => switchFlow(event.target.value)} disabled={loading || !bundle?.flows.length}>{!bundle?.flows.length && <option value="">尚无语义流程</option>}{bundle?.flows.map(flow => <option key={flow.id} value={flow.id}>{flow.title}</option>)}</select><span className="semantic-layer-tag">证据支持的解释</span></div><div className="semantic-mode-switch" role="group" aria-label="图层模式">{(['explanation', 'code', 'compare'] as SemanticMode[]).map(value => <button key={value} aria-pressed={mode === value} onClick={() => changeMode(value)}>{value === 'explanation' ? <Layers3 size={13} /> : value === 'code' ? <Code2 size={13} /> : <Columns2 size={13} />}{modeLabels[value]}</button>)}</div><button aria-label="重新载入语义图" title="重新载入当前定义与事实投影" onClick={refresh}><RefreshCw size={14} /></button></header>
    <div className="semantic-subtoolbar"><button aria-label="返回上一语义上下文" onClick={back} disabled={!history.length}><ArrowLeft size={14} />返回</button><div className="semantic-breadcrumb"><button onClick={() => select(undefined)}>{flow?.title || '业务流程'}</button>{selection && <><span>/</span><span title={selectedTitle}>{selectedTitle}</span></>}</div><div className="semantic-level-switch"><button aria-pressed={level === 'simple'} onClick={() => changeLevel('simple')}><LayoutGrid size={12} />简洁</button><button aria-pressed={level === 'detailed'} onClick={() => changeLevel('detailed')}><ListTree size={12} />详细</button></div><button onClick={() => setLayoutToken(value => value + 1)} disabled={!ready}>自动布局</button><button aria-label={inspectorOpen ? '收起语义详情' : '展开语义详情'} onClick={() => setInspectorOpen(value => !value)}><Filter size={13} /></button></div>
    {error && <Notice message={error} onReload={refresh} />}{conflict && !error && <Notice message="视图版本已变化。已清除旧源码；重新载入后继续查看。" onReload={refresh} />}
    <div className={`semantic-body ${!ready ? 'is-loading' : ''}`}><aside className="semantic-navigation"><label className="semantic-search"><Search size={13} /><input aria-label="筛选业务解释" placeholder="搜索阶段与步骤" value={search} onChange={event => setSearch(event.target.value)} /></label><div className="semantic-nav-heading">业务阶段<span>{flow?.summaryNodes.length || 0}</span></div><nav>{flow?.summaryNodes.map(group => <div className="semantic-group" key={group.id}><div className="semantic-group-row"><button aria-label={`${expanded.includes(group.id) ? '折叠' : '展开'} ${group.title}`} className="semantic-expand" onClick={() => expandGroup(group.id)}>{expanded.includes(group.id) ? '−' : '+'}</button><button className={selection?.id === group.id ? 'active' : ''} onClick={() => select({ type: 'node', id: group.id })}><span>{group.title}</span><small>{group.childIds.length} 步</small></button></div>{expanded.includes(group.id) && group.childIds.map(id => { const node = flow.detailNodes.find(node => node.id === id); return node && (!search || `${node.title} ${node.summary}`.includes(search)) ? <button className={`semantic-detail-nav ${selection?.id === id ? 'active' : ''}`} key={id} onClick={() => select({ type: 'node', id })}><span>{node.title}</span>{node.status !== 'current' && <i title={statusLabels[node.status]}>!</i>}</button> : null; })}</div>)}</nav><label className="semantic-relation-filter">关系依据<select aria-label="筛选语义关系依据" value={relationFilter} onChange={event => setRelationFilter(event.target.value)}><option value="">全部依据</option>{Object.entries(verificationLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><div className="semantic-nav-foot"><ShieldCheck size={14} /><p>人工解释与静态事实分层。确认文字不会验证运行时顺序。</p></div></aside>
      <main className="semantic-map-region"><div className="semantic-map-context"><span>{modeLabels[mode]} · {semanticNodes.length} 个可见解释</span><span>{expanded.length ? `局部展开 ${expanded.length} 组` : `${flow?.summaryNodes.length || 0} 个摘要阶段`}</span></div>{loading ? <div className="semantic-empty"><Loader2 className="spinner" size={20} /><strong>正在解析语义与实现映射</strong><p>保留导航上下文，等待同一版本的完整投影。</p></div> : !flow ? <div className="semantic-empty"><Layers3 size={30} /><strong>此项目尚无业务解释模型</strong><p>代码事实仍可通过代码地图浏览。语义模型需要明确的源码锚点与实现绑定。</p><button onClick={refresh}>重新检查模型</button></div> : <div className="semantic-map-panes">
        {mode !== 'code' && <section className="semantic-explanation-pane" aria-label="业务解释画布">{semanticNodes.length ? <SemanticCanvas identity={`${scope}:${flow.id}:${mode}`} nodes={semanticNodes} edges={semanticEdges} selectedId={selectedNode?.id} highlightedNodeIds={semanticHighlights} highlightedEdgeIds={semanticEdgeHighlights} layoutToken={layoutToken} batchFocusRequest={semanticBatchFocus} onFocusHandled={token => setSemanticBatchFocus(value => value?.token === token ? undefined : value)} onNode={node => select({ type: 'node', id: node.id })} onEdge={edge => select({ type: 'edge', id: edge.id })} onExpand={expandGroup} /> : <div className="semantic-empty">没有匹配的解释节点。<button onClick={() => setSearch('')}>清除筛选</button></div>}<div className="semantic-pane-note">{visible.hiddenEdges > 0 ? `${visible.hiddenEdges} 条其他粒度关系保留在详情中；不补造跨粒度连线。` : '连线含义以关系详情为准。'}<span>虚线：未验证或推断</span></div></section>}
        {mode !== 'explanation' && <section className="semantic-code-pane" aria-label="代码实现画布"><div className="semantic-code-pane-title"><Code2 size={13} />代码事实层<span>{flow.codeGraph.nodes.length}/{flow.codeNodes.length} 实现节点</span></div>{flow.codeGraph.nodes.length ? <GraphCanvas preserveFocusOnResize graph={flow.codeGraph} selectedId={selectedCodeNode?.id} onSelect={node => select({ type: 'code-node', id: node.id })} onEnter={node => onOpenCode({ nodeId: node.id, mode: 'symbol' })} onRelation={edge => select({ type: 'code-edge', id: edge.id })} layoutToken={layoutToken} batchFocusRequest={batchFocus} onFocusHandled={token => setBatchFocus(value => value?.token === token ? undefined : value)} view={`semantic-code:${scope}:${flow.id}:${mode}`} highlightedNodeIds={mapping.nodeIds} highlightedEdgeIds={mapping.edgeIds} /> : <div className="semantic-empty">此流程尚无可确认的实现节点。</div>}<div className="semantic-pane-note">{flow.codeGraph.truncated ? '画布已达显示预算；全部映射仍可在详情中打开。' : '拖动或缩放查看实现；调用与读写保持原始可信度。'}</div></section>}
      </div>}</main>
      {inspectorOpen && <aside className="semantic-inspector" data-node-id={selection?.id || ''}><div className="semantic-inspector-heading"><span>{selectedNode ? '业务解释' : selectedEdge ? '语义关系' : selectedCodeNode || selectedCodeEdge ? '代码事实与业务映射' : '流程概览'}</span><button aria-label="清除语义选择" onClick={() => select(undefined)} disabled={!selection}><X size={13} /></button></div><div className="semantic-inspector-scroll"><h2>{selectedTitle}</h2>
        {(selectedNode || selectedEdge) && <div className="semantic-status-row"><span className={`semantic-pill ${reviewState}`}>{reviewState && reviewLabels[reviewState]}</span><span className={`semantic-pill ${selectedNode?.status || selectedEdge?.status}`}>{statusLabels[(selectedNode?.status || selectedEdge?.status)!]}</span>{selectedNode && <span className="semantic-pill">{originLabels[selectedNode.origin]}</span>}</div>}
        {selectedNode ? <><p className="semantic-lead">{selectedNode.summary}</p>{selectedNode.purpose && <section><h4>目的</h4><p>{selectedNode.purpose}</p></section>}{selectedNode.detail && <section><h4>处理说明</h4><p>{selectedNode.detail}</p></section>}<TextItems title="输入" values={selectedNode.inputs} /><TextItems title="处理过程" values={selectedNode.processing} /><TextItems title="输出" values={selectedNode.outputs} /><TextItems title="状态变化" values={selectedNode.changes} />{selectedNode.controls.length > 0 && <section><h4>条件与控制边界</h4>{selectedNode.controls.map((control, index) => <div className="semantic-control" key={index}><span>{controlLabels[control.kind]}</span><p>{control.description}</p></div>)}</section>}{selectedNode.fragments.length > 1 && <div className="semantic-warning"><TriangleAlert size={13} />实现包含 {selectedNode.fragments.length} 个不相连片段；不表示连续调用链。</div>}{selectedNode.level === 'summary' && <button className="semantic-wide-action" onClick={() => expandGroup(selectedNode.id)}><ListTree size={13} />{expanded.includes(selectedNode.id) ? '折叠阶段' : `局部展开 ${selectedNode.childIds.length} 步`}</button>}</> : selectedEdge ? <><div className={`semantic-verification ${selectedEdge.verification}`}>{verificationLabels[selectedEdge.verification]}</div><p className="semantic-lead">{selectedEdge.description}</p><div className="semantic-endpoints"><button onClick={() => select({ type: 'node', id: selectedEdge.source })}>{explanationName(selectedEdge.source)}</button><span>→</span><button onClick={() => select({ type: 'node', id: selectedEdge.target })}>{explanationName(selectedEdge.target)}</button></div><p>{selectedEdge.kinds.map(kind => relationLabels[kind]).join(' · ')}</p><TextItems title="相关条件" values={selectedEdge.conditions} /><TextItems title="执行边界" values={selectedEdge.boundaries} />{selectedEdge.paths.map((path, index) => <section className="semantic-path" key={index}><h4>{path.kind === 'call-path' ? '逐跳调用路径' : '事实集合（不等同执行路径）'} <span>{verificationLabels[path.verification]}</span></h4>{path.nodeIds.map((id, position) => <div key={`${id}:${position}`}><button onClick={() => onOpenCode({ nodeId: id, mode: 'symbol' })}>{codeName(id)}<ArrowUpRight size={11} /></button>{path.edgeIds[position] && <button className="semantic-path-edge" onClick={() => select({ type: 'code-edge', id: path.edgeIds[position] })}>{edgeLabels[flow?.codeEdges.find(edge => edge.id === path.edgeIds[position])?.kind || 'references']} · 查看证据 ↓</button>}</div>)}</section>)}</> : selectedCodeNode ? <><span className="semantic-pill">{nodeLabels[selectedCodeNode.kind]} · {selectedCodeNode.language}</span><p className="semantic-code-name">{selectedCodeNode.qualifiedName}</p><p className="semantic-muted">{selectedCodeNode.filePath}</p><button className="semantic-wide-action" onClick={() => onOpenCode({ nodeId: selectedCodeNode.id, mode: 'symbol', evidenceId: evidenceId || undefined })}><ArrowUpRight size={13} />在代码地图继续探索</button></> : selectedCodeEdge ? <><div className="semantic-verification">{confidenceLabels[selectedCodeEdge.confidence]}</div><p>{selectedCodeEdge.rule}</p><div className="semantic-endpoints"><button onClick={() => select({ type: 'code-node', id: selectedCodeEdge.source })}>{codeName(selectedCodeEdge.source)}</button><span>→</span><button onClick={() => select({ type: 'code-node', id: selectedCodeEdge.target })}>{codeName(selectedCodeEdge.target)}</button></div>{selectedCodeEdge.condition && <p>条件：{selectedCodeEdge.condition}</p>}<TextItems title="静态分析限制" values={selectedCodeEdge.limitations || []} /></> : <><p className="semantic-lead">{flow?.description}</p><p>{flow?.summaryNodes.length || 0} 个摘要阶段 · {flow?.detailNodes.length || 0} 个详细步骤</p><div className="semantic-warning"><TriangleAlert size={13} />当前没有运行时采集。源码支持、静态调用和人工确认分别标记。</div></>}
        {(selectedNode || selectedEdge) && <><section><h4>实现映射 <span>{mappedNodes.length}</span></h4>{mappedNodes.length ? <><button className="semantic-wide-action" onClick={() => { changeMode('compare'); setBatchFocus({ ids: [...mapping.nodeIds], token: ++focusToken.current }); }}><Columns2 size={13} />对照并定位全部实现</button><div className="semantic-code-list">{mappedNodes.slice(0, 20).map(node => <button key={node.id} onClick={() => select({ type: 'code-node', id: node.id })}><Code2 size={12} /><span>{node.label}<small>{node.filePath}</small></span></button>)}</div>{mappedNodes.length > 20 && <details><summary>其余 {mappedNodes.length - 20} 个实现</summary>{mappedNodes.slice(20).map(node => <button key={node.id} onClick={() => onOpenCode({ nodeId: node.id, mode: 'symbol' })}>{node.label}<ArrowUpRight size={11} /></button>)}</details>}{outsideCanvas.length > 0 && <details className="semantic-warning"><summary>{outsideCanvas.length} 个映射被画布预算隐藏，可在代码页打开</summary>{outsideCanvas.map(node => <button key={node.id} onClick={() => onOpenCode({ nodeId: node.id, mode: 'symbol' })}>{node.label}<ArrowUpRight size={11} /></button>)}</details>}</> : <p className="semantic-muted">没有当前可解析的主实现，不能据名称补造绑定。</p>}{selectedNode?.contextNodeIds.length ? <details><summary>{selectedNode.contextNodeIds.length} 个上下文实体（不作为主实现）</summary>{selectedNode.contextNodeIds.map(id => <button key={id} onClick={() => onOpenCode({ nodeId: id, mode: 'symbol' })}>{codeName(id)}<ArrowUpRight size={11} /></button>)}</details> : null}</section>{selectedNode && selectedNode.bindings.length > 0 && <details><summary>绑定状态 · {selectedNode.bindings.length}</summary>{selectedNode.bindings.map(binding => <div className="semantic-binding" key={binding.id}><span>{binding.role === 'context' ? '上下文' : '主实现'} · {statusLabels[binding.status]}</span><code>{binding.selector?.qualifiedName || binding.sourceStepId || binding.id}</code></div>)}</details>}</>}
        {(selectedCodeNode || selectedCodeEdge) && <section><h4>关联业务解释 <span>{relatedNodes.length}</span></h4>{relatedNodes.length ? relatedNodes.map(node => <button className="semantic-related" key={node.id} onClick={() => select({ type: 'source' in node ? 'edge' : 'node', id: node.id })}><Layers3 size={12} />{node.title}</button>) : <p className="semantic-muted">此事实没有当前流程的显式语义映射。</p>}</section>}
        {relatedEdges.length > 0 && <details><summary>上下游关系与依据 · {relatedEdges.length}</summary>{relatedEdges.map(edge => <button className="semantic-related" key={edge.id} onClick={() => select({ type: 'edge', id: edge.id })}><span>{edge.title}<small>{verificationLabels[edge.verification]}</small></span></button>)}</details>}
        {selection && <section><h4>源码证据 <span>{availableEvidenceIds.length}</span></h4><div className="semantic-evidence-list">{availableEvidenceIds.slice(0, 10).map(id => { const evidence = flow?.evidence.find(item => item.id === id); return <button key={id} className={evidenceId === id ? 'active' : ''} data-evidence-id={id} onClick={() => activateEvidence(id)}><FileCode2 size={12} /><span>{evidence ? `${evidence.filePath}:${evidence.startLine}` : id}<small>{evidence?.rule || '查看当前绑定证据'}</small></span></button>; })}{availableEvidenceIds.length > 10 && <details><summary>其余 {availableEvidenceIds.length - 10} 条证据</summary>{availableEvidenceIds.slice(10).map(id => <button key={id} data-evidence-id={id} onClick={() => activateEvidence(id)}>{flow?.evidence.find(item => item.id === id)?.filePath || id}</button>)}</details>}{!availableEvidenceIds.length && <p className="semantic-muted">当前实体无可用源码锚点。</p>}</div></section>}
        <TextItems title="分析限制" values={selectedNode?.limitations || selectedEdge?.limitations || flow?.limitations || []} />
        {ready && !selectedCodeNode && !selectedCodeEdge && <section className="semantic-review-section"><h4>人工复核 · {selectedNode ? '当前解释' : selectedEdge ? '当前关系' : '当前流程'}</h4><p className="semantic-muted">确认说明不会提升底层调用、顺序或协议的验证等级。</p><div className="semantic-review-actions"><button disabled={!!operation || reviewState === 'confirmed'} onClick={() => void operationRequest('review', 'confirmed')}><Check size={12} />确认</button><button disabled={!!operation || reviewState === 'rejected'} onClick={() => void operationRequest('review', 'rejected')}><X size={12} />拒绝</button><button disabled={!!operation || reviewState === 'pending'} onClick={() => void operationRequest('review', 'pending')}>撤回复核</button></div></section>}
        {flow?.diagnostics.length ? <details><summary>扫描与模型诊断 · {flow.diagnostics.length}</summary>{flow.diagnostics.map((item, index) => <p className="semantic-muted" key={index}>{item.message}</p>)}</details> : null}
      </div><footer><button disabled={!ready} onClick={() => { setCandidate(undefined); setEditorOpen(true); }}><Pencil size={12} />编辑解释与分组</button><button title="按当前源码局部重新核验，保留人工文字" disabled={!ready || !!operation} onClick={() => void operationRequest('rebuild')}><RefreshCw size={12} />核验</button><button title="生成本地规则候选，不自动保存" disabled={!ready || !!operation} onClick={() => void operationRequest('generate')}><Sparkles size={12} />规则候选</button></footer></aside>}
    </div>
    {operationError && <Notice message={operationError} onReload={conflict ? refresh : undefined} />}{candidate && <div className="semantic-candidate"><div><strong>规则候选 · 尚未保存</strong><p>{candidate.flow.title} · {candidate.flow.groups.length} 组 / {candidate.flow.steps.length} 步 · {candidate.generatorVersion}</p></div><details><summary>预览候选解释</summary>{candidate.flow.steps.map(step => <section key={step.id}><strong>{step.title}</strong><p>{step.summary}</p><p>{step.detail}</p></section>)}</details><button onClick={() => setEditorOpen(true)}>采用到编辑草稿</button><button onClick={() => setCandidate(undefined)}>丢弃候选</button></div>}
    <div className="semantic-source-toggle"><button aria-label={sourceOpen ? '收起语义源码证据' : '展开语义源码证据'} onClick={() => setSourceOpen(value => !value)}>{sourceOpen ? <PanelBottomClose size={13} /> : <PanelBottomOpen size={13} />}源码证据{sourceBusy && <Loader2 className="spinner" size={12} />}</button><span title={metadata?.viewRevision}>语义 {metadata?.viewRevision.slice(0, 10) || '—'} · 源码 {metadata?.sourceRevision.slice(0, 8) || '—'}</span></div>
    {sourceOpen && <section className="semantic-source" data-selection-id={selection?.id || ''}>{sourceError ? <Notice message={sourceError} onReload={conflict ? refresh : undefined} /> : sourceBusy ? <div className="semantic-empty">正在读取当前证据…</div> : source && ready ? <SourcePreview source={source} rootPath={rootPath} nodeId={selection?.id} /> : <div className="semantic-empty">选择解释、实现或关系，点击证据查看授权目录内的源码。</div>}</section>}
    {editorOpen && flow && metadata && <SemanticEditor scope={scope} flowId={flow.id} viewRevision={metadata.viewRevision} resolvedFlow={flow} candidate={candidate?.flow} onClose={() => setEditorOpen(false)} onSaved={() => { setCandidate(undefined); refresh(); }} />}
  </div>;
}

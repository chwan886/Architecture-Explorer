import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Code2, Columns2, FileCode2, Layers3, LayoutGrid, PanelBottomClose, PanelBottomOpen, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { ControlCommand, EntityRef, AnalysisStep } from '../../../../packages/control-protocol/src/types';
import type { ArchitectureNode, ArchitectureEdge } from '../../../../packages/schema/src/index';
import type { ResolvedSemanticFlow, SemanticMode } from '../../../../packages/semantic-model/src/types';
import type { EvidenceContent } from '../api';
import GraphCanvas from '../GraphCanvas';
import type { CanvasSettlement, GraphCardPresentation } from '../GraphCanvas';
import SourcePreview from '../SourcePreview';
import SemanticCanvas from '../semantics/SemanticCanvas';
import { codeMapping, visibleSemanticGraph, visibleSemanticMatches } from '../semantics/graph';
import { originLabels, reviewLabels, statusLabels, verificationLabels } from '../semantics/labels';
import { confidenceLabels, edgeLabels, nodeLabels } from '../labels';
import type { BrowserActual } from './browser';

interface Selection { ref: EntityRef; edge?: boolean }
interface History { selection?: Selection; evidenceId: string; mode: SemanticMode; expanded: string[] }
export interface IntegrationWorkspaceProps {
  command: ControlCommand; highlightsEnabled: boolean; staleMessage: string; rootPath: string;
  onPresented: (commandId: string, actual: BrowserActual) => void; onFailed: (commandId: string, message: string) => void;
  onOpenCode: (nodeId: string, evidenceId?: string) => void; onOpenArchitecture?: (rootId: string) => void; onReturn: () => void;
}
const EMPTY_IDS: string[] = [];
export function requestedExpandedGroups(groups: { id: string; childIds: string[] }[], required: ReadonlySet<string>, detailed: boolean) {
  return groups.filter(group => group.childIds.some(id => required.has(id)) || (detailed && (required.has(group.id) || (!required.size && group.id === groups[0]?.id)))).map(group => group.id);
}
export function semanticFocusTargets(flow: ResolvedSemanticFlow, focus: EntityRef | undefined, visibleIds: ReadonlySet<string>, fallbackIds: string[] = []) {
  if (focus?.layer === 'semantic' && visibleIds.has(focus.id)) return [focus.id];
  const ids = focus?.layer === 'semantic' ? [focus.id] : focus?.layer === 'code' ? flow.reverseNodes[focus.id] || [] : fallbackIds;
  return [...visibleSemanticMatches(flow, ids, visibleIds)];
}
function Items({ title, values }: { title: string; values: string[] }) { return values.length ? <section><h4>{title}</h4><ul>{values.map((value, index) => <li key={index}>{value}</li>)}</ul></section> : null; }
export default function IntegrationWorkspace({ command, highlightsEnabled, staleMessage, rootPath, onPresented, onFailed, onOpenCode, onOpenArchitecture, onReturn }: IntegrationWorkspaceProps) {
  const { resolved } = command, { presentation, snapshot } = resolved, flow = resolved.semantic?.flow, architecture = resolved.architecture;
  const [mode, setMode] = useState<SemanticMode>(flow ? presentation.viewMode : 'code');
  const [selection, setSelection] = useState<Selection | undefined>(presentation.focusNodeId ? { ref: presentation.focusNodeId } : undefined);
  const requestedSemanticEdges = [...flow?.summaryEdges || [], ...flow?.detailEdges || []].filter(edge => presentation.highlightedEdgeIds.some(ref => ref.layer === 'semantic' && ref.id === edge.id));
  const requiredDetails = new Set([...presentation.highlightedNodeIds.filter(ref => ref.layer === 'semantic').map(ref => ref.id), ...(presentation.focusNodeId?.layer === 'semantic' ? [presentation.focusNodeId.id] : []), ...requestedSemanticEdges.flatMap(edge => [edge.source, edge.target])]);
  const [expanded, setExpanded] = useState<string[]>(requestedExpandedGroups(flow?.summaryNodes || [], requiredDetails, presentation.semanticGranularity === 'detailed'));
  const [history, setHistory] = useState<History[]>([]), [sourceOpen, setSourceOpen] = useState(!!resolved.evidence), [source, setSource] = useState<EvidenceContent | undefined>(resolved.evidence);
  const [evidenceId, setEvidenceId] = useState(resolved.evidence?.evidence.id || ''), [sourceError, setSourceError] = useState(''), [sourceBusy, setSourceBusy] = useState(false), [sourceEpoch, setSourceEpoch] = useState(0);
  const [evidenceLimit, setEvidenceLimit] = useState(24);
  const [layoutToken, setLayoutToken] = useState(0), [graphReady, setGraphReady] = useState<CanvasSettlement & { token: string }>(), [semanticReady, setSemanticReady] = useState<CanvasSettlement & { token: string }>();
  const [stepHighlights, setStepHighlights] = useState<{ nodes: string[]; edges: string[] }>();
  const sourceSequence = useRef(0), selectedRef = useRef(selection), callbacks = useRef({ onPresented, onFailed }); selectedRef.current = selection; callbacks.current = { onPresented, onFailed };
  const acknowledged = useRef('');
  const previousCommand = useRef(command), previousFocus = useRef(JSON.stringify(presentation.focusNodeId));
  const codeGraph = resolved.codeGraph || flow?.codeGraph;
  const graph = architecture?.graph || codeGraph;
  const graphNodes = architecture?.graph.nodes || codeGraph?.nodes || [];
  const graphEdges = architecture?.graph.edges || codeGraph?.edges || [];
  const allCodeNodes = flow?.codeNodes || codeGraph?.nodes || [];
  const codeNode = selection?.ref.layer === 'code' && !selection.edge ? allCodeNodes.find(node => node.id === selection.ref.id) : undefined;
  const codeEdge = selection?.ref.layer === 'code' && selection.edge ? (flow?.codeEdges || codeGraph?.edges || []).find(edge => edge.id === selection.ref.id) : undefined;
  const semanticNode = selection?.ref.layer === 'semantic' && !selection.edge ? [...flow?.summaryNodes || [], ...flow?.detailNodes || []].find(node => node.id === selection.ref.id) : undefined;
  const semanticEdge = selection?.ref.layer === 'semantic' && selection.edge ? [...flow?.summaryEdges || [], ...flow?.detailEdges || []].find(edge => edge.id === selection.ref.id) : undefined;
  const entity = selection?.ref.layer === 'architecture' && !selection.edge ? architecture?.entities.find(entity => entity.id === selection.ref.id || entity.nodeId === selection.ref.id) : undefined;
  const architectureEdge = selection?.ref.layer === 'architecture' && selection.edge ? architecture?.relations.find(edge => edge.id === selection.ref.id) : undefined;
  const selectedGraphId = codeNode?.id || entity?.nodeId || (selection?.ref.layer === 'architecture' && !selection.edge ? selection.ref.id : undefined);
  const visible = useMemo(() => {
    if (!flow) return { nodes: [], edges: [], hiddenEdges: 0 };
    const value = visibleSemanticGraph(flow, new Set(expanded));
    const retained = flow.summaryNodes.filter(node => requiredDetails.has(node.id) && !value.nodes.some(item => item.id === node.id));
    const nodes = [...value.nodes, ...retained], ids = new Set(nodes.map(node => node.id));
    const edges = [...flow.summaryEdges, ...flow.detailEdges].filter(edge => ids.has(edge.source) && ids.has(edge.target));
    return { nodes, edges, hiddenEdges: flow.summaryEdges.length + flow.detailEdges.length - edges.length };
  }, [flow, expanded]);
  const codeHighlights = new Set(highlightsEnabled ? resolved.highlights.codeNodeIds : EMPTY_IDS), codeEdgeHighlights = new Set(highlightsEnabled ? resolved.highlights.codeEdgeIds : EMPTY_IDS);
  const semanticIds = new Set(highlightsEnabled ? resolved.highlights.semanticNodeIds : EMPTY_IDS), semanticEdgeIds = new Set(highlightsEnabled ? resolved.highlights.semanticEdgeIds : EMPTY_IDS);
  if (flow && (semanticNode || semanticEdge)) { const mapping = codeMapping(flow, semanticNode, semanticEdge); mapping.nodeIds.forEach(id => codeHighlights.add(id)); mapping.edgeIds.forEach(id => codeEdgeHighlights.add(id)); }
  if (codeNode && flow) (flow.reverseNodes[codeNode.id] || []).forEach(id => semanticIds.add(id));
  if (codeEdge && flow) (flow.reverseEdges[codeEdge.id] || []).forEach(id => { semanticEdgeIds.add(id); const edge = flow.detailEdges.find(edge => edge.id === id); if (edge) { semanticIds.add(edge.source); semanticIds.add(edge.target); } });
  stepHighlights?.nodes.forEach(id => codeHighlights.add(id)); stepHighlights?.edges.forEach(id => codeEdgeHighlights.add(id));
  const semanticHighlights = flow ? visibleSemanticMatches(flow, [...semanticIds], new Set(visible.nodes.map(node => node.id))) : semanticIds;
  const architectureHighlights = new Set(highlightsEnabled ? resolved.highlights.architectureNodeIds : EMPTY_IDS), architectureEdgeHighlights = new Set(highlightsEnabled ? resolved.highlights.architectureEdgeIds : EMPTY_IDS);
  const graphPresentation = useMemo(() => Object.fromEntries((architecture?.entities || []).map(entity => [entity.nodeId, { kindLabel: entity.entityKind === 'system' ? '业务系统' : '职责模块', summary: entity.responsibility, badge: reviewLabels[entity.reviewState], footer: `${entity.memberNodeIds.length} 个成员` } satisfies GraphCardPresentation])), [architecture]);
  const evidenceIds = [...new Set([...(codeNode?.evidenceIds || codeEdge?.evidenceIds || semanticNode?.evidenceIds || semanticEdge?.evidenceIds || entity?.evidenceIds || architectureEdge?.evidenceIds || []), ...presentation.evidenceIds])];
  useEffect(() => { setEvidenceLimit(24); }, [selection?.ref.id, selection?.edge, command.commandId]);
  const title = codeNode?.label || semanticNode?.title || semanticEdge?.title || entity?.name || (architectureEdge && edgeLabels[architectureEdge.kind]) || (codeEdge && edgeLabels[codeEdge.kind]) || presentation.title;
  const focusNodes = [...new Set([...(selectedGraphId ? [selectedGraphId] : []), ...(architecture ? architectureHighlights : codeHighlights)])];
  const [batchFocus, setBatchFocus] = useState<{ ids: string[]; token: number }>(() => ({ ids: focusNodes, token: 1 }));
  const [semanticBatchFocus, setSemanticBatchFocus] = useState<{ ids: string[]; token: number }>();
  const previousSemanticFocus = useRef(''), semanticFocusSequence = useRef(0);
  const effectiveSemanticFocus = presentation.focusNodeId || selection?.ref;
  const semanticFocusKey = `${mode}:${snapshot.indexSnapshotId}:${JSON.stringify(effectiveSemanticFocus || null)}:${visible.nodes.map(node => node.id).join('|')}:${visible.edges.map(edge => edge.id).join('|')}`;
  useLayoutEffect(() => {
    if (!flow || mode === 'code' || previousSemanticFocus.current === semanticFocusKey) return;
    previousSemanticFocus.current = semanticFocusKey;
    const ids = semanticFocusTargets(flow, effectiveSemanticFocus, new Set(visible.nodes.map(node => node.id)), [...requiredDetails]);
    setSemanticBatchFocus({ ids, token: ++semanticFocusSequence.current });
  }, [semanticFocusKey]);
  const token = `${command.commandId}:${mode}`;
  useLayoutEffect(() => {
    if (previousCommand.current.commandId === command.commandId) return;
    sourceSequence.current++; acknowledged.current = ''; setGraphReady(undefined); setSemanticReady(undefined); setStepHighlights(undefined); setSourceError(''); setSourceBusy(false);
    const nextFocus = JSON.stringify(presentation.focusNodeId);
    if (presentation.focusNodeId) { const next = { ref: presentation.focusNodeId }; selectedRef.current = next; setSelection(next); }
    setMode(flow ? presentation.viewMode : 'code');
    if (flow) {
      const requiredExpanded = requestedExpandedGroups(flow.summaryNodes, requiredDetails, presentation.semanticGranularity === 'detailed');
      const granularityChanged = previousCommand.current.resolved.presentation.semanticGranularity !== presentation.semanticGranularity;
      setExpanded(value => granularityChanged ? requiredExpanded : [...new Set([...value, ...requiredExpanded])]);
    }
    setEvidenceId(resolved.evidence?.evidence.id || ''); setSource(resolved.evidence); setSourceEpoch(0); if (resolved.evidence) setSourceOpen(true);
    if (presentation.focusNodeId && nextFocus !== previousFocus.current) {
      const ref = presentation.focusNodeId;
      const ids = ref.layer === 'code' ? [ref.id] : ref.layer === 'architecture' ? [architecture?.entities.find(entity => entity.id === ref.id)?.nodeId || ref.id] : [...codeMapping(flow!, [...flow?.summaryNodes || [], ...flow?.detailNodes || []].find(node => node.id === ref.id)).nodeIds];
      setBatchFocus(value => ({ ids, token: value.token + 1 }));
    }
    previousFocus.current = nextFocus; previousCommand.current = command;
  }, [command.commandId]);
  const choose = (next?: Selection, preferredEvidence?: string) => {
    setHistory(value => [...value, { selection, evidenceId, mode, expanded }].slice(-40)); sourceSequence.current++; selectedRef.current = next; setSelection(next); setSource(undefined); setSourceError(''); setStepHighlights(undefined);
    const node = next?.ref.layer === 'code' ? allCodeNodes.find(node => node.id === next.ref.id) : next?.ref.layer === 'semantic' ? [...flow?.summaryNodes || [], ...flow?.detailNodes || []].find(node => node.id === next.ref.id) : architecture?.entities.find(entity => entity.id === next?.ref.id || entity.nodeId === next?.ref.id);
    const edge = next?.edge ? next.ref.layer === 'code' ? (flow?.codeEdges || codeGraph?.edges || []).find(edge => edge.id === next.ref.id) : next.ref.layer === 'semantic' ? [...flow?.summaryEdges || [], ...flow?.detailEdges || []].find(edge => edge.id === next.ref.id) : architecture?.relations.find(edge => edge.id === next.ref.id) : undefined;
    setEvidenceId(preferredEvidence || edge?.evidenceIds[0] || node?.evidenceIds[0] || ''); setSourceEpoch(value => value + 1);
  };
  const activateEvidence = (id: string) => { sourceSequence.current++; setEvidenceId(id); setSource(undefined); setSourceError(''); setSourceOpen(true); setSourceEpoch(value => value + 1); };
  const back = () => { const previous = history.at(-1); if (!previous) return; sourceSequence.current++; selectedRef.current = previous.selection; setSelection(previous.selection); setEvidenceId(previous.evidenceId); setMode(previous.mode); setExpanded(previous.expanded); setSource(undefined); setSourceError(''); setSourceEpoch(value => value + 1); setHistory(value => value.slice(0, -1)); };
  const openStep = (step: AnalysisStep) => {
    if (step.semanticNodeId && flow) { const group = flow.summaryNodes.find(group => group.childIds.includes(step.semanticNodeId!)); if (group) setExpanded(value => [...new Set([...value, group.id])]); choose({ ref: { layer: 'semantic', id: step.semanticNodeId, flowId: flow.id } }, step.evidenceIds[0]); }
    else if (step.codeNodeIds[0]) choose({ ref: { layer: 'code', id: step.codeNodeIds[0] } }, step.evidenceIds[0]);
    setStepHighlights({ nodes: step.codeNodeIds, edges: step.codeEdgeIds }); setBatchFocus(value => ({ ids: step.codeNodeIds, token: value.token + 1 })); if (step.evidenceIds.length) setSourceOpen(true);
  };
  const enterGraphNode = (node: ArchitectureNode) => {
    const logical = architecture?.entities.find(entity => entity.nodeId === node.id);
    if (logical) { if (onOpenArchitecture) onOpenArchitecture(logical.id); else choose({ ref: { layer: 'architecture', id: logical.id } }); }
    else onOpenCode(node.id);
  };
  useEffect(() => {
    const request = ++sourceSequence.current; if (staleMessage) { setSource(undefined); setSourceBusy(false); return; }
    if (!evidenceId) { setSource(undefined); setSourceBusy(false); return; }
    if (sourceEpoch === 0 && resolved.evidence?.evidence.id === evidenceId) { setSourceBusy(false); if (resolved.evidence.revision !== snapshot.indexSnapshotId || resolved.evidence.stale) { setSource(undefined); setSourceError('分析证据与当前快照不一致。'); callbacks.current.onFailed(command.commandId, '分析证据与当前快照不一致。'); } else { setSource(resolved.evidence); } return; }
    const controller = new AbortController(), stamp = selectedRef.current; setSource(undefined); setSourceBusy(true); setSourceError('');
    const prefix = flow ? '/api/semantics/evidence/' : architecture ? '/api/architecture/evidence/' : '/api/evidence/';
    const url = new URL(`${prefix}${encodeURIComponent(evidenceId)}`, window.location.origin); url.searchParams.set('scope', snapshot.scopeId); if (flow && resolved.semantic) url.searchParams.set('viewRevision', resolved.semantic.metadata.viewRevision); else if (architecture) url.searchParams.set('viewRevision', architecture.metadata.viewRevision);
    fetch(url, { signal: controller.signal }).then(async response => { if (!response.ok) throw new Error(`${response.status} · ${await response.text()}`); return response.json() as Promise<EvidenceContent>; }).then(value => {
      if (controller.signal.aborted || request !== sourceSequence.current || selectedRef.current !== stamp) return;
      if (value.evidence.id !== evidenceId || value.revision !== snapshot.indexSnapshotId || value.stale) throw new Error('证据ID、源码版本或有效状态与分析快照不匹配。'); setSource(value);
    }).catch(failure => { if (!controller.signal.aborted && request === sourceSequence.current) { const message = failure instanceof Error ? failure.message : String(failure); setSourceError(message); callbacks.current.onFailed(command.commandId, message); } }).finally(() => { if (request === sourceSequence.current) setSourceBusy(false); });
    return () => controller.abort();
  }, [command.commandId, evidenceId, sourceEpoch, staleMessage, snapshot.indexSnapshotId]);
  useEffect(() => {
    if (acknowledged.current === command.commandId || staleMessage) return;
    const needsGraph = !flow || mode !== 'explanation', needsSemantic = !!flow && mode !== 'code';
    if ((needsGraph && graph?.nodes.length && graphReady?.token !== token) || (needsSemantic && visible.nodes.length && semanticReady?.token !== token)) return;
    if (needsSemantic && semanticBatchFocus?.ids.length && semanticReady?.focusToken !== semanticBatchFocus.token) return;
    if (graphReady?.error || semanticReady?.error || sourceError) { callbacks.current.onFailed(command.commandId, graphReady?.error || semanticReady?.error || sourceError); return; }
    if (resolved.evidence && (sourceBusy || source?.evidence.id !== resolved.evidence.evidence.id)) return;
    const nodeIds = [...new Set([...(needsGraph ? graphReady?.nodeIds || [] : []), ...(needsSemantic ? semanticReady?.nodeIds || [] : [])])];
    const edgeIds = [...new Set([...(needsGraph ? graphReady?.edgeIds || [] : []), ...(needsSemantic ? semanticReady?.edgeIds || [] : [])])];
    acknowledged.current = command.commandId; callbacks.current.onPresented(command.commandId, { scopeId: snapshot.scopeId, indexSnapshotId: snapshot.indexSnapshotId, ...(presentation.focusNodeId ? { focusNodeId: presentation.focusNodeId } : {}), visibleNodeIds: nodeIds, visibleEdgeIds: edgeIds, ...(resolved.evidence && source ? { evidenceId: source.evidence.id } : {}) });
  }, [command.commandId, mode, graphReady, semanticReady, semanticBatchFocus, source, sourceBusy, sourceError, staleMessage, graph, visible.nodes.length]);
  const selectedNodeId = codeNode?.id;
  return <section className={`control-workspace mode-${mode} ${sourceOpen ? 'source-open' : ''}`} data-command-id={command.commandId} data-selection-id={selection?.ref.id || ''} data-scope={snapshot.scopeId}>
    <header className="control-analysis-heading"><div><span>CODEX 分析 · 当前快照</span><h1>{presentation.title}</h1><p>{presentation.summary}</p></div><button onClick={onReturn}><ArrowLeft size={13} />返回原工作区</button></header>
    {staleMessage && <div className="control-warning" role="alert"><TriangleAlert size={13} />{staleMessage}</div>}
    {resolved.warnings.length > 0 && <details className="control-boundaries"><summary><ShieldCheck size={12} />分析范围与限制 · {resolved.warnings.length}</summary>{resolved.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
    <div className="control-map-toolbar"><button aria-label="返回上一联动上下文" disabled={!history.length} onClick={back}><ArrowLeft size={13} />返回</button><span>{title}</span>{flow && <div className="control-modes">{(['explanation', 'code', 'compare'] as SemanticMode[]).map(value => <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>{value === 'explanation' ? '业务解释' : value === 'code' ? '代码实现' : '双层对照'}</button>)}<button aria-pressed={!expanded.length} onClick={() => setExpanded([])}>简洁</button><button aria-pressed={!!expanded.length} onClick={() => setExpanded(value => value.length ? value : [flow.summaryNodes[0]?.id].filter(Boolean))}>详细</button></div>}<button data-control-automatic="true" onClick={() => setLayoutToken(value => value + 1)}><LayoutGrid size={13} />布局</button><button onClick={() => setSourceOpen(value => !value)}>{sourceOpen ? <PanelBottomClose size={13} /> : <PanelBottomOpen size={13} />}源码</button></div>
    <div className={`control-content ${presentation.orderedSteps.length ? "has-reading" : ""}`}>{presentation.orderedSteps.length > 0 && <aside className="control-reading"><h3>阅读顺序</h3><p>逐项查看分析依据；阅读次序不等同运行时调用。</p>{presentation.orderedSteps.map((step, index) => <button key={step.id} onClick={() => openStep(step)}><b>{index + 1}</b><span>{step.name}<small>{verificationLabels[step.verification]} · {step.orderBasis === 'call-path' ? '真实调用路径' : step.orderBasis === 'reading-order' ? '阅读顺序' : step.orderBasis === 'source-supported' ? '源码支持' : '顺序未验证'}</small></span></button>)}</aside>}
      <main className="control-canvases">{flow && mode !== 'code' && <section className="control-semantic-map"><SemanticCanvas identity={`control:${snapshot.scopeId}:${flow.id}:${mode}`} nodes={visible.nodes} edges={visible.edges} selectedId={semanticNode?.id} highlightedNodeIds={semanticHighlights} highlightedEdgeIds={semanticEdgeIds} layoutToken={layoutToken} batchFocusRequest={semanticBatchFocus} onFocusHandled={() => {}} presentationToken={token} onSettled={(settledToken, value) => setSemanticReady({ ...value, token: settledToken })} onNode={node => choose({ ref: { layer: 'semantic', id: node.id, flowId: flow.id } })} onEdge={edge => choose({ ref: { layer: 'semantic', id: edge.id, flowId: flow.id }, edge: true })} onExpand={id => setExpanded(value => value.includes(id) ? value.filter(item => item !== id) : [...value, id])} /><div className="control-map-foot">语义解释层 · {visible.nodes.length} 节点{expanded.length > 0 && ` · 局部展开 ${expanded.length} 组`}{visible.hiddenEdges > 0 && ` · ${visible.hiddenEdges} 条其他粒度关系保留`}</div></section>}
        {(!flow || mode !== 'explanation') && <section className="control-code-map">{graph?.nodes.length ? <GraphCanvas graph={graph} selectedId={selectedGraphId} highlightedNodeIds={architecture ? architectureHighlights : codeHighlights} highlightedEdgeIds={architecture ? architectureEdgeHighlights : codeEdgeHighlights} view={`control:${snapshot.scopeId}:${presentation.targetView}:${mode}`} onSelect={node => choose({ ref: { layer: architecture ? 'architecture' : 'code', id: architecture?.entities.find(entity => entity.nodeId === node.id)?.id || node.id } })} onEnter={enterGraphNode} onRelation={edge => choose({ ref: { layer: architecture ? 'architecture' : 'code', id: edge.id }, edge: true })} layoutToken={layoutToken} batchFocusRequest={batchFocus} onFocusHandled={() => {}} presentationToken={token} onSettled={(settledToken, value) => setGraphReady({ ...value, token: settledToken })} preserveFocusOnResize cardPresentations={architecture ? graphPresentation : undefined} layoutMode={architecture && graph.nodes.length <= 8 ? 'grid' : 'elk'} /> : <div className="control-empty">此分析没有可呈现的代码图。</div>}<div className="control-map-foot">{architecture ? '职责投影' : '代码事实层'} · {graphNodes.length} 节点 · {graphEdges.length} 关系</div></section>}
      </main><aside className="control-inspector"><h2>{title}</h2>{codeNode && <><span className="control-tag">{nodeLabels[codeNode.kind]} · {codeNode.language}</span><code>{codeNode.qualifiedName}</code><p>{codeNode.summary || codeNode.signature || codeNode.filePath}</p><button onClick={() => onOpenCode(codeNode.id, evidenceId || undefined)}><ArrowUpRight size={12} />在代码地图继续探索</button></>}{codeEdge && <><span className="control-tag">{confidenceLabels[codeEdge.confidence]}</span><p>{codeEdge.rule}</p>{codeEdge.condition && <p>条件：{codeEdge.condition}</p>}<Items title="分析限制" values={codeEdge.limitations || []} /></>}{semanticNode && <><span className="control-tag">{originLabels[semanticNode.origin]} · {reviewLabels[semanticNode.reviewState]} · {statusLabels[semanticNode.status]}</span><p>{semanticNode.summary}</p><Items title="目的" values={semanticNode.purpose ? [semanticNode.purpose] : []} /><Items title="处理说明" values={semanticNode.detail ? [semanticNode.detail] : []} /><Items title="输入" values={semanticNode.inputs} /><Items title="处理" values={semanticNode.processing} /><Items title="输出" values={semanticNode.outputs} /><Items title="变化" values={semanticNode.changes} /><Items title="控制边界" values={semanticNode.controls.map(control => control.description)} /><Items title="分析限制" values={semanticNode.limitations} /></>}{semanticEdge && <><span className="control-tag">{verificationLabels[semanticEdge.verification]}</span><p>{semanticEdge.description}</p><Items title="条件" values={semanticEdge.conditions} /><Items title="边界" values={semanticEdge.boundaries} /><Items title="分析限制" values={semanticEdge.limitations} /></>}{entity && <><span className="control-tag">{reviewLabels[entity.reviewState]}</span><p>{entity.responsibility}</p>{onOpenArchitecture && <button data-open-architecture={entity.id} onClick={() => onOpenArchitecture(entity.id)}><Layers3 size={12} />进入内部结构</button>}<Items title="输入" values={entity.inputs} /><Items title="输出" values={entity.outputs} /><Items title="功能" values={entity.features} /></>}{architectureEdge && <><p>{edgeLabels[architectureEdge.kind]}</p><p>{architectureEdge.totalMembers} 条底层事实，聚合关系不证明执行顺序。</p></>}
        {(semanticNode?.codeNodeIds.length || 0) > 0 && <section><h4>全部实现 · {semanticNode!.codeNodeIds.length}</h4>{semanticNode!.codeNodeIds.map(id => <button key={id} onClick={() => choose({ ref: { layer: 'code', id } })}><Code2 size={12} />{allCodeNodes.find(node => node.id === id)?.label || id}</button>)}</section>}{codeNode && flow && <section><h4>关联业务解释</h4>{(flow.reverseNodes[codeNode.id] || []).map(id => <button key={id} onClick={() => choose({ ref: { layer: 'semantic', id, flowId: flow.id } })}><Layers3 size={12} />{flow.detailNodes.find(node => node.id === id)?.title || id}</button>)}</section>}
        <section><h4>源码证据 · {evidenceIds.length}</h4>{evidenceIds.slice(0, evidenceLimit).map(id => <button key={id} data-evidence-id={id} className={id === evidenceId ? 'active' : ''} onClick={() => activateEvidence(id)} disabled={!!staleMessage}><FileCode2 size={12} /><span>{flow?.evidence.find(evidence => evidence.id === id)?.filePath || (resolved.evidence?.evidence.id === id ? `${resolved.evidence.evidence.filePath}:${resolved.evidence.evidence.startLine}` : id)}</span></button>)}{evidenceIds.length > evidenceLimit && <button onClick={() => setEvidenceLimit(value => value + 24)}>加载更多证据 · 已显示 {evidenceLimit}/{evidenceIds.length}</button>}</section><p className="control-muted">源 {snapshot.indexSnapshotId.slice(0, 12)}<br />scope {snapshot.scopeId}</p></aside>
    </div>{sourceOpen && <section className="control-source">{sourceError ? <div className="control-warning" role="alert">{sourceError}</div> : sourceBusy ? <div className="control-empty">正在核验当前快照证据…</div> : source ? <SourcePreview source={source} rootPath={rootPath} nodeId={selectedNodeId || selection?.ref.id} /> : <div className="control-empty">选择证据查看授权目录内的源码。</div>}</section>}
  </section>;
}

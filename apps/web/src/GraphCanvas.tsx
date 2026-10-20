import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, BaseEdge, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, getSmoothStepPath, useEdgesState, useNodesState, useReactFlow, useViewport } from '@xyflow/react';
import type { Edge, EdgeProps, Node, NodeProps, Viewport, XYPosition } from '@xyflow/react';
import { Box, ChevronRight, Expand, LayoutGrid, Minus, Plus, RotateCcw } from 'lucide-react';
import type { ArchitectureEdge, ArchitectureNode, GraphResult } from '../../../packages/schema/src/index';
import { confidenceLabels, edgeLabels, expandableKinds, nodeLabels, shortPath } from './labels';
import { edgeForKeyboardActivation, nodeForKeyboardActivation } from './selection';

export interface GraphCardPresentation { kindLabel?: string; summary?: string; badge?: string; footer?: string }
export interface CanvasSettlement { nodeIds: string[]; edgeIds: string[]; error?: string; focusToken?: number }
type ExplorerNode = Node<{ entity: ArchitectureNode; connections: number; presentation?: GraphCardPresentation; highlighted?: boolean; size?: { width: number; height: number } }, 'entity'>;
const DEFAULT_NODE_SIZE = { width: 258, height: 108 };
interface CanvasSnapshot { positions: Record<string, XYPosition>; viewport: Viewport }
// Session memory is bounded and scoped by graph identity, whose IDs include the
// authorized worktree. It survives an empty result temporarily unmounting a graph.
const canvasSnapshots = new Map<string, CanvasSnapshot>();
function rememberCanvas(key: string, nodes: ExplorerNode[], viewport: Viewport) {
  canvasSnapshots.delete(key);
  canvasSnapshots.set(key, { positions: Object.fromEntries(nodes.map(node => [node.id, { ...node.position }])), viewport: { ...viewport } });
  while (canvasSnapshots.size > 48) canvasSnapshots.delete(canvasSnapshots.keys().next().value!);
}
const elkLoader = () => import('elkjs/lib/elk.bundled.js').then(module => new module.default());
let elkPromise: ReturnType<typeof elkLoader> | undefined;
const EntityNode = memo(function EntityNode({ data, selected }: NodeProps<ExplorerNode>) {
  const { entity } = data;
  return <div className={`entity-card kind-${entity.kind} ${selected ? 'is-selected' : ''} ${data.presentation ? 'architecture-card' : ''}`} style={{ width: data.size?.width, minHeight: data.size?.height, opacity: data.highlighted === false && !selected ? 'var(--canvas-muted-opacity, .3)' : 1, outline: data.highlighted ? '2px solid #77a7c7' : undefined, outlineOffset: data.highlighted ? 3 : undefined }}>
    <Handle type="target" position={Position.Left} />
    <div className="entity-head"><span className="entity-symbol"><Box size={15} /></span><span className="entity-kind">{data.presentation?.kindLabel || nodeLabels[entity.kind]}</span><span className="entity-language">{data.presentation?.badge || (entity.language === 'unknown' ? '目录' : entity.language === 'csharp' ? 'C#' : entity.language)}</span></div>
    <div className="entity-name" title={entity.qualifiedName}>{entity.label}</div>
    {data.presentation?.summary && <div className="entity-summary">{data.presentation.summary}</div>}<div className="entity-footer"><span title={entity.filePath}>{data.presentation?.footer || shortPath(entity.filePath)}</span><span>{data.connections > 0 ? `${data.connections} 关系` : expandableKinds.has(entity.kind) ? <><ChevronRight size={12} />展开</> : '符号'}</span></div>
    <Handle type="source" position={Position.Right} />
  </div>;
});
const nodeTypes = { entity: EntityNode };
function EvidenceEdge({ edge, path, labelX, labelY }: { edge: EdgeProps; path: string; labelX: number; labelY: number }) {
  const activate = edge.data?.activate;
  return <><BaseEdge id={edge.id} path={path} markerEnd={edge.markerEnd} style={edge.style} interactionWidth={20} />{edge.label && <EdgeLabelRenderer><button type="button" className="nodrag nopan graph-edge-label" data-edge-id={edge.id} title={String(edge.data?.description || edge.label)} aria-label={String(edge.data?.description || edge.label)} onClick={event => { event.preventDefault(); event.stopPropagation(); if (typeof activate === 'function') activate(); }} style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`, pointerEvents: 'all', zIndex: 20, padding: '3px 6px', border: '1px solid #354354', borderRadius: 4, background: '#111923', color: '#aebdd4', fontSize: 10, lineHeight: '14px', whiteSpace: 'nowrap', opacity: edge.style?.opacity }}>{edge.label}</button></EdgeLabelRenderer>}</>;
}
function ReadableEdge(edge: EdgeProps) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX: edge.sourceX, sourceY: edge.sourceY, targetX: edge.targetX, targetY: edge.targetY, sourcePosition: edge.sourcePosition, targetPosition: edge.targetPosition });
  return <EvidenceEdge edge={edge} path={path} labelX={labelX} labelY={labelY} />;
}
function ParallelEdge(edge: EdgeProps) {
  const { source, target, sourceX, sourceY, targetX, targetY, data } = edge;
  const offset = Number(data?.offset || 0);
  const self = source === target;
  const reach = self ? 90 : Math.max(45, Math.abs(targetX - sourceX) * .45);
  const bend = self ? -145 : offset;
  const c1x = sourceX + reach, c1y = sourceY + bend, c2x = targetX - reach, c2y = targetY + bend;
  const path = `M ${sourceX} ${sourceY} C ${c1x} ${c1y} ${c2x} ${c2y} ${targetX} ${targetY}`;
  return <EvidenceEdge edge={edge} path={path} labelX={(sourceX + 3 * c1x + 3 * c2x + targetX) / 8} labelY={(sourceY + 3 * c1y + 3 * c2y + targetY) / 8} />;
}
const edgeTypes = { parallel: ParallelEdge, readable: ReadableEdge };

export function refreshCodeEdgeMetadata(rendered: Edge, fact: ArchitectureEdge, options: { label?: string; pending?: boolean; highlightActive?: boolean; highlighted?: boolean } = {}): Edge {
  const uncertain = fact.confidence === 'inferred' || options.pending;
  const label = options.label || edgeLabels[fact.kind];
  const description = [label, confidenceLabels[fact.confidence], fact.rule, fact.condition && `条件：${fact.condition}`, fact.dispatch && `分派：${fact.dispatch}`, ...(fact.limitations || [])].filter(Boolean).join('；');
  return { ...rendered, source: fact.source, target: fact.target, label,
    data: { ...rendered.data, description },
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: uncertain ? '#d4aa65' : '#626e86' },
    style: { ...rendered.style, stroke: uncertain ? '#b89155' : fact.kind === 'writes' ? '#b78386' : fact.kind === 'reads' ? '#719eaa' : '#525f78', opacity: options.highlightActive && !options.highlighted ? .22 : 1, strokeWidth: options.highlightActive && options.highlighted ? 2.6 : 1.3, strokeDasharray: uncertain ? '5 4' : undefined },
    ariaLabel: `${options.pending ? '业务归属待复核；' : ''}${description}`,
  };
}

export function canvasResizeTargets(nodes: { id: string }[], selectedId?: string, highlightedIds?: ReadonlySet<string>) {
  const targets = nodes.filter(node => node.id === selectedId || highlightedIds?.has(node.id)).map(node => ({ id: node.id }));
  return targets.length ? targets : undefined;
}
export function observeCanvasResize(element: HTMLElement, isReady: () => boolean, onResize: () => void, debounceMs = 90) {
  if (typeof ResizeObserver === 'undefined') return () => {};
  let previous: { width: number; height: number } | undefined, timer: ReturnType<typeof setTimeout> | undefined, disposed = false;
  const flush = () => {
    if (disposed) return;
    if (!isReady()) { timer = setTimeout(flush, 35); return; }
    onResize();
  };
  const observer = new ResizeObserver(entries => {
    if (disposed) return;
    const rect = entries.find(entry => entry.target === element)?.contentRect;
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const next = { width: rect.width, height: rect.height };
    // The first measurement belongs to initialization/restored viewport. Only
    // later size changes may move the camera, never rearranging graph nodes.
    if (!previous) { previous = next; return; }
    if (Math.abs(next.width - previous.width) < 1 && Math.abs(next.height - previous.height) < 1) return;
    previous = next; clearTimeout(timer); timer = setTimeout(flush, debounceMs);
  });
  observer.observe(element);
  return () => { disposed = true; clearTimeout(timer); observer.disconnect(); };
}

function CanvasContent({ graph, selectedId, onSelect, onEnter, onRelation, layoutToken, focusRequest, batchFocusRequest, onFocusHandled, view, cardPresentations, edgeLabelOverrides, pendingEdgeIds, highlightedNodeIds, highlightedEdgeIds, preserveFocusOnResize = false, presentationToken, onSettled, nodeSize = DEFAULT_NODE_SIZE, layoutMode = 'elk' }: { graph: GraphResult; selectedId?: string; onSelect: (node: ArchitectureNode) => void; onEnter: (node: ArchitectureNode) => void; onRelation: (edge: ArchitectureEdge) => void; layoutToken: number; focusRequest?: { id: string; token: number }; batchFocusRequest?: { ids: string[]; token: number }; onFocusHandled: (token: number) => void; view: string; cardPresentations?: Record<string, GraphCardPresentation>; edgeLabelOverrides?: Record<string, string>; pendingEdgeIds?: Set<string>; highlightedNodeIds?: Set<string>; highlightedEdgeIds?: Set<string>; preserveFocusOnResize?: boolean; presentationToken?: string; onSettled?: (token: string, result: CanvasSettlement) => void; nodeSize?: { width: number; height: number }; layoutMode?: 'elk' | 'grid' }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<ExplorerNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [layoutError, setLayoutError] = useState('');
  const { fitView: rawFitView, zoomIn, zoomOut, getViewport, getNode, getNodes, setCenter: rawSetCenter, setViewport: rawSetViewport } = useReactFlow<ExplorerNode>();
  const cameraPending = useRef(0), cameraError = useRef('');
  const trackViewport = useCallback(<T,>(operation: Promise<T>) => { cameraPending.current++; return operation.catch(error => { cameraError.current = error instanceof Error ? error.message : String(error); }).finally(() => { cameraPending.current--; }); }, []);
  const fitView = useCallback((...args: Parameters<typeof rawFitView>) => trackViewport(rawFitView(...args)), [rawFitView, trackViewport]);
  const setCenter = useCallback((...args: Parameters<typeof rawSetCenter>) => trackViewport(rawSetCenter(...args)), [rawSetCenter, trackViewport]);
  const setViewport = useCallback((...args: Parameters<typeof rawSetViewport>) => trackViewport(rawSetViewport(...args)), [rawSetViewport, trackViewport]);
  const { zoom } = useViewport();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const layoutSequence = useRef(0);
  const layoutInFlight = useRef(false);
  const focusRef = useRef(focusRequest);
  focusRef.current = focusRequest;
  const handledFocus = useRef(0);
  const handledBatchFocus = useRef(0);
  const relationHandlerRef = useRef(onRelation); relationHandlerRef.current = onRelation;
  const graphRef = useRef(graph); graphRef.current = graph;
  const presentationRef = useRef({ edgeLabelOverrides, pendingEdgeIds, highlightedNodeIds, highlightedEdgeIds, cardPresentations, selectedId });
  presentationRef.current = { edgeLabelOverrides, pendingEdgeIds, highlightedNodeIds, highlightedEdgeIds, cardPresentations, selectedId };
  const activeGraphKey = useRef('');
  const previousLayoutToken = useRef(layoutToken);
  const graphSignature = useMemo(() => graph.nodes.map(n => n.id).sort().join('|') + ':' + graph.edges.map(e => e.id).sort().join('|'), [graph]);
  const graphKey = `${view}:${graph.rootId || ''}:${graphSignature}:${nodeSize.width}x${nodeSize.height}:${layoutMode}`;
  const saveCurrentCanvas = (moved?: ExplorerNode) => { if (activeGraphKey.current && !layoutInFlight.current) rememberCanvas(activeGraphKey.current, getNodes().map(node => moved?.id === node.id ? moved : node), getViewport()); };
  const focusHandledRef = useRef(onFocusHandled);
  focusHandledRef.current = onFocusHandled;
  const settledRef = useRef(onSettled); settledRef.current = onSettled;
  const settledToken = useRef('');

  useEffect(() => {
    const sequence = ++layoutSequence.current;
    cameraError.current = '';
    const forceLayout = previousLayoutToken.current !== layoutToken;
    previousLayoutToken.current = layoutToken;
    activeGraphKey.current = graphKey;
    const degree = new Map<string, number>();
    const highlightActive = !!(highlightedNodeIds?.size || highlightedEdgeIds?.size);
    graph.edges.forEach(edge => { degree.set(edge.source, (degree.get(edge.source) || 0) + 1); degree.set(edge.target, (degree.get(edge.target) || 0) + 1); });
    const nextNodes: ExplorerNode[] = graph.nodes.map(entity => ({ id: entity.id, type: 'entity', data: { entity, connections: degree.get(entity.id) || 0, presentation: cardPresentations?.[entity.id], highlighted: highlightActive ? highlightedNodeIds?.has(entity.id) || false : undefined, size: nodeSize }, position: { x: 0, y: 0 }, selected: entity.id === selectedId }));
    const ids = new Set(nextNodes.map(n => n.id));
    const pairKey = (source: string, target: string) => [source, target].sort().join('|');
    const pairs = new Map<string, string[]>();
    graph.edges.forEach(edge => { const key = pairKey(edge.source, edge.target); pairs.set(key, [...pairs.get(key) || [], edge.id]); });
    const nextEdges = graph.edges.filter(e => ids.has(e.source) && ids.has(e.target)).map(edge => {
      const pair = pairs.get(pairKey(edge.source, edge.target)) || [edge.id];
      return refreshCodeEdgeMetadata({
      id: edge.id, source: edge.source, target: edge.target, type: pair.length > 1 || edge.source === edge.target ? 'parallel' : 'readable', data: { offset: (pair.indexOf(edge.id) - (pair.length - 1) / 2) * 44, activate: () => { const current = graphRef.current.edges.find(item => item.id === edge.id); if (current) relationHandlerRef.current(current); } },
      labelStyle: { fill: '#a9b0bf', fontSize: 10 }, labelBgStyle: { fill: '#11151c', fillOpacity: .96 }, labelBgPadding: [6, 3] as [number, number],
    }, edge, { label: edgeLabelOverrides?.[edge.id], pending: pendingEdgeIds?.has(edge.id), highlightActive, highlighted: highlightedEdgeIds?.has(edge.id) }); });
    const currentEdges = () => { const options = presentationRef.current, active = !!(options.highlightedNodeIds?.size || options.highlightedEdgeIds?.size); return nextEdges.map(edge => { const fact = graphRef.current.edges.find(fact => fact.id === edge.id); return fact ? refreshCodeEdgeMetadata(edge, fact, { label: options.edgeLabelOverrides?.[edge.id], pending: options.pendingEdgeIds?.has(edge.id), highlightActive: active, highlighted: options.highlightedEdgeIds?.has(edge.id) }) : edge; }); };
    const currentNodes = (positioned: ExplorerNode[]) => { const options = presentationRef.current, active = !!(options.highlightedNodeIds?.size || options.highlightedEdgeIds?.size); return positioned.map(node => ({ ...node, selected: node.id === options.selectedId, data: { ...node.data, entity: graphRef.current.nodes.find(value => value.id === node.id) || node.data.entity, presentation: options.cardPresentations?.[node.id], highlighted: active ? options.highlightedNodeIds?.has(node.id) || false : undefined } })); };
    const cached = forceLayout ? undefined : canvasSnapshots.get(graphKey);
    if (cached) {
      layoutInFlight.current = true;
      setLayoutBusy(false); setLayoutError('');
      setNodes(currentNodes(nextNodes.map(node => ({ ...node, position: cached.positions[node.id] || node.position }))));
      setEdges(currentEdges());
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (sequence !== layoutSequence.current) return;
        void setViewport(cached.viewport, { duration: 0 }).then(() => {
          if (sequence !== layoutSequence.current) return;
          layoutInFlight.current = false;
          const focus = focusRef.current;
          if (focus && focus.token !== handledFocus.current && nextNodes.some(node => node.id === focus.id)) {
            handledFocus.current = focus.token;
            focusHandledRef.current(focus.token);
            void fitView({ nodes: [{ id: focus.id }], padding: .6, maxZoom: 1, duration: 250 });
          } else rememberCanvas(graphKey, getNodes(), getViewport());
        });
      }));
      return () => { saveCurrentCanvas(); layoutSequence.current++; };
    }
    setLayoutBusy(true); layoutInFlight.current = true; setLayoutError('');
    const applyLayout = (positioned: ExplorerNode[]) => {
      if (sequence !== layoutSequence.current) return;
      setNodes(currentNodes(positioned)); setEdges(currentEdges());
      setLayoutBusy(false);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (sequence !== layoutSequence.current) return;
        layoutInFlight.current = false;
        const focus = focusRef.current;
        if (focus && focus.token !== handledFocus.current && nextNodes.some(node => node.id === focus.id)) {
          handledFocus.current = focus.token;
          focusHandledRef.current(focus.token);
          void fitView({ nodes: [{ id: focus.id }], padding: .6, maxZoom: 1, duration: 250 });
        } else void fitView({ padding: layoutMode === 'grid' ? .08 : .12, minZoom: layoutMode === 'grid' ? .65 : .85, maxZoom: 1, duration: 180 }).then(() => {
          if (sequence !== layoutSequence.current) return;
          const targetId = nextNodes.some(node => node.id === selectedId) ? selectedId : graph.rootId;
          const target = targetId ? getNode(targetId) : undefined;
          const viewport = getViewport();
          const width = surfaceRef.current?.clientWidth || 750;
          const height = surfaceRef.current?.clientHeight || 400;
          if (!target) return;
          const left = target.position.x * viewport.zoom + viewport.x;
          const top = target.position.y * viewport.zoom + viewport.y;
          // Keep readable cards and bring the selected entity into the viewport;
          // users can pan to explore larger neighborhoods instead of tiny text.
          if (left < 22 || top < 42 || left + nodeSize.width * viewport.zoom > width - 22 || top + nodeSize.height * viewport.zoom > height - 50) {
            void setCenter(target.position.x + nodeSize.width / 2, target.position.y + nodeSize.height / 2, { zoom: viewport.zoom, duration: 160 });
          }
        });
      }));
    };
    if (layoutMode === 'grid' || graph.edges.length === 0) {
      // Unconnected architecture groups have no direction. Pick the grid that
      // preserves the largest readable card size within the current canvas.
      const width = Math.max(250, (surfaceRef.current?.clientWidth || 750) - 48);
      const height = Math.max(150, (surfaceRef.current?.clientHeight || 400) - 76);
      const candidates = nextNodes.length <= 1 ? [1] : [2, 3].filter(columns => columns <= nextNodes.length);
      const score = (columns: number) => Math.min(1, width / (columns * nodeSize.width + (columns - 1) * 36), height / (Math.ceil(nextNodes.length / columns) * nodeSize.height + (Math.ceil(nextNodes.length / columns) - 1) * 36));
      const columns = candidates.reduce((best, value) => score(value) > score(best) ? value : best, candidates[0]);
      applyLayout(nextNodes.map((node, index) => {
        const row = Math.floor(index / columns);
        const rowCount = Math.min(columns, nextNodes.length - row * columns);
        return { ...node, position: { x: (index % columns) * (nodeSize.width + 36) + (columns - rowCount) * (nodeSize.width + 36) / 2, y: row * (nodeSize.height + 36) } };
      }));
      return () => { saveCurrentCanvas(); layoutSequence.current++; };
    }
    const layered = { id: 'root', layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.spacing.nodeNode': '36', 'elk.layered.spacing.nodeNodeBetweenLayers': '95', 'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX', 'elk.padding': '[top=30,left=30,bottom=30,right=30]' }, children: nextNodes.map(n => ({ id: n.id, width: nodeSize.width, height: nodeSize.height })), edges: nextEdges.filter(e => e.source !== e.target).map(e => ({ id: e.id, sources: [e.source], targets: [e.target] })) };
    (elkPromise ??= elkLoader()).then(elk => elk.layout(layered)).then(result => {
      const positions = new Map(result.children?.map(n => [n.id, { x: n.x || 0, y: n.y || 0 }]));
      applyLayout(nextNodes.map(n => ({ ...n, position: positions.get(n.id) || n.position })));
    }).catch(() => {
      if (sequence !== layoutSequence.current) return;
      layoutInFlight.current = false; setNodes(currentNodes(nextNodes.map((n, i) => ({ ...n, position: { x: (i % 3) * 330, y: Math.floor(i / 3) * 165 } })))); setEdges(currentEdges()); setLayoutBusy(false); setLayoutError('自动布局失败，已使用网格布局');
    });
    return () => { saveCurrentCanvas(); layoutSequence.current++; };
  // Stable graph identity prevents index status updates from moving the canvas.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphKey, layoutToken]);

  useEffect(() => { setNodes(current => current.map(n => ({ ...n, selected: n.id === selectedId }))); }, [selectedId, setNodes]);
  useEffect(() => {
    const entities = new Map(graph.nodes.map(node => [node.id, node]));
    const facts = new Map(graph.edges.map(edge => [edge.id, edge]));
    const active = !!(highlightedNodeIds?.size || highlightedEdgeIds?.size);
    setNodes(current => current.map(node => ({ ...node, data: { ...node.data, entity: entities.get(node.id) || node.data.entity, presentation: cardPresentations?.[node.id], highlighted: active ? highlightedNodeIds?.has(node.id) || false : undefined, size: nodeSize } })));
    setEdges(current => current.map(edge => { const fact = facts.get(edge.id); return fact ? refreshCodeEdgeMetadata(edge, fact, { label: edgeLabelOverrides?.[edge.id], pending: pendingEdgeIds?.has(edge.id), highlightActive: active, highlighted: highlightedEdgeIds?.has(edge.id) }) : edge; }));
  }, [graph, cardPresentations, edgeLabelOverrides, pendingEdgeIds, highlightedNodeIds, highlightedEdgeIds, nodeSize, setNodes, setEdges]);
  useEffect(() => {
    if (layoutInFlight.current || !focusRequest || focusRequest.token === handledFocus.current || !nodes.some(node => node.id === focusRequest.id)) return;
    handledFocus.current = focusRequest.token;
    focusHandledRef.current(focusRequest.token);
    void fitView({ nodes: [{ id: focusRequest.id }], padding: .6, maxZoom: 1, duration: 250 });
  }, [focusRequest, nodes, fitView]);
  useEffect(() => {
    if (!batchFocusRequest || batchFocusRequest.token === handledBatchFocus.current) return;
    const ids = batchFocusRequest.ids.filter(id => nodes.some(node => node.id === id));
    if (!ids.length) return;
    let cancelled = false, frame = 0;
    const focus = () => {
      if (cancelled) return;
      if (layoutInFlight.current) { frame = requestAnimationFrame(focus); return; }
      handledBatchFocus.current = batchFocusRequest.token;
      focusHandledRef.current(batchFocusRequest.token);
      void fitView({ nodes: ids.map(id => ({ id })), padding: .2, maxZoom: 1, duration: 240 });
    };
    frame = requestAnimationFrame(focus);
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [batchFocusRequest, nodes, fitView]);
  useEffect(() => {
    if (!preserveFocusOnResize || !surfaceRef.current) return;
    return observeCanvasResize(surfaceRef.current, () => !layoutInFlight.current, () => {
      const current = getNodes(); if (!current.length) return;
      const display = presentationRef.current;
      void fitView({ nodes: canvasResizeTargets(current, display.selectedId, display.highlightedNodeIds), padding: .14, maxZoom: 1, duration: 0 });
    });
  }, [preserveFocusOnResize, fitView, getNodes]);
  useEffect(() => {
    if (!presentationToken || settledToken.current === `${presentationToken}:${graphKey}`) return;
    let cancelled = false, frame = 0, quietFrames = 0;
    const finish = () => {
      if (cancelled) return;
      if (layoutInFlight.current || cameraPending.current || getNodes().length !== graph.nodes.length) { quietFrames = 0; frame = requestAnimationFrame(finish); return; }
      if (++quietFrames < 2) { frame = requestAnimationFrame(finish); return; }
      settledToken.current = `${presentationToken}:${graphKey}`;
      settledRef.current?.(presentationToken, { nodeIds: getNodes().map(node => node.id), edgeIds: graph.edges.map(edge => edge.id), ...(cameraError.current ? { error: cameraError.current } : {}) });
    };
    frame = requestAnimationFrame(finish); return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [presentationToken, graphKey, graph, nodes, getNodes]);
  const labels = { 'node.a11yDescription.default': '按 Enter 选择节点，双击进入下一层，方向键移动节点，Escape 清除选择。', 'edge.a11yDescription.default': '关系，按 Enter 选择查看。', 'controls.zoomIn.ariaLabel': '放大', 'controls.zoomOut.ariaLabel': '缩小', 'controls.fitView.ariaLabel': '适应画布' };
  return <div className="canvas-surface" ref={surfaceRef} onKeyDownCapture={event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const nestedControl = !!target.closest('button, input, textarea, select, a, [contenteditable="true"]');
    const nodeElement = target.closest('.react-flow__node[data-id]');
    const node = nodeForKeyboardActivation(event.key, nodeElement?.getAttribute('data-id') || null, graph.nodes, nestedControl);
    if (node) { event.preventDefault(); event.stopPropagation(); onSelect(node); return; }
    const edgeElement = target.closest('.react-flow__edge[data-id]');
    const edge = edgeForKeyboardActivation(event.key, edgeElement?.getAttribute('data-id') || null, graph.edges, nestedControl);
    if (edge) { event.preventDefault(); event.stopPropagation(); onRelation(edge); }
  }}>
    <ReactFlow<ExplorerNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
      onNodeClick={(_, n) => onSelect(n.data.entity)} onNodeDoubleClick={(_, n) => onEnter(n.data.entity)}
      onEdgeClick={(_, edge) => { const entity = graph.edges.find(item => item.id === edge.id); if (entity) onRelation(entity); }}
      onMoveEnd={() => saveCurrentCanvas()} onNodeDragStop={(_, node) => saveCurrentCanvas(node)}
      nodesConnectable={false} deleteKeyCode={null} minZoom={.12} maxZoom={1.8} ariaLabelConfig={labels}
      defaultEdgeOptions={{ interactionWidth: 20 }} onlyRenderVisibleElements>
      <Background variant={BackgroundVariant.Dots} color="#303747" gap={22} size={1} />
    </ReactFlow>
    <div className="canvas-legend"><span><i className="legend-line" />静态确认</span>{graph.edges.some(e => e.confidence === 'inferred') && <span><i className="legend-line inferred" />有据推断</span>}{!!pendingEdgeIds?.size && <span><i className="legend-line inferred" />业务归属待复核</span>}<span className="canvas-note">拖动画布查看更多节点 · 滚轮缩放</span></div>
    <div className="canvas-controls"><button title="缩小" aria-label="缩小" onClick={() => void zoomOut()}><Minus size={15} /></button><span>{Math.round(zoom * 100)}%</span><button title="放大" aria-label="放大" onClick={() => void zoomIn()}><Plus size={15} /></button><div className="control-separator" /><button title="适应画布" aria-label="适应画布" onClick={() => void fitView({ padding: .12, duration: 250, maxZoom: 1 })}><Expand size={16} /></button><button title="重置视图" aria-label="重置视图" onClick={() => void fitView({ padding: .12, duration: 250, maxZoom: 1 })}><RotateCcw size={14} /></button></div>
    <div className="canvas-count"><LayoutGrid size={13} /> {graph.nodes.length} 个节点<span>·</span>{graph.edges.length} 条关系</div>
    {layoutBusy && <div className="canvas-layout-status"><span className="spinner" /> 正在整理布局</div>}
    {layoutError && <div className="canvas-layout-status warning-text">{layoutError}</div>}
  </div>;
}

export default function GraphCanvas(props: Parameters<typeof CanvasContent>[0]) { return <ReactFlowProvider><CanvasContent {...props} /></ReactFlowProvider>; }

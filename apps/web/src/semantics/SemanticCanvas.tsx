import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Background, BaseEdge, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, getSmoothStepPath, useEdgesState, useNodesState, useReactFlow, useViewport } from '@xyflow/react';
import type { Edge, EdgeProps, Node, NodeProps, Viewport, XYPosition } from '@xyflow/react';
import { Expand, Layers3, Minus, Plus } from 'lucide-react';
import type { SemanticEdge, SemanticNode } from '../../../../packages/semantic-model/src/types';
import { reviewLabels, statusLabels, verificationLabels } from './labels';
import { semanticEdgeShortLabel } from './graph';
import { canvasResizeTargets, observeCanvasResize } from '../GraphCanvas';

type SemanticGraphNode = Node<{ value: SemanticNode; expand: (id: string) => void; highlighted?: boolean }, 'semantic'>;
type SemanticGraphEdge = Edge<{ value: SemanticEdge; activate: () => void }, 'semantic'>;
interface Snapshot { positions: Record<string, XYPosition>; viewport: Viewport }
const snapshots = new Map<string, Snapshot>();
const CARD = { width: 216, height: 125 };
const SemanticCard = memo(function SemanticCard({ data, selected }: NodeProps<SemanticGraphNode>) {
  const value = data.value;
  return <div className={`semantic-card ${value.level} ${selected ? 'selected' : ''} ${value.status !== 'current' ? 'needs-review' : ''}`} style={{ opacity: data.highlighted === false ? .3 : 1, outline: data.highlighted ? '2px solid #7cabb8' : undefined }}>
    <Handle type="target" position={Position.Left} />
    <div className="semantic-card-top"><span>{value.level === 'summary' ? '业务阶段' : '实现说明'}</span><span className={`semantic-pill ${value.reviewState}`}>{reviewLabels[value.reviewState]}</span></div>
    <strong title={value.title}>{value.title}</strong><p title={value.summary}>{value.summary}</p>
    <div className="semantic-card-bottom"><span>{value.status === 'current' ? `${value.codeNodeIds.length} 个实现` : statusLabels[value.status]}</span>{value.level === 'summary' ? <button onClick={event => { event.stopPropagation(); data.expand(value.id); }}>展开 {value.childIds.length} 步</button> : <span>源码解释层</span>}</div>
    <Handle type="source" position={Position.Right} />
  </div>;
});
function SemanticLine(props: EdgeProps<SemanticGraphEdge>) {
  const [path, x, y] = getSmoothStepPath(props);
  const description = props.data ? `${props.data.value.title}；${props.data.value.description}；${verificationLabels[props.data.value.verification]}` : '语义关系';
  return <><BaseEdge path={path} markerEnd={props.markerEnd} style={props.style} interactionWidth={20} /><EdgeLabelRenderer><button type="button" className="semantic-edge-label nodrag nopan" data-semantic-edge-id={props.id} style={{ transform: `translate(-50%, -50%) translate(${x}px,${y}px)`, opacity: props.style?.opacity }} title={description} aria-label={description} onClick={event => { event.stopPropagation(); props.data?.activate(); }}>{props.data ? semanticEdgeShortLabel(props.data.value) : '关联'}</button></EdgeLabelRenderer></>;
}
const nodeTypes = { semantic: SemanticCard }, edgeTypes = { semantic: SemanticLine };
export function refreshSemanticEdgeMetadata(rendered: SemanticGraphEdge, value: SemanticEdge, options: { highlightActive?: boolean; highlighted?: boolean } = {}): SemanticGraphEdge {
  const uncertain = value.verification === 'unverified' || value.verification === 'inferred';
  const color = uncertain ? '#b89a65' : '#6f8f9e';
  return { ...rendered, source: value.source, target: value.target, data: { value, activate: rendered.data!.activate },
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
    style: { ...rendered.style, stroke: color, strokeWidth: options.highlighted ? 2.6 : 1.4, strokeDasharray: uncertain ? '5 4' : undefined, opacity: options.highlightActive && !options.highlighted ? .2 : 1 },
    ariaLabel: `${value.title}；${value.description}；${verificationLabels[value.verification]}`,
  };
}
export interface SemanticCanvasProps {
  identity: string; nodes: SemanticNode[]; edges: SemanticEdge[]; selectedId?: string;
  highlightedNodeIds?: Set<string>; highlightedEdgeIds?: Set<string>; layoutToken: number;
  batchFocusRequest?: { ids: string[]; token: number }; onFocusHandled?: (token: number) => void;
  onNode: (node: SemanticNode) => void; onEdge: (edge: SemanticEdge) => void; onExpand: (id: string) => void;
}
function Canvas({ identity, nodes: values, edges: relations, selectedId, highlightedNodeIds, highlightedEdgeIds, layoutToken, batchFocusRequest, onFocusHandled, onNode, onEdge, onExpand }: SemanticCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<SemanticGraphNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<SemanticGraphEdge>([]);
  const [busy, setBusy] = useState(false);
  const surface = useRef<HTMLDivElement>(null), sequence = useRef(0), layingOut = useRef(false);
  const { fitView, getNodes, getViewport, setViewport, zoomIn, zoomOut } = useReactFlow<SemanticGraphNode, SemanticGraphEdge>();
  const { zoom } = useViewport();
  const callbacks = useRef({ onNode, onEdge, onExpand, values, relations }); callbacks.current = { onNode, onEdge, onExpand, values, relations };
  const displayRef = useRef({ selectedId, highlightedNodeIds, highlightedEdgeIds }); displayRef.current = { selectedId, highlightedNodeIds, highlightedEdgeIds };
  const signature = useMemo(() => `${identity}:${values.map(node => node.id).sort().join('|')}:${relations.map(edge => edge.id).sort().join('|')}`, [identity, values, relations]);
  const activeKey = useRef(''), previousLayout = useRef(layoutToken);
  const handledFocus = useRef(0), focusHandled = useRef(onFocusHandled); focusHandled.current = onFocusHandled;
  const save = () => {
    if (!activeKey.current || layingOut.current) return;
    snapshots.delete(activeKey.current); snapshots.set(activeKey.current, { positions: Object.fromEntries(getNodes().map(node => [node.id, node.position])), viewport: getViewport() });
    while (snapshots.size > 32) snapshots.delete(snapshots.keys().next().value!);
  };
  useEffect(() => {
    const current = ++sequence.current, forced = previousLayout.current !== layoutToken; previousLayout.current = layoutToken; activeKey.current = signature;
    const active = !!(highlightedNodeIds?.size || highlightedEdgeIds?.size);
    const nextNodes: SemanticGraphNode[] = values.map(value => ({ id: value.id, type: 'semantic', position: { x: 0, y: 0 }, selected: value.id === selectedId, data: { value, highlighted: active ? highlightedNodeIds?.has(value.id) || false : undefined, expand: id => callbacks.current.onExpand(id) } }));
    const nextEdges: SemanticGraphEdge[] = relations.map(value => refreshSemanticEdgeMetadata({ id: value.id, source: value.source, target: value.target, type: 'semantic', data: { value, activate: () => { const edge = callbacks.current.relations.find(item => item.id === value.id); if (edge) callbacks.current.onEdge(edge); } } }, value, { highlightActive: active, highlighted: highlightedEdgeIds?.has(value.id) }));
    const cached = forced ? undefined : snapshots.get(signature);
    layingOut.current = true; setBusy(true);
    const apply = (positioned: SemanticGraphNode[], viewport?: Viewport) => {
      if (current !== sequence.current) return;
      const display = displayRef.current, active = !!(display.highlightedNodeIds?.size || display.highlightedEdgeIds?.size);
      setNodes(positioned.map(node => ({ ...node, selected: node.id === display.selectedId, data: { ...node.data, value: callbacks.current.values.find(value => value.id === node.id) || node.data.value, highlighted: active ? display.highlightedNodeIds?.has(node.id) || false : undefined } })));
      setEdges(nextEdges.map(edge => { const value = callbacks.current.relations.find(value => value.id === edge.id); return value ? refreshSemanticEdgeMetadata(edge, value, { highlightActive: active, highlighted: display.highlightedEdgeIds?.has(edge.id) }) : edge; })); setBusy(false);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (current !== sequence.current) return;
        layingOut.current = false;
        if (viewport) void setViewport(viewport, { duration: 0 });
        else void fitView({ padding: .1, minZoom: .6, maxZoom: 1, duration: 180 });
      }));
    };
    if (cached) apply(nextNodes.map(node => ({ ...node, position: cached.positions[node.id] || node.position })), cached.viewport);
    else if (values.every(node => node.level === 'summary') || !relations.length) {
      const width = surface.current?.clientWidth || 600;
      const columns = Math.max(1, Math.min(3, Math.floor((width + 24) / (CARD.width + 48))));
      apply(nextNodes.map((node, index) => ({ ...node, position: { x: index % columns * (CARD.width + 48), y: Math.floor(index / columns) * (CARD.height + 48) } })));
    } else {
      void import('elkjs/lib/elk.bundled.js').then(module => new module.default()).then(elk => elk.layout({ id: 'semantic', layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'DOWN', 'elk.spacing.nodeNode': '48', 'elk.layered.spacing.nodeNodeBetweenLayers': '66' }, children: values.map(value => ({ id: value.id, ...CARD })), edges: relations.filter(edge => edge.source !== edge.target).map(edge => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })) })).then(result => { const positions = new Map(result.children?.map(node => [node.id, { x: node.x || 0, y: node.y || 0 }])); apply(nextNodes.map(node => ({ ...node, position: positions.get(node.id) || node.position }))); }).catch(() => apply(nextNodes.map((node, index) => ({ ...node, position: { x: index % 2 * 264, y: Math.floor(index / 2) * 170 } }))));
    }
    return () => { save(); sequence.current++; };
    // Viewport memory is structural; refreshed text does not reset navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, layoutToken]);
  useEffect(() => {
    const active = !!(highlightedNodeIds?.size || highlightedEdgeIds?.size), byId = new Map(values.map(value => [value.id, value]));
    const facts = new Map(relations.map(value => [value.id, value]));
    setNodes(current => current.map(node => ({ ...node, selected: node.id === selectedId, data: { ...node.data, value: byId.get(node.id) || node.data.value, highlighted: active ? highlightedNodeIds?.has(node.id) || false : undefined } })));
    setEdges(current => current.map(edge => { const fact = facts.get(edge.id); return fact ? refreshSemanticEdgeMetadata(edge, fact, { highlightActive: active, highlighted: highlightedEdgeIds?.has(edge.id) }) : edge; }));
  }, [values, relations, selectedId, highlightedNodeIds, highlightedEdgeIds, setNodes, setEdges]);
  useEffect(() => {
    if (!batchFocusRequest || batchFocusRequest.token === handledFocus.current) return;
    const ids = batchFocusRequest.ids.filter(id => nodes.some(node => node.id === id)); if (!ids.length) return;
    let cancelled = false, frame = 0;
    const focus = () => {
      if (cancelled) return;
      if (layingOut.current) { frame = requestAnimationFrame(focus); return; }
      handledFocus.current = batchFocusRequest.token; focusHandled.current?.(batchFocusRequest.token);
      void fitView({ nodes: ids.map(id => ({ id })), padding: .2, maxZoom: 1, duration: 220 });
    };
    frame = requestAnimationFrame(focus); return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [batchFocusRequest, nodes, fitView]);
  useEffect(() => {
    if (!surface.current) return;
    return observeCanvasResize(surface.current, () => !layingOut.current, () => {
      const current = getNodes(); if (!current.length) return;
      const display = displayRef.current;
      void fitView({ nodes: canvasResizeTargets(current, display.selectedId, display.highlightedNodeIds), padding: .14, maxZoom: 1, duration: 0 });
    });
  }, [fitView, getNodes]);
  return <div className="semantic-canvas" ref={surface} onKeyDownCapture={event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target; if (!(target instanceof Element) || target.closest('button,input,textarea,select,a')) return;
    const id = target.closest('.react-flow__node[data-id]')?.getAttribute('data-id'), edgeId = target.closest('.react-flow__edge[data-id]')?.getAttribute('data-id');
    const node = values.find(value => value.id === id), edge = relations.find(value => value.id === edgeId);
    if (node || edge) { event.preventDefault(); event.stopPropagation(); if (node) onNode(node); else if (edge) onEdge(edge); }
  }}><ReactFlow<SemanticGraphNode, SemanticGraphEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onNodeClick={(_, node) => onNode(node.data.value)} onNodeDoubleClick={(_, node) => node.data.value.level === 'summary' && onExpand(node.id)} onEdgeClick={(_, edge) => { const value = relations.find(value => value.id === edge.id); if (value) onEdge(value); }} onMoveEnd={save} onNodeDragStop={save} minZoom={.15} maxZoom={1.6} nodesConnectable={false} deleteKeyCode={null} onlyRenderVisibleElements ariaLabelConfig={{ 'node.a11yDescription.default': '业务解释节点，按 Enter 查看，双击摘要展开步骤。', 'edge.a11yDescription.default': '解释关系，按 Enter 查看依据。' }}><Background color="#303f46" gap={22} size={1} /></ReactFlow>
    <div className="semantic-canvas-label"><Layers3 size={12} />语义解释层<span>实线不表示运行时已验证</span></div>
    <div className="semantic-canvas-controls"><button aria-label="缩小业务解释" onClick={() => void zoomOut()}><Minus size={14} /></button><span>{Math.round(zoom * 100)}%</span><button aria-label="放大业务解释" onClick={() => void zoomIn()}><Plus size={14} /></button><button aria-label="适应业务解释画布" onClick={() => void fitView({ padding: .1, maxZoom: 1, duration: 220 })}><Expand size={14} /></button></div>{busy && <div className="semantic-canvas-busy">正在整理解释图…</div>}
  </div>;
}
export default function SemanticCanvas(props: SemanticCanvasProps) { return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>; }

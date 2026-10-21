import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, ChevronRight, GitBranch, Info, Layers3, List, ShieldCheck } from 'lucide-react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import { activationOrder, deliveryStages, laneLabels, safeGitHubUrl } from './model';
import type { DeliveryLink, DeliveryStage } from './model';

type StageNode = Node<{ stage: DeliveryStage; index: number; expand: (id: string) => void }, 'delivery'>;
const stageLaneLabel = (stage: DeliveryStage) => stage.manualReview ? '游戏仓库 · 自动 CI + 人工 Review' : laneLabels[stage.lane];
function StageCard({ data, selected }: NodeProps<StageNode>) {
  const { stage, index } = data;
  return <article className={`delivery-node lane-${stage.lane} ${selected ? 'selected' : ''}`}>
    <Handle type="target" position={index < 5 ? Position.Left : index === 5 ? Position.Top : Position.Right} />
    <div className="delivery-node-meta"><span>{String(index + 1).padStart(2, '0')}</span><span>{stage.manualReview ? '游戏 · CI + 人工' : stage.lane === 'human' ? '人工' : stage.lane === 'game' ? '游戏 · 自动' : '工具 · 自动'}</span></div>
    <strong>{stage.title}</strong><p>{stage.summary}</p>
    <button className="nodrag" onClick={event => { event.stopPropagation(); data.expand(stage.id); }}>展开步骤<ChevronRight size={12} /></button>
    <Handle type="source" position={index < 4 ? Position.Right : index === 4 ? Position.Bottom : Position.Left} />
    {stage.id === 'checks-review' && <Handle id="ordinary" type="source" position={Position.Top} />}
    {stage.id === 'merge' && <Handle id="ordinary" type="target" position={Position.Top} />}
  </article>;
}
const nodeTypes = { delivery: StageCard };

export function GitHubLink({ value }: { value: DeliveryLink }) {
  const url = safeGitHubUrl(value.url);
  return url ? <a href={url} target="_blank" rel="noopener noreferrer">{value.label}<ArrowUpRight size={12} /></a> : <span className="delivery-invalid-link">链接不可用：{value.label}</span>;
}
function Links({ values }: { values: DeliveryLink[] }) { return <div className="delivery-links">{values.map(value => <GitHubLink key={value.url} value={value} />)}</div>; }
function StageFields({ stage }: { stage: DeliveryStage }) {
  return <>
    <dl className="delivery-fields">{([['负责', stage.actor], ['输入', stage.input], ['输出', stage.output], ['触发条件', stage.trigger], ['通过条件', stage.pass], ['阻塞原因', stage.blocked], ['失败处理', stage.failure]] as const).map(([title, text]) => <div key={title}><dt>{title}</dt><dd>{text}</dd></div>)}</dl>
    <ol className="delivery-substeps">{stage.steps.map(step => <li key={step}>{step}</li>)}</ol>
    {stage.configuration && <p className="delivery-config"><Info size={13} /><span>待配置 / 待核实：{stage.configuration}</span></p>}
    <Links values={stage.links} />
  </>;
}

export default function DeliveryWorkspace() {
  const [mode, setMode] = useState<'overview' | 'details'>('overview');
  const [selected, setSelected] = useState(deliveryStages[0].id);
  const [expanded, setExpanded] = useState<string[]>([deliveryStages[0].id]);
  const [history, setHistory] = useState<string[]>([]);
  const stage = deliveryStages.find(item => item.id === selected)!;
  const select = (id: string) => { if (id !== selected) { setHistory(current => [...current, selected].slice(-30)); setSelected(id); } };
  const expand = (id: string) => { select(id); setExpanded(current => current.includes(id) ? current : [...current, id]); setMode('details'); };
  const nodes: StageNode[] = deliveryStages.map((value, index) => ({ id: value.id, type: 'delivery', data: { stage: value, index, expand }, selected: value.id === selected, position: { x: (index < 5 ? index : 9 - index) * 225 + 20, y: index < 5 ? 35 : 285 }, style: { width: 196 }, draggable: false }));
  const edges = useMemo(() => [...deliveryStages.slice(0, -1).map((value, index) => ({ id: `${value.id}:${deliveryStages[index + 1].id}`, source: value.id, target: deliveryStages[index + 1].id, type: 'smoothstep', label: index === 2 ? '高风险 / 门禁变更' : index === 3 ? '本人批准当前内容' : index === 5 ? 'main 检查成功' : undefined, markerEnd: { type: MarkerType.ArrowClosed, color: '#7d91ac' }, style: { stroke: '#7d91ac', strokeWidth: 1.4 }, labelStyle: { fill: '#bdc8dc', fontSize: 10 }, labelBgStyle: { fill: '#151e2b', fillOpacity: 1 }, labelBgPadding: [5, 4] as [number, number], focusable: false })), { id: 'ordinary-approval-not-applicable', source: 'checks-review', target: 'merge', sourceHandle: 'ordinary', targetHandle: 'ordinary', type: 'smoothstep', label: 'CI + Review 均满足 · 普通变更无新增批准', markerEnd: { type: MarkerType.ArrowClosed, color: '#9b9d8b' }, style: { stroke: '#9b9d8b', strokeWidth: 1.4, strokeDasharray: '5 4' }, labelStyle: { fill: '#bdc8dc', fontSize: 10 }, labelBgStyle: { fill: '#151e2b', fillOpacity: 1 }, labelBgPadding: [5, 4] as [number, number], focusable: false }], []);
  return <div className="architecture-workspace delivery-workspace" data-delivery-mode={mode}>
    <div className="arch-toolbar"><div className="arch-breadcrumbs"><button aria-label="返回上一交付阶段" disabled={!history.length} onClick={() => { setSelected(history.at(-1)!); setHistory(current => current.slice(0, -1)); }}><ArrowLeft size={14} /></button><span>开发交付流程</span><ChevronRight size={11} /><span>{stage.title}</span></div><div className="delivery-mode-switch" aria-label="交付流程视图"><button aria-pressed={mode === 'overview'} onClick={() => setMode('overview')}><Layers3 size={13} />总览</button><button aria-pressed={mode === 'details'} onClick={() => setMode('details')}><List size={13} />详细步骤</button></div></div>
    <header className="arch-perspective-heading"><div><span className="arch-eyebrow">人工维护的交付流程说明</span><h1>从游戏变更到可追溯索引</h1><p>CI 与独立 Review 共同把关，合并后构建工具并核验游戏的准确提交。</p></div><div className="delivery-description-badge"><ShieldCheck size={14} />说明页 · 无实时状态</div></header>
    <div className="arch-trust-strip"><Info size={14} /><span>本页描述约定流程，不读取 GitHub 实时状态；平台配置需独立核实。流程连线表示交付条件，不是 C# / Python 静态调用或运行时证据。审批、合并、重跑与发布均在各自授权入口完成。</span></div>
    <div className="delivery-legend">{(['human', 'game', 'tool'] as const).map(lane => <span className={`lane-${lane}`} key={lane}><i />{laneLabels[lane]}</span>)}<span>点击阶段查看详情，或展开详细步骤</span></div>
    <div className="delivery-content">
      <main className="delivery-main">
        {mode === 'overview' ? <div className="delivery-diagram" aria-label="开发交付阶段总览">
          <ReactFlow<StageNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodeClick={(_event, node) => select(node.id)} onNodeDoubleClick={(_event, node) => expand(node.id)} fitView fitViewOptions={{ padding: .08 }} minZoom={.35} maxZoom={1.8} nodesConnectable={false} nodesDraggable={false} edgesFocusable={false} proOptions={{ hideAttribution: true }}><Background color="#2b3a4d" gap={22} /><Controls showInteractive={false} /></ReactFlow>
          <div className="delivery-diagram-note">约定条件图 · 高风险批准仅在适用时要求 · 远端 Fast ≠ Unity Full</div>
        </div> : <div className="delivery-detail-list" aria-label="可展开的交付步骤">
          {deliveryStages.map((value, index) => <details key={value.id} className={`delivery-detail-stage lane-${value.lane} ${selected === value.id ? 'selected' : ''}`} open={expanded.includes(value.id)} onToggle={event => { const open = event.currentTarget.open; setExpanded(current => open ? current.includes(value.id) ? current : [...current, value.id] : current.filter(id => id !== value.id)); }}>
            <summary onClick={() => select(value.id)}><span className="delivery-step-number">{String(index + 1).padStart(2, '0')}</span><span><strong>{value.title}</strong><small>{stageLaneLabel(value)} · {value.summary}</small></span><ChevronRight size={14} /></summary><div className="delivery-detail-body"><StageFields stage={value} /></div>
          </details>)}
          <section className="delivery-activation"><h2>首次正式启用顺序</h2><ol>{activationOrder.map(value => <li key={value}>{value}</li>)}</ol><p>流程文件完成、本地检查、人工设置与远端实际结果分别核验；未推送不表示远端运行通过。</p></section>
        </div>}
        <footer className="delivery-foot"><GitBranch size={12} /><span>沿用两仓现有历史与可见性；索引首版为 CI 快照证据包。</span></footer>
      </main>
      <aside className="arch-inspector delivery-inspector" aria-label="交付阶段详情"><header><span>阶段详情 · 人工说明</span><span>{String(deliveryStages.indexOf(stage) + 1).padStart(2, '0')} / 10</span></header><div className="arch-inspector-scroll"><div className="arch-inspector-overview"><span className={`delivery-lane-label lane-${stage.lane}`}>{stageLaneLabel(stage)}</span><h2>{stage.title}</h2><p>{stage.summary}</p><button className="arch-inspector-enter" onClick={() => expand(stage.id)}>展开该阶段的详细步骤<ArrowRight size={13} /></button></div><section><StageFields stage={stage} /></section><section className="delivery-platform-note"><h3>状态说明</h3><p>这是随工具源码维护的说明。链接打开 GitHub，由 GitHub 展示实际 PR、规则、运行与产物；此处没有当前成功、批准或发布状态。</p><Links values={[{ label: '工具交付合同与接入清单', url: 'https://github.com/chwan886/Architecture-Explorer/blob/main/docs/DEVELOPMENT-DELIVERY.md' }]} /></section></div></aside>
    </div>
  </div>;
}

import { ArrowDownRight, ArrowRight, ArrowUpRight, Check, GitBranch, Info, ShieldCheck } from 'lucide-react';
import type { ResolvedBusinessFlow, ResolvedFlowStep, ResolvedFlowTransition } from '../../../../packages/architecture-model/src/types';
import { basisLabels, resolutionLabels, reviewLabels, verificationLabels } from './labels';

export default function FlowBoard({ flow, selectedId, onStep, onTransition, onOpenCode }: {
  flow: ResolvedBusinessFlow; selectedId?: string; onStep: (step: ResolvedFlowStep) => void;
  onTransition: (transition: ResolvedFlowTransition) => void; onOpenCode: (nodeId: string) => void;
}) {
  const phases = [...new Set(flow.steps.map(step => step.phase))].sort((a, b) => a - b);
  const names = new Map(flow.steps.map(step => [step.id, step.name]));
  return <div className="arch-flow-board">
    <header className="arch-flow-intro"><span className="arch-eyebrow">端到端流程 · 阶段泳道</span><h2>{flow.name}</h2><p>{flow.description}</p><div><span className={`arch-review ${flow.reviewState}`}>{reviewLabels[flow.reviewState]}</span><span><GitBranch size={12} />触发：{flow.trigger}</span></div></header>
    <div className="arch-boundary-note"><Info size={13} /><span>阶段用于组织阅读；执行顺序以每条步骤关系的证据为准。人工确认流程说明不等于运行时验证。</span></div>
    <div className="arch-swimlane-scroll"><div className="arch-swimlanes" style={{ gridTemplateColumns: `145px repeat(${Math.max(1, phases.length)}, minmax(235px, 1fr))` }}>
      <div className="arch-lane-corner">职责 / 阶段</div>{phases.map(phase => <div className="arch-phase-heading" key={`phase:${phase}`}><span>{String(phase).padStart(2, '0')}</span>阶段 {phase}</div>)}
      {flow.lanes.map(lane => <div className="arch-swimlane-row" key={lane.id}><div className="arch-lane-heading"><span className="arch-lane-dot" />{lane.name}</div>{phases.map(phase => <div className="arch-lane-cell" key={`${lane.id}:${phase}`}>{flow.steps.filter(step => step.laneId === lane.id && step.phase === phase).map(step => <article key={step.id} className={`arch-flow-step ${selectedId === step.id ? 'active' : ''}`}>
        <button className="arch-flow-step-main" onClick={() => onStep(step)}><span className="arch-step-position">{phase}.{flow.steps.filter(item => item.phase === phase).indexOf(step) + 1}</span><h3>{step.name}</h3><p>{step.description}</p><span className={`arch-resolution ${step.resolution}`}>{resolutionLabels[step.resolution]}</span>{step.condition && <span className="arch-step-condition">条件：{step.condition}</span>}</button>
        {step.nodeIds.length > 0 && <button className="arch-step-code" onClick={() => onOpenCode(step.nodeIds[0])}>查看代码 <span>{step.nodeIds.length} 个符号</span><ArrowUpRight size={12} /></button>}
      </article>)}</div>)}</div>)}
    </div></div>
    <section className="arch-transitions"><div className="arch-section-heading"><h3>步骤之间的关系</h3><span>{flow.transitions.length} 段 · 逐段举证</span></div>{flow.transitions.map(transition => <button key={transition.id} className={`arch-transition ${transition.verification} ${selectedId === transition.id ? 'active' : ''}`} onClick={() => onTransition(transition)}>
      {transition.verification === 'static-confirmed' ? <ShieldCheck size={14} /> : transition.verification === 'source-supported' ? <Check size={14} /> : <ArrowDownRight size={14} />}<strong>{names.get(transition.source) || transition.source}</strong><ArrowRight size={13} /><strong>{names.get(transition.target) || transition.target}</strong><span className="arch-transition-basis">{basisLabels[transition.basis]}</span><span className="arch-verification">{verificationLabels[transition.verification]}</span>
    </button>)}{flow.transitions.length === 0 && <p className="arch-empty-inline">当前流程没有已定义的步骤关系。</p>}</section>
    {flow.limitations.length > 0 && <div className="arch-flow-limits"><Info size={14} /><div>{flow.limitations.map((text, index) => <p key={index}>{text}</p>)}</div></div>}
  </div>;
}

import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Activity, Check, ChevronDown, ChevronUp, Code2, GripVertical, Loader2, Minus, Pause, RotateCcw, Unlink, X } from 'lucide-react';
import type { BridgeActivity, ControlCommand, PresentationReceipt } from '../../../../packages/control-protocol/src/types';
import { BUBBLE_STORAGE_KEY, clampBubble, presentationIsCurrent, progressStatus, readBubblePreferences, recentActivities, type BubblePosition } from './progress';

export interface FloatingProgressProps {
  activities: readonly BridgeActivity[]; command?: ControlCommand; receipt?: PresentationReceipt;
  connected: boolean; allowControl: boolean; scopeId: string; staleMessage: string; error: string; openToken: number;
  userRevision?: number;
  onOpenCode: (nodeId: string, evidenceId?: string) => void; onLeave: () => void; onReconnect: () => void;
}
const short = (value: string | undefined, limit = 600) => value && value.length > limit ? `${value.slice(0, limit)}…` : value || '';
const time = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
const statusNames = { running: '进行中', completed: '完成', paused: '已暂停', failed: '失败' };
function loadPreferences() { try { return readBubblePreferences(window.localStorage.getItem(BUBBLE_STORAGE_KEY)); } catch { return undefined; } }

export default function FloatingProgress(props: FloatingProgressProps) {
  const { activities, command, receipt, connected, allowControl, scopeId, staleMessage, error, openToken, userRevision, onOpenCode, onLeave, onReconnect } = props;
  const saved = useRef(loadPreferences()), panel = useRef<HTMLElement>(null), hiddenByUser = useRef(false), firstOpenToken = useRef(openToken);
  const [collapsed, setCollapsed] = useState(saved.current?.collapsed ?? true);
  const [hidden, setHidden] = useState(!allowControl && !command && !activities.length);
  const [position, setPosition] = useState<BubblePosition>(() => saved.current ? { x: saved.current.x, y: saved.current.y } : { x: window.innerWidth - 312, y: window.innerHeight - 96 });
  const [now, setNow] = useState(Date.now()), [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; origin: BubblePosition } | undefined>(undefined), positionRef = useRef(position), collapsedRef = useRef(collapsed);
  positionRef.current = position; collapsedRef.current = collapsed;
  const contentId = useId(), log = recentActivities(activities, scopeId), latest = log[0];
  const snapshotExpired = !!command && (Date.parse(command.expiresAt) <= now || Date.parse(command.resolved.snapshot.expiresAt) <= now);
  const state = progressStatus({ connected, allowControl, command, receipt, staleMessage: staleMessage || (snapshotExpired ? '快照已过期' : ''), error, activity: latest, userRevision });
  const current = connected && allowControl && presentationIsCurrent(command, receipt, scopeId, staleMessage, now, activities, userRevision);
  const presentation = command?.resolved.presentation, flow = command?.resolved.semantic?.flow, focus = presentation?.focusNodeId;
  const semanticNodes = flow ? [...flow.summaryNodes, ...flow.detailNodes] : [];
  const focusNode = focus?.layer === 'semantic' ? semanticNodes.find(node => node.id === focus.id) : focus?.layer === 'code' ? semanticNodes.find(node => flow?.reverseNodes[focus.id]?.includes(node.id)) : undefined;
  const focusStep = presentation?.orderedSteps.find(step => step.semanticNodeId === focus?.id || focus?.layer === 'code' && step.codeNodeIds.includes(focus.id));
  const implementationIds = focusNode?.codeNodeIds || focusStep?.codeNodeIds || (focus?.layer === 'code' ? [focus.id] : []);
  const availableNodes = command?.resolved.codeGraph?.nodes || flow?.codeNodes || [];
  const implementations = [...new Set(implementationIds)].map(id => availableNodes.find(node => node.id === id) || flow?.codeNodes.find(node => node.id === id)).filter(node => !!node);
  const visibleImplementations = implementations.slice(0, 4);
  const currentTitle = focusNode?.title || focusStep?.name || (focus?.layer === 'code' ? availableNodes.find(node => node.id === focus.id)?.label : undefined) || latest?.title || '等待新的演示步骤';
  const clamp = (value: BubblePosition) => {
    const bounds = panel.current?.getBoundingClientRect();
    return clampBubble(value, { width: window.innerWidth, height: window.innerHeight }, { width: bounds?.width || Math.min(collapsedRef.current ? 292 : 330, Math.max(160, window.innerWidth - 24)), height: bounds?.height || (collapsedRef.current ? 82 : Math.min(420, window.innerHeight - 24)) });
  };
  const save = () => { try { window.localStorage.setItem(BUBBLE_STORAGE_KEY, JSON.stringify({ version: 1, x: positionRef.current.x, y: positionRef.current.y, collapsed: collapsedRef.current })); } catch { /* Storage is optional. */ } };
  useEffect(() => { if (!hiddenByUser.current && (allowControl || command || activities.length)) setHidden(false); }, [allowControl, command, activities.length]);
  useEffect(() => { if (firstOpenToken.current === openToken) return; firstOpenToken.current = openToken; hiddenByUser.current = false; setHidden(false); setCollapsed(false); }, [openToken]);
  useEffect(() => {
    if (hidden) return;
    const fit = () => setPosition(value => clamp(value));
    fit(); window.addEventListener('resize', fit);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : undefined;
    if (panel.current) observer?.observe(panel.current);
    return () => { window.removeEventListener('resize', fit); observer?.disconnect(); };
  }, [collapsed, hidden]);
  useEffect(() => { if (!command) return; setNow(Date.now()); const expiry = Math.min(Date.parse(command.expiresAt), Date.parse(command.resolved.snapshot.expiresAt)); if (!Number.isFinite(expiry)) return; const timer = window.setTimeout(() => setNow(Date.now()), Math.max(1, expiry - Date.now() + 10)); return () => window.clearTimeout(timer); }, [command]);
  useEffect(() => { save(); }, [position, collapsed]);
  const resetPosition = () => { const bounds = panel.current?.getBoundingClientRect(); setPosition(clamp({ x: window.innerWidth - (bounds?.width || 330) - 24, y: window.innerHeight - (bounds?.height || 82) - 24 })); };
  const pointerDown = (event: PointerEvent<HTMLButtonElement>) => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: positionRef.current }; event.currentTarget.setPointerCapture?.(event.pointerId); setDragging(true); };
  const pointerMove = (event: PointerEvent<HTMLButtonElement>) => { if (!drag.current || drag.current.id !== event.pointerId) return; event.stopPropagation(); const start = drag.current; setPosition(clamp({ x: start.origin.x + event.clientX - start.x, y: start.origin.y + event.clientY - start.y })); };
  const endDrag = (event: PointerEvent<HTMLButtonElement>) => { if (!drag.current || drag.current.id !== event.pointerId) return; drag.current = undefined; setDragging(false); if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); };
  const moveByKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => { if (event.key === 'Home') { event.preventDefault(); event.stopPropagation(); resetPosition(); return; } const direction: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }; const delta = direction[event.key]; if (!delta) return; event.preventDefault(); event.stopPropagation(); const amount = event.shiftKey ? 32 : 12; setPosition(value => clamp({ x: value.x + delta[0] * amount, y: value.y + delta[1] * amount })); };
  if (hidden) return null;
  return <section ref={panel} className={`floating-progress ${collapsed ? 'is-collapsed' : 'is-expanded'} ${dragging ? 'is-dragging' : ''}`} data-control-automatic="true" data-progress-tone={state.tone} data-current-snapshot={String(current)} role="region" aria-label="Codex 演示进度" style={{ left: position.x, top: position.y }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setCollapsed(true); } }}>
    <header className="floating-progress-head">
      <button type="button" className="floating-progress-handle" aria-label="移动演示气泡" aria-description="拖动或使用方向键移动；Home 键复位" aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Home" title="拖动移动 · 方向键微调 · Home 复位" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={() => { drag.current = undefined; setDragging(false); }} onKeyDown={moveByKeyboard}><GripVertical size={14} /><Activity size={13} /><span>Codex 演示</span></button>
      <button type="button" className="floating-progress-icon" aria-label="复位气泡位置" title="复位气泡位置" onClick={resetPosition}><RotateCcw size={12} /></button>
      <button type="button" className="floating-progress-icon" aria-label={collapsed ? '展开演示进度' : '收起演示进度'} aria-expanded={!collapsed} aria-controls={contentId} title={collapsed ? '展开' : '收起'} onClick={() => setCollapsed(value => !value)}>{collapsed ? <ChevronUp size={14} /> : <Minus size={14} />}</button>
      <button type="button" className="floating-progress-icon" aria-label="隐藏演示气泡" title="隐藏，可从联动栏再次打开" onClick={() => { hiddenByUser.current = true; setHidden(true); }}><X size={13} /></button>
    </header>
    <button type="button" className="floating-progress-current" aria-label={collapsed ? '展开当前演示步骤' : '收起当前演示步骤'} aria-expanded={!collapsed} aria-controls={contentId} onClick={() => setCollapsed(value => !value)}>
      <span className="floating-progress-status" role="status" aria-live="polite">{state.tone === 'running' ? <Loader2 size={11} className="floating-progress-spinner" /> : state.tone === 'complete' ? <Check size={11} /> : state.tone === 'paused' ? <Pause size={11} /> : <span className="floating-progress-dot" />}{state.label}</span>
      <strong title={currentTitle}>{short(currentTitle, 120)}</strong>
    </button>
    {!collapsed && <div id={contentId} className="floating-progress-content">
      {presentation && <div className="floating-progress-analysis"><small>当前分析 · {presentation.projectId} / {presentation.worktreeId}</small><h3>{short(presentation.title, 160)}</h3>{presentation.summary && <p>{short(presentation.summary)}</p>}</div>}
      {(staleMessage || error || !allowControl || !connected) && <p className="floating-progress-notice">{short(staleMessage || error || (!allowControl ? '联动已暂停。以下为本页已有记录，不会自动恢复控制。' : '连接暂时中断；记录保留，等待重新连接。'))}</p>}
      {focusNode && <details key={focusNode.id} className="floating-progress-explanation"><summary><span>步骤说明</span><ChevronDown size={12} /></summary><h4>这一步在做什么</h4><p>{short(focusNode.summary || focusNode.detail)}</p>{focusNode.purpose && focusNode.purpose.trim() !== (focusNode.summary || focusNode.detail).trim() && <><h4>为什么需要</h4><p>{short(focusNode.purpose)}</p></>}{focusNode.inputs.length > 0 && <><h4>输入</h4><p>{short(focusNode.inputs.join('；'))}</p></>}{focusNode.outputs.length > 0 && <><h4>输出</h4><p>{short(focusNode.outputs.join('；'))}</p></>}{focusNode.changes.length > 0 && <><h4>数据与状态</h4><p>{short(focusNode.changes.join('；'))}</p></>}{focusNode.controls.length > 0 && <p className="floating-progress-caution">{short(focusNode.controls.map(item => item.description).join('；'))}</p>}{focusNode.reviewState !== 'confirmed' && <small className="floating-progress-review">解释{focusNode.status !== 'current' ? '已变化，需复核' : '待人工确认'} · 不代表运行时已验证</small>}</details>}
      {implementations.length > 0 && <div className="floating-progress-code"><h4>对应实现 <span>{implementations.length}</span></h4>{!current && <small>当前快照未就绪或已暂停，源码跳转暂不可用。</small>}<div>{visibleImplementations.map(node => <button type="button" key={node.id} disabled={!current} title={node.qualifiedName} data-progress-code-id={node.id} onClick={() => onOpenCode(node.id, node.evidenceIds[0])}><Code2 size={12} /><span>{short(node.label, 100)}</span><small>{node.evidenceIds.length} 处证据</small></button>)}</div>{implementations.length > 4 && <small>另有 {implementations.length - 4} 个实现，完整映射请查看右侧 Inspector。</small>}</div>}
      <div className="floating-progress-log"><h4>实际操作记录 <span>最近 {log.length} 项</span></h4>{!log.length ? <p className="floating-progress-empty">尚无操作记录。收到 MCP 查询或展示请求后，会在这里更新。</p> : <ol>{log.map(item => <li key={item.id} data-activity-status={item.status}><span className="floating-progress-log-icon" aria-label={statusNames[item.status]}>{item.status === 'running' ? <Loader2 size={11} className="floating-progress-spinner" /> : item.status === 'completed' ? <Check size={11} /> : item.status === 'paused' ? <Pause size={11} /> : <X size={11} />}</span><div><div className="floating-progress-log-title"><strong>{short(item.title, 120)}</strong><time dateTime={item.updatedAt}>{time(item.updatedAt)}</time></div><small>{item.kind === 'query' ? '查询' : item.kind === 'presentation' ? '网页展示' : '会话'} · {statusNames[item.status]}</small><p>{short(item.message)}</p></div></li>)}</ol>}<p className="floating-progress-footnote">操作记录仅供阅读；静态证据不代表运行时顺序。</p></div>
      {(presentation?.warnings.length || command?.resolved.warnings.length) ? <div className="floating-progress-notice">{[...new Set([...(presentation?.warnings || []), ...(command?.resolved.warnings || [])])].slice(0, 5).map((warning, i) => <p key={i}>{short(warning)}</p>)}</div> : null}
    </div>}
    {!collapsed && <footer className="floating-progress-footer"><span>{scopeId || '未选择项目'}</span>{(!connected || error) && <button type="button" onClick={onReconnect}><RotateCcw size={12} />重连</button>}{allowControl && <button type="button" onClick={onLeave}><Unlink size={12} />恢复手动浏览</button>}</footer>}
  </section>;
}

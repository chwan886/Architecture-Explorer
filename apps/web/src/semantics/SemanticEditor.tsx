import { useEffect, useRef, useState } from 'react';
import { Download, GitMerge, RefreshCw, Save, Scissors, X } from 'lucide-react';
import type { ResolvedSemanticFlow, SemanticEditorEnvelope, SemanticFlowDefinition, SemanticText } from '../../../../packages/semantic-model/src/types';
import { mergeGroups, splitGroup } from '../../../../packages/semantic-content/src/index';
import { semanticError, semanticRequest } from './client';

interface Draft { flow: SemanticFlowDefinition; baseRevision: string; viewRevision?: string }
function editorVersion(value: SemanticEditorEnvelope, scope: string): string {
  if (value.overlay.scopeId !== scope || value.metadata?.scopeId !== scope || value.metadata.overlayRevision !== value.overlayRevision || value.metadata.definitionRevision !== value.definitionRevision || !value.metadata.viewRevision)
    throw new Error('解释模型与视图版本不匹配，已保留当前草稿。');
  return value.metadata.viewRevision;
}
const fields: { key: keyof SemanticText; label: string; lines?: boolean }[] = [
  { key: 'title', label: '名称' }, { key: 'summary', label: '一句话说明' }, { key: 'purpose', label: '目的' }, { key: 'detail', label: '详细解释' },
  { key: 'inputs', label: '输入', lines: true }, { key: 'processing', label: '处理过程', lines: true }, { key: 'outputs', label: '输出', lines: true }, { key: 'changes', label: '状态变化', lines: true },
];
export interface SemanticEditorProps { scope: string; flowId: string; viewRevision: string; resolvedFlow?: ResolvedSemanticFlow; candidate?: SemanticFlowDefinition; onClose: () => void; onSaved: () => void }

export default function SemanticEditor({ scope, flowId, viewRevision, resolvedFlow, candidate, onClose, onSaved }: SemanticEditorProps) {
  const [draft, setDraft] = useState<Draft>(), [envelope, setEnvelope] = useState<SemanticEditorEnvelope>();
  const [targetId, setTargetId] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false);
  const [candidatePending, setCandidatePending] = useState(false);
  const [groupIds, setGroupIds] = useState<string[]>([]), [childIds, setChildIds] = useState<string[]>([]), [groupTitle, setGroupTitle] = useState('');
  const identity = `${scope}:${flowId}`, live = useRef(identity), sequence = useRef(0), mounted = useRef(true); live.current = identity;
  const storageKey = `architecture-explorer:semantic-draft:${identity}`;
  const load = async (restore: boolean) => {
    const request = ++sequence.current, key = identity; setBusy(true); setError('');
    try {
      const value = await semanticRequest<SemanticEditorEnvelope>(scope, '/model');
      if (!mounted.current || request !== sequence.current || live.current !== key) return;
      const currentView = editorVersion(value, scope);
      const flow = value.effectiveFlows.find(flow => flow.id === flowId); if (!flow) throw new Error('当前流程定义不存在。');
      let restored: Draft | undefined;
      if (restore) { try { const raw = sessionStorage.getItem(storageKey); if (raw) { const parsed = JSON.parse(raw) as Draft; if (parsed.flow?.id === flowId && typeof parsed.baseRevision === 'string') restored = parsed; } } catch { /* Storage is optional; the editor remains usable. */ } }
      const next = restored || { flow: restore && candidate ? candidate : flow, baseRevision: value.overlayRevision, viewRevision: currentView };
      setEnvelope(value); setDraft(next); setTargetId(next.flow.groups[0]?.id || next.flow.steps[0]?.id || ''); setDirty(!!restored || (restore && !!candidate)); setCandidatePending(!!restored && !!candidate); setGroupIds([]); setChildIds([]);
      if (restored && !restored.viewRevision) setError('旧草稿缺少完整视图基线。请先导出草稿，再载入服务器版本后合并。');
      if (!restore) { try { sessionStorage.removeItem(storageKey); } catch { /* Optional session storage. */ } }
    } catch (failure) { if (mounted.current && request === sequence.current && live.current === key) setError(semanticError(failure)); }
    finally { if (mounted.current && request === sequence.current && live.current === key) setBusy(false); }
  };
  useEffect(() => { mounted.current = true; setDraft(undefined); setEnvelope(undefined); setDirty(false); setCandidatePending(false); void load(true); return () => { mounted.current = false; sequence.current++; }; }, [identity]);
  useEffect(() => { if (draft && dirty) { try { sessionStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* Keeping the in-memory draft is sufficient. */ } } }, [draft, dirty, storageKey]);
  const update = (flow: SemanticFlowDefinition) => { setDraft(value => value ? { ...value, flow } : value); setDirty(true); setError(''); };
  const applyCandidate = () => {
    if (!candidate || !envelope) return;
    const flow = structuredClone(candidate); setDraft({ flow, baseRevision: envelope.overlayRevision, viewRevision: envelope.metadata.viewRevision }); setTargetId(flow.groups[0]?.id || flow.steps[0]?.id || ''); setDirty(true); setCandidatePending(false); setGroupIds([]); setChildIds([]); setError('');
  };
  const target = draft?.flow.groups.find(value => value.id === targetId) || draft?.flow.steps.find(value => value.id === targetId);
  const resolvedTarget = resolvedFlow?.detailNodes.find(node => node.id === targetId);
  const adoptDeclaration = (bindingId: string) => {
    if (!draft || !target || !('bindings' in target)) return;
    const binding = resolvedTarget?.bindings.find(binding => binding.id === bindingId);
    if (!binding?.declarationHash || binding.codeNodeIds.length !== 1 || binding.anchorsValid === false || binding.status === 'missing' || binding.status === 'ambiguous' || binding.status === 'conflict') { setError('此绑定没有唯一可用的当前声明，需先修正原架构映射或锚点。'); return; }
    update({ ...draft.flow, steps: draft.flow.steps.map(step => step.id === target.id ? { ...step, origin: 'human-edited', bindings: step.bindings.map(value => value.id === bindingId ? { ...value, expectedDeclarationHash: binding.declarationHash } : value) } : step) });
  };
  const changeText = (key: keyof SemanticText, value: string, lines?: boolean) => {
    if (!draft || !target) return;
    const changed = { ...target, [key]: lines ? value.split('\n').map(text => text.trim()).filter(Boolean) : value, origin: 'human-edited' as const };
    update({ ...draft.flow, groups: draft.flow.groups.map(group => group.id === target.id ? changed as typeof group : group), steps: draft.flow.steps.map(step => step.id === target.id ? changed as typeof step : step) });
  };
  const save = async () => {
    if (!draft?.viewRevision) return; const request = ++sequence.current, key = identity; setBusy(true); setError('');
    try {
      const value = await semanticRequest<SemanticEditorEnvelope>(scope, '/model', {}, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedOverlayRevision: draft.baseRevision, viewRevision: draft.viewRevision, flow: draft.flow }) });
      if (!mounted.current || request !== sequence.current || live.current !== key) return;
      const currentView = editorVersion(value, scope);
      const flow = value.effectiveFlows.find(flow => flow.id === flowId); if (!flow) throw new Error('保存响应缺少当前流程，草稿仍保留。');
      setEnvelope(value); setDraft({ flow, baseRevision: value.overlayRevision, viewRevision: currentView }); setDirty(false); try { sessionStorage.removeItem(storageKey); } catch { /* Optional storage. */ } onSaved();
    } catch (failure) { if (mounted.current && request === sequence.current && live.current === key) setError(semanticError(failure)); }
    finally { if (mounted.current && request === sequence.current && live.current === key) setBusy(false); }
  };
  const transform = (operation: 'merge' | 'split') => {
    if (!draft) return;
    try { const flow = operation === 'merge' ? mergeGroups(draft.flow, groupIds, groupTitle || undefined) : splitGroup(draft.flow, targetId, childIds, groupTitle || undefined); update(flow); setGroupIds([]); setChildIds([]); setGroupTitle(''); if (!flow.groups.some(group => group.id === targetId)) setTargetId(flow.groups[0]?.id || ''); } catch (failure) { setError(semanticError(failure)); }
  };
  const download = () => { if (!draft) return; const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${flowId}-semantic-draft.json`; anchor.click(); URL.revokeObjectURL(url); };
  return <div className="semantic-editor-backdrop"><section role="dialog" aria-modal="true" aria-label="编辑业务解释" className="semantic-editor" data-base-revision={draft?.baseRevision || ''}><header><div><strong>编辑业务解释</strong><span>{dirty ? '有未保存修改 · 关闭后保留草稿' : '已与服务器同步'}</span></div><button aria-label="关闭业务解释编辑器" onClick={onClose}><X size={17} /></button></header>
    <div className="semantic-editor-toolbar"><button onClick={download} disabled={!draft}><Download size={13} />导出草稿</button><button title="重新读取服务器当前版本，将替换草稿；请先导出需要保留的修改" onClick={() => void load(false)} disabled={busy}><RefreshCw size={13} />载入服务器版本</button><button className="semantic-primary" onClick={() => void save()} disabled={busy || !draft?.viewRevision || !dirty}><Save size={13} />{busy ? '正在处理…' : '保存解释'}</button></div>
    {candidatePending && <div className="semantic-error"><div>已恢复未保存草稿，规则候选尚未应用。<br />请先导出需要保留的修改；替换只更新本地草稿，不自动保存。</div><button title="先导出需要保留的修改；此操作替换当前草稿，不自动保存" disabled={busy} onClick={applyCandidate}>用规则候选替换草稿</button></div>}
    {error && <div className="semantic-error" role="alert">{error}<span>保存失败不会丢弃草稿。版本冲突时请先导出，再载入当前服务器版本合并。</span></div>}
    {draft ? <div className="semantic-editor-body"><aside><label>流程名称<input value={draft.flow.title} disabled={busy} onChange={event => update({ ...draft.flow, title: event.target.value })} /></label><label>流程说明<textarea value={draft.flow.description} disabled={busy} onChange={event => update({ ...draft.flow, description: event.target.value })} /></label><strong>摘要分组</strong>{draft.flow.groups.map(group => <div className="semantic-editor-group" key={group.id}><label><input aria-label={`选择合并 ${group.title}`} type="checkbox" checked={groupIds.includes(group.id)} disabled={busy} onChange={event => setGroupIds(value => event.target.checked ? [...value, group.id] : value.filter(id => id !== group.id))} /><button className={targetId === group.id ? 'active' : ''} onClick={() => { setTargetId(group.id); setChildIds([]); }}>{group.title}<span>{group.childIds.length} 步</span></button></label></div>)}<label>新分组名称<input value={groupTitle} onChange={event => setGroupTitle(event.target.value)} placeholder="可选" disabled={busy} /></label><button disabled={busy || groupIds.length < 2} onClick={() => transform('merge')}><GitMerge size={13} />合并所选分组</button><p className="semantic-muted">只调整摘要分组，保留全部详细步骤、绑定与原始边界。</p><strong>详细步骤</strong>{draft.flow.steps.map(step => <button key={step.id} className={targetId === step.id ? 'active' : ''} onClick={() => setTargetId(step.id)}>{step.title}</button>)}</aside>
      <main>{target && <><h3>{'childIds' in target ? '摘要解释' : '详细步骤解释'}</h3>{fields.map(field => <label key={field.key}>{field.label}{field.key === 'title' ? <input aria-label={`解释${field.label}`} value={String(target[field.key])} disabled={busy} onChange={event => changeText(field.key, event.target.value)} /> : <textarea aria-label={`解释${field.label}`} rows={field.lines ? 3 : 2} value={Array.isArray(target[field.key]) ? (target[field.key] as string[]).join('\n') : target[field.key] as string} disabled={busy} onChange={event => changeText(field.key, event.target.value, field.lines)} />}{field.lines && <small>每行一项</small>}</label>)}{'childIds' in target && <section className="semantic-editor-split"><h4>拆分此分组</h4>{target.childIds.map(id => <label key={id}><input type="checkbox" aria-label={`拆分步骤 ${id}`} checked={childIds.includes(id)} onChange={event => setChildIds(value => event.target.checked ? [...value, id] : value.filter(item => item !== id))} disabled={busy} />{draft.flow.steps.find(step => step.id === id)?.title || id}</label>)}<button disabled={busy || childIds.length === 0 || childIds.length === target.childIds.length} onClick={() => transform('split')}><Scissors size={13} />将所选步骤拆为新组</button></section>}{'bindings' in target && <section className="semantic-editor-split"><h4>实现绑定与源码基准</h4><p className="semantic-muted">先核对当前源码证据。采用当前声明只更新 hash，人工说明保持原文，保存后仍需另行复核；不会修复失效锚点或把顺序标为已验证。</p>{target.bindings.map(binding => { const current = resolvedTarget?.bindings.find(item => item.id === binding.id); const unique = current?.declarationHash && current.codeNodeIds.length === 1 && current.anchorsValid !== false && !['missing', 'ambiguous', 'conflict'].includes(current.status); return <div className="semantic-binding" key={binding.id}><span>{binding.id}</span><code>原基准 {binding.expectedDeclarationHash?.slice(0, 14) || '未设置'}<br />当前 {current?.declarationHash?.slice(0, 14) || '不可用'}</code>{unique ? <button disabled={busy || binding.expectedDeclarationHash === current.declarationHash} onClick={() => adoptDeclaration(binding.id)}>采用当前源码基准（仍待审）</button> : <p className="semantic-muted">源码锚点失效或声明不能唯一解析，请修正原架构映射后重新核验。</p>}</div>; })}<p className="semantic-muted">{target.controls.length} 条控制条件保持原值。</p></section>}</>}</main></div> : !error && <div className="semantic-empty">正在载入流程定义…</div>}
    <footer><span>基线 {draft?.baseRevision.slice(0, 12) || '—'}</span><span>服务器 {envelope?.overlayRevision.slice(0, 12) || '—'}</span></footer>
  </section></div>;
}

import { useEffect, useRef, useState } from 'react';
import { Braces, Check, Download, Loader2, RefreshCw, Save, TriangleAlert, X } from 'lucide-react';
import type { ModelEnvelope } from '../../../../packages/architecture-model/src/types';
import { apiMessage, architectureRequest } from './client';

interface Draft { text: string; baseRevision: string }
function loadDraft(scope: string): Draft | undefined { try { return JSON.parse(sessionStorage.getItem(`ae:architecture-draft:${scope}`) || 'null') || undefined; } catch { return undefined; } }
function persistDraft(scope: string, draft?: Draft) { try { if (draft) sessionStorage.setItem(`ae:architecture-draft:${scope}`, JSON.stringify(draft)); else sessionStorage.removeItem(`ae:architecture-draft:${scope}`); } catch { /* In-memory draft is retained when browser storage is unavailable. */ } }

export default function ModelEditor({ scope, onClose, onSaved }: { scope: string; onClose: () => void; onSaved: (envelope: ModelEnvelope) => void }) {
  const [envelope, setEnvelope] = useState<ModelEnvelope>();
  const [draft, setDraft] = useState('');
  const [baseRevision, setBaseRevision] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const activeScope = useRef(scope); activeScope.current = scope;
  const mounted = useRef(true), requestSequence = useRef(0);
  useEffect(() => {
    mounted.current = true; let alive = true; const stored = loadDraft(scope); const sequence = ++requestSequence.current;
    const active = () => alive && mounted.current && activeScope.current === scope && sequence === requestSequence.current;
    setEnvelope(undefined); setDraft(stored?.text || ''); setBaseRevision(stored?.baseRevision || ''); setDirty(!!stored); setError(''); setBusy(true);
    architectureRequest<ModelEnvelope>(scope, '/model').then(value => {
      if (!active()) return; setEnvelope(value);
      if (!stored) { setDraft(JSON.stringify(value.model, null, 2)); setBaseRevision(value.modelRevision); }
      else if (stored.baseRevision !== value.modelRevision) setError('服务器模型已变化。草稿已保留；请复制草稿，载入当前版本后合并。旧基线保存会被服务器拒绝。');
    }).catch(error => { if (active()) setError(apiMessage(error)); }).finally(() => { if (active()) setBusy(false); });
    return () => { alive = false; mounted.current = false; requestSequence.current++; };
  }, [scope]);
  const change = (text: string) => { setDraft(text); setDirty(true); setNotice(''); persistDraft(scope, { text, baseRevision }); };
  const save = async () => {
    if (busy || !envelope) return;
    let model: unknown; try { model = JSON.parse(draft); } catch (error) { setError(`JSON 语法错误：${apiMessage(error)}`); return; }
    const requestScope = scope, sequence = ++requestSequence.current; setBusy(true); setError('');
    const active = () => mounted.current && activeScope.current === requestScope && sequence === requestSequence.current;
    try {
      const value = await architectureRequest<ModelEnvelope>(scope, '/model', {}, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: baseRevision, model }) });
      if (!active()) return;
      setEnvelope(value); setDraft(JSON.stringify(value.model, null, 2)); setBaseRevision(value.modelRevision); setDirty(false); persistDraft(scope); setNotice('模型已通过服务器校验并保存。源码索引没有被重新扫描。'); onSaved(value);
    } catch (error) { if (active()) setError(apiMessage(error)); }
    finally { if (active()) setBusy(false); }
  };
  const reloadServerVersion = async () => {
    if (busy) return;
    const requestScope = scope, sequence = ++requestSequence.current;
    const active = () => mounted.current && activeScope.current === requestScope && sequence === requestSequence.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const value = await architectureRequest<ModelEnvelope>(requestScope, '/model');
      if (!active()) return;
      setEnvelope(value); setDraft(JSON.stringify(value.model, null, 2)); setBaseRevision(value.modelRevision); setDirty(false); persistDraft(requestScope); setNotice('已重新读取并载入当前服务器版本。可在新基线上合并后保存。');
    } catch (error) { if (active()) setError(`${apiMessage(error)}\n重新载入失败，原草稿与基线已保留。`); }
    finally { if (active()) setBusy(false); }
  };
  const download = () => { const blob = new Blob([draft], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'architecture-model-draft.json'; link.click(); URL.revokeObjectURL(url); };
  return <div className="arch-editor-overlay" role="dialog" aria-modal="true" aria-label="架构模型编辑器"><div className="arch-model-editor"><header><span><Braces size={17} />架构模型<span className={`arch-editor-save-state ${dirty ? 'dirty' : ''}`}>{dirty ? '未保存草稿' : '已保存版本'}</span></span><button title="关闭编辑器（保留草稿）" aria-label="关闭编辑器" onClick={onClose}><X size={17} /></button></header>
    <div className="arch-editor-note">编辑工具仓库中的架构定义、归属和流程。所有变更由服务器进行 Schema 校验及并发版本检查；系统定义确认与成员归属确认分别记录。</div>
    {error && <div className="arch-editor-error" role="alert"><TriangleAlert size={14} /><pre>{error}</pre></div>}{notice && <div className="arch-editor-success"><Check size={14} />{notice}</div>}
    <textarea aria-label="架构模型 JSON" spellCheck={false} value={draft} onChange={event => change(event.target.value)} disabled={busy} placeholder={busy ? '读取当前模型…' : '模型 API 尚未就绪时，错误会显示于上方。'} />
    <footer><span title={baseRevision}>基线 {baseRevision ? baseRevision.slice(0, 12) : '尚未读取'}</span><button onClick={download} disabled={!draft}><Download size={13} />导出草稿</button><button onClick={() => { try { change(JSON.stringify(JSON.parse(draft), null, 2)); setError(''); } catch (error) { setError(apiMessage(error)); } }} disabled={!draft || busy}>格式化 JSON</button><button title="重新读取当前服务器模型并替换本地草稿；需要保留草稿请先导出" onClick={() => void reloadServerVersion()} disabled={busy}><RefreshCw size={13} />载入服务器版本</button><button className="arch-primary" disabled={!envelope || !dirty || busy} onClick={() => void save()}>{busy ? <Loader2 size={13} className="spin" /> : <Save size={13} />}校验并保存</button></footer>
  </div></div>;
}

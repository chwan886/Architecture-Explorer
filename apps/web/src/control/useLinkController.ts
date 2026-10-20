import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserBootstrap, BrowserState, ControlCommand, PresentationReceipt } from '../../../../packages/control-protocol/src/types';
import { bootstrapBrowser, BrowserControlError, browserRequest, commandConflict, getBrowserCurrent, postBrowserState, resetBrowserBootstrap } from './browser';
import type { BrowserAckStatus, BrowserActual } from './browser';

interface Options { scopeId: string; label: string; onApply: (command: ControlCommand, isCurrent: () => boolean) => Promise<void>; onClear: (message: string) => void }
export default function useLinkController(options: Options) {
  const handlers = useRef(options); handlers.current = options;
  const local = useRef<BrowserState>({ userRevision: 0, controlRevision: 0, allowControl: false, label: options.label, scopeId: options.scopeId || undefined, visible: document.visibilityState !== 'hidden' });
  local.current.label = options.label.slice(0, 120); local.current.scopeId = options.scopeId || undefined;
  const [bootstrap, setBootstrap] = useState<BrowserBootstrap>(), [state, setState] = useState(local.current), [connected, setConnected] = useState(false), [error, setError] = useState(''), [receipt, setReceipt] = useState<PresentationReceipt>();
  const [retry, setRetry] = useState(0), [command, setCommand] = useState<ControlCommand>();
  const bootstrapRef = useRef<BrowserBootstrap | undefined>(undefined), pending = useRef<ControlCommand | undefined>(undefined), active = useRef<ControlCommand | undefined>(undefined);
  const alive = useRef(false), queue = useRef(Promise.resolve()), pullBusy = useRef(false), pullAgain = useRef(false), receiving = useRef(new Set<string>()), completed = useRef(new Set<string>()), leaving = useRef(false);
  const awaitingAck = useRef<{ command: ControlCommand; actual: BrowserActual; userRevision: number; controlRevision: number } | undefined>(undefined);
  const publish = () => setState({ ...local.current });
  const report = useCallback(() => {
    queue.current = queue.current.catch(() => {}).then(async () => { const boot = bootstrapRef.current; if (!alive.current || !boot) return; try { await postBrowserState(boot, { ...local.current }); } catch (failure) { if (alive.current) { setConnected(false); setError(failure instanceof Error ? failure.message : String(failure)); } } });
    return queue.current;
  }, []);
  const ack = useCallback(async (value: ControlCommand, status: BrowserAckStatus, message?: string, actual?: BrowserActual, controlRevision = local.current.controlRevision) => {
    const boot = bootstrapRef.current; if (!boot) throw new Error('联动会话尚未建立。');
    const result = await browserRequest<PresentationReceipt>('ack', { sessionId: boot.sessionId, csrf: boot.csrf, commandId: value.commandId, status, userRevision: local.current.userRevision, controlRevision, ...(actual ? { actual } : {}), ...(message ? { message } : {}) });
    if (alive.current && bootstrapRef.current?.sessionId === boot.sessionId) setReceipt(result); return result;
  }, []);
  const cancelPending = useCallback((message: string) => {
    const value = pending.current; pending.current = undefined;
    awaitingAck.current = undefined;
    if (value) void ack(value, 'conflict', message).catch(() => {});
  }, [ack]);
  const markUserAction = useCallback(() => {
    local.current = { ...local.current, userRevision: local.current.userRevision + 1 }; publish(); cancelPending('人工操作已优先，旧联动命令取消。'); void report();
  }, [cancelPending, report]);
  const invalidate = useCallback((scopeId: string, kind: 'index' | 'architecture' | 'semantic', revision?: string) => {
    const value = active.current; if (!value || value.resolved.snapshot.scopeId !== scopeId || !revision) return;
    const expected = kind === 'index' ? value.resolved.snapshot.indexSnapshotId : kind === 'architecture' ? value.resolved.snapshot.architectureRevision : value.resolved.semantic?.metadata.overlayRevision;
    if (!expected || expected === revision) return;
    handlers.current.onClear('源码或模型已经更新；旧分析快照的高亮已清除，请重新分析。'); cancelPending('分析快照已失效。');
  }, [cancelPending]);
  const consume = useCallback(async () => {
    if (pullBusy.current) { pullAgain.current = true; return; }
    const boot = bootstrapRef.current; if (!boot || !alive.current) return;
    pullBusy.current = true;
    try {
      const current = await getBrowserCurrent(boot); if (!alive.current || bootstrapRef.current?.sessionId !== boot.sessionId) return;
      if (current.session.serverEpoch !== boot.serverEpoch) throw new BrowserControlError(409, '服务实例已更换，请重新允许联动。', 'SERVER_CHANGED');
      setConnected(true);
      if (current.pending) setReceipt(current.pending);
      if (!current.command && current.pending?.status === 'expired' && (active.current?.commandId === current.pending.commandId || pending.current?.commandId === current.pending.commandId)) {
        completed.current.add(current.pending.commandId); active.current = undefined; pending.current = undefined; awaitingAck.current = undefined;
        handlers.current.onClear(current.pending.message || '服务端分析快照已失效，请重新分析。'); return;
      }
      if (current.pending?.status === 'presented' && awaitingAck.current?.command.commandId === current.pending.commandId) { completed.current.add(current.pending.commandId); pending.current = undefined; awaitingAck.current = undefined; }
      if (!current.command && current.pending?.action === 'clear' && current.session.controlRevision > local.current.controlRevision) {
        pending.current = undefined; awaitingAck.current = undefined; local.current = { ...local.current, controlRevision: current.session.controlRevision }; publish(); handlers.current.onClear('联动高亮已清除。'); return;
      }
      const retryAck = awaitingAck.current;
      if (retryAck && current.pending?.commandId === retryAck.command.commandId && current.pending.status === 'received' && retryAck.userRevision === local.current.userRevision && local.current.allowControl) {
        await ack(retryAck.command, 'presented', '页面已呈现，重试确认此前未收到的回执。', retryAck.actual, retryAck.controlRevision); completed.current.add(retryAck.command.commandId); pending.current = undefined; awaitingAck.current = undefined; void report(); return;
      }
      const value = current.command; if (!value || completed.current.has(value.commandId) || receiving.current.has(value.commandId) || pending.current?.commandId === value.commandId) return;
      const conflict = commandConflict(value, boot, local.current);
      if (conflict) { completed.current.add(value.commandId); await ack(value, 'conflict', conflict); return; }
      if (document.querySelector('[role="dialog"]')) { completed.current.add(value.commandId); await ack(value, 'failed', '页面正在编辑模型，保留草稿；请关闭编辑器后重新提交联动。'); return; }
      receiving.current.add(value.commandId); pending.current = value;
      const isCurrent = () => alive.current && pending.current?.commandId === value.commandId && !commandConflict(value, boot, local.current);
      try {
        await ack(value, 'received', '浏览器已接收，正在校验并呈现。', undefined, value.expectedControlRevision);
        if (!isCurrent()) return;
        await handlers.current.onApply(value, isCurrent);
        if (!isCurrent()) return;
        active.current = value; setCommand(value); setError('');
      } catch (failure) {
        if (pending.current?.commandId === value.commandId) { pending.current = undefined; completed.current.add(value.commandId); await ack(value, 'failed', failure instanceof Error ? failure.message : String(failure)).catch(() => {}); }
      } finally { receiving.current.delete(value.commandId); }
    } catch (failure) { if (alive.current) { setConnected(false); setError(failure instanceof Error ? failure.message : String(failure)); if (failure instanceof BrowserControlError && ['SESSION_EXPIRED', 'BINDING_EXPIRED', 'SESSION_NOT_FOUND', 'SESSION_REJECTED', 'SESSION_FORBIDDEN', 'SERVER_CHANGED'].includes(failure.code || '')) { pending.current = undefined; awaitingAck.current = undefined; bootstrapRef.current = undefined; setBootstrap(undefined); local.current = { ...local.current, allowControl: false }; publish(); handlers.current.onClear('联动会话已过期，请再次明确允许联动。'); resetBrowserBootstrap(); setRetry(value => value + 1); } } }
    finally { pullBusy.current = false; if (pullAgain.current) { pullAgain.current = false; void consume(); } }
  }, [ack, report]);
  const presented = useCallback(async (commandId: string, actual: BrowserActual) => {
    const value = pending.current, boot = bootstrapRef.current;
    if (!value || value.commandId !== commandId || !boot || commandConflict(value, boot, local.current)) return;
    // CAS is checked after layout/evidence completion. Increment synchronously
    // before the acknowledgment so a newer command cannot reuse this baseline.
    local.current = { ...local.current, controlRevision: value.expectedControlRevision + 1 }; publish();
    awaitingAck.current = { command: value, actual, userRevision: local.current.userRevision, controlRevision: local.current.controlRevision };
    try { await ack(value, 'presented', '当前快照已完成布局、定位与证据核对。', actual, local.current.controlRevision); completed.current.add(commandId); awaitingAck.current = undefined; if (pending.current?.commandId === commandId) pending.current = undefined; void report(); }
    catch (failure) { setError(`呈现回执未确认：${failure instanceof Error ? failure.message : String(failure)}。重新连接后请查询命令状态。`); void consume(); }
  }, [ack, consume, report]);
  const failed = useCallback((commandId: string, message: string) => { const value = pending.current; if (!value || value.commandId !== commandId) return; pending.current = undefined; completed.current.add(commandId); void ack(value, 'failed', message).catch(() => {}); }, [ack]);
  const enable = useCallback(async () => { const boot = bootstrapRef.current; if (!boot) { setRetry(value => value + 1); return; } await queue.current.catch(() => {}); local.current = { ...local.current, userRevision: local.current.userRevision + 1, allowControl: true }; publish(); setError(''); try { await postBrowserState(boot, { ...local.current }); void consume(); } catch (failure) { local.current = { ...local.current, allowControl: false }; publish(); setError(failure instanceof Error ? failure.message : String(failure)); } }, [consume]);
  const clear = useCallback(() => { markUserAction(); handlers.current.onClear('联动高亮已清除。'); }, [markUserAction]);
  const leave = useCallback(async () => {
    if (leaving.current) return; leaving.current = true; markUserAction(); local.current = { ...local.current, allowControl: false }; publish(); handlers.current.onClear('已退出联动，当前浏览上下文与草稿保留。');
    const boot = bootstrapRef.current;
    try { if (boot) await browserRequest('leave', { sessionId: boot.sessionId, csrf: boot.csrf }); setError(''); } catch (failure) { setError(`本页已停止接受控制；服务回执未确认：${failure instanceof Error ? failure.message : String(failure)}`); } finally { leaving.current = false; void report(); }
  }, [markUserAction, report]);
  useEffect(() => {
    alive.current = true; let stopped = false, stream: EventSource | undefined;
    void bootstrapBrowser().then(value => {
      if (stopped) return; bootstrapRef.current = value; setBootstrap(value); local.current = { ...local.current, userRevision: Math.max(local.current.userRevision, value.state.userRevision), controlRevision: value.state.controlRevision, allowControl: false }; publish();
      stream = new EventSource(`/api/bridge/browser/events?sessionId=${encodeURIComponent(value.sessionId)}`);
      stream.addEventListener?.('control', () => void consume()); stream.onmessage = () => void consume(); stream.onopen = () => { if (!stopped) { setConnected(true); void consume(); } }; stream.onerror = () => { if (!stopped) setConnected(false); };
      void report(); void consume();
    }).catch(failure => { if (!stopped) setError(failure instanceof Error ? failure.message : String(failure)); });
    const heartbeat = setInterval(() => { local.current.visible = document.visibilityState !== 'hidden'; if (bootstrapRef.current) { void report(); void consume(); } }, 15000);
    const visibility = () => { local.current.visible = document.visibilityState !== 'hidden'; void report(); if (local.current.visible) void consume(); }; document.addEventListener('visibilitychange', visibility);
    return () => { stopped = true; alive.current = false; clearInterval(heartbeat); document.removeEventListener('visibilitychange', visibility); stream?.close(); };
  }, [retry, consume, report]);
  useEffect(() => { void report(); }, [options.scopeId, options.label, report]);
  useEffect(() => {
    if (!command) return; const remaining = Math.min(Date.parse(command.resolved.snapshot.expiresAt), Date.parse(command.expiresAt)) - Date.now();
    const timer = setTimeout(() => { handlers.current.onClear('分析快照已过期，高亮已清除。请重新分析后再联动。'); cancelPending('分析快照已过期。'); }, Math.max(0, remaining)); return () => clearTimeout(timer);
  }, [command, cancelPending]);
  return { bootstrap, state, connected, error, receipt, command, enable, clear, leave, markUserAction, invalidate, presented, failed, reconnect: () => void consume() };
}

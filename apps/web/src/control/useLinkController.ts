import { useCallback, useEffect, useRef, useState } from 'react';
import type { BridgeActivity, BrowserBootstrap, BrowserState, ControlCommand, PresentationReceipt } from '../../../../packages/control-protocol/src/types';
import { bootstrapBrowser, BrowserControlError, browserRequest, commandConflict, getBrowserCurrent, postBrowserState, resetBrowserBootstrap } from './browser';
import type { BrowserAckStatus, BrowserActual } from './browser';
import { mergeActivities } from './activity';

interface Options { scopeId: string; label: string; onApply: (command: ControlCommand, isCurrent: () => boolean) => Promise<void>; onClear: (message: string) => void }
export default function useLinkController(options: Options) {
  const handlers = useRef(options); handlers.current = options;
  const local = useRef<BrowserState>({ userRevision: 0, controlRevision: 0, allowControl: false, label: options.label, scopeId: options.scopeId || undefined, visible: document.visibilityState !== 'hidden' });
  local.current.label = options.label.slice(0, 120); local.current.scopeId = options.scopeId || undefined;
  const [bootstrap, setBootstrap] = useState<BrowserBootstrap>(), [state, setState] = useState(local.current), [connected, setConnected] = useState(false), [error, setError] = useState(''), [receipt, setReceipt] = useState<PresentationReceipt>();
  const [retry, setRetry] = useState(0), [command, setCommand] = useState<ControlCommand>();
  const [activities, setActivities] = useState<BridgeActivity[]>([]), activityValues = useRef<BridgeActivity[]>([]), activityScope = useRef(options.scopeId), activitySequence = useRef(0), activitySession = useRef<string | undefined>(undefined);
  const bootstrapRef = useRef<BrowserBootstrap | undefined>(undefined), pending = useRef<ControlCommand | undefined>(undefined), active = useRef<ControlCommand | undefined>(undefined);
  const alive = useRef(false), queue = useRef(Promise.resolve()), pullBusy = useRef(false), pullAgain = useRef(false), receiving = useRef(new Set<string>()), completed = useRef(new Set<string>()), leaving = useRef(false);
  const awaitingAck = useRef<{ command: ControlCommand; actual: BrowserActual; userRevision: number; controlRevision: number } | undefined>(undefined);
  const storeActivities = useCallback((incoming: BridgeActivity[]) => {
    if (!alive.current) return;
    const scopeId = handlers.current.scopeId;
    const previous = activityScope.current === scopeId ? activityValues.current : [];
    activityScope.current = scopeId;
    const next = mergeActivities(previous, incoming, scopeId);
    if (JSON.stringify(next) !== JSON.stringify(activityValues.current)) { activityValues.current = next; setActivities(next); }
  }, []);
  const recordActivity = useCallback((id: string, kind: BridgeActivity['kind'], operation: string, title: string, message: string, status: BridgeActivity['status'], value?: ControlCommand) => {
    const previous = activityScope.current === handlers.current.scopeId ? activityValues.current.find(item => item.id === id) : undefined;
    if (previous?.status === status && previous.message === message) return;
    const now = new Date().toISOString();
    storeActivities([{ id, sequence: previous?.sequence ?? ++activitySequence.current, kind, operation, title: title.slice(0, 120), message: message.slice(0, 400), status, startedAt: previous?.startedAt ?? now, updatedAt: now, scopeId: value?.resolved.snapshot.scopeId || handlers.current.scopeId || undefined, ...(value ? { snapshotId: value.resolved.snapshot.snapshotId, indexSnapshotId: value.resolved.snapshot.indexSnapshotId, commandId: value.commandId } : {}) }]);
  }, [storeActivities]);
  const recordCommand = useCallback((value: ControlCommand, status: BridgeActivity['status'], message: string) => {
    const boot = bootstrapRef.current;
    if (!boot || value.sessionId !== boot.sessionId || value.serverEpoch !== boot.serverEpoch) return;
    const id = `ui:command:${value.commandId}`, previous = activityValues.current.find(item => item.id === id);
    // A late ACK or unchanged server receipt must not erase manual takeover.
    if (previous?.status === 'paused') return;
    recordActivity(id, 'presentation', 'present', value.resolved.presentation.title || '展示架构分析', message, status, value);
  }, [recordActivity]);
  const connectionFailed = useCallback(() => recordActivity('ui:connection', 'session', 'connection', '本地联动连接', '暂时无法确认服务状态；已保留当前页面，请等待连接恢复。', 'failed'), [recordActivity]);
  const publish = () => setState({ ...local.current });
  const report = useCallback(() => {
    queue.current = queue.current.catch(() => {}).then(async () => { const boot = bootstrapRef.current; if (!alive.current || !boot) return; try { await postBrowserState(boot, { ...local.current }); } catch (failure) { if (alive.current) { setConnected(false); setError(failure instanceof Error ? failure.message : String(failure)); connectionFailed(); } } });
    return queue.current;
  }, [connectionFailed]);
  const ack = useCallback(async (value: ControlCommand, status: BrowserAckStatus, message?: string, actual?: BrowserActual, controlRevision = local.current.controlRevision) => {
    const boot = bootstrapRef.current; if (!boot) throw new Error('联动会话尚未建立。');
    const result = await browserRequest<PresentationReceipt>('ack', { sessionId: boot.sessionId, csrf: boot.csrf, commandId: value.commandId, status, userRevision: local.current.userRevision, controlRevision, ...(actual ? { actual } : {}), ...(message ? { message } : {}) });
    if (alive.current && bootstrapRef.current?.sessionId === boot.sessionId) setReceipt(result); return result;
  }, []);
  const cancelPending = useCallback((message: string) => {
    const value = pending.current; pending.current = undefined;
    awaitingAck.current = undefined;
    if (value) recordCommand(value, 'paused', message);
    if (value) void ack(value, 'conflict', message).catch(() => {});
  }, [ack, recordCommand]);
  const markUserAction = useCallback(() => {
    if (active.current && active.current.commandId !== pending.current?.commandId) recordCommand(active.current, 'paused', '人工操作已优先；此展示的自动定位已暂停。');
    local.current = { ...local.current, userRevision: local.current.userRevision + 1 }; publish(); cancelPending('人工操作已优先，旧联动命令取消。'); void report();
  }, [cancelPending, recordCommand, report]);
  const invalidate = useCallback((scopeId: string, kind: 'index' | 'architecture' | 'semantic', revision?: string) => {
    const value = active.current; if (!value || value.resolved.snapshot.scopeId !== scopeId || !revision) return;
    const expected = kind === 'index' ? value.resolved.snapshot.indexSnapshotId : kind === 'architecture' ? value.resolved.snapshot.architectureRevision : value.resolved.semantic?.metadata.overlayRevision;
    if (!expected || expected === revision) return;
    recordCommand(value, 'paused', '源码或模型已更新；原展示已过期，需要重新分析。');
    handlers.current.onClear('源码或模型已经更新；旧分析快照的高亮已清除，请重新分析。'); cancelPending('分析快照已失效。');
  }, [cancelPending, recordCommand]);
  const consume = useCallback(async () => {
    if (pullBusy.current) { pullAgain.current = true; return; }
    const boot = bootstrapRef.current; if (!boot || !alive.current) return;
    pullBusy.current = true;
    try {
      const current = await getBrowserCurrent(boot); if (!alive.current || bootstrapRef.current?.sessionId !== boot.sessionId) return;
      if (current.session.serverEpoch !== boot.serverEpoch) throw new BrowserControlError(409, '服务实例已更换，请重新允许联动。', 'SERVER_CHANGED');
      setConnected(true);
      if (activityValues.current.some(value => value.id === 'ui:connection' && value.status === 'failed')) recordActivity('ui:connection', 'session', 'connection', '本地联动连接', '已重新连接本地服务；旧展示仍受原有快照与人工操作校验约束。', 'completed');
      if (local.current.allowControl && current.session.scopeId === handlers.current.scopeId) storeActivities(current.activities || []);
      if (current.pending) setReceipt(current.pending);
      const receiptCommand = [pending.current, active.current].find(value => value?.commandId === current.pending?.commandId);
      if (receiptCommand && current.pending && ['expired', 'conflict', 'superseded', 'failed'].includes(current.pending.status)) recordCommand(receiptCommand, current.pending.status === 'failed' ? 'failed' : 'paused', current.pending.status === 'expired' ? '分析快照已过期，原展示已停止；请重新分析。' : current.pending.status === 'failed' ? '页面未能完成此展示；请检查联动状态后重新提交。' : '此展示已停止，保留当前人工浏览上下文。');
      if (!current.command && current.pending?.status === 'expired' && (active.current?.commandId === current.pending.commandId || pending.current?.commandId === current.pending.commandId)) {
        completed.current.add(current.pending.commandId); active.current = undefined; pending.current = undefined; awaitingAck.current = undefined;
        handlers.current.onClear(current.pending.message || '服务端分析快照已失效，请重新分析。'); return;
      }
      if (current.pending?.status === 'presented' && awaitingAck.current?.command.commandId === current.pending.commandId) { recordCommand(awaitingAck.current.command, 'completed', '页面已完成布局、节点定位与源码证据核对。'); completed.current.add(current.pending.commandId); pending.current = undefined; awaitingAck.current = undefined; }
      if (!current.command && current.pending?.action === 'clear' && current.session.controlRevision > local.current.controlRevision) {
        if (active.current) recordCommand(active.current, 'paused', '联动高亮已清除，近期展示摘要保留。');
        pending.current = undefined; awaitingAck.current = undefined; local.current = { ...local.current, controlRevision: current.session.controlRevision }; publish(); handlers.current.onClear('联动高亮已清除。'); return;
      }
      const retryAck = awaitingAck.current;
      if (retryAck && current.pending?.commandId === retryAck.command.commandId && current.pending.status === 'received' && retryAck.userRevision === local.current.userRevision && local.current.allowControl) {
        await ack(retryAck.command, 'presented', '页面已呈现，重试确认此前未收到的回执。', retryAck.actual, retryAck.controlRevision); recordCommand(retryAck.command, 'completed', '页面已完成布局、节点定位与源码证据核对。'); completed.current.add(retryAck.command.commandId); pending.current = undefined; awaitingAck.current = undefined; void report(); return;
      }
      const value = current.command; if (!value || completed.current.has(value.commandId) || receiving.current.has(value.commandId) || pending.current?.commandId === value.commandId) return;
      const conflict = commandConflict(value, boot, local.current);
      if (conflict) { recordCommand(value, 'paused', '页面状态或分析快照已变化；此命令未接管当前浏览。'); completed.current.add(value.commandId); await ack(value, 'conflict', conflict); return; }
      if (document.querySelector('[role="dialog"]')) { recordCommand(value, 'paused', '页面正在编辑模型；已保留草稿，请关闭编辑器后重新提交。'); completed.current.add(value.commandId); await ack(value, 'failed', '页面正在编辑模型，保留草稿；请关闭编辑器后重新提交联动。'); return; }
      storeActivities(activityValues.current.filter(item => item.kind === 'query' && item.status === 'running' && ((item.snapshotId && item.snapshotId !== value.resolved.snapshot.snapshotId) || (item.indexSnapshotId && item.indexSnapshotId !== value.resolved.snapshot.indexSnapshotId))).map(item => ({ ...item, status: 'paused', message: '本页已切换分析快照，停止跟踪此查询；不表示后端读取已取消。', updatedAt: new Date().toISOString() })));
      receiving.current.add(value.commandId); pending.current = value;
      recordCommand(value, 'running', '已接收展示请求，正在校验快照并准备页面。');
      const isCurrent = () => alive.current && pending.current?.commandId === value.commandId && !commandConflict(value, boot, local.current);
      try {
        await ack(value, 'received', '浏览器已接收，正在校验并呈现。', undefined, value.expectedControlRevision);
        if (!isCurrent()) return;
        await handlers.current.onApply(value, isCurrent);
        if (!isCurrent()) return;
        active.current = value; setCommand(value); setError('');
        recordCommand(value, 'running', '正在完成图形布局、节点定位与源码证据核对。');
      } catch (failure) {
        if (pending.current?.commandId === value.commandId) { recordCommand(value, 'failed', '页面未能完成此展示；请检查联动状态后重新提交。'); pending.current = undefined; completed.current.add(value.commandId); await ack(value, 'failed', failure instanceof Error ? failure.message : String(failure)).catch(() => {}); }
      } finally { receiving.current.delete(value.commandId); }
    } catch (failure) { if (alive.current) { setConnected(false); setError(failure instanceof Error ? failure.message : String(failure)); connectionFailed(); if (failure instanceof BrowserControlError && ['SESSION_EXPIRED', 'BINDING_EXPIRED', 'SESSION_NOT_FOUND', 'SESSION_REJECTED', 'SESSION_FORBIDDEN', 'SERVER_CHANGED'].includes(failure.code || '')) { pending.current = undefined; awaitingAck.current = undefined; bootstrapRef.current = undefined; setBootstrap(undefined); local.current = { ...local.current, allowControl: false }; publish(); handlers.current.onClear('联动会话已过期，请再次明确允许联动。'); resetBrowserBootstrap(); setRetry(value => value + 1); } } }
    finally { pullBusy.current = false; if (pullAgain.current) { pullAgain.current = false; void consume(); } }
  }, [ack, connectionFailed, recordActivity, recordCommand, report, storeActivities]);
  const presented = useCallback(async (commandId: string, actual: BrowserActual) => {
    const value = pending.current, boot = bootstrapRef.current;
    if (!value || value.commandId !== commandId || !boot || commandConflict(value, boot, local.current)) return;
    // CAS is checked after layout/evidence completion. Increment synchronously
    // before the acknowledgment so a newer command cannot reuse this baseline.
    local.current = { ...local.current, controlRevision: value.expectedControlRevision + 1 }; publish();
    awaitingAck.current = { command: value, actual, userRevision: local.current.userRevision, controlRevision: local.current.controlRevision };
    try { await ack(value, 'presented', '当前快照已完成布局、定位与证据核对。', actual, local.current.controlRevision); if (!alive.current || bootstrapRef.current !== boot) return; recordCommand(value, 'completed', '页面已完成布局、节点定位与源码证据核对。'); completed.current.add(commandId); awaitingAck.current = undefined; if (pending.current?.commandId === commandId) pending.current = undefined; void report(); }
    catch (failure) { if (!alive.current || bootstrapRef.current !== boot) return; recordCommand(value, 'running', '页面已呈现，正在等待服务确认回执；请勿重复提交旧命令。'); setError(`呈现回执未确认：${failure instanceof Error ? failure.message : String(failure)}。重新连接后请查询命令状态。`); void consume(); }
  }, [ack, consume, recordCommand, report]);
  const failed = useCallback((commandId: string, message: string) => { const value = pending.current; if (!value || value.commandId !== commandId) return; recordCommand(value, 'failed', '图形或证据核对未通过；此展示已停止。'); pending.current = undefined; completed.current.add(commandId); void ack(value, 'failed', message).catch(() => {}); }, [ack, recordCommand]);
  const enable = useCallback(async () => { const boot = bootstrapRef.current; if (!boot) { setRetry(value => value + 1); return; } await queue.current.catch(() => {}); local.current = { ...local.current, userRevision: local.current.userRevision + 1, allowControl: true }; publish(); setError(''); try { await postBrowserState(boot, { ...local.current }); recordActivity('ui:permission', 'session', 'allow', 'Codex 联动', '已允许本页接收展示请求；人工操作始终优先。', 'completed'); void consume(); } catch (failure) { local.current = { ...local.current, allowControl: false }; publish(); recordActivity('ui:permission', 'session', 'allow', 'Codex 联动', '允许联动未成功，页面仍由你手动控制。', 'failed'); setError(failure instanceof Error ? failure.message : String(failure)); } }, [consume, recordActivity]);
  const clear = useCallback(() => { markUserAction(); handlers.current.onClear('联动高亮已清除。'); recordActivity('ui:clear', 'session', 'clear', '已清除联动高亮', '页面保留当前浏览位置和近期执行摘要。', 'completed'); }, [markUserAction, recordActivity]);
  const leave = useCallback(async () => {
    if (leaving.current) return; leaving.current = true; markUserAction(); local.current = { ...local.current, allowControl: false }; publish(); handlers.current.onClear('已退出联动，当前浏览上下文与草稿保留。');
    storeActivities(activityValues.current.filter(value => value.kind === 'query' && value.status === 'running').map(value => ({ ...value, status: 'paused', message: '本页已停止跟踪此查询；这不表示后端读取已取消。', updatedAt: new Date().toISOString() })));
    recordActivity('ui:permission', 'session', 'leave', '已恢复手动浏览', '本页已停止接收联动展示，近期执行摘要保留。', 'paused');
    const boot = bootstrapRef.current;
    try { if (boot) await browserRequest('leave', { sessionId: boot.sessionId, csrf: boot.csrf }); setError(''); } catch (failure) { setError(`本页已停止接受控制；服务回执未确认：${failure instanceof Error ? failure.message : String(failure)}`); } finally { leaving.current = false; void report(); }
  }, [markUserAction, recordActivity, report, storeActivities]);
  useEffect(() => {
    alive.current = true; let stopped = false, stream: EventSource | undefined;
    void bootstrapBrowser().then(value => {
      if (stopped) return;
      const activitySessionId = `${value.serverEpoch}:${value.sessionId}`;
      if (activitySession.current !== activitySessionId) {
        const replacedSession = activitySession.current !== undefined;
        activitySession.current = activitySessionId; activityValues.current = []; activityScope.current = handlers.current.scopeId; activitySequence.current = 0; setActivities([]);
        active.current = undefined; pending.current = undefined; awaitingAck.current = undefined; receiving.current.clear(); completed.current.clear(); setCommand(undefined); setReceipt(undefined);
        if (replacedSession) handlers.current.onClear('联动会话已重建，旧展示及源码上下文已失效；请重新分析后再展示。');
      }
      bootstrapRef.current = value; setBootstrap(value); local.current = { ...local.current, userRevision: Math.max(local.current.userRevision, value.state.userRevision), controlRevision: value.state.controlRevision, allowControl: false }; publish();
      stream = new EventSource(`/api/bridge/browser/events?sessionId=${encodeURIComponent(value.sessionId)}`);
      stream.addEventListener?.('control', () => void consume()); stream.onmessage = () => void consume(); stream.onopen = () => { if (!stopped) { setConnected(true); void consume(); } }; stream.onerror = () => { if (!stopped) { setConnected(false); connectionFailed(); } };
      void report(); void consume();
    }).catch(failure => { if (!stopped) { setError(failure instanceof Error ? failure.message : String(failure)); connectionFailed(); } });
    const heartbeat = setInterval(() => { local.current.visible = document.visibilityState !== 'hidden'; if (bootstrapRef.current) { void report(); void consume(); } }, 15000);
    const visibility = () => { local.current.visible = document.visibilityState !== 'hidden'; void report(); if (local.current.visible) void consume(); }; document.addEventListener('visibilitychange', visibility);
    return () => { stopped = true; alive.current = false; clearInterval(heartbeat); document.removeEventListener('visibilitychange', visibility); stream?.close(); };
  }, [retry, consume, connectionFailed, report]);
  useEffect(() => { storeActivities([]); void report(); }, [options.scopeId, options.label, report, storeActivities]);
  useEffect(() => {
    if (!command) return; const remaining = Math.min(Date.parse(command.resolved.snapshot.expiresAt), Date.parse(command.expiresAt)) - Date.now();
    const timer = setTimeout(() => { recordCommand(command, 'paused', '分析快照已过期，原展示已停止；请重新分析。'); handlers.current.onClear('分析快照已过期，高亮已清除。请重新分析后再联动。'); cancelPending('分析快照已过期。'); }, Math.max(0, remaining)); return () => clearTimeout(timer);
  }, [command, cancelPending, recordCommand]);
  return { bootstrap, state, connected, error, receipt, command, activities, enable, clear, leave, markUserAction, invalidate, presented, failed, reconnect: () => void consume() };
}

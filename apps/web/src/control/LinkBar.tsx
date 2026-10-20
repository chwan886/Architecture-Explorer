import { Circle, Link2, Loader2, MessageSquareText, ShieldCheck, Unlink, X } from 'lucide-react';
import type useLinkController from './useLinkController';

export default function LinkBar({ controller, highlightsEnabled, staleMessage, onShowProgress }: { controller: ReturnType<typeof useLinkController>; highlightsEnabled: boolean; staleMessage: string; onShowProgress?: () => void }) {
  const { state, bootstrap, receipt, command } = controller;
  const highlighted = command?.resolved.highlights;
  const nodeCount = highlightsEnabled && highlighted ? highlighted.codeNodeIds.length + highlighted.semanticNodeIds.length + highlighted.architectureNodeIds.length : 0;
  const edgeCount = highlightsEnabled && highlighted ? highlighted.codeEdgeIds.length + highlighted.semanticEdgeIds.length + highlighted.architectureEdgeIds.length : 0;
  return <div className={`control-linkbar ${state.allowControl ? 'enabled' : ''}`} data-allow-control={String(state.allowControl)} data-user-revision={state.userRevision} data-control-revision={state.controlRevision}>
    <div className="control-link-status">{state.allowControl ? <Link2 size={13} /> : <ShieldCheck size={13} />}<span>{state.allowControl ? controller.connected ? 'Codex 联动已允许' : '联动重连中' : '本页由你控制'}</span>{state.allowControl && !controller.connected && <Loader2 size={12} className="spin" />}</div>
    {state.allowControl ? <><span className="control-session-label" title={bootstrap?.sessionId}>会话 {bootstrap?.sessionId.slice(-8)}</span><span className="control-current-analysis" title={command?.resolved.presentation.title}>{command?.resolved.presentation.title || '等待 Codex 分析'}</span>{command && <span className="control-snapshot-status">{staleMessage ? '快照失效' : `${nodeCount} 节点 · ${edgeCount} 关系映射`}</span>}<span className="control-receipt" title={receipt?.message}>{receipt?.status === 'presented' ? '已呈现' : receipt?.status === 'received' ? '正在呈现' : receipt?.status === 'conflict' ? '人工操作已优先' : receipt?.status === 'failed' ? '呈现失败' : ''}</span><button onClick={controller.clear} disabled={!command || !highlightsEnabled}><X size={12} />清高亮</button><button onClick={() => void controller.leave()}><Unlink size={12} />退出联动</button></> : <><span className="control-permission-note">启用后，仅允许指定会话定位和展示分析；可随时退出。</span><button disabled={!bootstrap} onClick={() => void controller.enable()}><Link2 size={12} />允许 Codex 联动</button></>}
    {onShowProgress && <button data-control-automatic="true" aria-label="打开演示进度气泡" onClick={onShowProgress}><MessageSquareText size={12} />演示进度</button>}
    {controller.error && <details className="control-connection-error"><summary title={controller.error}><Circle size={9} />联动连接说明</summary><p>{controller.error}</p><button onClick={controller.reconnect}>重新连接</button></details>}
  </div>;
}

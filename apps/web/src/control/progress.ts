import type { BridgeActivity, ControlCommand, PresentationReceipt } from '../../../../packages/control-protocol/src/types';

export interface BubblePosition { x: number; y: number }
export interface BubblePreferences extends BubblePosition { version: 1; collapsed: boolean }
export const BUBBLE_STORAGE_KEY = 'architecture-explorer.progress-ui.v1';
export const BUBBLE_MARGIN = 12;
/** UI preferences only. Never persist a session, a command, source, or activity. */
export function readBubblePreferences(value: string | null): BubblePreferences | undefined {
  try {
    const saved: unknown = JSON.parse(value || 'null');
    if (!saved || typeof saved !== 'object') return;
    const item = saved as Record<string, unknown>;
    if (item.version === 1 && typeof item.x === 'number' && Number.isFinite(item.x) && typeof item.y === 'number' && Number.isFinite(item.y) && typeof item.collapsed === 'boolean') return { version: 1, x: item.x, y: item.y, collapsed: item.collapsed };
  } catch { /* A blocked or old preference must not prevent the page opening. */ }
}
export function clampBubble(position: BubblePosition, viewport: { width: number; height: number }, size: { width: number; height: number }): BubblePosition {
  const left = Math.min(BUBBLE_MARGIN, Math.max(0, (viewport.width - size.width) / 2));
  const top = Math.min(BUBBLE_MARGIN, Math.max(0, (viewport.height - size.height) / 2));
  return { x: Math.max(left, Math.min(position.x, Math.max(left, viewport.width - size.width - BUBBLE_MARGIN))), y: Math.max(top, Math.min(position.y, Math.max(top, viewport.height - size.height - BUBBLE_MARGIN))) };
}
export function recentActivities(activities: readonly BridgeActivity[], scopeId: string): BridgeActivity[] {
  // Browser-local and server events have separate sequence domains. The merged
  // list order is the stable tie-breaker for equal timestamps, never sequence.
  return activities.map((item, order) => ({ item, order })).filter(({ item }) => !item.scopeId || !scopeId || item.scopeId === scopeId).sort((a, b) => (Date.parse(b.item.updatedAt) || Date.parse(b.item.startedAt) || 0) - (Date.parse(a.item.updatedAt) || Date.parse(a.item.startedAt) || 0) || (Date.parse(b.item.startedAt) || 0) - (Date.parse(a.item.startedAt) || 0) || b.order - a.order).slice(0, 40).map(({ item }) => item);
}
export function presentationIsCurrent(command: ControlCommand | undefined, receipt: PresentationReceipt | undefined, scopeId: string, staleMessage: string, now = Date.now(), activities: readonly BridgeActivity[] = [], userRevision?: number): boolean {
  if (!command || staleMessage || command.resolved.snapshot.scopeId !== scopeId) return false;
  if (userRevision !== undefined && command.expectedUserRevision !== userRevision) return false;
  // A presented receipt is historical acknowledgment, not ongoing permission.
  // Manual navigation pauses the command while allowControl may stay enabled.
  if (activities.some(item => item.kind === 'presentation' && item.commandId === command.commandId && (item.status === 'paused' || item.status === 'failed'))) return false;
  const { resolved } = command, { snapshot, presentation } = resolved;
  if (Date.parse(command.expiresAt) <= now || Date.parse(snapshot.expiresAt) <= now || !Number.isFinite(Date.parse(command.expiresAt)) || !Number.isFinite(Date.parse(snapshot.expiresAt))) return false;
  if (presentation.projectId !== snapshot.projectId || presentation.worktreeId !== snapshot.worktreeId || presentation.indexSnapshotId !== snapshot.indexSnapshotId || presentation.snapshotId !== snapshot.snapshotId) return false;
  if (resolved.codeGraph && resolved.codeGraph.revision !== snapshot.indexSnapshotId) return false;
  if (resolved.semantic && (resolved.semantic.metadata.sourceRevision !== snapshot.indexSnapshotId || resolved.semantic.metadata.scopeId !== scopeId || resolved.semantic.metadata.viewRevision !== snapshot.semanticViewRevision || resolved.semantic.metadata.architectureRevision !== snapshot.architectureRevision)) return false;
  if (resolved.architecture && (resolved.architecture.metadata.sourceRevision !== snapshot.indexSnapshotId || resolved.architecture.metadata.scopeId !== scopeId || resolved.architecture.metadata.modelRevision !== snapshot.architectureRevision)) return false;
  return receipt?.commandId === command.commandId && receipt.status === 'presented';
}
export function progressStatus(options: { connected: boolean; allowControl: boolean; command?: ControlCommand; receipt?: PresentationReceipt; staleMessage: string; error: string; activity?: BridgeActivity; userRevision?: number }): { label: string; tone: 'idle' | 'running' | 'complete' | 'paused' | 'failed' } {
  const { connected, allowControl, command, staleMessage, error, activity, userRevision } = options;
  // Old acknowledgments remain in history. Only the active command or an
  // incoming presentation activity may provide the current receipt status.
  const receipt = options.receipt && (options.receipt.commandId === command?.commandId || activity?.kind === 'presentation' && activity.commandId === options.receipt.commandId) ? options.receipt : undefined;
  if (staleMessage || receipt?.status === 'expired') return { label: '快照已过期', tone: 'paused' };
  if (!allowControl) return { label: '手动浏览 · 演示已暂停', tone: 'paused' };
  if (command && userRevision !== undefined && command.expectedUserRevision !== userRevision && !(activity?.kind === 'presentation' && activity.commandId !== command.commandId && activity.status === 'running')) return { label: '人工操作已优先 · 演示暂停', tone: 'paused' };
  if (error) return { label: '联动需要检查', tone: 'failed' };
  if (!connected) return { label: '连接中断 · 等待重连', tone: 'paused' };
  if (receipt?.status === 'conflict') return { label: '人工操作已优先', tone: 'paused' };
  if (receipt?.status === 'failed') return { label: '网页呈现失败', tone: 'failed' };
  if (activity?.status === 'running') return { label: activity.kind === 'query' ? '正在查询架构' : '正在更新展示', tone: 'running' };
  if (receipt?.status === 'received' || receipt?.status === 'pending') return { label: '网页正在呈现', tone: 'running' };
  const presented = receipt?.commandId === command?.commandId && receipt?.status === 'presented';
  const newerActivity = !!activity && (!presented || (Date.parse(activity.updatedAt) || 0) >= (Date.parse(receipt.updatedAt) || 0));
  if (newerActivity && activity.status === 'failed') return { label: activity.kind === 'query' ? '查询未完成 · 当前图保留' : '操作未完成', tone: 'failed' };
  if (newerActivity && activity.status === 'paused') return { label: '人工操作已优先 · 演示暂停', tone: 'paused' };
  if (newerActivity && activity.status === 'completed' && activity.kind === 'query') return { label: presented ? '查询完成 · 当前图保留' : '查询完成 · 等待展示', tone: 'complete' };
  if (presented) return { label: '网页已呈现', tone: 'complete' };
  if (activity?.status === 'completed') return { label: activity.kind === 'query' ? '查询完成 · 等待展示' : '操作已完成', tone: 'complete' };
  return { label: '已连接 · 等待演示', tone: 'idle' };
}

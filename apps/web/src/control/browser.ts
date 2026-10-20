import type { BrowserBootstrap, BrowserCurrent, BrowserState, ControlCommand, PresentationReceipt, ViewSession } from '../../../../packages/control-protocol/src/types';

export class BrowserControlError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
export async function browserRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/bridge/browser/${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) { const text = await response.text(); let message = text, code: string | undefined; try { const value = JSON.parse(text); message = typeof value.error === 'string' ? value.error : value.error?.message || value.message || text; code = value.code || value.error?.code; } catch {} throw new BrowserControlError(response.status, `${response.status} · ${message.slice(0, 2000)}`, code); }
  return response.json() as Promise<T>;
}
const bootstraps = new WeakMap<object, Promise<BrowserBootstrap>>();
export const resetBrowserBootstrap = () => bootstraps.delete(window);
export function bootstrapBrowser() {
  let pending = bootstraps.get(window);
  if (!pending) { pending = browserRequest<BrowserBootstrap>('bootstrap').catch(error => { bootstraps.delete(window); throw error; }); bootstraps.set(window, pending); }
  return pending;
}
export function commandConflict(command: ControlCommand, bootstrap: BrowserBootstrap, state: BrowserState, now = Date.now()) {
  if (!state.allowControl) return '此页面尚未允许联动，或已退出联动。';
  if (command.sessionId !== bootstrap.sessionId || command.serverEpoch !== bootstrap.serverEpoch) return '控制会话或服务实例已变化。';
  if (command.expectedUserRevision !== state.userRevision || command.expectedControlRevision !== state.controlRevision) return '页面已被人工操作或更新，旧命令已取消。';
  if (!Number.isFinite(Date.parse(command.expiresAt)) || Date.parse(command.expiresAt) <= now || Date.parse(command.resolved.snapshot.expiresAt) <= now) return '命令或分析快照已经过期。';
  const { presentation, snapshot } = command.resolved;
  if (presentation.snapshotId !== snapshot.snapshotId || presentation.indexSnapshotId !== snapshot.indexSnapshotId || presentation.projectId !== snapshot.projectId || presentation.worktreeId !== snapshot.worktreeId) return '分析数据的作用域或快照不一致。';
  return '';
}
export type BrowserActual = NonNullable<PresentationReceipt['actual']>;
export type BrowserAckStatus = 'received' | 'presented' | 'conflict' | 'failed';
export const postBrowserState = (bootstrap: BrowserBootstrap, state: BrowserState) => browserRequest<ViewSession>('state', { sessionId: bootstrap.sessionId, csrf: bootstrap.csrf, state });
export const getBrowserCurrent = (bootstrap: BrowserBootstrap) => browserRequest<BrowserCurrent>(`current?sessionId=${encodeURIComponent(bootstrap.sessionId)}`);

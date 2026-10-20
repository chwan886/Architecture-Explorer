import type { ProjectionMetadata } from '../../../../packages/architecture-model/src/types';

export class ArchitectureApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function architectureRequest<T>(scope: string, path = '', params: Record<string, string | number | undefined> = {}, init?: RequestInit): Promise<T> {
  const url = new URL(`/api/architecture${path}`, window.location.origin);
  url.searchParams.set('scope', scope);
  Object.entries(params).forEach(([name, value]) => { if (value !== undefined && value !== '') url.searchParams.set(name, String(value)); });
  const response = await fetch(url, init);
  if (!response.ok) {
    let message = await response.text();
    try { const body = JSON.parse(message); message = typeof body.error === 'string' ? body.error : body.error?.message || body.message || JSON.stringify(body); } catch { /* Preserve readable HTTP errors. */ }
    throw new ArchitectureApiError(response.status, `${response.status} · ${message.slice(0, 12000)}${message.length > 12000 ? '…（错误说明过长，更多诊断请查看本地服务日志）' : ''}`);
  }
  return response.json() as Promise<T>;
}
export function checkMetadata(metadata: ProjectionMetadata, scope: string, viewRevision?: string) {
  if (metadata.scopeId !== scope || (viewRevision && metadata.viewRevision !== viewRevision)) throw new ArchitectureApiError(409, '视图版本已变化，请重新载入后继续。');
}
export const apiMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

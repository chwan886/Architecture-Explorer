import type { SemanticMetadata } from '../../../../packages/semantic-model/src/types';

export class SemanticApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function semanticRequest<T>(scope: string, path = '', params: Record<string, string | number | undefined> = {}, init?: RequestInit): Promise<T> {
  const url = new URL(`/api/semantics${path}`, window.location.origin);
  url.searchParams.set('scope', scope);
  Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== '') url.searchParams.set(key, String(value)); });
  const response = await fetch(url, init);
  if (!response.ok) {
    let message = await response.text();
    try { const value = JSON.parse(message); message = typeof value.error === 'string' ? value.error : value.error?.message || value.message || message; } catch { /* Display the server's bounded diagnostic. */ }
    throw new SemanticApiError(response.status, `${response.status} · ${message.slice(0, 12000)}`);
  }
  return response.json() as Promise<T>;
}
export function checkSemanticMetadata(metadata: SemanticMetadata, scope: string, revision?: string) {
  if (metadata.scopeId !== scope || (revision && metadata.viewRevision !== revision)) throw new SemanticApiError(409, '语义视图版本已变化，请重新载入后继续。');
}
export const semanticError = (error: unknown) => error instanceof Error ? error.message : String(error);

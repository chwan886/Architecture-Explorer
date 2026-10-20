import type { ArchitectureEdge, ArchitectureNode, Diagnostic, Evidence, GraphResult, IndexMetadata } from '../../../packages/schema/src/index';

export interface Project { id: string; name: string; root: string }
export interface Summary { metadata: IndexMetadata; counts: { nodes: number; edges: number; files: number }; diagnostics: Diagnostic[]; rootId: string }
export interface NodeDetails { node: ArchitectureNode; parents: ArchitectureNode[]; incoming: ArchitectureEdge[]; outgoing: ArchitectureEdge[]; relatedNodes: ArchitectureNode[]; evidence: Evidence[]; revision: string }
export interface EvidenceContent { evidence: Evidence; content: string; stale: boolean; revision: string; startLine?: number; contextStartLine?: number }

export async function request<T>(path: string, scope?: string, options?: RequestInit): Promise<T> {
  const url = new URL(`/api${path}`, window.location.origin);
  if (scope) url.searchParams.set('scope', scope);
  const response = await fetch(url, options);
  if (!response.ok) {
    const raw = await response.text();
    let message = raw;
    try { const data = JSON.parse(raw); message = data.error?.message || data.error || data.message || raw; } catch { /* plain HTTP error */ }
    const description = String(message);
    throw new Error(`${response.status} · ${description.slice(0, 8000)}${description.length > 8000 ? '…（说明过长，更多内容请查看本地服务日志）' : ''}`);
  }
  return response.json() as Promise<T>;
}

export function graphPath(params: { rootId?: string; view: string; direction: string; depth: number; limit: number; kinds: string; confidence: string }) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== '') query.set(key, String(value)); });
  return `/graph?${query}`;
}

export type { GraphResult };

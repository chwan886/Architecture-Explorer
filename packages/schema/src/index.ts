import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = '1.0.0';
export const ANALYZER_VERSION = '0.2.0';
export type Confidence = 'static-confirmed' | 'runtime-verified' | 'inferred';
export type Language = 'csharp' | 'python' | 'json' | 'unity' | 'unknown';
export type NodeKind = 'project' | 'system' | 'module' | 'file' | 'class' | 'interface' | 'struct' | 'enum' | 'method' | 'function' | 'field' | 'property' | 'event' | 'parameter' | 'resource' | 'data';
export type EdgeKind = 'contains' | 'inherits' | 'implements' | 'references' | 'imports' | 'calls' | 'reads' | 'writes' | 'initializes' | 'passes' | 'returns' | 'subscribes' | 'unsubscribes' | 'publishes' | 'contract-mapping';
export interface Evidence {
  id: string; filePath: string; startLine: number; startColumn: number; endLine: number; endColumn: number;
  fileHash: string; rule: string; excerpt?: string;
}
export interface ArchitectureNode {
  id: string; kind: NodeKind; label: string; qualifiedName: string; language: Language;
  parentId?: string; moduleId?: string; filePath?: string; signature?: string; summary?: string; evidenceIds: string[];
}
export interface ArchitectureEdge {
  id: string; source: string; target: string; kind: EdgeKind; confidence: Confidence;
  evidenceIds: string[]; rule: string; dispatch?: string; condition?: string; limitations?: string[];
}
export interface Flow {
  id: string; label: string; scope: 'static-access' | 'intra-procedural' | 'contract-mapping';
  nodeIds: string[]; edgeIds: string[]; limitations: string[];
}
export interface Diagnostic {
  id: string; severity: 'info' | 'warning' | 'error'; code: string; message: string;
  filePath?: string; line?: number;
}
export interface SourceFile { path: string; content: string; hash: string; }
export interface AnalyzerRequest {
  scopeId: string; files: SourceFile[]; references?: string[]; defines?: string[];
  assemblyName?: string;
}
export interface AnalyzerResult {
  nodes: ArchitectureNode[]; edges: ArchitectureEdge[]; evidence: Evidence[]; diagnostics: Diagnostic[];
}
export interface FileRecord { path: string; hash: string; size: number; language: Language; }
export interface IndexMetadata {
  schemaVersion: string; analyzerVersion: string; projectId: string; projectName: string; worktreeId: string;
  scopeId: string; rootPath: string; gitHead: string; gitBranch: string; gitDirty: boolean; gitStatusHash: string;
  generatedAt: string; configFingerprint: string; compilationFingerprint: string; revision: string;
  fileCount: number; durationMs: number; changedFiles: number; reusedFiles: number;
  coverage: { languages: string[]; limitations: string[] };
}
export interface ArchitectureIndex extends AnalyzerResult {
  metadata: IndexMetadata; flows: Flow[]; files: FileRecord[];
}
export interface ProjectConfig {
  id: string; name: string; root: string; worktrees?: string[];
  include: string[]; exclude: string[]; defines?: string[]; references?: string[];
}
export interface ExplorerConfig {
  projects: ProjectConfig[]; cacheDir?: string; port?: number; python?: string; dotnet?: string;
}
export interface WorktreeInfo {
  id: string; path: string; branch: string; head: string; authorized: boolean;
}
export type IndexState = 'empty' | 'analyzing' | 'synced' | 'stale' | 'failed';
export interface IndexStatus {
  scopeId: string; state: IndexState; message: string; revision?: string; generatedAt?: string;
  diagnostics?: number; changedFiles?: number; progress?: string;
}
export interface GraphResult {
  nodes: ArchitectureNode[]; edges: ArchitectureEdge[]; rootId?: string; totalNodes: number;
  truncated: boolean; revision: string;
}
// IDs are scoped to an authorized worktree. Lines never participate in symbol identity.
export function stableId(scope: string, category: string, key: string): string {
  return `${category}:${createHash('sha256').update(`${scope}|${category}|${key}`).digest('hex').slice(0, 24)}`;
}
export function contentHash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
export function fileId(scope: string, path: string): string { return stableId(scope, 'file', path.replaceAll('\\', '/')); }

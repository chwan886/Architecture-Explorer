import type { ArchitectureIndex, GraphResult, IndexStatus, WorktreeInfo } from '../../schema/src/index.ts';
import type { ArchitectureView } from '../../architecture-model/src/types.ts';
import type { SemanticBundle } from '../../semantic-model/src/types.ts';

export const CONTROL_VERSION = '1.0' as const;
export type EntityLayer = 'code' | 'architecture' | 'semantic';
export interface EntityRef { layer: EntityLayer; id: string; flowId?: string }
export type Verification = 'static-confirmed' | 'source-supported' | 'inferred' | 'unverified';
export interface AnalysisStep {
  id: string; name: string; codeNodeIds: string[]; codeEdgeIds: string[]; pathId?: string; semanticNodeId?: string;
  inputs: string[]; outputs: string[]; evidenceIds: string[]; verification: Verification;
  orderBasis: 'reading-order' | 'call-path' | 'source-supported' | 'unverified';
}
export interface AnalysisPresentation {
  schemaVersion: '1.0'; presentationId: string; projectId: string; worktreeId: string;
  indexSnapshotId: string; snapshotId: string; title: string; summary: string;
  targetView: 'systems' | 'technical' | 'flow' | 'code';
  viewMode: 'explanation' | 'code' | 'compare'; semanticGranularity: 'simple' | 'detailed';
  focusNodeId?: EntityRef; highlightedNodeIds: EntityRef[]; highlightedEdgeIds: EntityRef[];
  flowId?: string; orderedSteps: AnalysisStep[]; evidenceIds: string[]; warnings: string[]; createdAt: string;
}
export interface SnapshotDescriptor {
  snapshotId: string; projectId: string; worktreeId: string; scopeId: string; indexSnapshotId: string;
  architectureRevision: string; semanticViewRevision: string; expiresAt: string; indexState: IndexStatus['state'];
}
export interface EvidenceContent { evidence: ArchitectureIndex['evidence'][number]; content: string; contextStartLine?: number; stale: boolean; revision: string }
export interface ResolvedPresentation {
  presentation: AnalysisPresentation; snapshot: SnapshotDescriptor; codeGraph?: GraphResult;
  architecture?: ArchitectureView; semantic?: SemanticBundle; evidence?: EvidenceContent;
  highlights: { codeNodeIds: string[]; codeEdgeIds: string[]; semanticNodeIds: string[]; semanticEdgeIds: string[]; architectureNodeIds: string[]; architectureEdgeIds: string[] };
  warnings: string[];
}
export interface QueryService {
  dispatch(operation: string, args: Record<string, unknown>): Promise<unknown>;
  resolve(presentation: AnalysisPresentation): Promise<ResolvedPresentation>;
}
export type PresentationStatus = 'pending' | 'received' | 'presented' | 'conflict' | 'failed' | 'expired' | 'superseded';
export interface BrowserState {
  userRevision: number; controlRevision: number; allowControl: boolean; scopeId?: string;
  label: string; visible: boolean;
}
export interface ViewSession extends BrowserState { sessionId: string; serverEpoch: string; lastSeenAt: string; bindingId?: string }
export interface PresentationReceipt {
  commandId: string; presentationId: string; status: PresentationStatus; sessionId?: string;
  action?: 'present' | 'clear'; openUrl?: string;
  userRevision?: number; controlRevision?: number; message: string; updatedAt: string;
  actual?: { scopeId: string; indexSnapshotId: string; focusNodeId?: EntityRef; visibleNodeIds: string[]; visibleEdgeIds: string[]; evidenceId?: string };
}
export interface ControlCommand {
  commandId: string; serverEpoch: string; sessionId: string; bindingId: string; sequence: number; expiresAt: string;
  expectedUserRevision: number; expectedControlRevision: number; resolved: ResolvedPresentation;
}
export interface BrowserBootstrap { sessionId: string; csrf: string; serverEpoch: string; state: BrowserState }
/** Public execution summaries only; never chain-of-thought or raw tool arguments/source. */
export interface BridgeActivity {
  id: string; sequence: number; kind: 'query' | 'presentation' | 'session'; operation: string;
  title: string; message: string; status: 'running' | 'completed' | 'paused' | 'failed';
  startedAt: string; updatedAt: string; scopeId?: string; snapshotId?: string;
  indexSnapshotId?: string; commandId?: string;
}
export interface BrowserCurrent { session: ViewSession; command?: ControlCommand; pending?: PresentationReceipt; activities?: BridgeActivity[] }
export interface ControlSubmit {
  presentation: AnalysisPresentation; bindingId?: string; expectedUserRevision?: number;
  expectedControlRevision?: number; commandId?: string;
}
export interface BridgeRuntime { schemaVersion: '1.0'; serverEpoch: string; port: number; token: string }
export interface BridgeWorktree extends WorktreeInfo { scopeId?: string; status?: IndexStatus }

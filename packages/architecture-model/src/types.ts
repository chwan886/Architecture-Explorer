import type { ArchitectureNode, ArchitectureEdge, ArchitectureIndex, Confidence, EdgeKind, Evidence, GraphResult, Language, NodeKind } from '../../schema/src/index.ts';

export const MODEL_SCHEMA_VERSION = '1.0.0';
export const PROJECTION_VERSION = '1.0.0';
export type ReviewState = 'pending' | 'confirmed' | 'rejected' | 'needs-review';
export type ResolutionState = 'resolved' | 'changed' | 'missing' | 'ambiguous' | 'conflict';
export type RelationCategory = 'dependency' | 'call' | 'interface' | 'data-access' | 'event' | 'resource' | 'initialization';
export type Perspective = 'business' | 'technical';
export interface SymbolSelector {
  language?: Language; kinds?: NodeKind[]; qualifiedName?: string; qualifiedNamePrefix?: string;
  filePath?: string; filePathPrefix?: string;
}
export interface SourceAnchor {
  id: string; filePath: string; startLine: number; endLine: number; expectedFileHash: string;
  quote: string; description: string;
}
export interface SystemDefinition {
  id: string; name: string; responsibility: string; features: string[]; inputs: string[]; outputs: string[];
  keyData: string[]; kind: 'business' | 'support' | 'legacy'; anchorIds: string[];
}
export interface ModuleDefinition {
  id: string; systemId: string; name: string; responsibility: string; inputs: string[]; outputs: string[]; anchorIds: string[];
}
export interface MembershipRule {
  id: string; systemId: string; moduleId: string; selector: SymbolSelector;
  role: 'owner' | 'participant' | 'shared'; origin: 'curated' | 'rule' | 'suggested'; anchorIds: string[];
}
export interface ReviewDecision {
  targetType: 'system' | 'membership' | 'flow'; targetId: string; scopeId: string; decision: 'confirmed' | 'rejected'; fingerprint: string; reviewedAt: string;
}
export interface FlowLane { id: string; name: string; systemId?: string }
export interface FlowStep {
  id: string; laneId: string; phase: number; name: string; description: string; moduleId?: string;
  selector?: SymbolSelector; anchorIds: string[]; reads: string[]; writes: string[]; condition?: string;
}
export type OrderBasis = 'static-call' | 'source-order' | 'protocol-contract' | 'request-boundary' | 'narrative';
export interface FlowTransition {
  id: string; source: string; target: string; basis: OrderBasis; anchorIds: string[];
  condition?: string; limitations: string[];
}
export interface BusinessFlow {
  id: string; name: string; description: string; trigger: string; systemIds: string[];
  lanes: FlowLane[]; steps: FlowStep[]; transitions: FlowTransition[]; limitations: string[];
}
export interface ArchitectureModel {
  schemaVersion: '1.0.0'; projectId: string; name: string; systems: SystemDefinition[]; modules: ModuleDefinition[];
  memberships: MembershipRule[]; anchors: SourceAnchor[]; flows: BusinessFlow[]; reviews: ReviewDecision[];
}
export interface ProjectionMetadata {
  scopeId: string; projectId: string; sourceRevision: string; modelRevision: string; viewRevision: string; projectionVersion: string;
}
export interface ArchitectureDiagnostic {
  id: string; code: string; severity: 'info' | 'warning' | 'error'; message: string; targetId?: string;
}
export interface ResolvedMembership extends MembershipRule {
  nodeIds: string[]; resolution: ResolutionState; reviewState: ReviewState; fingerprint: string; evidenceIds: string[];
}
export interface OwnershipEntry {
  systemId: string; systemName: string; moduleId: string; moduleName: string; membershipId: string;
  role: MembershipRule['role']; reviewState: ReviewState; resolution: ResolutionState;
}
export interface ResolvedEntity {
  id: string; nodeId: string; entityKind: 'system' | 'module'; name: string; responsibility: string;
  systemId?: string; systemKind?: SystemDefinition['kind']; inputs: string[]; outputs: string[]; features: string[]; keyData: string[];
  memberNodeIds: string[]; membershipIds: string[]; evidenceIds: string[]; flowIds: string[];
  reviewState: ReviewState; resolution: ResolutionState; fingerprint: string;
}
export interface ProjectedRelation extends ArchitectureEdge {
  level: 'system' | 'module' | 'technical'; category: RelationCategory; categories: RelationCategory[]; kinds: EdgeKind[];
  memberEdgeIds: string[]; memberNodeIds: string[]; membershipIds: string[]; dataNodeIds: string[];
  confidenceCounts: Record<Confidence, number>; totalMembers: number; membershipPending: boolean;
}
export interface ResolvedFlowStep extends FlowStep { nodeIds: string[]; evidenceIds: string[]; resolution: ResolutionState }
export interface ResolvedFlowTransition extends FlowTransition {
  memberEdgeIds: string[]; evidenceIds: string[]; verification: 'static-confirmed' | 'source-supported' | 'unverified';
}
export interface ResolvedBusinessFlow extends Omit<BusinessFlow, 'steps' | 'transitions'> {
  steps: ResolvedFlowStep[]; transitions: ResolvedFlowTransition[]; reviewState: ReviewState; fingerprint: string;
}
export interface ArchitectureProjection {
  metadata: ProjectionMetadata; entities: ResolvedEntity[]; memberships: ResolvedMembership[];
  relations: ProjectedRelation[]; technicalNodes: ArchitectureNode[]; technicalRelations: ProjectedRelation[];
  ownership: Record<string, OwnershipEntry[]>; flows: ResolvedBusinessFlow[]; evidence: Evidence[];
  diagnostics: ArchitectureDiagnostic[]; unclassifiedNodeIds: string[];
}
export interface ArchitectureView {
  metadata: ProjectionMetadata; perspective: Perspective; rootId?: string; graph: GraphResult;
  entities: ResolvedEntity[]; relations: ProjectedRelation[]; breadcrumbs: { id?: string; name: string }[];
  diagnostics: ArchitectureDiagnostic[]; unclassifiedCount: number; available: boolean;
}
export interface ArchitectureEntityDetail {
  metadata: ProjectionMetadata; entity: ResolvedEntity; modules: ResolvedEntity[]; components: ArchitectureNode[];
  totalComponents: number; memberships: ResolvedMembership[]; relations: ProjectedRelation[];
  evidence: Evidence[]; flows: ResolvedBusinessFlow[];
}
export interface RelationMembers {
  metadata: ProjectionMetadata; relation: ProjectedRelation; edges: ArchitectureEdge[]; nodes: ArchitectureNode[];
  evidence: Evidence[]; offset: number; total: number; truncated: boolean;
}
export interface OwnershipResult { metadata: ProjectionMetadata; nodeId: string; owners: OwnershipEntry[]; flowIds: string[] }
export interface ModelEnvelope { model: ArchitectureModel; modelRevision: string }
export interface ArchitectureRoute { perspective: Perspective | 'flows'; rootId?: string; flowId?: string }
export interface OpenCodeRequest { nodeId: string; mode?: 'structure' | 'symbol'; evidenceId?: string }

// Implemented by the model engine; routes retain the current source index separately.
export type BuildProjection = (index: ArchitectureIndex, model: ArchitectureModel) => ArchitectureProjection;

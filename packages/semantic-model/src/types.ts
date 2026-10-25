import type { ArchitectureEdge, ArchitectureNode, Evidence, GraphResult } from '../../schema/src/index.ts';
import type { ArchitectureDiagnostic, ArchitectureModel, ReviewState, SymbolSelector } from '../../architecture-model/src/types.ts';

export const SEMANTIC_SCHEMA_VERSION = '1.0.0';
export const SEMANTIC_PROJECTION_VERSION = '1.0.0';
export const SEMANTIC_GENERATOR_VERSION = 'evidence-template-1';
export type SemanticOrigin = 'curated' | 'rule-generated' | 'ai-suggested' | 'human-edited';
export type SemanticMode = 'explanation' | 'code' | 'compare';
export type SemanticLevel = 'simple' | 'detailed';
export type SemanticUpdateState = 'current' | 'stale' | 'missing' | 'ambiguous' | 'conflict';
export type SemanticRelationKind = 'direct-call' | 'indirect-call' | 'dependency' | 'data-access' | 'event' | 'source-order' | 'protocol' | 'request-boundary' | 'related';
export type SemanticVerification = 'static-confirmed' | 'source-supported' | 'inferred' | 'unverified';
export interface SemanticText {
  title: string; summary: string; purpose: string; detail: string;
  inputs: string[]; processing: string[]; outputs: string[]; changes: string[];
}
export interface SemanticControl {
  kind: 'condition' | 'loop' | 'async' | 'early-return' | 'request-boundary';
  description: string; anchorIds: string[];
}
export interface SemanticBindingDefinition {
  id: string; sourceStepId?: string; selector?: SymbolSelector;
  role: 'implementation' | 'context'; anchorIds: string[]; expectedDeclarationHash?: string;
}
export interface SemanticStepDefinition extends SemanticText {
  id: string; sourceStepIds: string[]; bindings: SemanticBindingDefinition[];
  controls: SemanticControl[]; origin: SemanticOrigin;
}
export interface SemanticGroupDefinition extends SemanticText {
  id: string; childIds: string[]; origin: SemanticOrigin;
}
export interface SemanticFlowDefinition {
  id: string; sourceFlowId: string; title: string; description: string;
  groups: SemanticGroupDefinition[]; steps: SemanticStepDefinition[];
}
export interface SemanticDefinitions { schemaVersion: '1.0.0'; projectId: string; flows: SemanticFlowDefinition[] }
export interface SemanticReview {
  flowId: string; targetType: 'flow' | 'node' | 'edge'; targetId: string;
  fingerprint: string; decision: 'confirmed' | 'rejected'; reviewedAt: string;
}
export interface SemanticEditRecord { id: string; at: string; operation: string; flowId: string; previousRevision: string; supersededIds: string[] }
export interface SemanticOverlay {
  schemaVersion: '1.0.0'; scopeId: string; baseDefinitionRevision: string;
  flowOverrides: SemanticFlowDefinition[]; reviews: SemanticReview[]; history: SemanticEditRecord[];
}
export interface SemanticMetadata {
  scopeId: string; projectId: string; sourceRevision: string; architectureRevision: string;
  definitionRevision: string; overlayRevision: string; viewRevision: string;
  generatorVersion: string; projectionVersion: string;
}
export interface SemanticBinding extends SemanticBindingDefinition {
  codeNodeIds: string[]; evidenceIds: string[]; status: SemanticUpdateState; declarationHash?: string; anchorsValid?: boolean;
}
export interface SemanticNode extends SemanticText {
  id: string; level: 'summary' | 'detail'; parentId?: string; childIds: string[]; sourceStepIds: string[];
  codeNodeIds: string[]; contextNodeIds: string[]; evidenceIds: string[]; fragments: string[][];
  bindings: SemanticBinding[]; controls: SemanticControl[]; origin: SemanticOrigin;
  status: SemanticUpdateState; reviewState: ReviewState; fingerprint: string; limitations: string[];
}
export interface SemanticPath {
  nodeIds: string[]; edgeIds: string[]; kind: 'call-path' | 'fact-set'; verification: SemanticVerification;
}
export interface SemanticEdge {
  id: string; source: string; target: string; level: 'summary' | 'detail'; title: string; description: string;
  kinds: SemanticRelationKind[]; sourceTransitionIds: string[]; codeEdgeIds: string[]; paths: SemanticPath[];
  evidenceIds: string[]; conditions: string[]; boundaries: string[]; verification: SemanticVerification;
  status: SemanticUpdateState; reviewState: ReviewState; fingerprint: string; limitations: string[];
}
export interface SemanticChangeSet {
  unchangedNodeIds: string[]; changedNodeIds: string[]; removedNodeIds: string[];
  unchangedEdgeIds: string[]; changedEdgeIds: string[]; removedEdgeIds: string[];
}
export interface ResolvedSemanticFlow {
  id: string; sourceFlowId: string; title: string; description: string;
  summaryNodes: SemanticNode[]; detailNodes: SemanticNode[]; summaryEdges: SemanticEdge[]; detailEdges: SemanticEdge[];
  codeGraph: GraphResult; codeNodes: ArchitectureNode[]; codeEdges: ArchitectureEdge[]; evidence: Evidence[];
  reviewState: ReviewState; fingerprint: string; diagnostics: ArchitectureDiagnostic[]; limitations: string[];
  reverseNodes: Record<string, string[]>; reverseEdges: Record<string, string[]>; changes: SemanticChangeSet;
}
export interface SemanticFlowInfo { id: string; title: string; description: string; steps: number; groups: number; reviewState: ReviewState }
export interface SemanticProjection { metadata: SemanticMetadata; flows: ResolvedSemanticFlow[]; diagnostics: ArchitectureDiagnostic[] }
export interface SemanticBundle { metadata: SemanticMetadata; flows: SemanticFlowInfo[]; flow?: ResolvedSemanticFlow }
export interface SemanticDefinitionEnvelope {
  definitions: SemanticDefinitions; overlay: SemanticOverlay; definitionRevision: string; overlayRevision: string;
  effectiveFlows: SemanticFlowDefinition[];
}
/** Editor responses pin the source/model/view baseline to the returned definitions and overlay. */
export interface SemanticEditorEnvelope extends SemanticDefinitionEnvelope { metadata: SemanticMetadata }
export interface SemanticBuildOptions { sourceTexts?: Record<string, string>; previous?: SemanticProjection }
export interface SemanticLocation { flowId?: string; mode?: SemanticMode; level?: SemanticLevel; nodeId?: string; codeNodeId?: string; codeEdgeId?: string }
export interface SemanticReverseMatch { flowId: string; flowTitle: string; nodeIds: string[]; edgeIds: string[] }
export interface SemanticReverseResult { metadata: SemanticMetadata; matches: SemanticReverseMatch[] }
export interface SemanticCandidate { metadata: SemanticMetadata; flow: SemanticFlowDefinition; generatorVersion: string; origin: 'rule-generated' }
export interface SemanticContextInput { architecture: ArchitectureModel; definitions: SemanticDefinitions; overlay: SemanticOverlay }

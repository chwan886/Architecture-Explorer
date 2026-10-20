import type { ArchitectureNode } from '../../../packages/schema/src/index';

export interface SelectionRequest { scopeId: string; nodeId: string; sequence: number }

/** Only an actual activation key on a node in the visible graph may select it. */
export function nodeForKeyboardActivation(key: string, nodeId: string | null, nodes: readonly ArchitectureNode[], nestedControl = false): ArchitectureNode | undefined {
  if (nestedControl || (key !== 'Enter' && key !== ' ') || !nodeId) return undefined;
  return nodes.find(node => node.id === nodeId);
}

export function isCurrentSelectionRequest(request: SelectionRequest, current: SelectionRequest): boolean {
  return request.scopeId === current.scopeId && request.nodeId === current.nodeId && request.sequence === current.sequence;
}

/** A response may refresh the selected entity, but may never change its identity. */
export function applySelectionResponse(selected: ArchitectureNode | undefined, response: ArchitectureNode, request: SelectionRequest, current: SelectionRequest): ArchitectureNode | undefined {
  return selected?.id === request.nodeId && response.id === request.nodeId && isCurrentSelectionRequest(request, current) ? response : selected;
}

import type { BridgeActivity } from '../../../../packages/control-protocol/src/types';

/** Keep only public summaries belonging to this page's current code scope. */
export function mergeActivities(current: BridgeActivity[], incoming: BridgeActivity[], scopeId: string, limit = 40): BridgeActivity[] {
  const values = new Map(current.filter(value => !value.scopeId || value.scopeId === scopeId).map(value => [value.id, value]));
  for (const value of incoming) {
    if (value.scopeId && value.scopeId !== scopeId) continue;
    const previous = values.get(value.id);
    if (previous && (Date.parse(value.updatedAt) < Date.parse(previous.updatedAt) || (previous.status !== 'running' && value.status === 'running'))) continue;
    // Polling the same activity is not a new event and does not move it in the list.
    if (!previous || JSON.stringify(previous) !== JSON.stringify(value)) values.set(value.id, value);
  }
  // Server and page sequences have different owners. Stable time ordering keeps
  // their counters separate and preserves arrival order for equal timestamps.
  return [...values.values()].sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt)).slice(-limit);
}

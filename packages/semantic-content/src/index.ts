import type { SemanticFlowDefinition, SemanticGroupDefinition, SemanticText } from '../../semantic-model/src/types.ts';

function assertPartition(flow: SemanticFlowDefinition): void {
  const steps = new Set(flow.steps.map(step => step.id));
  if (steps.size !== flow.steps.length) throw new Error('详细步骤 ID 重复');
  const children = flow.groups.flatMap(group => group.childIds);
  if (new Set(children).size !== children.length || children.length !== steps.size || children.some(id => !steps.has(id)))
    throw new Error('摘要分组必须完整且唯一地覆盖详细步骤');
}
const unique = (values: string[]): string[] => [...new Set(values)];
function combinedText(groups: SemanticText[], title: string): SemanticText {
  return { title, summary: groups.map(group => group.summary).filter(Boolean).join('；'), purpose: groups.map(group => group.purpose).filter(Boolean).join('；'),
    detail: groups.map(group => group.detail).filter(Boolean).join('\n\n'), inputs: unique(groups.flatMap(group => group.inputs)),
    processing: unique(groups.flatMap(group => group.processing)), outputs: unique(groups.flatMap(group => group.outputs)), changes: unique(groups.flatMap(group => group.changes)) };
}

/** Only summary membership changes: steps, bindings, controls and fact edges stay intact. */
export function mergeGroups(flow: SemanticFlowDefinition, groupIds: string[], title?: string): SemanticFlowDefinition {
  assertPartition(flow);
  const wanted = new Set(groupIds);
  if (wanted.size !== groupIds.length || wanted.size < 2) throw new Error('合并至少需要两个不同摘要组');
  const selected = flow.groups.filter(group => wanted.has(group.id));
  if (selected.length !== wanted.size) throw new Error('合并目标不存在');
  const first = selected[0];
  const merged: SemanticGroupDefinition = { ...combinedText(selected, title?.trim() || selected.map(group => group.title).join(' / ')),
    id: first.id, childIds: selected.flatMap(group => group.childIds), origin: 'human-edited' };
  const result = { ...flow, groups: flow.groups.flatMap(group => group.id === first.id ? [merged] : wanted.has(group.id) ? [] : [group]) };
  assertPartition(result); return result;
}

/** Moves a proper subset into a new summary group; never removes detail content. */
export function splitGroup(flow: SemanticFlowDefinition, groupId: string, childIds: string[], title?: string): SemanticFlowDefinition {
  assertPartition(flow);
  const group = flow.groups.find(item => item.id === groupId);
  if (!group) throw new Error('拆分目标不存在');
  const wanted = new Set(childIds);
  if (!wanted.size || wanted.size !== childIds.length || wanted.size >= group.childIds.length || childIds.some(id => !group.childIds.includes(id)))
    throw new Error('拆分必须选择当前组的一部分不同详细步骤，并为原组保留步骤');
  const existing = new Set([...flow.groups.map(item => item.id), ...flow.steps.map(item => item.id)]);
  let serial = 2; while (existing.has(`${groupId}-part-${serial}`)) serial++;
  const moved = group.childIds.filter(id => wanted.has(id));
  const steps = moved.map(id => flow.steps.find(step => step.id === id)!);
  const separated: SemanticGroupDefinition = { ...combinedText(steps, title?.trim() || `${group.title} · 拆分`),
    id: `${groupId}-part-${serial}`, childIds: moved, origin: 'human-edited' };
  const result = { ...flow, groups: flow.groups.flatMap(item => item.id === groupId
    ? [{ ...item, childIds: item.childIds.filter(id => !wanted.has(id)), origin: 'human-edited' as const }, separated] : [item]) };
  assertPartition(result); return result;
}

/** Deterministic offline template proposal; caller previews it before choosing to save. */
export function generateCandidateFlow(flow: SemanticFlowDefinition): SemanticFlowDefinition {
  assertPartition(flow);
  const snapshot = structuredClone(flow);
  const note = '规则生成仅重组已有说明、绑定与控制边界；没有新增源码关系或验证运行顺序。';
  const steps = snapshot.steps.map(step => ({ ...step, origin: 'rule-generated' as const,
    summary: `规则候选：依据 ${step.sourceStepIds.length} 个既有流程步骤、${step.bindings.length} 条显式绑定整理，待人工核对。`,
    detail: step.detail.includes(note) ? step.detail : [step.detail, note].filter(Boolean).join('\n\n') }));
  const byId = new Map(steps.map(step => [step.id, step]));
  return { ...snapshot, groups: snapshot.groups.map(group => ({ ...combinedText(group.childIds.map(id => byId.get(id)!), group.title),
    id: group.id, childIds: [...group.childIds], origin: 'rule-generated' as const })), steps };
}

export function editSemanticText(flow: SemanticFlowDefinition, nodeId: string, patch: Partial<SemanticText>): SemanticFlowDefinition {
  const permitted = new Set(['title', 'summary', 'purpose', 'detail', 'inputs', 'processing', 'outputs', 'changes']);
  if (Object.keys(patch).some(key => !permitted.has(key))) throw new Error('文本编辑不能改写绑定、关系或控制边界');
  if (!flow.groups.some(group => group.id === nodeId) && !flow.steps.some(step => step.id === nodeId)) throw new Error('解释节点不存在');
  return { ...flow, groups: flow.groups.map(group => group.id === nodeId ? { ...group, ...patch, origin: 'human-edited' } : group),
    steps: flow.steps.map(step => step.id === nodeId ? { ...step, ...patch, origin: 'human-edited' } : step) };
}

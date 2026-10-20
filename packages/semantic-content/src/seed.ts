import type { ArchitectureIndex, ArchitectureNode } from '../../schema/src/index.ts';
import type { ArchitectureModel, BusinessFlow } from '../../architecture-model/src/types.ts';
import type { SemanticControl, SemanticDefinitions, SemanticFlowDefinition, SemanticText } from '../../semantic-model/src/types.ts';
import { declarationHash } from '../../semantic-model/src/source.ts';
import { candidateExplanations, candidateSummaryGroups } from './seed-explanations.ts';

const declarationRules = new Set(['csharp.declaration', 'csharp.lambda-declaration', 'python.declaration']);
const unique = (values: string[]) => [...new Set(values)];
const asyncKinds: Record<string, SemanticControl['kind']> = {
  'claim-dispatch': 'async', 'claim-request': 'async', 'claim-http': 'request-boundary', 'claim-handler': 'request-boundary',
  'claim-return': 'request-boundary', 'claim-display': 'async', 'battle-request': 'async', 'battle-http': 'request-boundary',
  'battle-route': 'request-boundary', 'battle-next-poll': 'request-boundary', 'battle-poll-execute': 'request-boundary',
  'battle-response': 'request-boundary', 'battle-decode': 'async', 'battle-full-state': 'request-boundary', 'battle-view': 'async', 'battle-hud': 'async',
};
const earlyReturnSteps = new Set(['claim-execute', 'claim-return', 'claim-prepare-call', 'claim-check', 'battle-route', 'battle-decode', 'battle-prepare']);
function resolve(index: ArchitectureIndex, flow: BusinessFlow, stepId: string): ArchitectureNode {
  const step = flow.steps.find(item => item.id === stepId)!;
  const selector = step.selector;
  if (!selector?.qualifiedName) throw new Error(`种子步骤需要精确符号选择器：${stepId}`);
  const matches = index.nodes.filter(node => node.qualifiedName === selector.qualifiedName && !!node.filePath
    && (!selector.filePath || selector.filePath === node.filePath) && (!selector.language || selector.language === node.language)
    && (!selector.kinds || selector.kinds.includes(node.kind)));
  if (matches.length !== 1 || !['method', 'function'].includes(matches[0].kind)) throw new Error(`实现符号不唯一或不是过程：${stepId}`);
  return matches[0];
}

/** Initial curated artifact builder. It consumes current index/source, never scans or executes target code. */
export function buildCandidateDefinitions(index: ArchitectureIndex, architecture: ArchitectureModel, sourceTexts: Record<string, string>): SemanticDefinitions {
  if (index.metadata.projectId !== architecture.projectId) throw new Error('种子索引与业务模型项目不一致');
  const evidence = new Map(index.evidence.map(item => [item.id, item]));
  const anchors = new Map(architecture.anchors.map(anchor => [anchor.id, anchor]));
  const flows: SemanticFlowDefinition[] = [];
  for (const sourceFlowId of ['claim-reserve', 'battle-start-poll-result']) {
    const flow = architecture.flows.find(item => item.id === sourceFlowId);
    if (!flow) throw new Error(`缺少已授权的原始流程：${sourceFlowId}`);
    const steps = flow.steps.map(step => {
      const text = candidateExplanations[step.id];
      if (!text) throw new Error(`步骤没有离线候选说明：${step.id}`);
      const node = resolve(index, flow, step.id);
      const expectedDeclarationHash = declarationHash(index, node.id, sourceTexts);
      if (!expectedDeclarationHash) throw new Error(`没有唯一、可验证的过程声明文本：${step.id}`);
      const declaration = node.evidenceIds.map(id => evidence.get(id)!).filter(item => item && declarationRules.has(item.rule));
      const localAnchorIds = step.anchorIds.filter(id => {
        const anchor = anchors.get(id)!;
        return declaration.some(item => item.filePath === anchor.filePath && item.startLine <= anchor.startLine && item.endLine >= anchor.endLine);
      });
      // Some existing flow anchors describe the caller or containing class only.
      // Do not mislabel them as callee-local proof: precise declaration evidence
      // and expectedDeclarationHash still bind that implementation directly.
      const controls: SemanticControl[] = [];
      if (text.conditions.length) controls.push({ kind: 'condition', description: text.conditions.join('；'), anchorIds: localAnchorIds });
      if (asyncKinds[step.id]) controls.push({ kind: asyncKinds[step.id], description: text.asyncBoundaries.join('；') || '本阶段存在异步或独立请求边界。', anchorIds: localAnchorIds });
      if (earlyReturnSteps.has(step.id)) controls.push({ kind: 'early-return', description: '错误、重放、过旧响应或保护条件可能提前返回；详见原始步骤与源码。', anchorIds: localAnchorIds });
      if (['claim-transfer', 'battle-advance', 'battle-step'].includes(step.id)) controls.push({ kind: 'loop', description: step.id === 'claim-transfer' ? '按资源类型逐项领取整数储量。' : '按固定步预算或本步待处理对象迭代；不代表无限后台循环。', anchorIds: localAnchorIds });
      const extra = text.asyncBoundaries.length ? `\n\n边界：${text.asyncBoundaries.join('；')}` : '';
      return { id: step.id, title: step.name, summary: text.purpose, purpose: text.purpose,
        detail: `${step.description}\n\n${text.processing.join('；')}${extra}`, inputs: [...text.inputs], processing: [...text.processing], outputs: [...text.outputs], changes: [...text.stateChanges],
        sourceStepIds: [step.id], bindings: [{ id: `${step.id}-implementation`, sourceStepId: step.id,
          selector: { language: node.language, kinds: [node.kind], qualifiedName: node.qualifiedName, filePath: node.filePath! }, role: 'implementation' as const,
          anchorIds: localAnchorIds, expectedDeclarationHash }], controls, origin: 'curated' as const };
    });
    const groups = candidateSummaryGroups.filter(group => group.flowId === flow.id).map(group => {
      const children = group.stepIds.map(id => steps.find(step => step.id === id)!);
      if (children.some(child => !child)) throw new Error(`摘要组引用缺失步骤：${group.id}`);
      const text: SemanticText = { title: group.title, summary: group.purpose, purpose: group.purpose,
        detail: `${children.map(child => child.summary).join('；')}\n\n本摘要只折叠已有步骤；组内条件、提前返回及异步边界仍保留在详细层，不新增已验证顺序。`,
        inputs: unique(children.flatMap(child => child.inputs)), processing: children.map(child => child.summary),
        outputs: unique(children.flatMap(child => child.outputs)), changes: unique(children.flatMap(child => child.changes)) };
      return { ...text, id: group.id, childIds: [...group.stepIds], origin: 'curated' as const };
    });
    flows.push({ id: flow.id, sourceFlowId: flow.id, title: flow.name, description: flow.description, groups, steps });
  }
  return { schemaVersion: '1.0.0', projectId: architecture.projectId, flows };
}

import Ajv from 'ajv';
import definitionsSchema from '../definitions.schema.json';
import overlaySchema from '../overlay.schema.json';
import { canonicalJson } from '../../architecture-model/src/validation.ts';
import { contentHash } from '../../schema/src/index.ts';
import type { SemanticDefinitions, SemanticFlowDefinition, SemanticOverlay } from './types.ts';

const ajv = new Ajv({ strict: true, allErrors: true });
const definitionsCheck = ajv.compile<SemanticDefinitions>(definitionsSchema);
const overlayCheck = ajv.compile<SemanticOverlay>(overlaySchema);
const fail = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const uniqueIds = (items: { id: string }[], name: string) => {
  const ids = new Set(items.map(item => item.id)); if (ids.size !== items.length) fail(`${name}存在重复 ID`); return ids;
};
function path(value: string) {
  if (value.includes('\\') || value.includes(':') || value.startsWith('/') || value.includes('\0') || value.split('/').some(part => !part || part === '.' || part === '..')) fail('语义模型只接受授权范围内的正斜线相对路径');
}
function validateFlows(flows: SemanticFlowDefinition[]) {
  uniqueIds(flows, '语义流程');
  for (const flow of flows) {
    const steps = uniqueIds(flow.steps, '语义步骤'), groups = uniqueIds(flow.groups, '语义分组');
    if ([...steps].some(id => groups.has(id))) fail('摘要与详细节点不能共用 ID');
    const grouped = flow.groups.flatMap(group => group.childIds);
    if (grouped.length !== steps.size || new Set(grouped).size !== grouped.length || grouped.some(id => !steps.has(id))) fail('摘要分组必须唯一覆盖所有详细步骤');
    if (flow.groups.some(group => !group.childIds.length)) fail('摘要分组不能为空');
    uniqueIds(flow.steps.flatMap(step => step.bindings), '流程绑定');
    for (const step of flow.steps) for (const binding of step.bindings) {
      if (!binding.selector && !binding.sourceStepId) fail('绑定需要精确选择器或 sourceStepId');
      if (binding.sourceStepId && !step.sourceStepIds.includes(binding.sourceStepId)) fail('绑定的 sourceStepId 必须属于该详细步骤');
      if (binding.selector?.filePath) path(binding.selector.filePath);
      if (binding.selector?.filePathPrefix) path(binding.selector.filePathPrefix.replace(/\/$/, ''));
    }
  }
}
export function validateDefinitions(value: unknown): asserts value is SemanticDefinitions {
  if (!definitionsCheck(value)) fail(`语义定义不符合 Schema：${ajv.errorsText(definitionsCheck.errors?.slice(0, 4))}`);
  validateFlows((value as SemanticDefinitions).flows);
}
export function validateOverlay(value: unknown): asserts value is SemanticOverlay {
  if (!overlayCheck(value)) fail(`语义覆盖不符合 Schema：${ajv.errorsText(overlayCheck.errors?.slice(0, 4))}`);
  const overlay = value as SemanticOverlay;
  validateFlows(overlay.flowOverrides);
  uniqueIds(overlay.history, '语义编辑历史');
  for (const item of [...overlay.reviews.map(review => review.reviewedAt), ...overlay.history.map(record => record.at)]) if (!Number.isFinite(Date.parse(item))) fail('语义复核/历史时间无效');
}
export function semanticRevision(value: SemanticDefinitions | SemanticOverlay | SemanticFlowDefinition): string { return contentHash(canonicalJson(value)); }

import Ajv from 'ajv';
import schema from '../presentation.schema.json';
import type { AnalysisPresentation, EntityRef } from './types.ts';
export type * from './types.ts';
export { CONTROL_VERSION } from './types.ts';
export const presentationSchema = schema;
export const entityRefSchema = schema.properties.focusNodeId;
const ajv = new Ajv({ allErrors: true, strict: true });
const check = ajv.compile<AnalysisPresentation>(schema);
const checkRef = ajv.compile<EntityRef>(entityRefSchema);
export function controlError(code: string, message: string, statusCode = 400): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode });
}
export function validateEntityRef(value: unknown): asserts value is EntityRef {
  if (!checkRef(value)) throw controlError('INVALID_REFERENCE', `实体引用不符合协议：${ajv.errorsText(checkRef.errors?.slice(0, 3))}`);
}
export function validatePresentation(value: unknown): asserts value is AnalysisPresentation {
  if (!check(value)) throw controlError('INVALID_PRESENTATION', `展示协议校验失败：${ajv.errorsText(check.errors?.slice(0, 4))}`);
  const presentation = value as AnalysisPresentation;
  if (Buffer.byteLength(JSON.stringify(presentation), 'utf8') > 256 * 1024) throw controlError('PRESENTATION_TOO_LARGE', '展示内容超过256 KiB预算');
  if (!Number.isFinite(Date.parse(presentation.createdAt))) throw controlError('INVALID_PRESENTATION', 'createdAt 必须为有效时间');
  if (new Set(presentation.orderedSteps.map(step => step.id)).size !== presentation.orderedSteps.length) throw controlError('INVALID_PRESENTATION', '阅读步骤存在重复 ID');
  if (presentation.targetView === 'flow' && !presentation.flowId) throw controlError('INVALID_PRESENTATION', '流程展示必须明确 flowId');
  if (presentation.targetView !== 'flow' && presentation.semanticGranularity !== 'simple') throw controlError('UNSUPPORTED_PRESENTATION', '简洁/详细语义粒度仅适用于流程；其他目标使用 simple 协议占位值');
  for (const step of presentation.orderedSteps) {
    if (step.orderBasis === 'call-path' && !step.pathId) throw controlError('INVALID_PRESENTATION', '调用路径步骤必须引用服务器注册的 pathId');
    if (step.semanticNodeId && !presentation.flowId) throw controlError('INVALID_PRESENTATION', '语义步骤必须明确所属 flowId');
  }
}

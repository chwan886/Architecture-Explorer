import type { RelationCategory, ResolutionState, ReviewState, ResolvedBusinessFlow, ResolvedFlowStep, ResolvedFlowTransition } from '../../../../packages/architecture-model/src/types';
export const reviewLabels: Record<ReviewState, string> = { pending: '候选 · 待确认', confirmed: '已人工确认', rejected: '已拒绝', 'needs-review': '源码变化 · 待复核' };
export const resolutionLabels: Record<ResolutionState, string> = { resolved: '已定位', changed: '源码已变化', missing: '未找到源码', ambiguous: '匹配不唯一', conflict: '归属冲突' };
export const categoryLabels: Record<RelationCategory, string> = { dependency: '依赖', call: '调用', interface: '接口', 'data-access': '数据读写', event: '事件', resource: '资源', initialization: '初始化' };
export const roleLabels = { owner: '所属模块', participant: '参与职责', shared: '共享支撑' };
export const verificationLabels = { 'static-confirmed': '静态调用确认', 'source-supported': '源码顺序支持', unverified: '流程顺序未验证' };
export const basisLabels = { 'static-call': '真实调用', 'source-order': '源码顺序', 'protocol-contract': '协议关联', 'request-boundary': '跨请求边界', narrative: '叙述顺序' };
export function flowStep(flow: ResolvedBusinessFlow | undefined, id?: string): ResolvedFlowStep | undefined { return flow?.steps.find(step => step.id === id); }
export function flowTransition(flow: ResolvedBusinessFlow | undefined, id?: string): ResolvedFlowTransition | undefined { return flow?.transitions.find(transition => transition.id === id); }

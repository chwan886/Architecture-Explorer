import Ajv from 'ajv';
import schema from '../model.schema.json';
import { contentHash } from '../../schema/src/index.ts';
import type { ArchitectureModel } from './types.ts';

const ajv = new Ajv({ allErrors: true, strict: true });
const check = ajv.compile<ArchitectureModel>(schema);
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
  return JSON.stringify(value);
}
export function modelRevision(model: ArchitectureModel): string { return contentHash(canonicalJson(model)); }

export function validateModel(value: unknown): asserts value is ArchitectureModel {
  if (!check(value)) throw Object.assign(new Error(`架构模型不符合 Schema：${ajv.errorsText(check.errors?.slice(0, 4))}`), { statusCode: 400 });
  const fail = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 400 }); };
  const unique = (items: { id: string }[], label: string) => {
    const ids = new Set(items.map(item => item.id));
    if (ids.size !== items.length) fail(`${label}存在重复 ID`);
    return ids;
  };
  const systems = unique(value.systems, '业务系统');
  const modules = unique(value.modules, '业务模块');
  if (value.modules.some(m => systems.has(m.id))) fail('系统与模块不能共用逻辑 ID');
  const memberships = unique(value.memberships, '归属规则');
  const anchors = unique(value.anchors, '源码锚点');
  const flows = unique(value.flows, '业务流程');
  const moduleSystem = new Map(value.modules.map(m => [m.id, m.systemId]));
  const checkAnchors = (ids: string[]) => { if (ids.some(id => !anchors.has(id))) fail('引用了不存在的源码锚点'); };
  const checkPath = (p: string) => {
    if (p.includes('\\') || p.includes(':') || p.startsWith('/') || p.includes('\0') || p.split('/').some(s => !s || s === '.' || s === '..'))
      fail('模型只接受不越界的正斜线相对路径');
  };
  const selector = (s: ArchitectureModel['memberships'][number]['selector']) => {
    if (s.filePath) checkPath(s.filePath);
    if (s.filePathPrefix) checkPath(s.filePathPrefix.replace(/\/$/, ''));
  };
  for (const a of value.anchors) {
    checkPath(a.filePath);
    if (a.endLine < a.startLine) fail('源码锚点行范围倒置');
    if (a.quote.split(/\r?\n/).length !== a.endLine - a.startLine + 1) fail('源码锚点 quote 行数与精确行范围不一致');
  }
  for (const s of value.systems) checkAnchors(s.anchorIds);
  for (const m of value.modules) { if (!systems.has(m.systemId)) fail('模块所属系统不存在'); checkAnchors(m.anchorIds); }
  for (const m of value.memberships) {
    if (!systems.has(m.systemId) || !modules.has(m.moduleId) || moduleSystem.get(m.moduleId) !== m.systemId) fail('归属规则的系统与模块不一致');
    checkAnchors(m.anchorIds); selector(m.selector);
  }
  for (const f of value.flows) {
    if (f.systemIds.some(id => !systems.has(id))) fail('流程引用的系统不存在');
    const lanes = unique(f.lanes, '流程泳道'); const steps = unique(f.steps, '流程步骤'); unique(f.transitions, '流程转换');
    for (const lane of f.lanes) if (lane.systemId && !systems.has(lane.systemId)) fail('泳道所属系统不存在');
    for (const step of f.steps) {
      if (!lanes.has(step.laneId) || (step.moduleId && !modules.has(step.moduleId))) fail('流程步骤的泳道或模块不存在');
      checkAnchors(step.anchorIds); if (step.selector) selector(step.selector);
    }
    for (const t of f.transitions) { if (!steps.has(t.source) || !steps.has(t.target)) fail('流程转换端点不存在'); checkAnchors(t.anchorIds); }
  }
  for (const review of value.reviews) {
    if (!(review.targetType === 'system' ? systems : review.targetType === 'membership' ? memberships : flows).has(review.targetId)) fail('人工决策目标不存在');
    if (!Number.isFinite(Date.parse(review.reviewedAt))) fail('人工决策时间无效');
  }
}

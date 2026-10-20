import Ajv from 'ajv';
import indexSchema from '../index.schema.json';
import analyzerSchema from '../analyzer.schema.json';
import type { ArchitectureIndex, AnalyzerResult } from './index';

const ajv = new Ajv({ allErrors: true, strict: false });
const checkIndex = ajv.compile<ArchitectureIndex>(indexSchema);
const checkAnalyzer = ajv.compile<AnalyzerResult>(analyzerSchema);
function errors(value: typeof checkAnalyzer.errors): string {
  const count=value?.length ?? 0;
  return `${count} 项校验问题；${ajv.errorsText(value?.slice(0, 3))}${count>3?'（其余省略）':''}`;
}
export function validateAnalyzerResult(result: unknown): asserts result is AnalyzerResult {
  if (!checkAnalyzer(result)) throw new Error(`分析器输出不符合 Schema: ${errors(checkAnalyzer.errors)}`);
}
export function validateIndex(index: unknown): asserts index is ArchitectureIndex {
  if (!checkIndex(index)) throw new Error(`索引不符合 Schema: ${errors(checkIndex.errors)}`);
  const unique = (ids: string[], kind: string) => {
    if (new Set(ids).size !== ids.length) throw new Error(`${kind} 存在重复 ID`);
    return new Set(ids);
  };
  const nodes = unique(index.nodes.map(n => n.id), '节点');
  const edges = unique(index.edges.map(e => e.id), '关系');
  const evidence = unique(index.evidence.map(e => e.id), '证据');
  const paths = unique(index.files.map(f => f.path), '源文件');
  const parents = new Map(index.nodes.map(n=>[n.id,n.parentId]));
  for (const n of index.nodes) {
    if (n.parentId && !nodes.has(n.parentId)) throw new Error(`节点父级不存在: ${n.id}`);
    if (n.moduleId && !nodes.has(n.moduleId)) throw new Error(`节点模块不存在: ${n.id}`);
    const seen=new Set([n.id]); let current=n.parentId;
    while(current){if(seen.has(current))throw new Error(`节点父级存在循环: ${n.id}`);seen.add(current);current=parents.get(current);}
    if (n.filePath && !paths.has(n.filePath)) throw new Error(`节点源文件不在清单: ${n.filePath}`);
    for (const id of n.evidenceIds) if (!evidence.has(id)) throw new Error(`节点证据不存在: ${id}`);
  }
  for (const e of index.edges) {
    if (!nodes.has(e.source) || !nodes.has(e.target)) throw new Error(`关系端点不存在: ${e.id}`);
    if (e.kind !== 'contains' && !e.evidenceIds.length) throw new Error(`关系缺少证据: ${e.id}`);
    if (e.confidence === 'runtime-verified') throw new Error('当前分析器没有运行时采集器');
    for (const id of e.evidenceIds) if (!evidence.has(id)) throw new Error(`关系证据不存在: ${id}`);
  }
  for (const e of index.evidence) {
    if (!paths.has(e.filePath) || /(^[A-Za-z]:|^[/\\]|(^|[/\\])\.\.([/\\]|$))/.test(e.filePath)) throw new Error(`证据路径非法: ${e.filePath}`);
    if (e.endLine < e.startLine) throw new Error(`证据范围非法: ${e.id}`);
    if (index.files.find(f => f.path === e.filePath)?.hash !== e.fileHash) throw new Error(`证据哈希不匹配: ${e.id}`);
  }
  for (const f of index.flows) {
    if (f.nodeIds.some(id => !nodes.has(id)) || f.edgeIds.some(id => !edges.has(id))) throw new Error(`路径引用失效: ${f.id}`);
  }
}

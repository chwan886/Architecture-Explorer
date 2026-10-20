import { contentHash, type ArchitectureIndex, type ArchitectureNode, type Evidence } from '../../schema/src/index.ts';

export interface Declaration { node: ArchitectureNode; evidence: Evidence; text: string; hash: string; start: number; end: number }
export const normalize = (value: string) => value.replaceAll('\r\n', '\n');
const declarationRules = new Set(['csharp.declaration', 'csharp.lambda-declaration', 'python.declaration']);
interface SourceContext { nodes: Map<string, ArchitectureNode>; evidence: Map<string, Evidence>; files: Map<string, string>; inputs: Map<string, string | undefined>; sources: Map<string, string | undefined>; results: Map<string, Declaration[]> }
const contexts = new WeakMap<ArchitectureIndex, WeakMap<Record<string, string>, SourceContext>>();
const emptyTexts: Record<string, string> = {};
export function declarationCandidates(index: ArchitectureIndex, nodeId: string, sourceTexts: Record<string, string> = emptyTexts): Declaration[] {
  let byTexts = contexts.get(index); if (!byTexts) { byTexts = new WeakMap(); contexts.set(index, byTexts); }
  let context = byTexts.get(sourceTexts);
  if (!context) { context = { nodes: new Map(index.nodes.map(node => [node.id, node])), evidence: new Map(index.evidence.map(item => [item.id, item])), files: new Map(index.files.map(file => [file.path, file.hash])), inputs: new Map(), sources: new Map(), results: new Map() }; byTexts.set(sourceTexts, context); }
  const node = context.nodes.get(nodeId); if (!node) return [];
  for (const file of new Set(node.evidenceIds.flatMap(id => context.evidence.get(id)?.filePath ?? []))) {
    if (!context.inputs.has(file) || context.inputs.get(file) !== sourceTexts[file]) {
      context.inputs.set(file, sourceTexts[file]); context.sources.delete(file); context.results.clear();
    }
  }
  const cached = context.results.get(nodeId); if (cached) return cached;
  const result: Declaration[] = [];
  for (const id of node.evidenceIds) {
    const item = context.evidence.get(id); if (!item || !declarationRules.has(item.rule)) continue;
    const original = sourceTexts[item.filePath];
    if (!context.sources.has(item.filePath)) context.sources.set(item.filePath, original !== undefined && contentHash(original) === context.files.get(item.filePath) ? normalize(original) : undefined);
    const source = context.sources.get(item.filePath);
    if (source === undefined || item.fileHash !== context.files.get(item.filePath)) continue;
    const lines = source.split('\n');
    if (item.startLine < 1 || item.endLine < item.startLine || item.endLine > lines.length || item.startColumn < 1 || item.endColumn < 1) continue;
    if (item.startColumn > lines[item.startLine - 1].length + 1 || item.endColumn > lines[item.endLine - 1].length + 1) continue;
    const start = lines.slice(0, item.startLine - 1).reduce((total, line) => total + line.length + 1, 0) + item.startColumn - 1;
    const end = lines.slice(0, item.endLine - 1).reduce((total, line) => total + line.length + 1, 0) + item.endColumn - 1;
    if (end <= start) continue;
    const text = source.slice(start, end);
    if (!result.some(value => value.evidence.filePath === item.filePath && value.start === start && value.end === end))
      result.push({ node, evidence: item, text, hash: contentHash(text), start, end });
  }
  context.results.set(nodeId, result);
  return result;
}

// Public evidence columns are UTF-16 in both workers. Hash exact AST declaration
// text, normalizing CRLF only; neighboring methods and absolute line numbers do
// not participate. Multiple declarations require explicit disambiguation.
export function declarationHash(index: ArchitectureIndex, nodeId: string, sourceTexts: Record<string, string> = {}): string | undefined {
  const candidates = declarationCandidates(index, nodeId, sourceTexts);
  return candidates.length === 1 ? candidates[0].hash : undefined;
}

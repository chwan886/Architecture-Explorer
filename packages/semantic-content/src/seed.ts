import { contentHash, type ArchitectureIndex, type ArchitectureNode } from '../../schema/src/index.ts';
import { validateIndex } from '../../schema/src/validate.ts';
import { validateModel } from '../../architecture-model/src/validation.ts';
import type { ArchitectureModel, FlowStep, SourceAnchor, SymbolSelector } from '../../architecture-model/src/types.ts';
import type { SemanticControl, SemanticDefinitions, SemanticText } from '../../semantic-model/src/types.ts';
import { SEMANTIC_SCHEMA_VERSION } from '../../semantic-model/src/types.ts';
import { validateDefinitions } from '../../semantic-model/src/validation.ts';
import { declarationCandidates, normalize, type Declaration } from '../../semantic-model/src/source.ts';
import { validateContentPack, type SemanticContentPack } from './seed-explanations.ts';

const unique = (values: string[]) => [...new Set(values)];
const note = 'Rule seed: existing model and explicit declaration bindings only. Descriptions and control annotations remain pending review; no new code relationships or runtime order are established.';

function matches(node: ArchitectureNode, selector: SymbolSelector): boolean {
  const prefix = selector.filePathPrefix?.replace(/\/$/, '');
  return node.qualifiedName === selector.qualifiedName && !!node.filePath
    && (!selector.filePath || selector.filePath === node.filePath)
    && (!selector.language || selector.language === node.language)
    && (!selector.kinds || selector.kinds.includes(node.kind))
    && (!selector.qualifiedNamePrefix || node.qualifiedName.startsWith(selector.qualifiedNamePrefix))
    && (!prefix || node.filePath === prefix || node.filePath.startsWith(prefix + '/'));
}
function resolve(index: ArchitectureIndex, step: FlowStep): ArchitectureNode | undefined {
  if (!step.selector) return undefined;
  if (!step.selector.qualifiedName) throw new Error(`Seed requires an exact qualifiedName selector: ${step.id}`);
  const nodes = index.nodes.filter(node => matches(node, step.selector!));
  if (nodes.length !== 1 || !['method', 'function'].includes(nodes[0].kind)) throw new Error(`Implementation must resolve to one procedure: ${step.id}`);
  return nodes[0];
}
function local(anchor: SourceAnchor, declaration: Declaration, source: string): boolean {
  const range = declaration.evidence;
  if (anchor.filePath !== range.filePath || anchor.startLine < range.startLine || anchor.endLine > range.endLine) return false;
  const lines = normalize(source).split('\n');
  // Anchors quote complete lines; a neighboring declaration on the same line
  // cannot become local proof merely because its line numbers overlap.
  return (anchor.startLine !== range.startLine || !lines[range.startLine - 1].slice(0, range.startColumn - 1).trim())
    && (anchor.endLine !== range.endLine || !lines[range.endLine - 1].slice(range.endColumn - 1).trim());
}
function text(step: FlowStep): SemanticText {
  const description = step.description || step.name;
  return { title: step.name, summary: description, purpose: description, detail: `${description}\n\n${note}`,
    inputs: [...step.reads], processing: [description], outputs: [...step.writes], changes: [...step.writes] };
}

/** Pure builder. A content pack changes presentation only, never source mapping
 * or confirmation state. Source text is read by the caller and never executed. */
export function buildCandidateDefinitions(index: ArchitectureIndex, architecture: ArchitectureModel, sourceTexts: Record<string, string>, pack?: SemanticContentPack): SemanticDefinitions {
  validateIndex(index); validateModel(architecture);
  if (index.metadata.projectId !== architecture.projectId) throw new Error('Index and architecture project do not match');
  if (pack) {
    validateContentPack(pack);
    if (pack.projectId && pack.projectId !== architecture.projectId) throw new Error('Content pack project does not match');
    if (pack.flows.some(adapter => !architecture.flows.some(flow => flow.id === adapter.sourceFlowId))) throw new Error('Content pack references an unknown flow');
  }
  const files = new Map(index.files.map(file => [file.path, file.hash]));
  const anchors = new Map(architecture.anchors.map(anchor => [anchor.id, anchor]));
  const checked = new Set<string>();
  const checkAnchor = (id: string): SourceAnchor => {
    const anchor = anchors.get(id)!;
    if (!checked.has(id)) {
      const source = sourceTexts[anchor.filePath];
      if (source === undefined || files.get(anchor.filePath) !== anchor.expectedFileHash || contentHash(source) !== anchor.expectedFileHash)
        throw new Error(`Anchor source is missing or stale: ${id}`);
      const lines = normalize(source).split('\n');
      if (anchor.endLine > lines.length || lines.slice(anchor.startLine - 1, anchor.endLine).join('\n') !== normalize(anchor.quote))
        throw new Error(`Anchor quote does not match current full lines: ${id}`);
      checked.add(id);
    }
    return anchor;
  };
  const definitions: SemanticDefinitions = { schemaVersion: SEMANTIC_SCHEMA_VERSION, projectId: architecture.projectId, flows: architecture.flows.map(flow => {
    const adapter = pack?.flows.find(item => item.sourceFlowId === flow.id);
    if (adapter?.steps?.some(item => !flow.steps.some(step => step.id === item.sourceStepId))) throw new Error(`Content pack references an unknown step: ${flow.id}`);
    const steps = flow.steps.map(step => {
      const authored = adapter?.steps?.find(item => item.sourceStepId === step.id);
      const node = resolve(index, step);
      const declarations = node ? declarationCandidates(index, node.id, sourceTexts) : [];
      if (node && declarations.length !== 1) throw new Error(`Missing or ambiguous current declaration: ${step.id}`);
      const declaration = declarations[0];
      const localAnchorIds = step.anchorIds.filter(id => {
        const anchor = checkAnchor(id);
        return !declaration || local(anchor, declaration, sourceTexts[anchor.filePath]);
      });
      const controls: SemanticControl[] = step.condition ? [{ kind: 'condition', description: step.condition, anchorIds: [...localAnchorIds] }] : [];
      for (const control of authored?.controls ?? []) {
        const anchorIds = control.anchorIds ?? localAnchorIds;
        if (anchorIds.some(id => !localAnchorIds.includes(id))) throw new Error(`Control anchor is outside the current step declaration: ${step.id}`);
        controls.push({ kind: control.kind, description: control.description, anchorIds: [...anchorIds] });
      }
      return { ...text(step), ...structuredClone(authored?.text ?? {}), id: step.id, sourceStepIds: [step.id],
        bindings: node ? [{ id: `implementation-${contentHash(step.id).slice(0, 24)}`, sourceStepId: step.id,
          selector: { language: node.language, kinds: [node.kind], qualifiedName: node.qualifiedName, filePath: node.filePath! }, role: 'implementation' as const,
          anchorIds: [...localAnchorIds], expectedDeclarationHash: declaration.hash }] : [], controls, origin: 'rule-generated' as const };
    });
    let defaultGroup = 'seed-summary', groupOrdinal = 0;
    while (steps.some(step => step.id === defaultGroup)) defaultGroup = `seed-summary-${++groupOrdinal}`;
    const groups = adapter?.groups ?? (steps.length ? [{ id: defaultGroup, stepIds: steps.map(step => step.id) }] : []);
    return { id: flow.id, sourceFlowId: flow.id, title: adapter?.title ?? flow.name, description: adapter?.description ?? flow.description,
      steps, groups: groups.map(group => {
        const children = group.stepIds.map(id => steps.find(step => step.id === id));
        if (children.some(child => !child)) throw new Error(`Summary group references an unknown step: ${group.id}`);
        const present = children.filter(child => !!child);
        const summary = flow.description || flow.name;
        const defaults: SemanticText = { title: flow.name, summary, purpose: summary, detail: `${summary}\n\n${note}`,
          inputs: unique(present.flatMap(child => child.inputs)), processing: present.map(child => child.summary),
          outputs: unique(present.flatMap(child => child.outputs)), changes: unique(present.flatMap(child => child.changes)) };
        return { ...defaults, ...structuredClone(group.text ?? {}), id: group.id, childIds: [...group.stepIds], origin: 'rule-generated' as const };
      }) };
  }) };
  validateDefinitions(definitions);
  return definitions;
}

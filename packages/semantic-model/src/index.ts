export { declarationHash } from './source.ts';
export { validateDefinitions, validateOverlay, semanticRevision } from './validation.ts';
export type * from './types.ts';
export { SEMANTIC_SCHEMA_VERSION, SEMANTIC_PROJECTION_VERSION, SEMANTIC_GENERATOR_VERSION } from './types.ts';

import { contentHash, stableId, type ArchitectureIndex, type ArchitectureNode, type ArchitectureEdge, type Evidence } from '../../schema/src/index.ts';
import { buildProjection, modelRevision } from '../../architecture-model/src/index.ts';
import { canonicalJson } from '../../architecture-model/src/validation.ts';
import type { ArchitectureModel, ArchitectureDiagnostic, ReviewState, SymbolSelector } from '../../architecture-model/src/types.ts';
import { declarationCandidates, normalize, type Declaration } from './source.ts';
import { validateDefinitions, validateOverlay, semanticRevision } from './validation.ts';
import { SEMANTIC_PROJECTION_VERSION, SEMANTIC_GENERATOR_VERSION, type SemanticDefinitions, type SemanticOverlay, type SemanticBuildOptions, type SemanticProjection, type SemanticNode, type SemanticEdge, type SemanticBinding, type SemanticBindingDefinition, type SemanticUpdateState, type SemanticVerification, type SemanticPath, type SemanticBundle, type SemanticReverseResult, type ResolvedSemanticFlow, type SemanticReview, type SemanticRelationKind } from './types.ts';

const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)];
const hash = (value: unknown) => contentHash(canonicalJson(value));
const failure = (message: string, statusCode = 400): never => { throw Object.assign(new Error(message), { statusCode }); };
const worst = (values: SemanticUpdateState[]): SemanticUpdateState => ['conflict', 'ambiguous', 'missing', 'stale', 'current'].find(state => values.includes(state as SemanticUpdateState)) as SemanticUpdateState || 'current';
const verification = (values: SemanticVerification[]): SemanticVerification => values.includes('unverified') ? 'unverified' : values.includes('inferred') ? 'inferred' : values.includes('source-supported') ? 'source-supported' : 'static-confirmed';
const edgeKind = (edge: ArchitectureEdge): SemanticRelationKind => edge.kind === 'calls' ? 'direct-call' : ['reads', 'writes', 'passes', 'returns', 'initializes'].includes(edge.kind) ? 'data-access' : ['publishes', 'subscribes', 'unsubscribes'].includes(edge.kind) ? 'event' : 'dependency';
const kindLabels: Record<SemanticRelationKind, string> = { 'direct-call': '直接调用', 'indirect-call': '间接调用', dependency: '静态依赖', 'data-access': '数据读写', event: '事件关系', 'source-order': '源码位置', protocol: '协议对应', 'request-boundary': '跨请求边界', related: '叙述关联' };
function review(overlay: SemanticOverlay, flowId: string, targetType: SemanticReview['targetType'], targetId: string, fingerprint: string, status: SemanticUpdateState = 'current'): ReviewState {
  const decisions = overlay.reviews.filter(item => item.flowId === flowId && item.targetType === targetType && item.targetId === targetId).sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt));
  const matching = decisions.find(item => item.fingerprint === fingerprint);
  if (matching?.decision === 'rejected') return 'rejected';
  if (status !== 'current') return 'needs-review';
  return matching?.decision ?? (decisions.length ? 'needs-review' : 'pending');
}
function changeSet(currentNodes: SemanticNode[], currentEdges: SemanticEdge[], previous?: ResolvedSemanticFlow) {
  const oldNodes = new Map([...(previous?.detailNodes ?? []), ...(previous?.summaryNodes ?? [])].map(node => [node.id, node.fingerprint]));
  const oldEdges = new Map([...(previous?.detailEdges ?? []), ...(previous?.summaryEdges ?? [])].map(edge => [edge.id, edge.fingerprint]));
  const nodes = new Map(currentNodes.map(node => [node.id, node.fingerprint])), edges = new Map(currentEdges.map(edge => [edge.id, edge.fingerprint]));
  return { unchangedNodeIds: [...nodes].filter(([id, value]) => oldNodes.get(id) === value).map(([id]) => id), changedNodeIds: [...nodes].filter(([id, value]) => oldNodes.get(id) !== value).map(([id]) => id), removedNodeIds: [...oldNodes.keys()].filter(id => !nodes.has(id)), unchangedEdgeIds: [...edges].filter(([id, value]) => oldEdges.get(id) === value).map(([id]) => id), changedEdgeIds: [...edges].filter(([id, value]) => oldEdges.get(id) !== value).map(([id]) => id), removedEdgeIds: [...oldEdges.keys()].filter(id => !edges.has(id)) };
}

export function buildSemanticProjection(index: ArchitectureIndex, architectureModel: ArchitectureModel, definitions: SemanticDefinitions, overlay: SemanticOverlay, options: SemanticBuildOptions = {}): SemanticProjection {
  validateDefinitions(definitions); validateOverlay(overlay);
  if (definitions.projectId !== index.metadata.projectId || architectureModel.projectId !== definitions.projectId) return failure('语义定义与授权项目不一致');
  if (overlay.scopeId !== index.metadata.scopeId) return failure('语义覆盖不属于当前授权 Scope', 403);
  const definitionRevision = semanticRevision(definitions), overlayRevision = semanticRevision(overlay), architectureRevision = modelRevision(architectureModel);
  const metadata = { scopeId: index.metadata.scopeId, projectId: index.metadata.projectId, sourceRevision: index.metadata.revision, architectureRevision, definitionRevision, overlayRevision,
    viewRevision: hash({ scope: index.metadata.scopeId, source: index.metadata.revision, architectureRevision, definitionRevision, overlayRevision, projection: SEMANTIC_PROJECTION_VERSION }), generatorVersion: SEMANTIC_GENERATOR_VERSION, projectionVersion: SEMANTIC_PROJECTION_VERSION };
  const sourceTexts = options.sourceTexts ?? {}, nodes = new Map(index.nodes.map(node => [node.id, node])), facts = new Map(index.edges.map(edge => [edge.id, edge]));
  const evidence = new Map(index.evidence.map(item => [item.id, item])), files = new Map(index.files.map(file => [file.path, file.hash]));
  const outgoing = new Map<string, ArchitectureEdge[]>(), adjacency = new Map<string, Set<string>>(), byName = new Map<string, ArchitectureNode[]>();
  for (const node of index.nodes) { const entries = byName.get(node.qualifiedName) ?? []; entries.push(node); byName.set(node.qualifiedName, entries); }
  for (const edge of index.edges) { const entries = outgoing.get(edge.source) ?? []; entries.push(edge); outgoing.set(edge.source, entries);
    if (edge.kind !== 'contains') { const a = adjacency.get(edge.source) ?? new Set(); a.add(edge.target); adjacency.set(edge.source, a); const b = adjacency.get(edge.target) ?? new Set(); b.add(edge.source); adjacency.set(edge.target, b); } }
  const architecture = buildProjection(index, architectureModel);
  const modelAnchors = new Map(architectureModel.anchors.map(anchor => [anchor.id, anchor]));
  const diagnostics: ArchitectureDiagnostic[] = [];
  const diagnostic = (list: ArchitectureDiagnostic[], code: string, message: string, targetId?: string) => list.push({ id: stableId(index.metadata.scopeId, 'semantic-diagnostic', `${code}|${targetId ?? ''}|${message}`), code, message, targetId, severity: 'warning' });
  if (overlay.baseDefinitionRevision !== definitionRevision) diagnostic(diagnostics, 'semantic-base-changed', '基础解释版本已变化；保留当前工作区人工覆盖，请合并复核。');
  const flowDefinitions = new Map(definitions.flows.map(flow => [flow.id, flow]));
  for (const flow of overlay.flowOverrides) flowDefinitions.set(flow.id, flow);
  function select(selector?: SymbolSelector): ArchitectureNode[] {
    if (!selector) return [];
    const prefix = selector.filePathPrefix?.replace(/\/$/, '');
    const candidates = selector.qualifiedName ? byName.get(selector.qualifiedName) ?? [] : index.nodes;
    const selected = candidates.filter(node => node.filePath && files.has(node.filePath) && !['project', 'system', 'module', 'file'].includes(node.kind)
      && (!selector.language || node.language === selector.language) && (!selector.kinds || selector.kinds.includes(node.kind))
      && (!selector.qualifiedName || selector.qualifiedName === node.qualifiedName) && (!selector.qualifiedNamePrefix || node.qualifiedName.startsWith(selector.qualifiedNamePrefix))
      && (!selector.filePath || node.filePath === selector.filePath) && (!prefix || node.filePath === prefix || node.filePath.startsWith(prefix + '/')));
    // Prefix selectors from legacy flows may also match callbacks. Resolve only
    // the explicit primary declaration, never silently include its descendants.
    const selectedIds = new Set(selected.map(node => node.id));
    return selected.filter(node => { let parent = node.parentId; const seen = new Set<string>(); while (parent && !seen.has(parent)) { seen.add(parent); if (selectedIds.has(parent)) return false; parent = nodes.get(parent)?.parentId; } return true; });
  }
  const declarationCache = new Map<string, Declaration[]>();
  const declarations = (id: string) => { let result = declarationCache.get(id); if (!result) { result = declarationCandidates(index, id, sourceTexts); declarationCache.set(id, result); } return result; };
  const flowResults: ResolvedSemanticFlow[] = [];
  for (const definition of flowDefinitions.values()) {
    const flowDiagnostics: ArchitectureDiagnostic[] = [];
    const previous = options.previous?.metadata.scopeId === index.metadata.scopeId ? options.previous.flows.find(flow => flow.id === definition.id) : undefined;
    const sourceFlow = architectureModel.flows.find(flow => flow.id === definition.sourceFlowId), resolvedSource = architecture.flows.find(flow => flow.id === definition.sourceFlowId);
    if (!sourceFlow || !resolvedSource) { diagnostic(diagnostics, 'semantic-flow-missing', '解释引用的真实业务流程不存在，未构造替代流程。', definition.id); continue; }
    const sourceSteps = new Map(sourceFlow.steps.map(step => [step.id, step]));
    const mappedSourceSteps = new Set(definition.steps.flatMap(step => step.sourceStepIds));
    const unmappedSteps = sourceFlow.steps.filter(step => !mappedSourceSteps.has(step.id));
    const missingSteps = [...mappedSourceSteps].filter(id => !sourceSteps.has(id));
    const unmappedTransitions = sourceFlow.transitions.filter(transition => !mappedSourceSteps.has(transition.source) || !mappedSourceSteps.has(transition.target));
    const transitionIds = new Set(sourceFlow.transitions.map(transition => transition.id));
    const removedTransitions = unique(previous?.detailEdges.flatMap(edge => edge.sourceTransitionIds) ?? []).filter(id => !transitionIds.has(id));
    for (const step of unmappedSteps) diagnostic(flowDiagnostics, 'semantic-source-step-unmapped', '源流程新增或尚未映射的步骤未进入人工解释；保留现有文字，等待维护映射。', step.id);
    for (const id of missingSteps) diagnostic(flowDiagnostics, 'semantic-source-step-missing', '人工解释引用的源步骤已删除；未按名称重新绑定其他步骤。', id);
    for (const transition of unmappedTransitions) diagnostic(flowDiagnostics, 'semantic-source-transition-unmapped', '源转换的一端尚未映射，未补造语义节点或关系。', transition.id);
    for (const id of removedTransitions) diagnostic(flowDiagnostics, 'semantic-source-transition-removed', '上次投影中的源转换已删除；保留人工解释并要求流程级复核。', id);
    const flowDrift = !!(unmappedSteps.length || missingSteps.length || unmappedTransitions.length || removedTransitions.length);
    const anchorResults = new Map<string, { evidence?: Evidence; valid: boolean; relocated: boolean; basis: unknown }>();
    const bindingDeclarations = new Map<string, Declaration[]>();
    function anchor(id: string, ranges: Declaration[]) {
      const cacheKey = id + '|' + ranges.map(range => range.evidence.id).sort().join('|');
      const cached = anchorResults.get(cacheKey); if (cached) return cached;
      const item = modelAnchors.get(id), original = item ? sourceTexts[item.filePath] : undefined;
      let result: { evidence?: Evidence; valid: boolean; relocated: boolean; basis: unknown } = { valid: false, relocated: false, basis: { id, valid: false } };
      if (item && original !== undefined && files.get(item.filePath) === contentHash(original)) {
        const text = normalize(original), lines = text.split('\n'), quote = normalize(item.quote), quoteLines = quote.split('\n');
        const sameHash = files.get(item.filePath) === item.expectedFileHash;
        const locations: number[] = [];
        for (let line = 0; line + quoteLines.length <= lines.length; line++) if (lines.slice(line, line + quoteLines.length).join('\n') === quote) locations.push(line + 1);
        const exact = sameHash && locations.includes(item.startLine) && item.endLine === item.startLine + quoteLines.length - 1;
        let startLine: number | undefined = exact ? item.startLine : undefined;
        if (!sameHash && locations.length === 1) {
          const start = locations[0], end = start + quoteLines.length - 1;
          const contained = ranges.some(range => range.evidence.filePath === item.filePath && range.evidence.startLine <= start && range.evidence.endLine >= end
            && (range.evidence.startLine !== start || !lines[start - 1].slice(0, range.evidence.startColumn - 1).trim())
            && (range.evidence.endLine !== end || !lines[end - 1].slice(range.evidence.endColumn - 1).trim()));
          if (contained) startLine = start;
        }
        if (startLine !== undefined) {
          const endLine = startLine + quoteLines.length - 1, fileHash = files.get(item.filePath)!;
          const proof: Evidence = { id: stableId(index.metadata.scopeId, 'semantic-evidence', `${definition.id}|${id}|${fileHash}|${startLine}|${endLine}|${quote}`), filePath: item.filePath, startLine, endLine, startColumn: 1, endColumn: quoteLines.at(-1)!.length + 1, fileHash, rule: 'semantic:verified-source-anchor', excerpt: item.quote };
          evidence.set(proof.id, proof); result = { evidence: proof, valid: true, relocated: !sameHash, basis: { id, quote, valid: true } };
        } else result.basis = { id, quote, valid: false };
      }
      anchorResults.set(cacheKey, result); return result;
    }
    const bindingBasis = new Map<string, unknown>();
    function bind(binding: SemanticBindingDefinition): SemanticBinding {
      const sourceStep = binding.sourceStepId ? sourceSteps.get(binding.sourceStepId) : undefined;
      const selected = select(binding.selector ?? sourceStep?.selector);
      const candidates = selected.length === 1 ? declarations(selected[0].id) : [];
      const matched = binding.expectedDeclarationHash ? candidates.filter(item => item.hash === binding.expectedDeclarationHash) : candidates;
      const chosen = matched.length === 1 ? matched : candidates.length === 1 ? candidates : [];
      const status: SemanticUpdateState = !selected.length || (binding.sourceStepId && !sourceStep) ? 'missing' : selected.length > 1 || candidates.length > 1 && matched.length !== 1 ? 'ambiguous'
        : !chosen.length || binding.expectedDeclarationHash && chosen[0].hash !== binding.expectedDeclarationHash ? 'stale' : 'current';
      bindingDeclarations.set(binding.id, chosen);
      const anchors = binding.anchorIds.map(id => anchor(id, chosen));
      const finalStatus = status === 'current' && anchors.some(item => !item.valid) ? 'stale' : status;
      if (anchors.some(item => item.relocated)) diagnostic(flowDiagnostics, 'semantic-anchor-relocated', '完整引文在当前绑定声明内唯一匹配，已生成当前源码证据；原始锚点未修改。', binding.id);
      if (finalStatus !== 'current') diagnostic(flowDiagnostics, 'semantic-binding-' + finalStatus, '绑定的唯一声明、局部哈希或源码锚点需要复核；未按名称猜测新实现。', binding.id);
      bindingBasis.set(binding.id, { definition: binding, sourceSelector: sourceStep?.selector, nodes: selected.map(node => ({ id: node.id, name: node.qualifiedName, signature: node.signature })), declarations: chosen.map(item => item.hash), status: finalStatus, anchors: anchors.map(item => item.basis) });
      return { ...binding, codeNodeIds: selected.map(node => node.id), evidenceIds: unique([...anchors.flatMap(item => item.evidence ? [item.evidence.id] : []), ...chosen.map(item => item.evidence.id)]), status: finalStatus, declarationHash: chosen.length === 1 ? chosen[0].hash : undefined, anchorsValid: anchors.every(item => item.valid) };
    }
    const parentByStep = new Map(definition.groups.flatMap(group => group.childIds.map(id => [id, group.id] as const)));
    function fragments(ids: string[]) {
      const remaining = new Set(ids), result: string[][] = [];
      while (remaining.size) { const pending = [remaining.values().next().value!], part: string[] = []; remaining.delete(pending[0]);
        while (pending.length) { const id = pending.pop()!; part.push(id); for (const other of adjacency.get(id) ?? []) if (remaining.delete(other)) pending.push(other); } result.push(part); }
      return result;
    }
    const detailNodes: SemanticNode[] = definition.steps.map(step => {
      const bindings = step.bindings.map(bind), ranges = bindings.flatMap(binding => bindingDeclarations.get(binding.id) ?? []);
      const controls = step.controls.flatMap(control => control.anchorIds.map(id => anchor(id, ranges)));
      const sourceReferences = step.sourceStepIds.every(id => sourceSteps.has(id));
      const status = worst([...bindings.map(binding => binding.status), ...controls.map(item => item.valid ? 'current' as const : 'stale' as const), ...(sourceReferences ? [] : ['missing' as const])]);
      const codeNodeIds = unique(bindings.filter(binding => binding.role === 'implementation').flatMap(binding => binding.codeNodeIds));
      const contextNodeIds = unique(bindings.filter(binding => binding.role === 'context').flatMap(binding => binding.codeNodeIds));
      const fingerprint = hash({ scope: index.metadata.scopeId, step, bindings: bindings.map(binding => bindingBasis.get(binding.id)), controls: controls.map(item => item.basis), sourceReferences });
      const parts = fragments(codeNodeIds);
      return { ...step, level: 'detail', parentId: parentByStep.get(step.id), childIds: [], codeNodeIds, contextNodeIds,
        evidenceIds: unique([...bindings.flatMap(binding => binding.evidenceIds), ...controls.flatMap(item => item.evidence ? [item.evidence.id] : [])]), fragments: parts, bindings, status,
        reviewState: review(overlay, definition.id, 'node', step.id, fingerprint, status), fingerprint,
        limitations: unique(['业务文字为解释候选，人工确认不改变底层静态证据可信度。', ...(parts.length > 1 ? [`包含 ${parts.length} 个未由当前事实连接的实现片段，未补造执行顺序。`] : []), ...(!codeNodeIds.length ? ['没有绑定主实现过程；此处保留叙述或边界说明。'] : []), ...(status !== 'current' ? ['当前源码依据需要复核，原人工文字仍保留。'] : [])]) };
    });
    const detailById = new Map(detailNodes.map(node => [node.id, node]));
    const sourceToDetail = new Map<string, SemanticNode[]>();
    for (const node of detailNodes) for (const id of node.sourceStepIds) { const entries = sourceToDetail.get(id) ?? []; entries.push(node); sourceToDetail.set(id, entries); }
    const edgeGroups = new Map<string, typeof sourceFlow.transitions>();
    for (const transition of sourceFlow.transitions) for (const source of sourceToDetail.get(transition.source) ?? []) for (const target of sourceToDetail.get(transition.target) ?? []) {
      const key = source.id + '|' + target.id; const members = edgeGroups.get(key) ?? []; members.push(transition); edgeGroups.set(key, members);
    }
    function paths(from: string[], to: string[]) {
      const targets = new Set(to), results: SemanticPath[] = []; let visits = 0, truncated = false;
      for (const source of from) {
        const queue = [{ nodeIds: [source], edgeIds: [] as string[] }];
        while (queue.length) {
          const path = queue.shift()!;
          for (const edge of outgoing.get(path.nodeIds.at(-1)!) ?? []) {
            if (edge.kind !== 'calls' || path.nodeIds.includes(edge.target)) continue;
            if (++visits > 200) { truncated = true; break; }
            const next = { nodeIds: [...path.nodeIds, edge.target], edgeIds: [...path.edgeIds, edge.id] };
            if (targets.has(edge.target)) results.push({ ...next, kind: 'call-path', verification: next.edgeIds.some(id => facts.get(id)!.confidence === 'inferred') ? 'inferred' : 'static-confirmed' });
            if (next.edgeIds.length < 4) queue.push(next);
            else if ((outgoing.get(edge.target) ?? []).some(item => item.kind === 'calls')) truncated = true;
          }
          if (visits > 200) break;
        }
        if (truncated && visits > 200) break;
      }
      return { results: results.slice(0, 200), truncated: truncated || results.length > 200 };
    }
    const rawEdgeBasis = (id: string) => { const edge = facts.get(id)!; return { id, source: edge.source, target: edge.target, kind: edge.kind, confidence: edge.confidence, rule: edge.rule, condition: edge.condition, dispatch: edge.dispatch, limitations: edge.limitations }; };
    const detailEdges: SemanticEdge[] = [];
    for (const [key, transitions] of edgeGroups) {
      const separator = key.indexOf('|'), source = detailById.get(key.slice(0, separator))!, target = detailById.get(key.slice(separator + 1))!;
      const targetIds = new Set(target.codeNodeIds), crossFacts = source.codeNodeIds.flatMap(id => outgoing.get(id) ?? []).filter(edge => edge.kind !== 'contains' && targetIds.has(edge.target));
      const callSearch = transitions.some(item => item.basis === 'static-call') ? paths(source.codeNodeIds, target.codeNodeIds) : { results: [], truncated: false };
      const ranges = [...source.bindings, ...target.bindings].flatMap(binding => bindingDeclarations.get(binding.id) ?? []);
      const anchorStates = transitions.flatMap(transition => transition.anchorIds.map(id => anchor(id, ranges)));
      // Legacy projection anchors invalidate at file granularity. Current local
      // declarations/quotes and continuous raw paths are the semantic proof;
      // narrative/protocol/request transitions retain their unverified ceiling.
      const verifiedCalls = transitions.every(transition => transition.basis === 'static-call')
        && [...source.codeNodeIds, ...target.codeNodeIds].every(id => declarations(id).length > 0)
        && anchorStates.every(item => item.valid);
      const sourceOrders = anchorStates.every(item => item.valid) && transitions.every(transition => transition.basis === 'source-order') && transitions.every(transition => {
        const from = sourceSteps.get(transition.source)!, to = sourceSteps.get(transition.target)!;
        const before = from.anchorIds.filter(id => transition.anchorIds.includes(id)).map(id => anchor(id, ranges));
        const after = to.anchorIds.filter(id => transition.anchorIds.includes(id)).map(id => anchor(id, ranges));
        return before.some(a => a.valid && after.some(b => b.valid && a.evidence!.filePath === b.evidence!.filePath && a.evidence!.endLine < b.evidence!.startLine
          && ranges.some(range => range.evidence.filePath === a.evidence!.filePath && range.evidence.startLine <= a.evidence!.startLine && range.evidence.endLine >= b.evidence!.endLine)));
      });
      const edgeVerification: SemanticVerification = verifiedCalls && callSearch.results.length ? verification(callSearch.results.map(path => path.verification)) : sourceOrders ? 'source-supported' : 'unverified';
      const codeEdgeIds = unique([...crossFacts.map(edge => edge.id), ...callSearch.results.flatMap(path => path.edgeIds)]);
      const kinds: SemanticRelationKind[] = unique([...transitions.map(item => item.basis === 'protocol-contract' ? 'protocol' as const : item.basis === 'request-boundary' ? 'request-boundary' as const : item.basis === 'source-order' ? 'source-order' as const : item.basis === 'static-call' ? callSearch.results.some(path => path.edgeIds.length > 1) ? 'indirect-call' as const : 'direct-call' as const : 'related' as const), ...crossFacts.map(edgeKind)]);
      const actualPaths: SemanticPath[] = [...callSearch.results, ...crossFacts.filter(edge => edge.kind !== 'calls').map(edge => ({ nodeIds: [edge.source, edge.target], edgeIds: [edge.id], kind: 'fact-set' as const, verification: edge.confidence === 'inferred' ? 'inferred' as const : 'static-confirmed' as const }))];
      const id = stableId(index.metadata.scopeId, 'semantic-edge', `${definition.id}|detail|${source.id}|${target.id}`);
      const status = worst([source.status, target.status, ...(anchorStates.some(item => !item.valid) ? ['stale' as const] : [])]);
      const fingerprint = hash({ scope: index.metadata.scopeId, transitions, source: source.fingerprint, target: target.fingerprint, facts: codeEdgeIds.map(rawEdgeBasis), paths: actualPaths, anchors: anchorStates.map(item => item.basis), pathDeclarations: unique(actualPaths.flatMap(path => path.nodeIds)).map(id => [id, declarations(id).map(item => item.hash)]), verification: edgeVerification });
      detailEdges.push({ id, source: source.id, target: target.id, level: 'detail', title: edgeVerification === 'static-confirmed' ? '真实静态调用' : edgeVerification === 'source-supported' ? '源码位置支持' : '关系说明 · 顺序未验证', description: `${source.title} → ${target.title}`, kinds,
        sourceTransitionIds: unique(transitions.map(item => item.id)), codeEdgeIds, paths: actualPaths, evidenceIds: unique([...anchorStates.flatMap(item => item.evidence ? [item.evidence.id] : []), ...codeEdgeIds.flatMap(id => facts.get(id)!.evidenceIds)]),
        conditions: unique(transitions.flatMap(item => item.condition ? [item.condition] : []).concat(codeEdgeIds.flatMap(id => facts.get(id)!.condition ? [facts.get(id)!.condition!] : []))),
        boundaries: unique(transitions.filter(item => ['protocol-contract', 'request-boundary'].includes(item.basis)).map(item => item.basis === 'request-boundary' ? '跨请求边界：没有单次连续执行栈证明。' : '协议对应：没有跨语言调用栈证明。')),
        verification: edgeVerification, status, reviewState: review(overlay, definition.id, 'edge', id, fingerprint, status), fingerprint,
        limitations: unique([...transitions.flatMap(item => item.limitations), ...codeEdgeIds.flatMap(id => facts.get(id)!.limitations ?? []), '静态调用或依赖不证明运行时必然执行、时间顺序或完整数据传递。', ...(edgeVerification === 'unverified' ? ['原流程未验证的叙述/边界不会由文字或人工确认升级为确定执行链。'] : []), ...(callSearch.truncated ? ['间接调用搜索达到4跳/200访问预算，结果已截断。'] : [])]) });
    }
    const summaryNodes: SemanticNode[] = definition.groups.map(group => {
      const children = group.childIds.map(id => detailById.get(id)!); const ids = new Set(group.childIds);
      const internal = detailEdges.filter(edge => ids.has(edge.source) && ids.has(edge.target));
      const status = worst(children.map(child => child.status)), fingerprint = hash({ scope: index.metadata.scopeId, group, children: children.map(child => child.fingerprint), internal: internal.map(edge => edge.fingerprint) });
      return { ...group, level: 'summary', sourceStepIds: unique(children.flatMap(child => child.sourceStepIds)), codeNodeIds: unique(children.flatMap(child => child.codeNodeIds)), contextNodeIds: unique(children.flatMap(child => child.contextNodeIds)),
        evidenceIds: unique([...children.flatMap(child => child.evidenceIds), ...internal.flatMap(edge => edge.evidenceIds)]), fragments: children.flatMap(child => child.fragments), bindings: children.flatMap(child => child.bindings), controls: children.flatMap(child => child.controls), status, fingerprint,
        reviewState: review(overlay, definition.id, 'node', group.id, fingerprint, status), limitations: unique([`组内保留 ${internal.length} 条详细关系、${internal.reduce((n, edge) => n + edge.boundaries.length, 0)} 个协议/请求边界；折叠不补造跨组连线。`, ...children.flatMap(child => child.limitations)]) };
    });
    const summaryGroups = new Map<string, SemanticEdge[]>();
    for (const edge of detailEdges) { const source = parentByStep.get(edge.source)!, target = parentByStep.get(edge.target)!; if (source === target) continue; const key = source + '|' + target; const entries = summaryGroups.get(key) ?? []; entries.push(edge); summaryGroups.set(key, entries); }
    const summaryEdges: SemanticEdge[] = [...summaryGroups].map(([key, members]) => {
      const separator = key.indexOf('|'), source = key.slice(0, separator), target = key.slice(separator + 1), id = stableId(index.metadata.scopeId, 'semantic-edge', `${definition.id}|summary|${source}|${target}`);
      const status = worst(members.map(edge => edge.status)), fingerprint = hash({ scope: index.metadata.scopeId, source, target, members: members.map(edge => [edge.id, edge.fingerprint]).sort() });
      const kinds = unique(members.flatMap(edge => edge.kinds));
      return { id, source, target, level: 'summary', title: `${kinds.map(kind => kindLabels[kind]).join('、')} · ${members.length} 条关系`, description: '仅汇总实际详细关系；内部边与边界在展开后保留。', kinds, sourceTransitionIds: unique(members.flatMap(edge => edge.sourceTransitionIds)), codeEdgeIds: unique(members.flatMap(edge => edge.codeEdgeIds)), paths: unique(members.flatMap(edge => edge.paths).map(path => canonicalJson(path))).map(path => JSON.parse(path)), evidenceIds: unique(members.flatMap(edge => edge.evidenceIds)), conditions: unique(members.flatMap(edge => edge.conditions)), boundaries: unique(members.flatMap(edge => edge.boundaries)), verification: verification(members.map(edge => edge.verification)), status, fingerprint, reviewState: review(overlay, definition.id, 'edge', id, fingerprint, status), limitations: unique(members.flatMap(edge => edge.limitations)) };
    });
    const codeNodeIds = unique([...detailNodes.flatMap(node => [...node.codeNodeIds, ...node.contextNodeIds]), ...detailEdges.flatMap(edge => edge.paths.flatMap(path => path.nodeIds)), ...detailEdges.flatMap(edge => edge.codeEdgeIds.flatMap(id => [facts.get(id)!.source, facts.get(id)!.target]))]);
    const codeIds = new Set(codeNodeIds), codeNodes = codeNodeIds.map(id => nodes.get(id)!).filter(Boolean), codeEdges = index.edges.filter(edge => codeIds.has(edge.source) && codeIds.has(edge.target));
    const reverseNodes: Record<string, string[]> = Object.create(null), reverseEdges: Record<string, string[]> = Object.create(null);
    for (const node of detailNodes) for (const id of [...node.codeNodeIds, ...node.contextNodeIds]) (reverseNodes[id] ??= []).push(node.id);
    for (const edge of detailEdges) for (const id of edge.codeEdgeIds) (reverseEdges[id] ??= []).push(edge.id);
    const proofIds = new Set([...detailNodes.flatMap(node => node.evidenceIds), ...detailEdges.flatMap(edge => edge.evidenceIds), ...codeNodes.flatMap(node => node.evidenceIds), ...codeEdges.flatMap(edge => edge.evidenceIds)]);
    const fingerprint = hash({ scope: index.metadata.scopeId, id: definition.id, title: definition.title, description: definition.description, sourceFlowId: definition.sourceFlowId,
      sourceBasis: { steps: sourceFlow.steps.map(step => ({ id: step.id, selector: step.selector, anchorIds: step.anchorIds, phase: step.phase, laneId: step.laneId, condition: step.condition, reads: step.reads, writes: step.writes })), transitions: sourceFlow.transitions },
      nodes: [...detailNodes, ...summaryNodes].map(node => [node.id, node.fingerprint]), edges: [...detailEdges, ...summaryEdges].map(edge => [edge.id, edge.fingerprint]) });
    const sourceDefinitionChanged = !!previous && options.previous!.metadata.architectureRevision !== architectureRevision && previous.fingerprint !== fingerprint;
    if (sourceDefinitionChanged) diagnostic(flowDiagnostics, 'semantic-source-definition-changed', '源流程定义或相关解释依据已变化；节点的局部确认独立保留，流程整体需要重新复核。', definition.id);
    const visible = codeNodes.slice(0, 80), visibleIds = new Set(visible.map(node => node.id));
    flowResults.push({ id: definition.id, sourceFlowId: definition.sourceFlowId, title: definition.title, description: definition.description, summaryNodes, detailNodes, summaryEdges, detailEdges, codeNodes, codeEdges,
      codeGraph: { nodes: visible, edges: codeEdges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target)), totalNodes: codeNodes.length, truncated: codeNodes.length > visible.length, revision: metadata.viewRevision },
      evidence: [...proofIds].map(id => evidence.get(id)!).filter(Boolean), reviewState: review(overlay, definition.id, 'flow', definition.id, fingerprint, flowDrift || sourceDefinitionChanged ? 'stale' : worst(detailNodes.map(node => node.status))), fingerprint, diagnostics: flowDiagnostics,
      limitations: unique([...sourceFlow.limitations, '解释与代码事实分层；没有运行时采集器，未验证关系保留原有可信边界。', ...(codeNodes.length > 80 ? [`代码画布仅显示80/${codeNodes.length}节点，完整映射仍保留。`] : [])]), reverseNodes, reverseEdges, changes: changeSet([...detailNodes, ...summaryNodes], [...detailEdges, ...summaryEdges], previous) });
  }
  return { metadata, flows: flowResults, diagnostics };
}

export function semanticBundle(projection: SemanticProjection, flowId?: string): SemanticBundle {
  const flow = flowId ? projection.flows.find(item => item.id === flowId) : projection.flows[0];
  if (flowId && !flow) return failure('语义流程不存在于当前 Scope 与版本', 404);
  return { metadata: projection.metadata, flows: projection.flows.map(item => ({ id: item.id, title: item.title, description: item.description, steps: item.detailNodes.length, groups: item.summaryNodes.length, reviewState: item.reviewState })), flow };
}
export function semanticReverse(projection: SemanticProjection, query: { nodeId?: string; edgeId?: string }): SemanticReverseResult {
  return { metadata: projection.metadata, matches: projection.flows.flatMap(flow => { const nodeIds = query.nodeId ? flow.reverseNodes[query.nodeId] ?? [] : [], edgeIds = query.edgeId ? flow.reverseEdges[query.edgeId] ?? [] : []; return nodeIds.length || edgeIds.length ? [{ flowId: flow.id, flowTitle: flow.title, nodeIds: unique(nodeIds), edgeIds: unique(edgeIds) }] : []; }) };
}
export function semanticReviewFingerprint(projection: SemanticProjection, flowId: string, targetType: SemanticReview['targetType'], targetId: string): string {
  const flow = projection.flows.find(item => item.id === flowId);
  const target = targetType === 'flow' ? flow?.id === targetId ? flow : undefined : targetType === 'node' ? [...(flow?.detailNodes ?? []), ...(flow?.summaryNodes ?? [])].find(item => item.id === targetId) : [...(flow?.detailEdges ?? []), ...(flow?.summaryEdges ?? [])].find(item => item.id === targetId);
  return target?.fingerprint ?? failure('语义复核目标不存在', 404);
}

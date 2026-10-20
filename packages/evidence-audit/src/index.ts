import { contentHash, type ArchitectureIndex, type Evidence } from '../../schema/src/index.ts';
import type { ArchitectureModel, ArchitectureProjection } from '../../architecture-model/src/types.ts';
import type { SemanticProjection } from '../../semantic-model/src/types.ts';

export interface AuditSourceFile { hash?: string; content?: string; error?: string }
export interface EvidenceAuditInput {
  index: ArchitectureIndex;
  architecture?: { model: ArchitectureModel; projection: ArchitectureProjection };
  semantic?: SemanticProjection;
  /** Only previously authorized, indexed relative paths; this function performs no I/O. */
  sourceFiles?: Record<string, AuditSourceFile>;
  serviceErrors?: { service: string; message: string }[];
  generatedAt?: string;
  limits?: { maxFindings?: number; maxItems?: number; maxGroupSamples?: number };
}
export interface AuditFinding {
  id: string; severity: 'error' | 'warning' | 'info'; reason: string;
  layer: 'code' | 'architecture' | 'semantic' | 'source'; targetId: string;
  message: string; action: string; rule?: string; flowId?: string; systemIds?: string[];
  evidenceIds?: string[];
}
export interface AuditGroup {
  id: string; label: string; findings: number; reasons: Record<string, number>;
  severities: Record<string, number>; sampleFindingIds: string[];
}
export interface EvidenceAuditReport {
  schemaVersion: '1.0.0'; generatedAt: string;
  snapshot: { projectId: string; worktreeId: string; scopeId: string; sourceRevision: string; analyzerVersion: string; sourceSchemaVersion: string; indexGeneratedAt: string; gitHead: string; gitStatusHash: string; architectureRevision?: string; modelRevision?: string; semanticRevision?: string; definitionRevision?: string; overlayRevision?: string; generatorVersion?: string };
  result: 'consistent' | 'gaps' | 'invalid' | 'incomplete';
  coverage: {
    available: { nodes: number; edges: number; evidence: number; files: number };
    checked: { nodes: number; edges: number; evidence: number; anchors: number; semanticNodes: number; semanticEdges: number; sourceFiles: number };
    rawRelations: { byKind: Record<string, number>; byConfidence: Record<string, number>; byKindAndConfidence: Record<string, Record<string, number>>; calls: Record<string, number>; byRule: Record<string, number>; dynamicDispatch: number; withLimitations: number };
    reviews: { ownership: Record<string, number>; entities: Record<string, number>; architectureFlows: Record<string, number>; semanticFlows: Record<string, number>; semanticNodes: Record<string, number>; semanticEdges: Record<string, number> };
    flowRelations: { architecture: Record<string, number>; semantic: Record<string, number> };
    evidence: { indexedHashValid: number; currentHashValid: number; rangeValid: number; sourceUnchecked: number };
    unclassifiedCodeNodes: number;
    systems: { id: string; name: string; codeNodes: number; relationsByKind: Record<string, number>; relationsByConfidence: Record<string, number> }[];
    flows: { id: string; name: string; steps: number; currentSteps: number; relationsByVerification: Record<string, number>; reviewState: string }[];
    sourceCheck: 'not-provided' | 'current-indexed-files';
    runtimeVerificationClaimedByAudit: false;
  };
  totals: { findings: number; bySeverity: Record<string, number>; byReason: Record<string, number> };
  groups: { rules: AuditGroup[]; systems: AuditGroup[]; flows: AuditGroup[] };
  findings: AuditFinding[];
  truncation: { findings: boolean; omittedFindings: number; checks: boolean; checkedItems: number; maxItems: number; groupSamples: boolean };
  limitations: string[];
}

const increment = (counts: Record<string, number>, key: string, n = 1) => { counts[key] = (counts[key] ?? 0) + n; };
const findingPriority = (item: AuditFinding) => ({ error: 1000, warning: 500, info: 0 }[item.severity])
  + (['candidate-ownership', 'candidate-explanation', 'unverified-order', 'disconnected-mapping', 'unknown-runtime-target'].includes(item.reason) ? 20 : item.reason === 'analysis-limitation' ? 0 : 10);
const bounded = (value: number | undefined, fallback: number, maximum: number) => {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new RangeError('审计预算必须为有限非负数');
  return Math.min(maximum, Math.floor(value ?? fallback));
};
const mappingReasons: Record<string, string> = { stale: 'stale-mapping', changed: 'stale-mapping', missing: 'missing-mapping', ambiguous: 'ambiguous-mapping', conflict: 'conflicting-mapping' };

/** Read-only accounting: human review and source-level proof never imply runtime execution. */
export function auditEvidence(input: EvidenceAuditInput): EvidenceAuditReport {
  const { index, architecture, semantic } = input;
  const maxFindings = bounded(input.limits?.maxFindings, 500, 10000);
  const maxItems = bounded(input.limits?.maxItems, 1000000, 5000000);
  const maxGroupSamples = bounded(input.limits?.maxGroupSamples, 8, 100);
  const report: EvidenceAuditReport = {
    schemaVersion: '1.0.0', generatedAt: input.generatedAt ?? new Date().toISOString(),
    snapshot: { projectId: index.metadata.projectId, worktreeId: index.metadata.worktreeId, scopeId: index.metadata.scopeId, sourceRevision: index.metadata.revision,
      analyzerVersion: index.metadata.analyzerVersion, sourceSchemaVersion: index.metadata.schemaVersion, indexGeneratedAt: index.metadata.generatedAt,
      gitHead: index.metadata.gitHead, gitStatusHash: index.metadata.gitStatusHash,
      architectureRevision: architecture?.projection.metadata.viewRevision, modelRevision: architecture?.projection.metadata.modelRevision,
      semanticRevision: semantic?.metadata.viewRevision, definitionRevision: semantic?.metadata.definitionRevision,
      overlayRevision: semantic?.metadata.overlayRevision, generatorVersion: semantic?.metadata.generatorVersion },
    result: 'consistent',
    coverage: {
      available: { nodes: index.nodes.length, edges: index.edges.length, evidence: index.evidence.length, files: index.files.length },
      checked: { nodes: 0, edges: 0, evidence: 0, anchors: 0, semanticNodes: 0, semanticEdges: 0, sourceFiles: 0 },
      rawRelations: { byKind: {}, byConfidence: {}, byKindAndConfidence: {}, calls: {}, byRule: {}, dynamicDispatch: 0, withLimitations: 0 },
      reviews: { ownership: {}, entities: {}, architectureFlows: {}, semanticFlows: {}, semanticNodes: {}, semanticEdges: {} },
      flowRelations: { architecture: {}, semantic: {} },
      evidence: { indexedHashValid: 0, currentHashValid: 0, rangeValid: 0, sourceUnchecked: 0 },
      unclassifiedCodeNodes: architecture?.projection.unclassifiedNodeIds.length ?? 0,
      systems: architecture?.model.systems.map(system => ({ id: system.id, name: system.name, codeNodes: 0, relationsByKind: {}, relationsByConfidence: {} })) ?? [],
      flows: semantic?.flows.map(flow => ({ id: flow.id, name: flow.title, steps: flow.detailNodes.length, currentSteps: flow.detailNodes.filter(node => node.status === 'current').length,
        relationsByVerification: {}, reviewState: flow.reviewState })) ?? [],
      sourceCheck: input.sourceFiles ? 'current-indexed-files' : 'not-provided', runtimeVerificationClaimedByAudit: false,
    },
    totals: { findings: 0, bySeverity: {}, byReason: {} }, groups: { rules: [], systems: [], flows: [] }, findings: [],
    truncation: { findings: false, omittedFindings: 0, checks: false, checkedItems: 0, maxItems, groupSamples: false },
    limitations: [
      '静态确认说明源码存在对应关系，不证明某次运行一定执行；人工确认仅适用于归属或解释。',
      'source-supported 表示源码局部顺序或锚点支持，条件、循环、异常及异步仍影响执行。',
      '请求、协议和叙述关系不作为已验证的跨请求执行顺序；不为图形连贯性补线。',
      '当前文件核验仅覆盖已有索引中的文件；不遍历目标目录发现新增文件，也不运行目标程序。',
      '当前文件逐个只读核验，文件系统不提供跨文件原子快照；请在索引同步且源码稳定时运行。系统计数可因多归属重叠。',
    ],
  };
  const nodeIds = new Set(index.nodes.map(node => node.id));
  const rawEdges = new Map(index.edges.map(edge => [edge.id, edge]));
  const files = new Map(index.files.map(file => [file.path, file]));
  const evidence = new Map(index.evidence.map(item => [item.id, item]));
  const sourceCache = new Map<string, { hash?: string; lines?: string[]; error?: string }>();
  const allEvidence = new Map(evidence);
  for (const item of architecture?.projection.evidence ?? []) allEvidence.set(item.id, item);
  for (const flow of semantic?.flows ?? []) for (const item of flow.evidence) allEvidence.set(item.id, item);
  const ruleGroups = new Map<string, AuditGroup>(), systemGroups = new Map<string, AuditGroup>(), flowGroups = new Map<string, AuditGroup>();
  const systemCoverage = new Map(report.coverage.systems.map(system => [system.id, system]));
  const flowCoverage = new Map(report.coverage.flows.map(flow => [flow.id, flow]));
  const systemLabels = new Map(architecture?.model.systems.map(system => [system.id, system.name]) ?? []);
  const flowLabels = new Map([...(architecture?.model.flows.map(flow => [flow.id, flow.name] as const) ?? []), ...(semantic?.flows.map(flow => [flow.id, flow.title] as const) ?? [])]);
  const systemIdsFor = (...ids: string[]) => [...new Set(ids.flatMap(id => architecture?.projection.ownership[id]?.map(owner => owner.systemId) ?? []))];
  function group(groups: Map<string, AuditGroup>, id: string, label: string, finding: AuditFinding) {
    let item = groups.get(id);
    if (!item) { item = { id, label, findings: 0, reasons: {}, severities: {}, sampleFindingIds: [] }; groups.set(id, item); }
    item.findings++; increment(item.reasons, finding.reason); increment(item.severities, finding.severity);
    if (item.sampleFindingIds.length < maxGroupSamples) item.sampleFindingIds.push(finding.id); else report.truncation.groupSamples = true;
  }
  function add(value: Omit<AuditFinding, 'id'>) {
    const item = { ...value, id: `audit:${contentHash([value.layer, value.targetId, value.reason, value.flowId ?? '', value.message].join('|')).slice(0, 24)}` };
    report.totals.findings++; increment(report.totals.byReason, item.reason); increment(report.totals.bySeverity, item.severity);
    if (report.findings.length < maxFindings) report.findings.push(item);
    else {
      report.truncation.findings = true; report.truncation.omittedFindings++;
      // Keep actionable errors ahead of abundant informational limitations.
      const replace = report.findings.findIndex(old => findingPriority(old) < findingPriority(item));
      if (replace >= 0) report.findings[replace] = item;
    }
    if (item.rule) group(ruleGroups, item.rule, item.rule, item);
    for (const id of item.systemIds ?? []) group(systemGroups, id, systemLabels.get(id) ?? id, item);
    if (item.flowId) group(flowGroups, item.flowId, flowLabels.get(item.flowId) ?? item.flowId, item);
  }
  function take() {
    if (report.truncation.checkedItems >= maxItems) { report.truncation.checks = true; return false; }
    report.truncation.checkedItems++; return true;
  }
  function source(relative: string) {
    if (!sourceCache.has(relative)) {
      const value = input.sourceFiles?.[relative];
      sourceCache.set(relative, value ? { hash: value.content !== undefined ? contentHash(value.content) : value.hash, lines: value.content?.split(/\r?\n/), error: value.error } : {});
    }
    return sourceCache.get(relative)!;
  }
  function refs(ids: string[], layer: AuditFinding['layer'], targetId: string, context: Partial<AuditFinding> = {}) {
    for (const id of ids) if (!(layer === 'code' ? evidence : allEvidence).has(id)) add({ layer, targetId, reason: 'missing-evidence', severity: 'error', message: `引用的证据不存在：${id}`, action: '重新索引并修正该映射，不能保留确认标记。', ...context, evidenceIds: [id] });
  }
  function mapping(status: string, layer: AuditFinding['layer'], targetId: string, context: Partial<AuditFinding> = {}) {
    const reason = mappingReasons[status]; if (reason) add({ layer, targetId, reason, severity: status === 'conflict' || status === 'missing' ? 'error' : 'warning', message: `映射状态为 ${status}。`, action: '核对当前声明、锚点和选择器，仅修复受影响映射；保留人工文字。', ...context });
  }
  function checkEvidence(item: Evidence, layer: AuditFinding['layer'], context: Partial<AuditFinding> = {}) {
    report.coverage.checked.evidence++;
    const indexed = files.get(item.filePath), current = source(item.filePath);
    if (!indexed) add({ layer, targetId: item.id, reason: 'evidence-outside-index', severity: 'error', message: `证据文件未被当前索引授权：${item.filePath}`, action: '移除越界证据或由用户明确调整扫描授权。', ...context });
    else if (indexed.hash !== item.fileHash) add({ layer, targetId: item.id, reason: 'evidence-hash-mismatch', severity: 'error', message: '证据哈希与当前索引文件哈希不同。', action: '等待增量索引完成后重新生成证据。', ...context });
    else report.coverage.evidence.indexedHashValid++;
    if (!Number.isInteger(item.startLine) || !Number.isInteger(item.endLine) || item.startLine < 1 || item.endLine < item.startLine || (current.lines && item.endLine > current.lines.length))
      add({ layer, targetId: item.id, reason: 'invalid-source-range', severity: 'error', message: '源码行范围无效或超过当前文件。', action: '修正解析器或锚点范围，不能继续定位旧行号。', ...context });
    else if (current.lines) report.coverage.evidence.rangeValid++;
    if (current.hash && !current.error && current.hash === item.fileHash) report.coverage.evidence.currentHashValid++; else report.coverage.evidence.sourceUnchecked++;
  }
  for (const item of input.serviceErrors ?? []) add({ layer: 'architecture', targetId: item.service, reason: 'service-unavailable', severity: 'error', message: `${item.service} 无法建立当前投影：${item.message}`, action: '先修复对应模型、锚点或快照错误；本报告不宣称该层通过。' });
  if (!input.sourceFiles) report.limitations.push('未提供当前授权源码，当前磁盘哈希、锚点内容及行范围尚未实读核验。');
  for (const file of index.files) {
    if (!take()) break;
    if (!input.sourceFiles) continue;
    report.coverage.checked.sourceFiles++;
    const current = source(file.path);
    if (!current.hash || current.error) add({ layer: 'source', targetId: file.path, reason: 'source-unavailable', severity: 'error', message: `当前授权源码未能读取：${current.error ?? '未提供此文件'}`, action: '确认文件仍存在且符合授权策略，再重新索引。' });
    else if (current.hash !== file.hash) add({ layer: 'source', targetId: file.path, reason: 'source-stale', severity: 'error', message: '当前源码与已保存索引快照不一致。', action: '先更新索引再复核解释；不要沿用旧的确认状态。' });
  }
  for (const item of index.evidence) { if (!take()) break; checkEvidence(item, 'code'); }
  for (const node of index.nodes) {
    if (!take()) break; report.coverage.checked.nodes++; refs(node.evidenceIds, 'code', node.id, { systemIds: systemIdsFor(node.id) });
    for (const id of systemIdsFor(node.id)) { const system = systemCoverage.get(id); if (system) system.codeNodes++; }
    if (node.parentId && !nodeIds.has(node.parentId)) add({ layer: 'code', targetId: node.id, reason: 'missing-node', severity: 'error', message: `父节点不存在：${node.parentId}`, action: '修正索引层级并重建缓存。' });
    if (node.filePath && !files.has(node.filePath)) add({ layer: 'code', targetId: node.id, reason: 'evidence-outside-index', severity: 'error', message: '代码节点的文件不属于当前索引。', action: '修正分析器输出与文件授权边界。' });
  }
  for (const edge of index.edges) {
    if (!take()) break; report.coverage.checked.edges++;
    const raw = report.coverage.rawRelations;
    increment(raw.byKind, edge.kind); increment(raw.byConfidence, edge.confidence); increment(raw.byRule, edge.rule);
    increment(raw.byKindAndConfidence[edge.kind] ??= {}, edge.confidence);
    if (edge.kind === 'calls') increment(raw.calls, edge.confidence);
    const context = { rule: edge.rule, systemIds: systemIdsFor(edge.source, edge.target), evidenceIds: edge.evidenceIds };
    for (const id of context.systemIds) { const system = systemCoverage.get(id); if (system) { increment(system.relationsByKind, edge.kind); increment(system.relationsByConfidence, edge.confidence); } }
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) add({ layer: 'code', targetId: edge.id, reason: 'missing-node', severity: 'error', message: '关系起点或终点不存在于当前索引。', action: '修复解析器悬空关系，不能在图中静默省略。', ...context });
    refs(edge.evidenceIds, 'code', edge.id, context);
    if (!edge.evidenceIds.length && edge.kind !== 'contains') add({ layer: 'code', targetId: edge.id, reason: 'missing-evidence', severity: 'error', message: '非结构性关系没有任何源码证据引用。', action: '补充解析器证据；在证据补齐前不得确认。', ...context });
    if (edge.confidence === 'inferred') add({ layer: 'code', targetId: edge.id, reason: 'inferred-relation', severity: 'info', message: '原始分析器保留为有据推断，未升级为静态或运行时确认。', action: '优先核验核心流程中的该关系；其余保留推断标签。', ...context });
    if (edge.kind === 'calls' && edge.dispatch && !['direct', 'static'].includes(edge.dispatch)) { raw.dynamicDispatch++; add({ layer: 'code', targetId: edge.id, reason: 'dynamic-dispatch', severity: 'info', message: `调用分发方式：${edge.dispatch}。`, action: '核对可能实现集合；静态绑定目标不等于运行时选中该实现。', ...context }); }
    if (edge.limitations?.length) { raw.withLimitations++; for (const limitation of edge.limitations) add({ layer: 'code', targetId: edge.id, reason: 'analysis-limitation', severity: 'info', message: limitation, action: '保留局限说明；需要新增解析规则或运行时证据时单独安排。', ...context }); }
  }
  if (architecture) {
    const { model, projection } = architecture;
    if (projection.metadata.scopeId !== index.metadata.scopeId || projection.metadata.sourceRevision !== index.metadata.revision || model.projectId !== index.metadata.projectId)
      add({ layer: 'architecture', targetId: 'snapshot', reason: 'snapshot-mismatch', severity: 'error', message: '架构模型或投影不属于当前项目/工作目录/源码快照。', action: '停止使用混合结果，重新构建当前 Scope 的投影。' });
    const anchorIds = new Set(model.anchors.map(anchor => anchor.id));
    const anchors = new Map(model.anchors.map(anchor => [anchor.id, anchor]));
    for (const item of projection.evidence) { if (!take()) break; if (!evidence.has(item.id)) checkEvidence(item, 'architecture'); }
    for (const anchor of model.anchors) {
      if (!take()) break; report.coverage.checked.anchors++;
      const indexed = files.get(anchor.filePath), current = source(anchor.filePath);
      if (!indexed || indexed.hash !== anchor.expectedFileHash || current.hash && current.hash !== anchor.expectedFileHash)
        add({ layer: 'architecture', targetId: anchor.id, reason: 'anchor-stale', severity: 'warning', message: '人工定义的源码锚点不匹配当前索引或当前文件哈希。', action: '核对原意后迁移完整行锚点，不能只替换哈希。' });
      else if (current.lines && current.lines.slice(anchor.startLine - 1, anchor.endLine).join('\n') !== anchor.quote.replaceAll('\r\n', '\n'))
        add({ layer: 'architecture', targetId: anchor.id, reason: 'anchor-quote-mismatch', severity: 'error', message: '锚点 quote 与当前源码完整行不匹配。', action: '核对行范围和原意后修复锚点。' });
    }
    const entities = new Set(projection.entities.map(entity => entity.nodeId));
    for (const item of [...model.systems, ...model.modules, ...model.memberships, ...model.flows.flatMap(flow => [...flow.steps, ...flow.transitions])]) {
      if (!take()) break;
      for (const id of item.anchorIds) if (!anchorIds.has(id)) add({ layer: 'architecture', targetId: item.id, reason: 'anchor-missing', severity: 'error', message: `模型定义引用不存在的源码锚点：${id}`, action: '恢复或替换经核验的完整行锚点。' });
    }
    for (const item of [...projection.memberships, ...projection.entities]) {
      if (!take()) break;
      const membership = 'selector' in item;
      increment(membership ? report.coverage.reviews.ownership : report.coverage.reviews.entities, item.reviewState);
      const systemIds = membership ? [item.systemId] : item.entityKind === 'system' ? [item.id] : item.systemId ? [item.systemId] : [];
      const context = { systemIds };
      mapping(item.resolution, 'architecture', item.id, context); refs(item.evidenceIds, 'architecture', item.id, context);
      if (item.reviewState === 'pending' || item.reviewState === 'needs-review') add({ layer: 'architecture', targetId: item.id, reason: 'candidate-ownership', severity: 'info', message: '业务归属或职责尚未人工确认；这不表示底层静态调用未验证。', action: '先核对职责和归属边界，仅对存在业务歧义的部分请求人工裁定。', ...context });
      if (membership) for (const id of item.nodeIds) if (!nodeIds.has(id)) add({ layer: 'architecture', targetId: item.id, reason: 'missing-node', severity: 'error', message: `归属引用不存在的代码节点：${id}`, action: '重新解析选择器及代码归属。', ...context });
    }
    for (const relation of [...projection.relations, ...projection.technicalRelations]) {
      if (!take()) break;
      if (![relation.source, relation.target].every(id => entities.has(id) || nodeIds.has(id))) add({ layer: 'architecture', targetId: relation.id, reason: 'missing-node', severity: 'error', message: '聚合关系端点不存在。', action: '重新计算系统/模块聚合关系。' });
      refs(relation.evidenceIds, 'architecture', relation.id);
      for (const id of relation.memberEdgeIds) if (!rawEdges.has(id)) add({ layer: 'architecture', targetId: relation.id, reason: 'missing-edge', severity: 'error', message: `聚合引用不存在的原始关系：${id}`, action: '重新计算聚合，不得保留旧连线。' });
    }
    for (const flow of projection.flows) {
      increment(report.coverage.reviews.architectureFlows, flow.reviewState);
      const steps = new Set(flow.steps.map(step => step.id));
      const stepById = new Map(flow.steps.map(step => [step.id, step]));
      for (const step of flow.steps) {
        if (!take()) break; mapping(step.resolution, 'architecture', step.id, { flowId: flow.id }); refs(step.evidenceIds, 'architecture', step.id, { flowId: flow.id });
        for (const id of step.nodeIds) if (!nodeIds.has(id)) add({ layer: 'architecture', targetId: step.id, flowId: flow.id, reason: 'missing-node', severity: 'error', message: `流程步骤引用不存在的代码实体：${id}`, action: '修复流程选择器和代码映射。' });
        for (const id of step.anchorIds) if (!anchorIds.has(id)) add({ layer: 'architecture', targetId: step.id, flowId: flow.id, reason: 'anchor-missing', severity: 'error', message: `流程锚点不存在：${id}`, action: '恢复或替换经核验的源码锚点。' });
      }
      for (const transition of flow.transitions) {
        if (!take()) break; increment(report.coverage.flowRelations.architecture, `${transition.basis}:${transition.verification}`);
        const context = { flowId: flow.id, systemIds: flow.systemIds, evidenceIds: transition.evidenceIds };
        if (!steps.has(transition.source) || !steps.has(transition.target)) add({ layer: 'architecture', targetId: transition.id, reason: 'missing-node', severity: 'error', message: '流程关系端点不存在。', action: '修复流程定义，不能跳过缺失步骤。', ...context });
        refs(transition.evidenceIds, 'architecture', transition.id, context);
        for (const id of transition.memberEdgeIds) if (!rawEdges.has(id)) add({ layer: 'architecture', targetId: transition.id, reason: 'missing-edge', severity: 'error', message: `流程引用不存在的关系：${id}`, action: '重新构建该流程的底层映射。', ...context });
        if (transition.verification === 'unverified') add({ layer: 'architecture', targetId: transition.id, reason: 'unverified-order', severity: 'info', message: `${transition.basis} 关系未证明运行顺序。${transition.limitations.join(' ')}`, action: '保留请求/协议/叙述边界；只能用源码路径或运行时证据补强。', ...context });
        else if (transition.verification === 'source-supported') add({ layer: 'architecture', targetId: transition.id, reason: 'source-supported-order', severity: 'info', message: '同一过程的源码顺序受到支持；条件等执行边界仍然保留。', action: '结合分支、循环及提前返回阅读，不作为无条件运行链。', ...context });
        const from = stepById.get(transition.source), to = stepById.get(transition.target);
        const endpointsMatch = transition.memberEdgeIds.some(id => { const edge = rawEdges.get(id); return edge && from?.nodeIds.includes(edge.source) && to?.nodeIds.includes(edge.target); });
        if (transition.verification === 'static-confirmed' && (transition.basis !== 'static-call' || !endpointsMatch || transition.memberEdgeIds.some(id => rawEdges.get(id)?.kind !== 'calls' || rawEdges.get(id)?.confidence !== 'static-confirmed')))
          add({ layer: 'architecture', targetId: transition.id, reason: 'invalid-proof', severity: 'error', message: '静态调用确认缺少对应静态 calls 依据。', action: '修正投影规则，降低状态并补齐真实直接调用证据。', ...context });
        if (transition.verification === 'source-supported') {
          const before = transition.anchorIds.filter(id => from?.anchorIds.includes(id)).map(id => anchors.get(id)).filter(item => !!item);
          const after = transition.anchorIds.filter(id => to?.anchorIds.includes(id)).map(id => anchors.get(id)).filter(item => !!item);
          const localOrder = transition.basis === 'source-order' && from?.nodeIds.some(id => to?.nodeIds.includes(id) && index.nodes.some(node => node.id === id && ['method', 'function'].includes(node.kind) && before.some(a => after.some(b => a.filePath === b.filePath && a.endLine < b.startLine && node.evidenceIds.some(evidenceId => { const proof = evidence.get(evidenceId); return proof && proof.filePath === a.filePath && proof.startLine <= a.startLine && proof.endLine >= b.endLine; })))));
          if (!localOrder) add({ layer: 'architecture', targetId: transition.id, reason: 'invalid-proof', severity: 'error', message: '源码顺序缺少同一真实过程内前后完整锚点的支持。', action: '核对源码声明范围、锚点先后及分支边界，降低无法证明的顺序。', ...context });
        }
      }
    }
  }
  if (semantic) {
    if (semantic.metadata.scopeId !== index.metadata.scopeId || semantic.metadata.sourceRevision !== index.metadata.revision || semantic.metadata.projectId !== index.metadata.projectId || architecture && semantic.metadata.architectureRevision !== architecture.projection.metadata.modelRevision)
      add({ layer: 'semantic', targetId: 'snapshot', reason: 'snapshot-mismatch', severity: 'error', message: '解释图与代码图不属于同一有效源码快照。', action: '重新生成当前 Scope 的解释投影。' });
    for (const flow of semantic.flows) {
      increment(report.coverage.reviews.semanticFlows, flow.reviewState);
      const semanticNodes = new Set([...flow.summaryNodes, ...flow.detailNodes].map(node => node.id));
      for (const item of flow.evidence) { if (!take()) break; if (!evidence.has(item.id)) checkEvidence(item, 'semantic', { flowId: flow.id }); }
      for (const node of [...flow.summaryNodes, ...flow.detailNodes]) {
        if (!take()) break; report.coverage.checked.semanticNodes++; increment(report.coverage.reviews.semanticNodes, node.reviewState);
        const context = { flowId: flow.id, systemIds: systemIdsFor(...node.codeNodeIds), evidenceIds: node.evidenceIds };
        mapping(node.status, 'semantic', node.id, context); refs(node.evidenceIds, 'semantic', node.id, context);
        if (node.reviewState === 'pending' || node.reviewState === 'needs-review') add({ layer: 'semantic', targetId: node.id, reason: 'candidate-explanation', severity: 'info', message: '解释文字/步骤分组尚未人工确认，与代码事实的验证状态相互独立。', action: '结合源码复核中文语义，避免为了消除标签自动确认。', ...context });
        for (const id of [...node.codeNodeIds, ...node.contextNodeIds]) if (!nodeIds.has(id)) add({ layer: 'semantic', targetId: node.id, reason: 'missing-node', severity: 'error', message: `解释引用不存在的代码实体：${id}`, action: '重新解析该解释步骤的实现绑定。', ...context });
        if (!node.codeNodeIds.length) add({ layer: 'semantic', targetId: node.id, reason: 'missing-mapping', severity: 'error', message: '解释步骤没有真实实现代码映射。', action: '补充经证据核验的实现绑定或保留为失效解释。', ...context });
        for (const binding of node.bindings) { mapping(binding.status, 'semantic', binding.id, context); refs(binding.evidenceIds, 'semantic', binding.id, context); }
        if (node.fragments.length > 1) add({ layer: 'semantic', targetId: node.id, reason: 'disconnected-mapping', severity: 'info', message: '该解释包含多个不相连的实现片段，未把它们拼成执行链。', action: '分别核对片段及证据；必要时拆分解释或人工确认分组。', ...context });
        for (const id of node.childIds) if (!semanticNodes.has(id)) add({ layer: 'semantic', targetId: node.id, reason: 'missing-node', severity: 'error', message: `详细子步骤不存在：${id}`, action: '修复简洁/详细层映射。', ...context });
      }
      for (const edge of [...flow.summaryEdges, ...flow.detailEdges]) {
        if (!take()) break; report.coverage.checked.semanticEdges++; increment(report.coverage.reviews.semanticEdges, edge.reviewState); increment(report.coverage.flowRelations.semantic, edge.verification);
        if (edge.level === 'detail') increment(flowCoverage.get(flow.id)!.relationsByVerification, edge.verification);
        const context = { flowId: flow.id, evidenceIds: edge.evidenceIds };
        mapping(edge.status, 'semantic', edge.id, context); refs(edge.evidenceIds, 'semantic', edge.id, context);
        if (!semanticNodes.has(edge.source) || !semanticNodes.has(edge.target)) add({ layer: 'semantic', targetId: edge.id, reason: 'missing-node', severity: 'error', message: '解释关系端点不存在。', action: '修复解释层映射。', ...context });
        for (const id of edge.codeEdgeIds) if (!rawEdges.has(id)) add({ layer: 'semantic', targetId: edge.id, reason: 'missing-edge', severity: 'error', message: `解释边引用不存在的代码关系：${id}`, action: '让受影响解释边失效，重新核验后恢复。', ...context });
        if (edge.verification === 'unverified') add({ layer: 'semantic', targetId: edge.id, reason: 'unverified-order', severity: 'info', message: `解释边未证明运行顺序；关系类型为 ${edge.kinds.join('、')}。${edge.boundaries.join(' ')}`, action: '保留未验证边界；不能把普通依赖或协议对应升级为执行顺序。', ...context });
        for (const path of edge.paths) {
          const facts = path.edgeIds.map(id => rawEdges.get(id));
          if (facts.some(fact => !fact) || path.nodeIds.some(id => !nodeIds.has(id))) add({ layer: 'semantic', targetId: edge.id, reason: 'invalid-path', severity: 'error', message: '语义路径或事实集合引用不存在的代码节点/关系。', action: '让失效路径退出确认状态并重新计算。', ...context });
          const continuous = path.nodeIds.length === path.edgeIds.length + 1 && facts.every((fact, i) => fact && fact.source === path.nodeIds[i] && fact.target === path.nodeIds[i + 1]);
          if (path.kind === 'call-path' && (!continuous || facts.some(fact => fact?.kind !== 'calls'))) add({ layer: 'semantic', targetId: edge.id, reason: 'invalid-path', severity: 'error', message: '声明的调用路径不是连续、同方向的真实 calls 链。', action: '删除伪连接，按实际调用重新计算路径。', ...context });
          if (path.verification === 'static-confirmed' && facts.some(fact => !fact || fact.confidence !== 'static-confirmed')) add({ layer: 'semantic', targetId: edge.id, reason: 'invalid-proof', severity: 'error', message: '路径确认状态高于底层关系证据。', action: '降低确认状态并保留动态/推断限制。', ...context });
        }
        if (edge.verification === 'static-confirmed' && (!edge.codeEdgeIds.length || edge.codeEdgeIds.some(id => rawEdges.get(id)?.confidence !== 'static-confirmed')))
          add({ layer: 'semantic', targetId: edge.id, reason: 'invalid-proof', severity: 'error', message: '解释边的静态确认缺少一致的底层事实。', action: '重新计算解释边可信度，不以人工确认替代证据。', ...context });
      }
    }
  }
  for (const diagnostic of [...index.diagnostics, ...(architecture?.projection.diagnostics ?? []), ...(semantic?.diagnostics ?? [])]) {
    if (!take()) break;
    const runtimeTarget = diagnostic.code === 'CS_DELEGATE_TARGETS' || diagnostic.code === 'PY_DYNAMIC_CALLBACKS';
    add({ layer: 'code', targetId: diagnostic.id, rule: diagnostic.code, reason: runtimeTarget ? 'unknown-runtime-target' : 'diagnostic', severity: diagnostic.severity, message: diagnostic.message,
      action: runtimeTarget ? '调用点/回调参数传递可以已知，实际处理器集合仍未知；保留 references/passes，不伪造 calls。' : '按诊断原因补充解析能力或保留已知限制。' });
  }
  const sort = (groups: Map<string, AuditGroup>) => [...groups.values()].sort((a, b) => b.findings - a.findings || a.id.localeCompare(b.id));
  report.groups = { rules: sort(ruleGroups), systems: sort(systemGroups), flows: sort(flowGroups) };
  report.findings.sort((a, b) => findingPriority(b) - findingPriority(a) || a.id.localeCompare(b.id));
  if (report.truncation.checks) report.limitations.push('审计检查达到显式项目预算，未覆盖部分不可视为通过；可增大 --max-items 后重跑。');
  report.result = report.truncation.checks ? 'incomplete' : report.totals.bySeverity.error ? 'invalid' : report.totals.findings ? 'gaps' : 'consistent';
  return report;
}

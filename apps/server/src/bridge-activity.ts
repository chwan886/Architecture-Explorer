/** Deliberately small public summaries, not tool inputs, source text or model reasoning. */
const queryTitles: Readonly<Record<string, string>> = {
  search_architecture: '搜索架构实体',
  get_node_details: '核对节点详情',
  get_related_graph: '查询代码关系',
  get_call_paths: '追踪静态调用路径',
  get_flow: '读取业务流程',
  get_source_evidence: '核对源码证据',
  semantic_reverse: '定位关联解释步骤',
};

export const QUERY_ACTIVITY_LIMIT = 40;
export const queryActivityTitle = (operation: string): string | undefined => Object.hasOwn(queryTitles, operation) ? queryTitles[operation] : undefined;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number | undefined => Array.isArray(value) ? value.length : undefined;
const bounded = (value: number): string => value > 10_000 ? '10,000+' : String(value);
const counted = (value: unknown, label: string): string | undefined => { const amount = count(value); return amount === undefined ? undefined : `${bounded(amount)} ${label}`; };

export function queryActivityCompleted(operation: string, result: unknown): string {
  const value = record(result), graph = record(value.graph), bundle = record(value.bundle), flow = record(bundle.flow);
  let summary: string | undefined;
  if (operation === 'search_architecture') summary = counted(value.matches, '项匹配');
  else if (operation === 'get_related_graph') {
    const nodes = counted(graph.nodes, '个节点'), edges = counted(graph.edges, '条关系');
    if (nodes && edges) summary = `${nodes}、${edges}`;
  } else if (operation === 'get_call_paths') summary = counted(value.paths, '条静态可达路径（不证明运行顺序）');
  else if (operation === 'get_flow') {
    const steps = counted(flow.detailNodes, '个详细步骤');
    summary = steps ?? counted(bundle.flows, '条可用流程');
  } else if (operation === 'semantic_reverse') summary = counted(value.matches, '个流程映射');
  else if (operation === 'get_node_details') summary = '当前快照中的节点详情';
  else if (operation === 'get_source_evidence') summary = '1 处经过索引核对的源码证据';
  const truncated = value.truncated === true || graph.truncated === true ? '（结果已按预算截断）' : '';
  return `${summary ? `已读取 ${summary}` : '查询已完成'}${truncated}；尚不代表网页已呈现。`;
}

export function queryActivityFailed(error: unknown): string {
  // Never surface arbitrary exception messages: they can contain arguments, paths or credentials.
  const code = record(error).code;
  if (code === 'STALE_SNAPSHOT') return '源码或分析快照已失效；请重新开始分析，未改变网页呈现。';
  if (code === 'UNKNOWN_REFERENCE' || code === 'UNKNOWN_FLOW' || code === 'UNKNOWN_EVIDENCE') return '当前快照中未找到请求的实体或证据；未改变网页呈现。';
  return '查询未完成；未改变网页呈现。';
}

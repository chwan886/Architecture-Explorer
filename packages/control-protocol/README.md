# 本地查询与展示协议

[简体中文](README.md) | [English](README.en.md)

公共类型由 `src/types.ts` 定义。`presentation.schema.json` 严格限制未知字段、引用格式、文字长度、数组和载荷预算；`src/index.ts` 导出 `presentationSchema`、`entityRefSchema`、`validatePresentation`、`validateEntityRef` 和带 `code/statusCode` 的 `controlError`。

`AnalysisPresentation` 只表达展示意图，不是新的分析事实。`semantic` 引用必须带 `flowId`；引用究竟是节点还是边由字段语境决定，并由服务端查询真实快照验证。业务实体逻辑 ID 保留在原意图内，`ResolvedPresentation.highlights.architecture*` 转为实际画布 ID。

`BridgeQueryService` 位于 `apps/server/src/bridge-query.ts`，复用现有 `IndexManager`、`ArchitectureService` 与 `SemanticService`，不扫描或修改目标。`begin_analysis` 返回十分钟、当前版本有效的句柄；最多保留十六句柄，并共享事实索引与查找表。源码索引、架构/语义定义、授权配置或 TTL 变化即报 `STALE_SNAPSHOT`。没有历史源码回放，也不以当前源码替代旧快照。

模式支持：`code` 目标仅 `viewMode=code`；`systems` 和 `technical` 仅 `explanation`；已有 `flow` 支持三种模式。流程中隐藏画布的显式引用会被拒绝，模式切换应由工具层在同一快照内先完成全部对应映射。简单粒度允许真实详细节点引用，由前端局部展开父组。

代码目标支持没有预定义流程的真实代码链。明确端点、原始关系及注册路径必须全部呈现，超过八十节点或二百条明确关系报 `PRESENTATION_TOO_LARGE`；有限邻域截断会明确提示。系统/技术目标无法在一个真实层级同时呈现的引用会被拒绝。流程引用必须属于该流程映射。

`get_call_paths` 仅遍历原始有向 `calls`，最多四跳、二百访问；服务器注册的 `pathId` 只在所属快照内有效。路径证明静态符号可达，不证明某次运行时调用栈、路径条件可满足性或完整数据流。`reading-order` 仅为阅读顺序。协议、推断、动态分发及解释文字不会被升级为执行事实。

验证：`node --import tsx --test tests/bridge-query.test.ts`。

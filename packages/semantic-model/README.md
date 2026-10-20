# 语义解释纯投影

`src/types.ts` 是公共接口。`definitions.schema.json` 与 `overlay.schema.json` 独立严格校验持久定义和工作区覆盖；引擎没有文件、网络、Git 或目标程序执行能力。

- `validateDefinitions` / `validateOverlay`：校验 Schema、唯一身份、摘要分组完整覆盖、绑定来源、相对路径与历史时间。
- `semanticRevision`：定义/覆盖的稳定 JSON 指纹。
- `declarationHash(index,nodeId,sourceTexts)`：根据分析器声明证据截取精确 UTF-16 范围，归一化 CRLF 后计算哈希。源码必须匹配当前索引；没有当前源码或存在多个声明时返回 `undefined`。
- `buildSemanticProjection(index,architecture,definitions,overlay,{sourceTexts,previous})`：构造解释节点、原始事实映射、逐跳调用路径和摘要聚合。
- `semanticBundle` / `semanticReverse` / `semanticReviewFingerprint`：当前流程、代码反向映射和局部复核依据。

绑定只选择明确的主声明，不自动吸收参数、字段或所有子回调。`implementation` 与 `context` 分开，一份源码可对应多个解释步骤。歧义和失效会保留文字并标记待复核。

局部复核指纹包含解释定义、绑定声明文本、相关引文和关系事实，不包含全局源码版本、文件整体哈希或绝对行号。未变的相邻方法可保留确认；绑定方法变化则失效。原锚点文件哈希过期后，仅当完整引文在当前源码中唯一出现且落在匹配声明内时重新举证；不修改原模型锚点。

调用路径逐跳使用真实有向 `calls` 边，并保留原始置信度、分发与分析限制。仅原 `static-call` 转换可获调用确认；协议、跨请求和人工叙述不会因文字编辑或人工确认升级。源码位置仅支持位置叙述，不证明运行时顺序。间接路径最多四跳、访问二百条调用边，达到预算明确提示。

摘要线只汇总存在的详细关系，组内关系和控制边界通过数量说明保留。`codeNodes` / `codeEdges` 保留全部映射事实，`codeGraph` 最多渲染八十节点并标记截断。原事实索引不被修改。

源流程新增、删除或改变时，未覆盖步骤/转换明确警告；完整源流程结构进入整体指纹。`previous` 用于变化集合和已删除转换诊断。没有上次快照时，持久复核仍由当前整体指纹检测变化；引擎不会猜测删除前的结构。

验证：`node --import tsx --test tests/semantic-model.test.ts`。

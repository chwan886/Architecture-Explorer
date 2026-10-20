# 多粒度双层图实施契约

基线258f4a0；只写Architecture Explorer工作树，GameDemo02只读。共用接口唯一来源packages/semantic-model/src/types.ts，由主控维护。原事实Schema与业务模型不变，不将语义节点加入ArchitectureIndex。

## 纯引擎（Agent A）

packages/semantic-model/src/index.ts exports：validateDefinitions(value)、validateOverlay(value)、semanticRevision(value)、buildSemanticProjection(index,architectureModel,definitions,overlay,options?)、semanticBundle(projection,flowId?)、semanticReverse(projection,{nodeId?,edgeId?})、semanticReviewFingerprint(projection,flowId,targetType,targetId)、declarationHash(index,nodeId,sourceTexts)。validate函数为asserts；options.sourceTexts来自服务器当前授权文件，engine本身无IO。

定义持久化使用sourceStepId/selector精确解析主实现，不自动扩展方法所有子实体。一个step可有多bindings，一个codeNode可属多个step。上下文另列。groups.childIds覆盖所有detail steps且唯一；sourceStepIds对source flow步骤明确引用。default adapter不能补造执行边。group聚合只来自detail边，内部边及控制边界保留计数与说明，不因折叠补线。

候选定义缺失时可以空投影，不虚构流程。每个project只有明确seed两流程。sourceTexts用于按当前AST声明范围计算局部方法hash（CRLF归一化、不含行号）；binding.expectedDeclarationHash不符即stale，未修改的邻接方法不得因此失效。review绑定当前fingerprint；无关全局sourceRevision变化不应清空确认。原anchor hash变更时仅允许完整quote精确唯一且位于匹配方法声明内的局部重新验证，标记说明并生成当前Scope的新Evidence，不修改原anchor、不据名称猜测重新绑定。没有唯一过程/证据则待复核。root负责source读取白名单及hash。

static调用按原calls保留confidence/dispatch限制；路径必须逐跳连续有向；依赖/读写/协议不是调用或已证实顺序。原22段unverified不能被文字/人工确认升级。自动间接路径预算≤4跳/200访问，超预算明确截断。codeNodes/codeEdges完整映射事实，codeGraph渲染预算80并明确truncated。reverseNodes/Edges返回detail IDs/edge IDs，包含一对多。候选/人工确认与底层证据可信度独立。changes与previous比较局部fingerprint。无runtime collector。

## 内容与存储（Agent C）

architecture/semantics/game-demo-02/definitions.json：两现有flows，5–7个summary groups+35个detail steps；语义中文text字段及有证据的controls。复用已有flow sourceStepIds/anchorIds；bindings要expectedDeclarationHash，调用A.declarationHash或同等按声明文本计算。所有初始origin=curated，reviews为空，不能冒称AI生成或人工确认。

apps/server/src/semantic-store.ts exports SemanticStore(config)；read(projectId,scopeId):Promise<SemanticDefinitionEnvelope>、save(projectId,scopeId,expectedOverlayRevision,transform:(overlay)=>overlay):Promise<SemanticDefinitionEnvelope>。工具内definitions固定项目路径，scope覆盖文件architecture/semantics/<projectId>/worktrees/<worktreeId>.json。read无文件返回空定义/overlay，不能向game写入。严格schema、project/scope检查、拒绝路径/junction、单文件审计history、wx锁+乐观revision+原子rename。history最多100；写入会验证definitions及overlay；引用有效性/当前证据由主控service调用engine检查。源更新不会覆盖人工flowOverrides。

packages/semantic-content/**提供编辑纯函数、merge/split groups（保留全部detail与边界）及局部规则解释候选生成；UI首批编辑表单不依赖外部API。规则生成必须origin=rule-generated，不声称AI。未配置AI时不显示假生成按钮。

## API（主控）

全部/api/semantics要求授权scope，metadata携相同source/architecture/definition/overlay/view版本；支持viewRevision参数不符409。GET /api/semantics ->SemanticBundle(flowId可选默认首流程)；GET /api/semantics/model ->SemanticDefinitionEnvelope；GET /api/semantics/reverse?nodeId=&edgeId= ->SemanticReverseResult；GET /api/semantics/evidence/:id ->兼容EvidenceContent（ID与sourceRevision必须核对）。generate返回SemanticCandidate {metadata,flow,generatorVersion,origin:'rule-generated'}，不保存。

PUT /api/semantics/model body {expectedOverlayRevision,viewRevision,flow:SemanticFlowDefinition}：仅替换当前scope一个flowOverride并写history，返回envelope。POST /api/semantics/review body {expectedOverlayRevision,viewRevision,flowId,targetType:'flow'|'node'|'edge',targetId,decision:'confirmed'|'rejected'|'pending'} ->envelope。POST /api/semantics/rebuild body {flowId,viewRevision} ->SemanticBundle，仅局部重算/重新核验，不改人工文字。POST /api/semantics/generate body {flowId,nodeId?,viewRevision} ->候选definition envelope（不自动保存；只规则生成，先展示预览人工采用）。主控SSE事件semantic-model携scopeId,overlayRevision。原API不变。

## UI（Agent B）

apps/web/src/semantics/SemanticWorkspace.tsx default props {scope,revision?,location?:SemanticLocation,onLocationChange?:(location)=>void,onOpenCode:(OpenCodeRequest)=>void}。root在现有业务流程入口接入，旧FlowBoard保留legacy入口。semantic.css只由main统一import，组件不importCSS以支持DOM测试。

同一bundle两画布共享选择、source、history、筛选与展开状态。切换mode/level不得丢失焦点。一对多全部高亮；部分被预算/筛选隐藏时列明且可定位。GraphCanvas可选highlightedNodeIds/EdgeIds、focusRequest（可扩展batch）；旧selectedId行为不变。SemanticCanvas单独画语义节点，不伪装为代码节点。Inspector统一显示目的/处理/输入输出/变化/下游依据/实现；边显示实际含义+逐跳路径证据。source响应必须id/revision吻合，否则清旧source。快速选择、重复点击、返回、scope变更和409全部guard。

人工维护提供文本字段编辑、分组合并/拆分（选择已有detail IDs）、确认/拒绝/撤回；保存冲突保留草稿，重新载入真实GET。source/boundary/不相连片段解释明显可见；summary默认5–7卡，detail仅展开选择组。对照宽窗左右、窄窗上下/可折叠Inspector，独立缩放与共享定位。

## 文件边界

A：semantic-model除types、tests/semantic-model.test.ts。B：web/src/semantics、GraphCanvas及B自有新test。C：architecture/semantics、semantic-content、server/semantic-store.ts、tests/semantic-content.test.ts。主控：types、App/main/server routes、package/lock、集成测试、使用文档和最终QA。不可并行改共享入口；不自行build替换主控QA chunks。

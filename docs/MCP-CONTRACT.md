# 本地 MCP 联动实施契约（基线60f560b）

GameDemo02严格只读。用户级Codex配置不修改。类型唯一来源packages/control-protocol/src/types.ts由主控维护。原分析Schema不改，不重新索引、不重写网站。独立文件边界作为并行隔离，所有Agent共享同一工作树。

## Agent A：协议校验和统一查询

拥有packages/control-protocol除types、apps/server/src/bridge-query.ts、tests/bridge-query.test.ts。exports validatePresentation(value):asserts AnalysisPresentation，controlError(code,message,statusCode=400)，错误含code/statusCode。严格unknown字段、长度/预算、Ref kind由工具语境node/edge决定，semantic必须flowId。当前快照而非历史回放；索引/模型/语义revision变动、配置收窄或TTL失效报STALE_SNAPSHOT。每请求捕获同一index对象并在所有async前后检查，不用旧snapshot调用捕获latest的manager.evidence。

BridgeQueryService(manager,architectureService,semanticService) implements QueryService，dispatch(operation,args)和resolve(presentation)。支持get_capabilities、list_projects、list_worktrees{projectId}、begin_analysis{projectId,worktreeId}、search_architecture{snapshotId,query,limit?}、get_node_details{snapshotId,ref}、get_related_graph{snapshotId,nodeId,view:'calls'|'data'|'impact'|'structure',direction?,depth?,limit?,kinds?}、get_call_paths{snapshotId,sourceNodeId,targetNodeId,maxDepth?,limit?}、get_flow{snapshotId,flowId?}、get_source_evidence{snapshotId,evidenceId}、semantic_reverse{snapshotId,nodeId?,edgeId?}。返回结果统一metadata:SnapshotDescriptor；begin_analysis直接descriptor；get_flow返回{metadata,bundle:SemanticBundle}；related返回{metadata,graph};details返回{metadata,detail};search返回{metadata,matches:[{ref,label,kind,summary?,evidenceIds}],truncated};paths返回{metadata,paths:[{id,nodeIds,edgeIds,verification,limitations}],truncated}。list_projects返回{projects}，list_worktrees返回{worktrees}。实际源码规则复用，最大4hop/200visits；path ID由服务器创建并在snapshot注册，不能把BFS或聚合线当call path。

resolve验证整个presentation所有refs/evidence/orderedSteps。保留原ID，业务logical id与graph nodeId明确转换；semantic需flowId。code target仅接受code focus/highlights；flow target需已有semantic flow，code必须在flow映射内，未支持模式明确拒绝。systems/technical用现有architectureView，拒绝不可呈现的隐藏引用而非静默略过。Resolved payload所有图属于一个SnapshotDescriptor；code graph包含明确请求端点、原始边、有限邻域，总节点≤80，超预算报PRESENTATION_TOO_LARGE。解释文字不冒充验证事实，reading-order仅阅读顺序。动态未解析调用只在warnings标记，不补边。额外warnings由服务器添加不能靠调用方清除。初始快照TTL10分钟，最多16handles共享index引用，过期即拒绝，不保存历史源码。

## Agent C：服务端本机broker、身份与会话

拥有apps/server/src/bridge-control.ts及可拆auth/store辅助、tests/bridge-control.test.ts。export async registerBridgeRoutes(app,manager,query:QueryService) returns broker；仅新增route和hooks，不改server.ts（根接入）。私有路由统一/api/bridge/private/*，根仅为这条路径豁免“必须有网站Origin”，仍保留Host和恶意Origin拒绝；每条私有route必须先校验独立Bearer令牌，不能信任伪造Origin。runtime固定config.cacheDir/bridge/runtime.json（BridgeRuntime），限定工具目录、拒绝links/junction、当前Windows用户+SYSTEM ACL（原生固定参数，不Shell）。监听成功后写runtime，避免失败第二实例覆盖在跑服务凭据；app.inject测试可显式broker.publishRuntime或等价fixture。onClose清理本实例runtime，不能删后来实例。公有hello GET /api/bridge/hello?nonce=64hex -> {serverEpoch,proof:HMAC-SHA256(token,nonce+'|'+serverEpoch)}，sidecar先验服务身份再发token。

私有接口 POST /api/bridge/private/query {operation,arguments}调用query.dispatch；POST /api/bridge/private/control {operation,arguments} 支持list_view_sessions、attach_view_session{sessionId}、submit(ControlSubmit)、status{commandId}、clear{bindingId,expectedUserRevision,expectedControlRevision,commandId?}。attach返回{bindingId,session:ViewSession}；list返回{sessions}；submit/status/clear返回PresentationReceipt。无session可保存离线pending最近一条，返回pending+openUrl（纯loopback URL，不执行启动Shell）。多session未显式binding时返回AMBIGUOUS_SESSION。每绑定目标会话lease，stale userRevision/controlRevision拒绝；无显式expected时只允许首次submit在当前binding刚获取的revision，不默默刷新revision覆盖手动操作。幂等commandId与payload一致，否则冲突。TTL≤5min，session心跳失联清理；队列状态落工具缓存，重启旧命令不过期重放，恢复presentation需重新resolve。保存只收有限数据、原子替换、拒绝链接，不改业务/语义人工模型。

浏览器cookie HttpOnly SameSite=Strict owner绑定多文档sessions（不能每tab覆盖单一cookie）；bootstrap GET /api/bridge/browser/bootstrap ->BrowserBootstrap（每文档独立session）；POST /api/bridge/browser/state body{sessionId,csrf,state:BrowserState}返回ViewSession；GET /api/bridge/browser/current?sessionId ->BrowserCurrent；GET /api/bridge/browser/events?sessionId SSE控制事件（只发通知、带event id），cookieowner校验；POST /api/bridge/browser/ack body{sessionId,csrf,commandId,status:'received'|'presented'|'conflict'|'failed',userRevision,controlRevision,actual?,message?} ->PresentationReceipt。POST /api/bridge/browser/leave {sessionId,csrf}取消待命令撤销binding、allow=false；不回滚人工选择。bootstrap默认allowControl=false，首次UI明确允许后state optin；attach只允许optin，拒绝争抢已有其他lease（浏览器退出可撤销）。退出后不能自动重新开启。浏览器state label等长度严格校验。浏览器HTTP继续全量Origin/JSON/CSRF检查。SSE启动及重连主动拉current补偿；ack只有匹配快照和版本才成功。

## Agent B：前端联动与现有页面适配

拥有apps/web/src/control/**、App.tsx、GraphCanvas.tsx、architecture/ArchitectureWorkspace.tsx、semantics/SemanticWorkspace.tsx、semantics/SemanticCanvas.tsx及新DOM回归。根不修改这些文件，main.tsx/CSS入口由根负责。提供网站顶层LinkController/hook通过固定browser endpoints bootstrap/state/events/current/ack/leave，UI初始“允许Codex联动”，只有用户启用才state.allowControl。展示Codex状态、分析标题、scope、snapshot状态、高亮数量、清高亮/退出、orderedSteps逐项入口。不能影响普通未启用用户的原有流程。

控制状态与实体选择分离，保留原UI三模式/语义两粒度/导航历史。外部 ResolvedPresentation 通过可选props进入两个工作区，或可新增复用工作区（GraphCanvas/SemanticWorkspace/SourcePreview复用，不重写）。code范围使用resolved.codeGraph覆盖查询图，不把合法外部节点藏在固定flow内；flow用resolved.semantic及highlights。系统使用resolved.architecture与现有职责详情。scope切换须在App原子设置(projectId,worktreeId)，不能默认首worktree回写抢目标。

浏览器是最终CAS：用户操作开始同步递增userRevision，包含选择/路由/返回/筛选/展开/证据/drag/zoom（自动布局和命令自身不算）；解析前和提交前核对command.expected...；pending用户操作取消旧command并ack conflict。当前presentation source/mode/data更新需版本一致；snapshot过期清高亮并提示，不能与新模型混合。改变模式/粒度维持selection和focus；many-to-many高亮全部映射，预算隐藏必须明确。GraphCanvas原onFocusHandled发生太早不可当呈现回执；新增可选settled callback等布局/fit promise完成才让LinkController ack presented（附实际source/node/edge/evidenceIDs）。只导航不强制重布局；用户可随时leave并保留当前人工上下文/草稿。agent控制产生的DOM点击不能被当人工（不要通过模拟按钮实现控制）。原图功能/原128测试保持。

## 主控

types、依赖/lock、apps/mcp/**、server.ts注册与私有Origin规则、main.tsx CSS、MCP stdio集成测试、文档、Codex配置差异模板、最终浏览/安全/安装。MCP使用官方SDK低层Server+JSONSchema+stdio，stdout只有协议；client只访问从固定授权runtime得到的127.0.0.1端口，nonce验证后Bearer，禁止redirect/任意URL/文件参数，不spawn Shell。工具查询仅允许约定dispatch；控制便利工具生成规范AnalysisPresentation并走submit，支持present_analysis完整协议和status/attach/clear。无新增AI API、无自动改用户Codex配置。先真实stdio SDK Client→服务→浏览器验证，Codex App tool discovery未实际发生则准确报告未完成，不能用测试客户端成功冒充。

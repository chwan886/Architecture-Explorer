# Codex 本机 MCP 联动

本阶段提供只读架构查询和网页展示控制，无网页聊天、模型 API、Shell 工具或游戏写入。MCP 复用现有索引、系统模型和语义投影。GameDemo02 仍是只读目标。

## 启动与连接

先在工具目录运行：

```powershell
.\Tools\explorer.ps1 -Task Dev
```

网站服务仅监听 `127.0.0.1`。浏览器打开配置端口（默认 http://127.0.0.1:4310），点击“允许 Codex 联动”。未允许的页面不会接受远程导航。网站不用额外启动 MCP HTTP 服务。

stdio 服务启动命令（正常会等待输入，stdout 仅用于 MCP JSON-RPC）：

```powershell
.\Tools\explorer.ps1 -Task Mcp
# 或指定已授权的工具配置
.\Tools\explorer.ps1 -Task Mcp -Config .\config\local.json
```

Codex App 的 Settings → MCP servers → Add server 可配置本地 STDIO；也可审查后向用户级 `~/.codex/config.toml` **新增** `config/codex-mcp.example.toml` 的块。App 与 CLI 使用官方 MCP 配置机制。已存在同名块时先合并审查，不重复追加。实现不会修改用户配置。示例路径指向安装目录 `E:\Projects\Architecture-Explorer`；如从开发工作树测试，使用该工作树的绝对路径及对应配置，端口和缓存必须一致。

完整字段与官方连接说明：[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。保存配置后在 App 的 MCP servers 设置按提示选择 Restart，再在对话输入 `/mcp` 检查连接；本轮未刷新工具列表时可在重载后继续下一轮。`codex mcp list` 只证明已配置，不能证明工具调用成功。连接后实际调用 `get_capabilities` 与 `list_projects`，再完成下方流程，才算验证工具可用。

## 推荐调用顺序

1. `list_projects` → `list_worktrees`，只选择已授权工作区。
2. `begin_analysis` 固定一次分析快照。保存所有返回的 ID 与版本。
3. `search_architecture` 查符号、模块中文名称或语义标题；`get_node_details`、`get_related_graph`、`get_source_evidence` 核对事实。
4. `get_flow` 列出/读取已有业务流程。`get_call_paths` 仅查真实有向调用路径；不把邻域 BFS、普通依赖或未验证转换当作执行顺序。
5. `list_view_sessions` → 明确选择已允许的页面 → `attach_view_session`。多标签页没有隐式“当前页面”；会话冲突必须显式选择。使用返回的 `bindingId`、`userRevision`、`controlRevision`。
6. `show_flow`、`open_architecture` 或 `present_analysis` 提交展示，在线提交必须带绑定与两项版本。
7. `get_presentation_status(commandId)` 等待 `presented`，并检查 `actual` 的快照、实体及证据。`pending`/`received` 不能称为网页已成功展示。浏览器布局或快照失败会返回失败原因。
8. `set_view_mode` / `highlight_nodes` / `focus_node` 使用本 MCP 会话曾提交的 `basePresentationId`，显式传递最新已确认的版本。焦点、流程和快照保留；不得遇到版本冲突就刷新版本自动重试覆盖用户。

查询工具：`get_capabilities`、`list_projects`、`list_worktrees`、`begin_analysis`、`search_architecture`、`get_node_details`、`get_related_graph`、`get_call_paths`、`get_flow`、`get_source_evidence`、`semantic_reverse`。

控制工具：`list_view_sessions`、`attach_view_session`、`open_architecture`、`show_flow`、`present_analysis`、`highlight_nodes`、`focus_node`、`set_view_mode`、`clear_highlights`、`get_presentation_status`。每个工具有严格 JSON Schema、中文说明与参数预算。

清高亮仅移除联动高亮、保留人工上下文。网页“恢复手动浏览/退出联动”撤销绑定。之后旧 MCP 指令不会自动重新启用控制。网站未打开时，可保存最近一条有效请求并返回固定 loopback `openUrl`；打开、允许并明确绑定后重新核验再投递。服务重启后旧快照句柄不会猜测绑定到新索引，过期请求须重新查询提交。

## 展示协议与真实性

`packages/control-protocol/src/types.ts` 定义 `AnalysisPresentation`：协议版本、presentation/project/worktree/indexSnapshot/snapshot ID，标题说明、目标页面、三模式、两粒度、带 layer 的焦点与高亮引用、flowId、orderedSteps、evidenceIds、warnings、createdAt。

- `code` ID 来自原始索引；`architecture` ID 来自当前投影；`semantic` 引用必须加 `flowId`。不可猜 ID。
- `orderedSteps` 支持一对多代码映射，记录输入/输出、证据、代码边、服务器注册的 pathId、verification 与 orderBasis。
- `reading-order` 只是说明的阅读顺序。`call-path` 必须来自本快照查询注册路径，仍不等于完整运行时顺序。未证明步骤标为 `unverified`。
- 引用不存在、跨工作区、隐藏不可呈现、超过预算或源快照过期都会拒绝，不能静默忽略。
- 搜索每条命中最多预览12个证据ID，同时给出 `evidenceCount` / `evidenceTruncated`；系统的大量成员证据通过详情进一步查看，搜索不会倾倒整套证据。明确调用路径展示仅保留请求端点及真实边；无明确边时邻域默认16节点，明确请求仍受80节点硬预算约束。
- 当前快照句柄有效期10分钟、最多16个。源码、模型、语义人工修改或授权范围变化后旧句柄失效，重新 `begin_analysis`。
- 建议等索引“已同步”后开始分析；后台重新发布索引对象也会使已有句柄失效，即使文件内容revision不变。服务返回过期时页面清除旧高亮，重新开始分析，不静默替换旧结果。
- 数据邻域为静态读写引用；动态分发/回调与跨 HTTP 关系未自动确认。不会为了连贯而补边。

现有首批业务语义流程是领地领取/库存交互与宗门战斗启动/轮询/结果读取。飞剑命中局部调用可以查询代码图；尚无完整的飞剑专属语义流程。若搜索显示 `projectile_hit → apply_hit → damage` 与投射物推进片段，必须保留动态 `on_hit` 和跨层连接的缺口，不声称完整攻击链已证实。

## 直接可用的提示词

> 使用 Architecture Explorer MCP 查询 GameDemo02 的宗门战斗流程。先列出项目和 Worktree，固定快照，搜索并检查源码证据。区分已确认调用、候选业务解释和未验证顺序。选择我已允许联动的页面，展示现有战斗流程的简洁业务解释。等待 presented 回执后用中文解释，列出缺口。

> 在刚才同一快照和流程中展开详细解释，再切到双层对照。保留当前焦点，高亮该步骤对应的全部方法。若用户操作或索引变化造成冲突，停止旧展示并说明原因。

> 查询飞剑命中到伤害计算的真实调用路径，读取证据并在代码图展示。动态回调、缺失边和普通依赖请单独说明；不要把不相连片段拼成已验证执行链。

> 从这个生命值字段查询静态读写引用，并展示相关方法及源码。明确这只是当前解析器可验证的读写范围，不代表完整运行时数据流。

## 安全与排错

| 情况 | 处理 |
|---|---|
| SERVICE_NOT_RUNNING / SERVICE_UNREACHABLE | 先启动网站，确认 MCP 与网站使用同一 config、端口和缓存。 |
| SERVICE_IDENTITY / UNSAFE_RUNTIME | 不发送令牌。检查本工具缓存权限、链接路径或冲突端口；不要从网页手工复制令牌。 |
| RUNTIME_IN_USE / RUNTIME_LOCKED | 同一缓存已有活实例或发布锁，服务拒绝覆盖凭据。先检查本工具进程与日志；崩溃遗留锁采取拒绝策略，确认所有相关实例已停止后才能清理工具缓存中的该锁。 |
| STALE_SNAPSHOT / SOURCE_CHANGED | 重做 begin_analysis，重新搜索/检查证据；不要换 ID 强行提交旧分析。 |
| AMBIGUOUS_SESSION / SESSION_NOT_ALLOWED | 在明确目标页面允许联动，列出并绑定该文档会话。 |
| 版本冲突 / 用户手动浏览 | 停止旧控制请求。保留用户操作；确认新意图后才重新绑定/提交。 |
| pending / received | 检查页面联动提示、SSE/网络和回执。收到不等于呈现，不循环无限重试。 |
| PRESENTATION_TOO_LARGE | 缩小节点/路径范围，分步展示。单个代码展示不超过80节点。 |
| 当前 Codex 对话没有新工具 | 在 App MCP servers 设置重载，用 `/mcp`（或 `/mcp verbose`）检查；本轮未刷新时重载后继续下一轮。配置存在与模型实际调用是两个验证步骤。 |

服务使用 Host/Origin、JSON/CSRF 与 HttpOnly SameSite=Strict 浏览器身份；私有调用使用工具缓存中仅当前用户+SYSTEM可读的令牌。sidecar先用随机nonce/HMAC校验服务身份，再向固定 `127.0.0.1` 端口发送认证请求，不跟随重定向。SSE仅通知，前端主动读取状态并做最后版本校验。令牌、浏览器CSRF和缓存不提交Git、不写进Codex配置。

当前绑定租约为120秒、页面心跳失联90秒过期、待呈现命令最长5分钟；租约过期后明确重新绑定。完整刷新或服务重启会建立新页面会话并要求重新允许。图布局、阅读历史和人工焦点在当前文档内保持，刷新后不会冒充仍已绑定。`actual.visibleNodeIds` 表示当前层级、预算内的画布实体集合，不表示所有实体同时位于屏幕像素范围；显式焦点另通过画布定位处理。

## 验证命令及范围

```powershell
.\Tools\explorer.ps1 -Task Typecheck
.\Tools\explorer.ps1 -Task Test
.\Tools\explorer.ps1 -Task Build
```

测试覆盖严格参数、快照/证据、真实SDK stdio客户端、认证服务、会话及回执。协议测试模拟浏览器ACK，不冒充视觉验收。实际浏览器验收和 Codex App 工具调用验证分别记录于 `docs/MCP-VALIDATION.md`；未通过真实 Codex App 工具发现/调用的部分必须标为未验证。

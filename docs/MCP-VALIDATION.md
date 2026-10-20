# 本地 MCP 联动验收记录

日期：2026-10-20。初始产品实现：`250c045`；用户配置及重载前验收记录：`5bbc405`；本轮服务端焦点预览修复：`e8825e8`，前端源码交接修复及最终产品代码：`83caaaf`。目标 GameDemo02 HEAD：`4ea5d3d25b86d57a6b022faca23008f8351dea47`。

## 已验证的范围

- 官方 SDK Client 通过真实 STDIO 初始化、发现22个工具并调用本地服务；不是只模拟 MCP handler。
- 用户重载后，本次 Codex App 聊天实际发现 `mcp__architecture_explorer` 的22个工具，并调用项目、Worktree、分析快照、实体搜索、节点详情、调用路径、源码证据及网页控制工具。App实际工具调用与此前SDK客户端验收分别记录，详见下方“Codex App 实际端到端验收”。
- 服务以 HMAC/nonce 先验身份，再接收 Bearer 请求；错误服务、端口、重定向均不能取得令牌。
- 真实 GameDemo02 查询：已授权项目与 primary Worktree、当前快照、代码/业务系统搜索、调用路径、静态字段读写、语义流程和源码证据。
- 真实浏览器由 MCP 指令切换并返回 `presented`。分别检查焦点、图中实体、源码证据 ID 和分析快照；`pending`、`received` 单独记录，未当成成功。
- 领取驻守收益：简洁六阶段、局部详细展开、代码和对照；固定步/战斗结果：详细对照、原始调用与源码。解释仍为待复核，未验证连线保持原状态。
- 飞剑命中局部路径：`projectile_hit → apply_hit → damage`，三实体、两条静态调用；命中调用证据在 `Server/sect_combat.py:296`，伤害调用在205，伤害函数183–190。没有把动态 `on_hit` 或 HTTP/UI缺口补成确定路径。
- 伤害静态数据邻域查询返回16条读取、6条写入，包含局部所有者的 `a['hp']`、护盾与防御访问。没有称为完整运行时数据流。
- 点击调用连线后源码切到205；返回后恢复原节点与296证据，避免详情/源码错位。
- 人工操作后以旧 userRevision 提交定位，得到 `CONTROL_CONFLICT`；错误 indexSnapshotId 和 Worktree 均得到 `STALE_SNAPSHOT`，未应用。
- 两个实际标签页具有不同文档会话；无目标绑定时得到 `AMBIGUOUS_SESSION`。退出后旧心跳不能重新启用。
- 无允许页面时保存最新请求；明确允许并 attach 后重新核验、投递并收到真实浏览器 `presented`。
- 人工缩放后仅更新高亮，实际 viewport transform 完全保持；语义焦点通过 DOM边界确认位于画布可见范围。
- 系统“进入内部结构”进入原有L2/L3模块架构，使用逻辑实体ID，未误请求原始代码节点。

## 自动化与构建

本轮修复后完整测试 **170/170 通过，0失败、0跳过**；上轮产品基线为168/168。使用原生本机 socket 和 NTFS权限运行，未跳过安全用例。TypeScript检查及 Vite生产构建通过，安装目录生产构建592ms。Vite仍提示既有ELK大块及依赖的 `use client` 指令；本次MCP SDK仅在Node侧，未打包进网页。

覆盖：参数Schema与未知字段、越界源码、快照与模型竞态、Worktree隔离、注册路径与推断可信度、显示预算、many-to-many焦点往返、真实stdio、Host/Origin/Bearer/CSRF、Windows SID+SYSTEM ACL、NTFS Junction拒绝、SSE持续推送与关闭、活实例凭据不覆盖、幂等与持久队列回滚、离线/重启、最终呈现ACK，以及原有系统/代码/语义/源码导航回归。

本轮新增服务端预览回归：显式焦点改变时，预览只从该焦点自身或由它发出的关系证据中选择，不再沿用不相关的原展示首项证据；没有相交证明时使用焦点自身证据，没有焦点证据时不显示旧证明。原证明集合与阅读步骤保持原样，无证明请求仍不自动打开源码。此修复也覆盖视图切换后的焦点映射，不需要修改stdio工具接口。

实际App验收还发现前端命令交接竞态：新命令内嵌源码与旧evidenceId的清理effect交错，使回执停留在received。新增DOM回归先观察失败，再修复为当前证据命中时恢复source及busy状态；最终实际App定位damage获得presented，不能以服务端返回了正确证据代替前端呈现。

可重复执行：

```powershell
.\Tools\explorer.ps1 -Task Typecheck
.\Tools\explorer.ps1 -Task Test
.\Tools\explorer.ps1 -Task Build
```

本轮完整日志：`test-results/mcp/app-native-test.log`（170/170）、`app-native-typecheck.log`、`app-native-build.log`；本轮结构化验收记录为 `app-native-acceptance.json`，包含原始metadata/回执、负向错误及DOM观察，并区分修复前错误与最终结果。上轮168/168的 `test.log`、`build.log` 和SDK请求/回执 `browser-transcript.ndjson` 保留为历史证据。实际App调用与回执来自本次聊天的工具记录。这些本机验收产物默认忽略，不提交游戏或工具Git。

## 视觉验收

实际运行页面，在1920×1080、1280×800、1024×768检查布局、面板、连线、缩放、源码及横向溢出。中窄窗口对照改为上下排列，Inspector独立滚动；没有页面级横向溢出。显式焦点会定位，纯高亮更新保持镜头。大范围图仍需平移/缩放；ACK中的可见ID集合指当前层级的Canvas实体，并非所有实体同时出现在屏幕像素内。

验收发现并修复：详细摘要未展开、详细切回简洁未折叠、命令重挂载导致镜头重置、语义逻辑焦点未进入实际视口、业务系统误用代码ID钻取。系统搜索每命中仅预览12个证据并给总数/截断标记；Inspector证据按24项分批加载，避免大量成员证据淹没界面。

主要截图（本机）：

- `test-results/mcp/projectile-path-1920.png`
- `test-results/mcp/battle-compare-1920.png`
- `test-results/mcp/claim-simple-1280-final.png`
- `test-results/mcp/claim-simple-1024.png`

本轮实际App联动截图：

- `test-results/mcp/app-native-battle-compare-final.png`
- `test-results/mcp/app-native-projectile-damage.png`
- `test-results/mcp/app-native-path-highlight.png`
- `test-results/mcp/app-native-final-manual.png`

本轮默认1255×884浏览器窗口无页面水平溢出，浏览器warning/error日志为空。复杂对照图仍需缩放与平移；不声称回执中的所有节点同时处于屏幕像素内。

## Codex App 实际端到端验收

用户在2026-10-20明确批准后，已仅追加 `docs/CODEX-CONFIG-PENDING.diff` 中的 Architecture Explorer 块到用户级 Codex 配置。原文件3346字节逐字节保留，追加410字节，TOML及已有配置语义校验通过；没有覆盖既有 `node_repl` 配置。`codex mcp get architecture_explorer` 已识别启用的stdio命令、参数与安装目录。

**本轮实际 Codex App → MCP工具 → 本机服务 → 真实浏览器联动已通过。** 重载前，当前聊天未发现新服务，CLI的默认 `app-server proxy` 曾报Windows socket错误10050；这些是历史排查结果。用户在App中重载后，本聊天直接调用新增的 `mcp__architecture_explorer` 工具，未用SDK客户端或CLI配置列表代替App验收，也未通过内部接口注入工具。

本轮分次建立有效分析快照，服务重启后重新开始分析。修复后最终上下文：项目 `game-demo-02`、Worktree `primary`，snapshotId `8dbc7f3a-727d-4779-bdde-951e99150ae5`，源码版本 `da7c48f918b52bc52c549c6d`；已同步2190文件、changedFiles=0。以下commandId均来自实际App工具调用，逐一查询回执；前七项为 `presented`，最后一项明确为清除动作回执。

| 展示或操作 | commandId | 实际核验 |
|---|---|---|
| 系统总览 | `2a2f236e-db22-44e8-b1c6-3e065e1b733c` | 对应当前项目、Worktree及快照 |
| 战斗流程简洁解释 | `876282d4-e2b6-421f-b500-60b21556418d` | 现有流程及简洁粒度，保留候选与未验证标记 |
| 战斗流程详细对照 | `18622c36-19b7-4fe6-8933-1c5db6d28902` | battle-resolve与step/finish映射，同源代码对照 |
| 代码模式 | `975ad858-71a3-41b7-a484-ba83e3fe5c81` | 同一流程与代码映射，未新造关系 |
| 飞剑命中局部调用路径 | `9a66727f-2010-4346-a4bc-c348bb4bb05d` | 3个代码节点、2条静态调用，首证据为296行 |
| 定位damage | `68d54d0f-ec8c-4ee2-b325-4f6f0edb1311` | 源码证据切换至183–190行，焦点、详情与源码一致 |
| 更新局部高亮 | `57d882f1-a33e-4a1b-a90d-3a2824abe142` | apply_hit/damage共2个描边节点、1条加粗调用边 |
| 清除高亮 | `fc9a6ec5-29cf-454a-a92b-84b82e1105ef` | action=clear；DOM为0个高亮节点，保留damage详情与源码 |

damage实际实体为 `symbol:14b13f9af3ae16c2bdde9974`，源码证据为 `evidence:d5ba30671c005f48eb18d6a3`；画布selected节点、Inspector及SourcePreview的data-node-id均为该实体。调用边 `edge:451aa045c94d1ef2b2082282` 是apply_hit到damage的原始关系。更新高亮时约72.51%的缩放保持；清除前后稳态viewport字符串完全一致。最终用户退出联动后，页面恢复手动浏览，保留3节点地图与源码，并已滚动到HP写入190行；旧binding调用返回 `BINDING_EXPIRED`，可绑定会话列表为空。

本轮负向验收：错误Worktree及indexSnapshotId均被 `STALE_SNAPSHOT` 拒绝，不存在的节点和源码证据被拒绝；人工执行适应视图后，用旧CAS定位得到 `CONTROL_CONFLICT`，没有覆盖人工操作。重启本机网站服务后旧snapshot被拒绝；App工具连接新服务身份，重新查询当前快照，新网页文档重新明确允许和attach后恢复。本轮不需要再次修改用户配置或重载Codex App。

## 当前能力边界

不接入模型API，不提供网页聊天、Shell、注册任意路径、修改游戏或人工语义模型的MCP工具。完整飞剑专属语义流程、动态回调、完整过程间数据流及运行时顺序尚未实现。服务重启不保留旧快照句柄；需重新查询、允许并绑定。人工历史/布局仅当前文档内保持。待呈现最长5分钟，快照10分钟，租约120秒，过期明确拒绝。

GameDemo02验收前后均以 `git --no-optional-locks` 只读检查；HEAD保持 `4ea5d3d25b86d57a6b022faca23008f8351dea47`，Git工作区为空。本轮用户配置SHA256保持 `EAFB833B9B64B932B0ABFBC0907AE2351C315B9948763621C4D27DCA341170CD`，Architecture Explorer与原node_repl配置块均各1个，未重复追加或改写。安装目录与开发工作树使用独立服务端口与固定配置，不能跨缓存复用快照句柄。

## 安装目录复验

`E:\Projects\Architecture-Explorer` 在核对 main 干净且可快进后集成；锁定依赖安装、类型检查及生产构建成功。4310服务已启动，实际stdio客户端读取该安装目录入口与配置。浏览器已收到系统展示的 `presented`，源版本 `da7c48f918b52bc52c549c6d`；后台校验后已同步2190文件、changedFiles=0。系统搜索实际只预览12/2035条证据，Inspector首次24条、点击加载后48条。

启动期间重新发布索引会使先前分析句柄失效，即使内容revision保持不变。安装复验观察到该过期回执，补充了独立回归：服务返回expired、没有新源码revision事件时，页面也必须清除旧高亮并显示原因。重新开始分析即可使用已同步索引，不能静默用新句柄代替旧分析。安装日志位于 `test-results/mcp/installed-service.*.log`。

同时修复了既有系统/语义投影缓存：同revision的新索引对象发布后，缓存须重新绑定该对象，不能持续返回旧对象使新分析永久报过期。真实fixture执行一次无变更扫描，验证旧句柄拒绝、新句柄可建立、两类投影与新索引相同且代码展示可解析。

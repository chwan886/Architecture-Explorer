# 本地 MCP 联动验收记录

日期：2026-10-20。基线：60f560b。目标 GameDemo02 HEAD：`4ea5d3d25b86d57a6b022faca23008f8351dea47`。

## 已验证的范围

- 官方 SDK Client 通过真实 STDIO 初始化、发现22个工具并调用本地服务；不是只模拟 MCP handler。
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

最终完整测试 **168/168 通过，0失败、0跳过**。使用原生本机 socket 和 NTFS权限运行，未跳过安全用例。TypeScript检查及 Vite生产构建通过。Vite仍提示既有ELK大块及依赖的 `use client` 指令；本次MCP SDK仅在Node侧，未打包进网页。

覆盖：参数Schema与未知字段、越界源码、快照与模型竞态、Worktree隔离、注册路径与推断可信度、显示预算、many-to-many焦点往返、真实stdio、Host/Origin/Bearer/CSRF、Windows SID+SYSTEM ACL、NTFS Junction拒绝、SSE持续推送与关闭、活实例凭据不覆盖、幂等与持久队列回滚、离线/重启、最终呈现ACK，以及原有系统/代码/语义/源码导航回归。

可重复执行：

```powershell
.\Tools\explorer.ps1 -Task Typecheck
.\Tools\explorer.ps1 -Task Test
.\Tools\explorer.ps1 -Task Build
```

完整日志：`test-results/mcp/test.log`、`build.log`；实际MCP请求与结构化回执：`browser-transcript.ndjson`。这些本机验收产物默认忽略，不提交游戏或工具Git。

## 视觉验收

实际运行页面，在1920×1080、1280×800、1024×768检查布局、面板、连线、缩放、源码及横向溢出。中窄窗口对照改为上下排列，Inspector独立滚动；没有页面级横向溢出。显式焦点会定位，纯高亮更新保持镜头。大范围图仍需平移/缩放；ACK中的可见ID集合指当前层级的Canvas实体，并非所有实体同时出现在屏幕像素内。

验收发现并修复：详细摘要未展开、详细切回简洁未折叠、命令重挂载导致镜头重置、语义逻辑焦点未进入实际视口、业务系统误用代码ID钻取。系统搜索每命中仅预览12个证据并给总数/截断标记；Inspector证据按24项分批加载，避免大量成员证据淹没界面。

主要截图（本机）：

- `test-results/mcp/projectile-path-1920.png`
- `test-results/mcp/battle-compare-1920.png`
- `test-results/mcp/claim-simple-1280-final.png`
- `test-results/mcp/claim-simple-1024.png`

## 未完成的外部验收与边界

用户在2026-10-20明确批准后，已仅追加 `docs/CODEX-CONFIG-PENDING.diff` 中的 Architecture Explorer 块到用户级 Codex 配置。原文件3346字节逐字节保留，追加410字节，TOML及已有配置语义校验通过；没有覆盖既有 `node_repl` 配置。`codex mcp get architecture_explorer` 已识别启用的stdio命令、参数与安装目录。

**Codex App 实际发现与调用仍待验证。** 当前完成的是官方SDK真实stdio客户端 → 本机服务 → 实际浏览器的联动验收。本轮主Agent和重启任务的子Agent工具列表均没有该新服务。已安装CLI支持的 `app-server proxy` 连接默认控制socket失败（Windows socket错误10050），未通过内部接口注入或重启整个应用绕过。已请求用户在App设置中重载MCP后继续实际调用；`codex mcp list/get` 或注册成功均不能代替该验证。

不接入模型API，不提供网页聊天、Shell、注册任意路径、修改游戏或人工语义模型的MCP工具。完整飞剑专属语义流程、动态回调、完整过程间数据流及运行时顺序尚未实现。服务重启不保留旧快照句柄；需重新查询、允许并绑定。人工历史/布局仅当前文档内保持。待呈现最长5分钟，快照10分钟，租约120秒，过期明确拒绝。

GameDemo02验收前后均只读检查；HEAD未变化，Git工作区为空。安装目录与开发工作树使用独立服务端口与固定配置，不能跨缓存复用快照句柄。

## 安装目录复验

`E:\Projects\Architecture-Explorer` 在核对 main 干净且可快进后集成；锁定依赖安装、类型检查及生产构建成功。4310服务已启动，实际stdio客户端读取该安装目录入口与配置。浏览器已收到系统展示的 `presented`，源版本 `da7c48f918b52bc52c549c6d`；后台校验后已同步2190文件、changedFiles=0。系统搜索实际只预览12/2035条证据，Inspector首次24条、点击加载后48条。

启动期间重新发布索引会使先前分析句柄失效，即使内容revision保持不变。安装复验观察到该过期回执，补充了独立回归：服务返回expired、没有新源码revision事件时，页面也必须清除旧高亮并显示原因。重新开始分析即可使用已同步索引，不能静默用新句柄代替旧分析。安装日志位于 `test-results/mcp/installed-service.*.log`。

同时修复了既有系统/语义投影缓存：同revision的新索引对象发布后，缓存须重新绑定该对象，不能持续返回旧对象使新分析永久报过期。真实fixture执行一次无变更扫描，验证旧句柄拒绝、新句柄可建立、两类投影与新索引相同且代码展示可解析。

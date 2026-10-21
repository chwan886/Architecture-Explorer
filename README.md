# Architecture Explorer

本地运行的中文架构探索工具。系统职责与模块协作、技术分层、多粒度业务解释与代码双层对照、React Flow 代码画布、源码证据、C#/Python 静态分析及文件监听。分析目标默认只读，普通本地扫描不上传目标源码。显式启用的 GitHub 工具包保留人工模型/文档中的游戏源码摘录，索引证据包也可能包含源码上下文；工具仓库、日志和产物均须遵循游戏的访问范围。

支持 Codex 本地 STDIO MCP 查询与网页联动：[连接和使用指南](docs/MCP-GUIDE.md)。新增服务不会修改用户级 Codex 配置；网页明确允许后才接受控制，指令与实体绑定到同一索引快照。

## Windows 启动

在本仓库中运行（首次准备需要网络，Python 3.11+ 需已安装）：

```powershell
./Tools/explorer.ps1 -Task Setup -ProjectRoot 'E:/Projects/GameDemo02' -ProjectName GameDemo02 -ProjectId game-demo-02 -UnityEditorPath 'C:/Program Files/Unity/Hub/Editor/6000.6.5f1'
./Tools/explorer.ps1 -Task Build
./Tools/explorer.ps1 -Task Dev
```

浏览器打开 **http://127.0.0.1:4310**。首次进入会建立真实索引，后续自动监听文件变化。`Start-Explorer.cmd` 可启动已完成准备和构建的工具。不要同时启动两个服务占用相同端口。

Setup 将校验过的官方 Node/npm、.NET SDK 和包管理器放在 `.tools/`，不修改全局安装。NuGet/npm 依赖固定并提交锁文件。工具使用自己的 Roslyn，不执行目标项目构建或目标 Python 模块。

`config/local.json` 是本机项目清单，默认不提交；已存在时 Setup 不覆盖。模板为 [config/projects.example.json](config/projects.example.json)，路径相对配置文件解析。项目目录只出现在配置中。`EXPLORER_CONFIG` 可指定另一份配置。

默认聚焦运行源码，排除 Tests、Editor 和 `test_*.py`。需要探索测试或编辑器工具时，可调整 exclude 并补充其元数据引用；不要同时引入 Unity 根聚合 DLL 和同名模块 DLL。

## 探索代码

- 首屏为业务系统总览；技术架构独立展示真实程序集与源码分组。
- 系统总览 → 系统内部模块 → 组件 → 现有代码地图中的方法、调用与源码。单击查看职责，双击或右侧按钮进入；面包屑和返回支持双向导航。
- 点击系统连线查看真实成员关系、静态可信度、条件与证据；普通引用和字段读写不等同于已验证业务数据传递。
- 业务流程页支持简洁/详细解释、代码实现、双层对照与人工维护，详见[双层语义图指南](docs/SEMANTIC-GUIDE.md)。原阶段泳道可从“原始流程证据”进入；静态调用、源码位置支持、未验证的协议或跨请求关系分别标记，图形不是运行时追踪结果。
- 代码详情中的“所属业务系统与模块”可反向定位。无法确定的实体保留在“待分类”中。
- 搜索类、方法或字段，选择后查看 Inspector 和真实源码证据。
- 在调用、数据和影响视图中选择方向与深度，展开当前符号附近关系。
- 字段或字典位置的读取、写入和初始化分别表示。数据访问位置不等于完整运行时数据流。
- 确认与推断有独立标签；未知动态调用及不支持范围可在扫描警告查看。
- 未实现分析器的语言不会获得虚构的调用关系。

## 业务归属与人工复核

`architecture/models/<项目ID>/model.json` 是独立的可维护职责模型，包含系统、模块、选择器、源码锚点、流程和人工复核记录；生成的聚合图放在独立 `.cache/` 中。没有模型的项目仍可使用技术架构与代码地图。

GameDemo02 随附六个候选业务系统，以及共享支撑与旧路径两个分组；初始未包含任何人工确认。候选定义与底层静态事实使用不同标签。一个系统可跨技术层，`owner` 决定主要归属；`participant`/`shared` 保留协作关联而不制造跨系统连线。多个 owner 冲突时提示复核，并停止为冲突实体生成业务汇总边。

网站“模型”编辑器可修改 JSON 并保存，采用严格 Schema、源码锚点校验、版本比较和原子写入；并发保存冲突会保留草稿。系统定义、单条归属和流程说明分别复核，确认系统不会批量确认其成员。复核与当前 Worktree、定义及源码指纹绑定；源码或边界变化后需要重新复核，旧的人工记录不会被扫描覆盖。

源码索引更新后按源版本与模型版本重新生成聚合图；只改职责模型不会重新执行源码分析器。同一服务通过 SSE 刷新模型修改；外部编辑模型后使用“重新载入架构模型”。详情与源码要求相同视图版本，过期返回409并清空旧证据。

完整使用方法见 [docs/SYSTEM-ARCHITECTURE.md](docs/SYSTEM-ARCHITECTURE.md)。

## 开发交付流程与 GitHub CI

顶部“开发交付流程”提供人工维护的条件图、可展开阶段详情和两仓 GitHub 跳转；也可使用 `?page=delivery` 直达。不读取 GitHub 实时状态，不保存 GitHub 凭据，不提供审批、合并、重跑或发布操作。

工具 PR / main CI 仅使用仓库夹具，在干净 Windows runner 冻结还原锁定依赖，执行 Typecheck、全部测试、前端和 C# worker 构建。`Build` 保持前端命令；`BuildAnalyzer` 显式构建 C#。`Tools/ci-check.ps1 -Prepare` 执行完整准备与检查，CI 不生成或读取 `config/local.json`，任何必需测试被跳过也会失败。

`game-index.yml` 接收固定游戏仓库、精确 SHA 与来源 run，经保护规则、合并 PR / 独立 Review、main 检查和历史核验后复用 Scan → Verify → Audit。工具构建包包含 TypeScript/tsx 后端、运行依赖、前端及 C# worker，**dist 不能单独运行完整工具**；游戏索引另存为每提交/每 run/attempt 的 CI 快照证据包，不能直接覆盖本地 `.cache`。

两仓当前 main 尚未保护，自动触发尚未启用。正式接入遵循用户确定的六步顺序：游戏第一阶段交接 → 工具接收端 → 工具 main 合入并手动验证 → 游戏发送初始关闭 → 用户配置并启用 → 真实 feature 联调。接口、最小游戏补丁、Unity 元数据引用供应、App / Environment / Secrets 与规则手动清单见 [开发交付合同](docs/DEVELOPMENT-DELIVERY.md)；本地验证见 [本轮交付验证](docs/DELIVERY-VALIDATION.md)。

## 本地命令

工具自身 [CODEOWNERS](.github/CODEOWNERS) 保护 CI、依赖、读取/分析边界和交付证据；需由 main Ruleset 启用 Code Owner review 才强制生效，作者不能自批。工具包与索引均须经过受保护环境的读者范围审核才能上传。[Unity 引用供应方案](docs/UNITY-REFERENCE-SUPPLY.md)已准备，真实版本、许可、私有 ZIP 与指纹仍待维护者交付；首次手测使用 Secret 短期 URL，自动发送保持关闭。

开发 App `chwan-dev-agent` 的[共享入口](docs/DEV-APP-SETUP.md)支持每次指定一个仓库的 Verify、任务分支 Push、PR 创建/文字更新和 Status；两仓只读认证均已实测。推送固定准确 SHA 与 `codex/` 分支，PR 固定 main、核对 App 作者，禁强推/批准/合并和 Owner 回退。工具任务分支的实际 PR/CI 以本机回交报告为准；安装恰好两仓仍需人工核实，自动发送继续关闭。

```powershell
./Tools/explorer.ps1 -Task Scan                 # 手动全量扫描
./Tools/explorer.ps1 -Task Watch                # 无界面持续监听
./Tools/explorer.ps1 -Task Verify               # 缓存哈希、源码与上下文一致性校验
./Tools/explorer.ps1 -Task Audit                # 已有快照、映射、锚点与当前证据核验
./Tools/explorer.ps1 -Task Test                 # 分析器、索引、安全与契约测试
./Tools/explorer.ps1 -Task Typecheck
./Tools/explorer.ps1 -Task Build
./Tools/explorer.ps1 -Task BuildAnalyzer        # 锁定还原并构建 C# 分析器
```

扫描命令支持 `-Project <配置ID>` 与 `-Worktree <工作目录ID>`。Worktree ID 从网站选择器或 API 查询；只允许配置授权的工作目录。可配置多个项目，但不会自动扫描 Git 发现的其他工作目录。

独立 CLI 扫描前先停止同一作用域的网站服务，避免同时争用缓存锁。若异常强杀遗留 `scan.lock`，确认所有工具扫描进程已退出后，仅移除报错指出的工具 `.cache` 子目录内锁文件；不要操作游戏仓库。

GameDemo02 的只读 HP 验收脚本为 `node node_modules/tsx/dist/cli.mjs Tools/validate-hp.ts game-demo-02`。先停止同作用域服务再执行；报告写入 `.cache/validation-hp.json`。它验证两端真实调用/读写证据，并保留协议边界，不运行游戏。

系统模型的只读复验命令为 `node node_modules/tsx/dist/cli.mjs Tools/validate-architecture.ts`（也可使用 `.tools` 中的 Node）。支持 `--config`、`--project` 和 `--worktree`；仅核对保存索引和当前授权锚点文件，不扫描、不争用服务锁，可与网站同时运行。报告写入 `.cache/validation-architecture-<项目>-<Worktree>.json`，包含模型版本、实际覆盖与未验证关系。

`-Task Audit` 对已有索引及授权源码生成 `.cache/evidence-audit/<项目>-<Worktree>.json`，分别统计静态调用、推断调用、参数绑定、未知回调目标、候选归属和解释；不会批量勾选人工确认。查看[证据审计指南](docs/EVIDENCE-AUDIT.md)和[本轮源码复核记录](docs/GAME-EVIDENCE-REVIEW.md)。

本轮完整回归、真实索引、浏览器和 Codex App 结果见[复核验收记录](docs/EVIDENCE-REVIEW-VALIDATION.md)。

前端开发可另运行 `-Task Web`，地址 http://127.0.0.1:5173，API 代理到 4310。`Dev` 提供构建后的本地网站和 API；不接触游戏进程。

## 可信度与边界

当前版本不采集运行时轨迹，因此不产生“运行时验证”关系。C# 语义依赖引用与编译配置；Unity 元数据来自显式配置，不保证等同某次实际构建。Python 仅保守解析无歧义调用，动态字典和动态分发保留对象/作用域边界。跨语言 JSON 字段同名不会被自动连接为确定数据流。

缓存包含 Worktree、HEAD、工作区状态、源文件哈希、解析器/Schema 版本、配置和引用指纹。失败保留最后有效索引，源码预览验证哈希以防行号过期。大型图采用局部查询与预算限制，截断结果明确提示。

当前增量能力是**按文件复用 AST/SyntaxTree、按语言复用未变结果，并保守重绑定受影响语言的语义**。每次任务仍两次读取授权文本清单核对内容哈希，尚未实现精细文件 IO 缓存和符号级失效。直接源内调用支持有限的实参表达式到声明形参绑定（`passes`）；推断目标继续标记为推断，绑定不证明跨函数对象身份、值保持或回调执行。完整跨函数值/别名传播、返回值传播、自动协议映射、通用状态机与完整 Unity GUID 资源图仍未实现。

更多设计与验收见 [docs/CONTRACT.md](docs/CONTRACT.md)、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/VALIDATION.md](docs/VALIDATION.md)。

# Architecture Explorer

本地运行的中文代码架构探索工具。React Flow 画布、源码证据、C#/Python 静态分析、独立缓存及文件监听。分析目标默认只读，源代码不会上传。

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

- 首屏为系统与模块聚合地图，双击节点逐层进入；返回保留探索路径。
- 搜索类、方法或字段，选择后查看 Inspector 和真实源码证据。
- 在调用、数据和影响视图中选择方向与深度，展开当前符号附近关系。
- 字段或字典位置的读取、写入和初始化分别表示。数据访问位置不等于完整运行时数据流。
- 确认与推断有独立标签；未知动态调用及不支持范围可在扫描警告查看。
- 未实现分析器的语言不会获得虚构的调用关系。

## 命令

```powershell
./Tools/explorer.ps1 -Task Scan                 # 手动全量扫描
./Tools/explorer.ps1 -Task Watch                # 无界面持续监听
./Tools/explorer.ps1 -Task Verify               # 缓存哈希、源码与上下文一致性校验
./Tools/explorer.ps1 -Task Test                 # 分析器、索引、安全与契约测试
./Tools/explorer.ps1 -Task Typecheck
./Tools/explorer.ps1 -Task Build
```

扫描命令支持 `-Project <配置ID>` 与 `-Worktree <工作目录ID>`。Worktree ID 从网站选择器或 API 查询；只允许配置授权的工作目录。可配置多个项目，但不会自动扫描 Git 发现的其他工作目录。

独立 CLI 扫描前先停止同一作用域的网站服务，避免同时争用缓存锁。若异常强杀遗留 `scan.lock`，确认所有工具扫描进程已退出后，仅移除报错指出的工具 `.cache` 子目录内锁文件；不要操作游戏仓库。

GameDemo02 的只读 HP 验收脚本为 `node node_modules/tsx/dist/cli.mjs Tools/validate-hp.ts game-demo-02`。先停止同作用域服务再执行；报告写入 `.cache/validation-hp.json`。它验证两端真实调用/读写证据，并保留协议边界，不运行游戏。

前端开发可另运行 `-Task Web`，地址 http://127.0.0.1:5173，API 代理到 4310。`Dev` 提供构建后的本地网站和 API；不接触游戏进程。

## 可信度与边界

当前版本不采集运行时轨迹，因此不产生“运行时验证”关系。C# 语义依赖引用与编译配置；Unity 元数据来自显式配置，不保证等同某次实际构建。Python 仅保守解析无歧义调用，动态字典和动态分发保留对象/作用域边界。跨语言 JSON 字段同名不会被自动连接为确定数据流。

缓存包含 Worktree、HEAD、工作区状态、源文件哈希、解析器/Schema 版本、配置和引用指纹。失败保留最后有效索引，源码预览验证哈希以防行号过期。大型图采用局部查询与预算限制，截断结果明确提示。

当前增量能力是**按文件复用 AST/SyntaxTree、按语言复用未变结果，并保守重绑定受影响语言的语义**。每次任务仍两次读取授权文本清单核对内容哈希，尚未实现精细文件 IO 缓存和符号级失效。跨函数参数/返回值传播、自动协议映射、通用状态机与完整 Unity GUID 资源图留待下一阶段；Schema 中相应类型为扩展预留。

更多设计与验收见 [docs/CONTRACT.md](docs/CONTRACT.md)、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/VALIDATION.md](docs/VALIDATION.md)。

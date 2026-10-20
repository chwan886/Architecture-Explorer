# 验收记录

验收日期：2026-10-20（America/Toronto）。这是第二阶段 MVP 的实际记录，高级分析的未完成范围见下文。

## 验收场景

1. 真实 GameDemo02 主路径：从 Python damage 的 hp 写入，查看调用点、数据访问及源位置；从 C# SectBattleActor.hp 查看 HUD 读取和表现相关读取。跨 JSON 边界明确显示限制。
2. 金标准：C# 重载/partial/遮蔽/ref/out/事件/动态调用；Python 作用域/重绑定/字典容器/条件/语法失败。
3. 增量：新增/修改/删除/移动/重命名/突发保存，最终与同配置全量扫描一致；上下文变化扩大语义分析。
4. 安全：路径穿越、绝对路径、junction、跨 Worktree、超大文件、来源请求、源码文本转义。
5. UI：搜索→定位→下钻→调用/数据→源码→返回；扫描、故障和空状态；1920×1080、1440×900、1280×720 与200%缩放。
6. 游戏仓库：前后 Git 状态一致，不启动或修改游戏。

## 组合检查

- `Tools/explorer.ps1 -Task Setup`：固定 Node 24.22.0、pnpm 11.25.0、.NET SDK 10.0.402，下载校验及锁定还原实际成功。
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File Tools/explorer.ps1 -Task Test`：42 项通过，0 失败，0 跳过。包括允许 loopback/junction 的本机补验。
- TypeScript 类型检查通过；Vite 生产构建通过。保留依赖 `use client` 提示及 ELK 大 chunk 提示；ELK 按需加载，未通过放宽警告阈值掩盖。
- Roslyn Worker Release 构建：0 警告、0 错误。这是工具分析器构建，未构建游戏。
- Windows PowerShell 5 入口与 UTF-8 BOM 配置已验证；入口脚本含 BOM，避免中文源文件被错误解码。

测试覆盖真实双语言 Worker、语法错误保留 lastgood、恢复同步、跨作用域、路径/junction、收窄配置拒绝旧缓存、跨进程锁、监听防抖、SSE 推送与关闭、增量/全量语义一致性。修改、删除、文件移动及符号重命名均在工具自己的临时目标内模拟。

## 真实项目

只读目标来自本机 config/local.json。初次调查 HEAD 为 `2cc8b4f`；开发期间目标主分支由其他工作更新，最终重新核验 `4ea5d3d25b86d57a6b022faca23008f8351dea47`。工具没有向 GameDemo02 写文件或执行 Git 变更命令；各次检查工作区均干净。

最终主运行范围排除 Tests、Editor 和 Python test_*。索引包含 2,190 个授权文本文件、12,620 个实体、45,341 条关系（含包含关系）、63,200 条源码证据、35 条诊断。实体包含文件、数据位置及外部元数据符号，这些数字不代表类数或已验证运行时调用次数。

`Tools/validate-hp.ts game-demo-02` 已实际通过：

| 检查 | 证据 |
| --- | --- |
| apply_hit 静态调用 damage | Server/sect_combat.py:205 |
| damage 写入其参数容器的 hp 键 | Server/sect_combat.py:190 |
| BattleMeters 内回调读取 SectBattleActor.hp | Assets/Game/Presentation/SectGameHost.Theme.cs:131 |
| 当前证据哈希与源码一致 | 所有抽查 stale=false |
| 缓存、源码、Git 与上下文校验 | valid=true |

报告写入 `.cache/validation-hp.json`，不提交缓存或项目源码。以上两端证据没有被冒充为已验证跨语言运行时数据流。

## 实际浏览器

使用本机 in-app browser 运行生产页面，检查 1280×720、1440×900、1920×1080。截图保存在本机 `test-results/ui/`（忽略，不作为源文件提交）：hp-data 三尺寸和 python-callers-1440x900。

已实际操作：字段搜索与定位、系统树祖先展开、HP 数据视图、HUD 源码定位、键盘搜索/Enter、Python 两层上游调用、影响范围、收藏/取消收藏、底部/详情面板折叠与恢复。返回后方向与深度恢复，画布 transform 对比为 viewportRestored=true。

发现并修复：长错误撑满画布、无边小图过度缩小、关系图默认字体不可读、历史丢失视口、搜索新节点被旧画布选择状态覆盖。最后一项增加六个回归测试，并用 HP → damage → 调用链真实路径重新验证。

浏览器控制未提供可验证的实际 200% 页面缩放，本项未核验；不能把视口尺寸测试写成浏览器缩放验证。VS Code 链接已呈现，但未实际启动外部 IDE。开发中替换构建 chunk 曾需要刷新；最终重新加载后未见新增控制台错误。

## 支持边界与下一批

- 当前是静态调用、读写和有限事件证据，没有运行时采集器。
- C# 为配置指定引用的合并上下文；不等同 Unity 各 asmdef 的真实构建验证。
- 持久进程复用 AST/SyntaxTree；语义重绑定仍保守覆盖受影响语言，每次任务仍两次全清单文本哈希复核。精细文件 IO/符号级失效尚未完成。
- 跨过程别名、参数/返回传播、自动 HTTP/JSON 映射、通用状态机及完整 Unity GUID 资源图尚未实现。
- 已对当前项目记录扫描与缓存行为，尚未做大型仓库系统性能基准。ELK 的按需资源约 1.43MB（gzip约442KB）。
- 异常强杀可能遗留工具缓存锁，处理方法见 README；不清理目标仓库来恢复工具。

# 证据审计与复核

`Tools/audit-evidence.ts` 将已有索引、系统归属和语义解释放在同一源码快照中检查，生成可重复执行的只读审计报告。它不启动 GameDemo02、不调用扫描器、不修改游戏文件，也不会代替用户勾选“人工确认”。

在工具目录运行：

```powershell
.\.tools\node-v24.22.0-win-x64\node.exe node_modules/tsx/dist/cli.mjs Tools/audit-evidence.ts --project game-demo-02 --worktree primary
```

可选参数：`--config` 选择工具配置，`--max-findings` 控制报告详情条数（默认 500，最多 10,000），`--max-items` 控制检查项预算（默认 1,000,000，最多 5,000,000）。Worktree 必须已被配置授权；格式仅允许 `primary` 或真实 `wt-<12 位哈希>`。

报告固定写到工具配置下的 `.cache/evidence-audit/<project>-<worktree>.json`。不接受输出路径参数。缓存目录逐层拒绝符号链接与目录联接，不能指向分析目标。报告只包含实体 ID、源码相对路径、诊断与计数，不包含整份源码。

## 各类状态分别看什么

| 报告项 | 表示什么 | 后续处理 |
| --- | --- | --- |
| `rawRelations.calls.static-confirmed` | 分析器找到源码中的静态调用关系 | 无需逐条人工确认；不代表某次运行一定执行 |
| `rawRelations.calls.inferred` | 有依据但不能静态确认的调用 | 优先复核核心流程，保留推断标签 |
| `rawRelations.dynamicDispatch` / `dynamic-dispatch` | 仅统计 `calls` 的非直接分发，例如虚方法声明目标 | 不把传参的 `declared-parameter`、`argument:*` 或委托槽引用当作动态调用；处理器未知另看 `unknown-runtime-target` |
| `rawRelations.byKind.passes` | 所有 `passes` 关系的数量，包含确认和推断 | 仅按类型统计，不能把总数描述为已静态确认 |
| `rawRelations.byKindAndConfidence.passes` | 按可信度区分实参/回调传递关系；C# 声明形参绑定可静态确认，Python 动态转发保留 inferred | 不自动推导回调最终执行、对象身份或完整运行时数据流 |
| `csharp.delegate-invocation` / `unknown-runtime-target` | 委托调用槽或传递点已知，实际运行处理器集合未知 | 保留 references/passes；需要运行时证据才能确认处理器 |
| `candidate-ownership` | 业务归属/系统职责尚未人工复核 | 与底层调用准确性分开，只有业务歧义需要用户裁定 |
| `candidate-explanation` | 中文解释文字、步骤分组待复核 | 结合实现映射审查，不自动勾选确认 |
| `source-supported-order` | 同一真实过程内前后源码锚点支持局部顺序 | 继续保留条件、循环、提前返回及异步限制 |
| `unverified-order` | 请求、协议、叙述或其他关系不能证明运行顺序 | 允许部分流程，不为图形连贯补线 |
| `source-stale` / `anchor-stale` | 当前文件或锚点与保存快照不一致 | 先正常同步索引，再复核受影响解释 |
| `missing-*` / `invalid-proof` / `invalid-path` | 存在缺失引用、悬空边或证据与确认状态冲突 | 修正索引/模型，不得沿用确认标记 |
| `disconnected-mapping` | 一个解释关联多个未连接实现片段 | 分别显示证据，必要时拆分或人工确认分组 |

人工 `confirmed` 仅是解释/归属的审查状态。报告始终输出 `runtimeVerificationClaimedByAudit: false`，不会把人工确认升级为运行时证明。

## 核验范围

- 每个代码节点、关系的端点、父节点和证据引用；非结构性关系不能没有源码证据。
- 证据文件必须属于当前索引，证据哈希必须等于索引文件哈希。
- 只读读取已有索引列出的当前授权文件，计算文本哈希；具备文本时检查证据行范围。
- 模型锚点的当前文件哈希、完整行 quote 和行范围；不能只更新哈希掩盖语义变化。
- 系统/模块聚合的底层关系引用、业务流程步骤与关系映射。
- 简洁/详细解释的实现节点、子步骤、证据及路径；调用路径必须由同方向连续真实 calls 组成，可信状态不能高于底层事实。
- `static-confirmed` 流程转换必须由两端步骤对应的真实静态 calls 支撑。`source-supported` 顺序必须在同一真实方法/函数声明范围内拥有先后完整锚点。
- 项目、Worktree、源码、模型及解释投影必须一致；报告记录解析器/Schema、Git HEAD、源码、模型、解释定义及人工覆盖版本。
- 通过原有 `IndexManager`、`ArchitectureService` 和 `SemanticService` 读取已有授权快照并建立派生投影。扫描 worker 被禁用；不调用 `requestScan`、`watch`、`verify` 或目标程序。

命令不会遍历目标目录寻找新增文件。新增、删除或修改应先通过正常扫描/监听流程更新索引。当前文件逐个核验，文件系统不提供跨文件原子快照；建议在网页显示“已同步”且源码稳定时运行。运行期间保存的索引或模型变化会阻止输出混合快照。

## 报告阅读

`coverage` 分开显示原始关系类型/可信度（包含 `byKindAndConfidence` 交叉统计）、归属与解释审查状态、流程验证状态、源码哈希覆盖及系统/流程摘要。`groups.rules`、`groups.systems`、`groups.flows` 按原因列出可行动缺口，避免把大量待人工审查的解释误算成“未知调用”。系统计数可能因多归属重叠，不能简单相加还原全局数量。

`totals` 在已检查范围内保留完整发现数量。`findings` 是有上限的详情样本，优先保留错误，再保留警告和信息。`truncation.omittedFindings` 明确标出省略条数；分组样本也有独立截断标记。达到检查预算时 `result` 为 `incomplete`，未检查部分不能视为通过。达到详情预算不会改变检查覆盖。

退出码 `0` 表示未发现结构性错误；报告仍可能包含正常的候选解释或未验证运行边界。退出码 `1` 表示 `invalid`、`incomplete` 或命令失败。仅凭退出码 `0` 不能声称所有业务解释已人工确认、所有执行顺序已验证。

## 可重复验证

```powershell
.\.tools\node-v24.22.0-win-x64\node.exe node_modules/tsx/dist/cli.mjs --test tests/evidence-audit.test.ts
```

回归覆盖静态事实与人工审查分离、回调传递与动态目标分离、请求/协议/局部顺序、当前 hash/完整 quote/行范围、悬空引用、跨 Scope/模型快照、错误路径、检查与详情预算、输入不可变及拒绝任意报告输出路径。

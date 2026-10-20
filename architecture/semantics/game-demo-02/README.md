# 双层语义解释候选

`definitions.json` 是原有业务流程之上的中文解释定义，保留对 `claim-reserve` 与 `battle-start-poll-result` 的引用。领取流程有 6 个摘要组、16 个详细步骤；斗法流程有 7 个摘要组、19 个详细步骤。摘要不新增原始代码事实，也不把协议、跨请求或人工叙述顺序升级为已确认调用。

每个详细步骤包含目的、输入、处理、输出、状态变化与控制边界。35 个 implementation binding 仅匹配精确的方法/回调符号及文件，不自动纳入参数、局部变量、嵌套回调或整棵后代。绑定使用当前 AST 声明文本的 SHA-256，统一 CRLF，排除行号与相邻方法。两个 `PrepareResponse` 步骤与 `SetState` 的既有流程锚点只描述调用点/包含类型，因此使用真实声明证据，不把调用者锚点冒充被调用者内部证明。

初始文本为 `curated` 候选，没有人工确认记录。离线规则生成使用 `rule-generated`，仅重组现有定义，不调用外部服务、不生成新关系，先提供预览。人工文字确认、映射当前状态与底层证据可信度相互独立。

## 保存与维护

`worktrees/<worktreeId>.json` 保存某一授权 Scope 的 flowOverrides、reviews 与最多 100 条审计记录。基础候选更新不会覆盖人工 flowOverride。审计保存操作、前版本及被替代 ID；它不是全文回滚快照。不同 Worktree 不复用确认决策。

保存使用工具目录内的独立文件、wx 锁、expectedOverlayRevision 和原子替换。服务在提交前重新检查源码、原架构与解释版本；冲突时保留已有文件及用户草稿。客户端不能删除或伪造存储层审计历史。路径检查拒绝未授权 Scope、符号链接与目录联接，目标项目只读。

摘要 merge/split 只更改分组，保留所有详细步骤、精确绑定和控制边界。规则生成是候选操作，不能自动刷新声明哈希。源方法变化后应核对说明，再显式采用当前唯一声明作为新基准并复核；符号重命名、移动或歧义应维护原架构/解释绑定，不按名称猜测新目标。

## 可重复检查

在工具根目录执行：

```powershell
node node_modules/tsx/dist/cli.mjs --test tests/semantic-content.test.ts
```

初始候选构建命令只读取配置授权目录与已有索引，不扫描或执行目标代码，并拒绝覆盖已存在的 `definitions.json`：

```powershell
node node_modules/tsx/dist/cli.mjs packages/semantic-content/seed.ts game-demo-02
```

该命令用于首次创建，不应通过删除现有文件来跳过人工差异核对。后续更新应保留已编辑内容，并在真实当前声明和证据上进行局部复核。

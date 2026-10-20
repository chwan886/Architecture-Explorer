# 业务架构模型与投影

这个包在现有事实索引上计算业务系统、模块协作和流程解释，不重新解析源码，也不改变原始节点的词法 `parentId`。
人工模型由服务独立保存，技术扫描缓存不拥有人工决策。类型由主控维护在 `src/types.ts`；`model.schema.json` 是严格独立 JSON Schema，`validateModel` 另校验引用、唯一身份、路径与行范围。

主要入口：

- `buildProjection(index, model)`：按 Scope 与源码/模型版本构建投影。
- `architectureView`：业务四级入口与技术视角；技术下钻复用现有事实图。
- `entityDetail`、`relationMembers`、`ownership`：职责、原始协作成员分页及代码归属。
- `modelRevision`、`reviewFingerprint`：独立模型版本和当前审核依据。

所有导出函数纯计算。没有本地文件读取、网络、持久化或目标项目写入。

## 可信边界

业务系统是人工定义；定义确认不会批量确认归属。`owner` 才能形成系统/模块边，`participant/shared` 仅表示参与。不同主要 owner 冲突的源码实体不生成业务边。
未确认、源码已变化的归属与底层源码关系分别保留状态；不能把人工分类当作运行时事实。

选择器字段为合取条件。`qualifiedNamePrefix` 使用字面前缀，`filePathPrefix` 使用目录边界；精确名称可用文件、语言和种类收窄。
归属选择器匹配类/文件后包含其源码子实体。外部元数据节点和未进入当前索引的文件不会被模型选择器授权。

每个方向一条协作汇总线，原始关系 ID、端点、数据节点、证据与可信状态计数均保留。
类别筛选后重新统计成员、证据、主要归属来源和待确认状态。
筛选关系 ID 带 `~category=<enum>`，分页据此重建同一集合；组件/技术钻取还带可验证上下文。图最多 80 个节点，分页最多 200 个成员，均明确截断。

SourceAnchor 必须匹配当前 `index.files` 的文件及哈希；失效锚点只产生需复核诊断，不用旧行号生成新证据。
纯计算层没有源码正文，服务写入与证据读取边界必须额外校验 quote 等于指定完整行范围的原文（CRLF 归一化）。

审核指纹包含 Scope、当前定义、源码成员及文件/锚点哈希，不包含 reviews 本身。
其他 Worktree 的确认不在当前 Scope 生效；目标删除、源码变更或锚点失效保留定义并显示需复核。
模型和源码索引对象不同版本不能混合查询。

流程的 `phase` 是叙述布局顺序。`static-call` 仅在两步骤的当前成员之间存在确认的真实 `calls` 边时标静态支持；虚分发的实际实现仍未验证。
`source-order` 需要同文件有序的有效双端锚点，仍不证明运行时顺序；协议、多请求和人工叙述始终为未验证。

## 验证

```powershell
node node_modules/tsx/dist/cli.mjs --test tests/architecture-model.test.ts tests/architecture-api.test.ts
```

模型测试使用显式金标准。API 测试通过真实 Fastify、IndexManager 与 Python AST，在工具 `.tmp` 内建立独立工具根及两个授权分析目标；不访问或修改 GameDemo02。

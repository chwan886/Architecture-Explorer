# 项目内容适配

[简体中文](CONTENT-PACKS.md) | [English](en/CONTENT-PACKS.md)

工具没有默认业务项目、固定领域符号或必需的私有内容。配置授权源码，职责模型定义流程；内容包只定制解释，验收故事只声明需要核对的事实。两者都是显式加载的 JSON，不执行插件代码，也不加载被分析项目的模块。

## 通用语义种子

先在 `architecture/models/<projectId>/model.json` 维护职责与流程，再正常 Scan。初次生成解释：

```powershell
pnpm seed-semantics --config config/my-project.local.json --project my-project --dry-run
# 检查候选后，移除 --dry-run 创建尚不存在的 definitions.json。
```

必须传 `--project`；`--config` 也可由 `EXPLORER_CONFIG` 或默认本机配置提供。`--worktree` 默认为 `primary`，其他值必须对应已授权 Worktree。没有模型或流程时返回空结果（`no-model` / `no-flows`），不要求既有索引，也不创建输出。有流程时读取该作用域的已保存索引；缺失或版本、配置、源码不符时，先重新 Scan。

每个已有流程可生成候选，不要求预设 ID 或数量。明确绑定需要唯一、精确的方法/函数选择器和当前声明哈希；没有选择器的叙述步骤保留为未绑定候选，不按名称猜实现。默认说明来自模型，没有自动推断控制流或跨语言关系。

创建使用共同文件锁、完整临时文件与原子发布，拒绝覆盖任何已有定义，不修改人工覆盖和复核。`--dry-run` 同样验证输入，只输出摘要，不写定义。写入位置仅在工具目录，不能落入任一分析目标。

## 可选外部内容包

```powershell
# 仓库演示已有定义，因此只预览，不覆盖。
pnpm seed-semantics --config config/demo.json --project combat-demo --content-pack examples/content-packs/combat-description --dry-run
```

`--content-pack` 显式授权一个目录，只读取其中固定的 `content-pack.json`，最多 512 KiB，使用严格 UTF-8 和[独立 Schema](../packages/semantic-content/content-pack.schema.json)。未传参数时不搜索任何包目录。包内链接文件、额外字段、未知流程/步骤、跨步骤控制锚点及错误分组均被拒绝。

主要字段：

| 字段 | 用途 |
| --- | --- |
| `schemaVersion` | 当前为 `1.0.0` |
| `projectId` | 可选；填写后必须匹配授权项目 |
| `flows[].sourceFlowId` | 当前职责模型的真实流程 ID |
| `steps[].sourceStepId` / `text` | 定制已有步骤的标题、说明和输入输出等文字 |
| `steps[].controls` | 候选条件、循环、异步、提前返回或请求边界；锚点只能取当前步骤的有效局部锚点 |
| `groups[].stepIds` / `text` | 摘要分组，必须完整且唯一覆盖详细步骤 |

包不能提供源码路径、源码引文、符号选择器、新代码关系、运行证明或人工复核记录。所有生成节点标为 `rule-generated`，等待人工核对。[可实跑的演示包](../examples/content-packs/combat-description/content-pack.json)只依赖仓库内独立示例；自己的私有包应放在仓库外或 Git 排除范围。

## 配置驱动的证据验收

```powershell
pnpm validate-story --config config/demo.json --story Tools/stories/combat-demo.json
```

[示例故事](../Tools/stories/combat-demo.json)声明节点选择器、所需关系与局部图要求。[通用入口](../Tools/validate-story.ts)要求 `--config` 和 `--story`；项目来自 `--project` 或故事的 `projectId`，不默认选择首项目。`--worktree` 可覆盖故事选择，仍须已授权且与故事声明一致。旧 `Tools/validate-hp.ts` 仅转发相同参数，没有内置故事。

- 节点选择器必须唯一匹配当前索引；缺失和歧义均失败。
- 关系可声明 `kind`、`confidence` 和 `minCount`，默认只接受 `static-confirmed`；接受 `inferred` 需要在 JSON 中明确声明。
- 每条匹配关系的当前证据、完整元数据、源码与最终索引版本均需一致。局部图还可检查 `requiredKinds`，超出显示预算不会冒充通过。
- 命令正常扫描授权目标，随后核验事实与缓存；不构建或执行目标程序。报告原子写入工具缓存中的固定文件名，无任意输出路径参数。

结构、证据或版本要求不满足时退出码为 1；通过为 0。通过只表示配置要求的静态事实成立，不表示运行时顺序、动态目标或跨语言值传播已经验证。

## 回归与发布

内容包和故事测试均使用合成目标，覆盖无包、空模型、多项目、Worktree 隔离、陈旧/歧义证据、非法路径和只读保护。公开版保留全部产品测试；发布副本在没有任何外部私有模型、配置和缓存的环境独立运行完整套件，见[发布审计](PUBLICATION.md)。

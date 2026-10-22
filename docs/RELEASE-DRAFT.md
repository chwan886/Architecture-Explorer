# 私有工具 Release 草稿

目标链为游戏 PR 经检查和独立审查合入 main → 游戏 main 成功检查 → 固定七字段触发工具 main → 完整工具包和准确游戏 SHA 索引核验 → 私有工具 Release 草稿。最终由用户发布产品草稿。游戏 Windows Release 不在此链中。

工具页面仍是人工维护说明，没有 GitHub 凭据、实时状态或发布按钮。功能部署、本地测试和真实成功运行必须分别记录；没有实际草稿回执不能宣布端到端成功。

## 权限与执行

`game-index.yml` 的 `build-index` 继续仅有本仓 `contents: read`。游戏读取 App 和发送 App 的既有权限不变。只有依赖成功 producer 的 `draft-release` job 有本仓 `contents: write`、`actions: read`；它仅在私有工具仓库、受保护 main 的 workflow_dispatch 中运行，使用 `architecture-delivery` Environment。

草稿 job 校验锁文件中的官方 Node ZIP 摘要，只准备 Node，直接运行可擦除类型的 TypeScript。它不安装依赖、不运行测试、分析器或任何下载产物中的代码，也不再次 checkout 游戏。写 token 只提供给官方 artifact 下载 Action 和固定端点的草稿入口；不复用开发 App、游戏读取 App 或 Owner 登录。

[GitHub 权限规则](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)要求按 job 指定权限；未列权限保持关闭。生产凭据不进入 PR 检查。

## 冻结证据

producer 成功后输出自己的 run ID、attempt、工具 SHA，以及 tool/index/checks 三个 artifact 的准确 ID 和 ZIP SHA256。仅重跑草稿 job 时，producer attempt 保持不变；新的 publisher attempt 单独记录。全部 jobs 重跑则生成新的 producer attempt、产物和 tag。

固定官方 `actions/download-artifact` v8 commit `9000827ccba6bdab643e8b6fd33ac0654aef8333`，按 ID 下载且 `skip-decompress: true`、`digest-mismatch: error`。随后再核对 producer digest、REST artifact digest、真实 ZIP 字节和身份，不能只凭 Action 下载成功。[官方输入定义](https://github.com/actions/download-artifact/blob/9000827ccba6bdab643e8b6fd33ac0654aef8333/action.yml)

原生 ZIP 适配器不提取文件，只读取全部条目元数据和限定 JSON。压缩包限 512 MiB、条目 200000、声明展开量 2 GiB；单份 JSON 实际解码限 32 MiB、合计 64 MiB。路径穿越、重复/冲突、链接、非法 UTF-8、预算超限及读取期间 ZIP 改变均失败。非选定二进制不进行执行或完整解压/CRC验收；其完整性依赖冻结 ZIP 摘要和可信 producer 的真实构建、包启动及源码只读证明。

必须一致的证据包括：

- `delivery-result.json` 的各阶段成功及两个完成布尔值。
- 工具 `build-manifest.json` 的准确 SHA/run/attempt、干净源码和源码摘录告知。
- 唯一 `package-smoke-tool-<工具SHA>-<producerRun>-<producerAttempt>.json`，且清理和临时凭据移除已通过。
- 精确游戏索引的 manifest、非空 `metadata.gitHead`、Audit revision/状态、引用指纹、来源授权与前后源码/人工模型只读证明。

Audit 的 `gaps`、partial 语义范围和待复核数量保留原样，不重写为人工确认。来源游戏工作流可因发送 job 尚在执行而 in_progress；既有授权已核对同 attempt 的 fast-gate，不增加等待整个来源工作流完成的死锁条件。

## 草稿、资产与重跑

tag 固定为 `ae-tool-<完整工具SHA>-game-<完整游戏SHA>-r<producerRun>-a<producerAttempt>`。两份资产直接采用已验证的原 tool/index artifact ZIP 字节，另附确定性的 `release-manifest.json`，记录所有 SHA、来源/producer run、artifact ID/摘要、引用/分析器指纹、限制与访问范围。

创建请求始终 `draft=true`、`prerelease=true`、`generate_release_notes=false`、`make_latest="false"`，准确 target_commitish 为实际工具 SHA。入口只有 GET 和创建/补缺资产的 POST，没有 PATCH、删除、强改 tag、批准、合并或发布请求。

重跑分页查询现有草稿并核对 tag、精确绑定、Actions bot 作者和已有 tag 的实际 commit。相同资产仅在 uploaded、长度和 SHA256 完全一致时复用；缺失才上传。冲突、starter、不完整身份、重复草稿或已发布状态均停止，不自动覆盖或删除。

创建或上传失败可能留下真实不完整草稿；失败回执记录其实际 ID/状态，job 保持红色。用户应等待 publisher job 成功后才手动发布。每次写前和最终都会重读草稿状态；GitHub API 不提供跨 GET/POST 的原子人工发布锁，不能声称能阻止外部人工并发操作。[Release API](https://docs.github.com/en/rest/releases/releases)、[资产 API](https://docs.github.com/en/rest/releases/assets)

当前官方创建限制：若冻结工具提交与默认分支存在工作流文件差异，创建 Release 可能需要 `workflows: write`，而 `GITHUB_TOKEN` 不能获此权限。因此本版要求创建时工具 SHA 仍等于受保护 main tip；main 前进则明确阻塞。重新从 main 启动同一准确游戏七字段，得到新的实际工具 SHA，不改旧产物的 target，不追加宽权 App。[官方限制](https://docs.github.com/en/rest/releases/releases#create-a-release)

## 供应与产品边界

Unity 引用 ZIP 是独立私有 CI 依赖，可由维护者授权发布到专用依赖 Release，以固定 asset ID 和 SHA256 读取；它不是工具产品草稿。产品工具包和游戏索引不包含 Unity DLL，继续保持游戏资料允许的读者范围，不发布公开 Pages/Release，也不构建本地缓存导入系统。

真实验收记录必须包含：部署工具 SHA、来源七字段、producer/publisher run 与 attempt、检查和两类 artifact、真实 Release ID/URL/tag、`draft=true`/空 `published_at`，以及三项资产的实际 ID、字节数和摘要。草稿一般只对有 push 权限的读者可见；访问页面行为不能代替这些证明。自动发送的启用仍由两仓独立接入步骤控制。

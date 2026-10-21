# 开发交付流程与 GitHub 接入合同

这是人工维护的交付流程说明。工具页面不查询 GitHub 实时状态，不保存 GitHub 凭据，也不提供审批、合并、重跑或发布操作。图中的顺序表示交付约定，不是 C#/Python 静态调用关系或运行时证据。

## 实施范围与验收

本轮只负责 Architecture-Explorer：工具 PR/main 的 Windows CI、游戏提交接收端、复用 Scan/Verify/Audit 的只读快照包装、工具构建包、快照证据包及流程页面。游戏仓库只读核查，发送端提供[旧基线最小参考补丁](ci/game-trigger.patch)、[job 片段](ci/game-trigger.fragment.yml)和[脚本参考](ci/dispatch-explorer.ps1)；游戏主控已在实施发送端，不覆盖其现有改动或第一阶段 Fast CI、报告和 CODEOWNERS 成果。

验收分四类记录，不能相互代替：本地实际执行的检查；已完成的工作流文件；GitHub 人工设置；远端实际运行。当前只做本地独立提交，不推送、不合并、不配置平台、不清理已有成果。真实端到端结果必须在首次接入后由两位主控补证。

2026-10-21 的只读核实结果：

| 项目 | 工具 | 游戏 |
| --- | --- | --- |
| 原有仓库 | `chwan886/Architecture-Explorer` | `chwan886/GameDemo02` |
| origin | `https://github.com/chwan886/Architecture-Explorer.git` | `https://github.com/chwan886/GameDemo02.git` |
| 远端默认分支 | `main` | `main` |
| 可见性 | private | private |
| 当前认证访问 | pull/push/maintain/admin 可用 | pull/push/maintain/admin 可用 |
| 远端 main | `e388133a859d6f5494d69a2d1dec0ab947c7ad83` | `8118b73bb632d6618720c47ac95ad95d6b349d55` |
| main 保护 | **未启用，阻塞正式接入** | **未启用，阻塞正式接入** |

连接器曾返回不可见；随后通过原有 Git 认证的只读 API 核实上述元数据。访问权限不构成修改 GitHub 设置的授权。沿用仓库、历史、私有可见性及 origin；不得新建替代仓库。工具实现位于 `E:/Codex/worktrees/cd84/Architecture-Explorer`，与原目录 `E:/Projects/Architecture-Explorer` 共享 Git 历史；开始时工具 worktree 干净、detached HEAD，游戏 main 干净且领先本地 origin/main 13 个提交。游戏本地成果不能用远端旧 SHA 代替或重置。

最新工具侧交接统一见 [receiver-handoff-v1.txt](ReviewEvidence/receiver-handoff-v1.txt)，绝对路径为 `E:/Codex/worktrees/cd84/Architecture-Explorer/docs/ReviewEvidence/receiver-handoff-v1.txt`。其中分别记录接收端 ready 状态、实际检查、缺少项和真实远端证据；没有执行的 run 不填写虚构链接。上表是本轮开始时的核实快照，不能代替最新就绪材料。

收尾时重新只读用户指定的同一游戏交接文档：其已确认游戏本地和远端 main 同为 `f2761432cfa68140b7b095112cc5e0ee2fda3cd4`，既有 13 提交的同步待办已完成并取消。此结论来自游戏主控的新交接材料，不表示第一阶段 CI 或发送端已经合入 main，也不表示保护/远端检查已通过。

工具自身 [CODEOWNERS](../.github/CODEOWNERS) 已补齐，唯一所有者为 `@chwan886`。敏感路径包括工作流、依赖/工具链、读取/分析/协议边界、源码锚点和交付证据，普通 UI/CSS 不全仓加门禁。必须在 main Ruleset 启用 Code Owner review；首次引入时 base 尚无该文件，仍须独立人工审阅，且本人不能批准自己作者的 PR。依据[GitHub CODEOWNERS 文档](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)。

## 人工与自动阶段

| 阶段 | 责任、输入与输出 | 通过条件、阻塞及失败处理 |
| --- | --- | --- |
| 1. 任务范围/变更分级 | 用户与游戏主控；需求→范围、所有者、风险和验证计划 | 依据 Development/ChangeControl。范围不清先补齐；架构方向或门禁变更按原规则审阅，普通小改不新增审批。 |
| 2. feature 分支与 PR | 游戏执行者；批准范围→可审阅提交及 PR | 保留历史，提交必要源码/资源/文档。独立成果不得混入；未完成门禁应明确待验收。 |
| 3. CI 与独立 Review | GitHub 自动检查、独立审阅者；PR→检查结果和审阅记录 | **两者均须满足**。CI 失败、取消、零测试或跳过不算通过；独立 Review 不由作者自审替代。 |
| 4. 高风险/门禁的本人批准 | 用户；冻结变更及风险说明→明确批准或要求修订 | 依据 ChangeControl；批准不能覆盖 FAIL 或失败测试。内容变化后重评，不接受 payload 的 `reviewed=true`。 |
| 5. 合并受保护 main | 有权限的维护者/GitHub；通过检查及批准的 PR→main 提交 SHA | main 必须强制 PR、至少一位独立审阅、所需检查，禁强推/删除，审核绕过名单。平台未配置时阻塞。 |
| 6. main 检查 | 游戏 GitHub CI；准确 main SHA→Fast、工具与文档检查报告 | 使用第一阶段主控确认的工作流和全部相关 job；失败或取消不触发。远端 Fast 不等于 Unity Full。 |
| 7. 跨仓库触发 | 游戏 GitHub job；成功 main 检查→请求回执和真实目标 run 链接 | 仅固定仓库、受保护 main 的 push，启用开关开启后发送。PR、未合并关闭、失败/取消无正式触发。请求被接受不等于目标构建成功。 |
| 8. 工具构建 | 工具 GitHub CI；受保护工具 main→实际工具 SHA、测试报告、前端与 C# worker | 锁定工具链和依赖；Typecheck、Test、前端 Build、C# Build 均通过。失败保持红色，保留必要诊断。 |
| 9. 精确 SHA 扫描与核验 | 工具 GitHub CI；输入游戏 SHA、显式 Unity 元数据→Scan/Verify/Audit 证据 | 检查允许来源与 main 历史；准确 SHA checkout、HEAD 非空、metadata.gitHead 相等，扫描前后只读核对。引用缺失或 Git 失败阻塞，不用最新 main 顶替。人工锚点过期保留待复核。 |
| 10. 产物与失败处理 | 工具 GitHub CI/维护者；验证结果→分开的工具包和快照证据包 | 按 SHA/run/attempt 区分产物；失败在目标 Actions 标红，可到 GitHub 重跑。不得自动撤销已合并游戏、改写历史、发布 Pages/Release 或自动导入本地缓存。 |

游戏日常 Full 目前只做横屏（默认 1280×800）；竖屏留到 Release。第一阶段远端 Fast 不构成 Unity、Windows Player、Full 或 Release 已通过的证据。流程依据游戏的 `Docs/Handbook/Development.md`、`Docs/Handbook/ChangeControl.md`、`Docs/GitPolicy.md`、`Tools/verify-project.ps1`；本轮不改写这些游戏规则。

## 接收接口 v1

目标仓库为 `chwan886/Architecture-Explorer`，工作流为 `.github/workflows/game-index.yml`，事件为 `workflow_dispatch`，请求顶层 `ref`（target_ref）固定 `main`。工作流文件必须已进入默认分支才可调用。只执行该次 dispatch 固定的工具提交，记录实际工具 HEAD，不执行 feature 或游戏提交提供的脚本。正式输入严格为以下七个字符串，不临时兼容旧字段合同：

| 输入 | 约束 | 用途 |
| --- | --- | --- |
| `contract_version` | 严格等于字符串 `1` | 固定接口版本 |
| `source_repo` | 严格等于 `chwan886/GameDemo02` | 来源白名单，不能任意指定仓库 |
| `source_ref` | 严格等于 `refs/heads/main` | 固定受保护来源分支 |
| `source_sha` | 本次 main push 的完整 40 位小写十六进制 SHA | 精确 checkout 及索引 metadata 对照，禁止使用 PR head 或替换最新 main |
| `source_run_id` | 正整数 run ID | 通过游戏 Actions API 核对事件、分支、SHA 与已成功的来源检查 |
| `source_run_attempt` | 正整数 attempt 字符串 | 核对发送当次 run attempt，禁止临时取 latest 替代 |
| `source_run_url` | 严格匹配 `https://github.com/chwan886/GameDemo02/actions/runs/<source_run_id>` | 追溯链接，不能接受任意 URL |

发送 job `dispatch-explorer` 的 `needs: [fast-gate]`，属于已确认的 `Architecture and server`（`.github/workflows/architecture.yml`）。第一阶段本地提交为 `faca62dc6fcd30fa08ef4fac59b0db83d8ded448`，尚未进入 main；`fast-gate` 是唯一候选检查显示名称，尚未在远端注册和验证，不能当作已启用的必需检查。应先由游戏主控在真实 run 与规则中确认准确 job/check 名，再填写工具受保护 Environment 的来源配置。

发送时来源 run 整体可能仍在运行。接收端读取精确 `/actions/runs/<id>/attempts/<attempt>` 及其 jobs，核对本次 `fast-gate` 内 Fast/tools 已成功；不要求包含发送 job 的整个来源 run 已完成，也不读取 latest attempt 顶替。来源必须是 `push`、`main`、相同 SHA、约定工作流。`source_run_url` 始终为基础 run URL，回执另派生 `sourceAttemptUrl = <source_run_url>/attempts/<source_run_attempt>`。游戏 SHA 必须是允许的远端 main 历史祖先。main 保护及独立 Review 是平台前提，不能靠调用者自称。

`Tools/ci-authorize.ts` 在 checkout 游戏前通过只读 GitHub API 核对双方仓库、默认分支、有效 main 规则、游戏/工具 SHA 历史、来源 run 和必需 jobs。任何 Git/API 权限读取失败都阻塞；403/404 不能当作保护存在。工具 `GITHUB_TOKEN` 仅 `contents: read`，因此工具 main 要采用可通过有效规则接口读取的 **Ruleset**，含至少一位 PR 审阅者、Code Owner review 及准确的 `Tool / typecheck, tests and builds` 必需检查；仅 classic protection 时接收端失败关闭。游戏读 App 有 Administration read，可兼容 classic protection；classic 还需对管理员强制生效。接收端聚合全部有效 Ruleset 的审批数量（最大值）、各布尔门禁（任一要求即生效）和状态检查，必须覆盖主控确认的 `GAME_REQUIRED_CHECK_CONTEXTS`，不能把规则顺序或任意无关检查代替门禁。

接收端还检查该游戏 SHA 对应的真实已合并 PR：`merge_commit_sha` 必须等于输入 SHA，base 为固定游戏仓库的 main。分页读取 Review，以每位审阅者合并前的最新决定为准（普通 `COMMENTED` 不撤销批准），GitHub 类型为 `User` 的非 PR 作者、非 bot 审阅者，必须对准确 PR head SHA 提交 `APPROVED`，且发生在合并之前；有效独立人数须达到游戏保护的实际审批门限，至少一人。已驳回、已撤销、过期 head、自审或合并后补审均不能通过。游戏保护还必须启用 Code Owner 审阅、新 push 撤销旧批准、最近 push 的独立批准、严格保持最新检查与讨论解决；不会给普通游戏文件扩大 CODEOWNERS 范围。回执保存 PR 与审阅证据；工具侧此处证明平台规则，不声称已核验工具 PR 的审批数量。main 上的直接 push 或找不到精确合并 PR 的旧 SHA 不满足此接入合同，不能以 `reviewed=true` 绕过。API 依据[关联 PR](https://docs.github.com/en/rest/commits/commits?apiVersion=2026-03-10#list-pull-requests-associated-with-a-commit)与[PR Review](https://docs.github.com/en/rest/pulls/reviews?apiVersion=2026-03-10#list-reviews-for-a-pull-request)官方合同。

Ruleset 的管理员/机器人绕过名单仍须由维护者人工审核，设保护 Environment 的 `RULE_BYPASS_REVIEWED=true` 后接收端才继续。它记录人工配置前提；不能当成程序已经证明每一次操作全程没有绕过。保护回执的 `requiresIndependentReview` 表示规则要求，实际审阅记录单独列在 `mergedPr` 中。

发送脚本使用 GitHub REST `2026-03-10`：成功返回 HTTP 200 及 `workflow_run_id`、`run_url`、`html_url`。校验返回的固定目标仓库 URL 后保存请求回执；不用“最新一次 run”猜测关联。`targetConclusion: not-observed` 明确表示只知道请求被接受。接口依据[官方 workflow dispatch 文档](https://docs.github.com/en/rest/actions/workflows?apiVersion=2026-03-10#create-a-workflow-dispatch-event)。

输出分层：

- 游戏发送回执：参考脚本写 `artifacts/ci/explorer-dispatch.json`，记录合同版本、双方仓库、来源 ref/SHA/run/attempt、基础与 attempt URL、真实目标 run、请求接受状态。游戏主控可按其已实施的回执位置交付，工具侧不覆盖该实现；不写令牌。
- 工具构建包：前端 `dist`、TypeScript/tsx 后端与 MCP 启动所需源码和运行依赖、C# worker 及依赖、Python 分析器、锁文件和启动说明。**dist 单独不是完整工具包**；使用方仍需按说明配置本机授权目录和可用 Python/.NET 环境。
- 索引证据包：工具侧 `.ci-output/<game-sha>/<run-id>-<attempt>/index-evidence/` 中的 `index.json`、`architecture.json`、`semantics.json`、`audit.json`、`references.json`、`manifest.json`、只读前后摘要与必要阶段日志。记录实际工具 SHA、游戏 SHA、配置/引用指纹、分析器版本、限制、来源/目标 run 链接；人工模型副本保留原文字和复核记录。它是 CI 快照证据，不承诺复制到本地 `.cache` 即可使用。本轮没有自动安装或缓存导入功能。

工具构建包也含游戏源码摘录：它保留 `architecture/models/game-demo-02/model.json` 的 `anchors[].quote`、人工语义解释和文档，不含完整游戏 checkout。包的 `RUNNING.md` 和 `build-manifest.json` 明示 `containsGameSourceExcerpts=true`；不能再声称“不含游戏源码”。索引也可能含摘录。工具 Git 仓库本身、Actions 日志、测试报告、工具包、索引和失败诊断的读者均不得超出游戏允许范围；两仓 private 不足以证明读者相同。不得公开 Pages、Release 或下载链接。

`tool-ci.yml` 的原必需检查名称不变，PR 不挂生产 Environment、不取得跨仓凭据，报告仅在私有仓库上传。main 的工具包由单独 `tool-package` job 处理，依赖检查成功，在 `architecture-delivery` 验证受保护 main、当前工具库 private 和人工 `INDEX_ACCESS_APPROVED` 后才能打包/上传；缺项明确失败。`game-index.yml` 的工具包和索引都要求来源授权输出 `index_access=allowed`，不再因工具包已构建就绕过失败的来源审核。访问变量是人工审核回执，不是程序自动比较完整权限集合的证明。

## 游戏主控集成材料

`docs/ci/game-trigger.patch` 仅以此前只读保存的旧 `.github/workflows/architecture.yml` 为基线，示范末尾增加一个 job 及新增 `Tools/dispatch-explorer.ps1`，未修改任何已有检查。它已同步七字符串正式合同与当前发送端命名，但不是针对游戏主控最新实施结果生成的补丁；最新回合未重新读取游戏文件、未重新进行游戏 apply 检查。**游戏主控已有发送端工作时不要应用本补丁覆盖成果**，只核对接口或摘取尚缺的最小内容。

游戏主控如确需参考补丁，应在自己已核实的工作区审阅差异并自行决定集成方式；有冲突时人工合并，禁止覆盖整个 workflow。工具执行者不在游戏工作区应用本轮补丁，不对游戏主控最新发送实现宣称已经检查或通过。

发送 job 的条件、脚本 guard 和游戏 `explorer-dispatch` protected Environment 共同限制 main；`EXPLORER_AUTOBUILD_ENABLED` 是独立仓库变量，初始未设或 `false`。它应在接收端就绪、人工设置与来源改动审核完成后才变为 `true`。关闭它停止新请求，已开始的目标 run 仍由 GitHub 管理；不会撤销已合并游戏。工具自己的 Environment 仍为 `architecture-delivery`，两个环境名称与凭据职责分别核对。

## GitHub 人工设置清单

以下均待有授权的维护者配置/核实；本地 YAML 存在不代表已部署。当前两仓 main 都未保护，**接收端尚未就绪，自动开关必须保持关闭**。

开发 App `chwan-dev-agent` 已创建，App ID `5417611`、Installation ID `173913073` 已通过 API 核实，两仓安装归属与各自单仓 Contents read 验证/撤销通过。注册/安装为 Contents / Pull requests / Workflows write 与隐含 Metadata read，无 Administration；只读 CI 回查可选 Actions read，尚需用户设置/接受，不能自动扩大权限。精确安装集合仍待 UI 证明。[共享本机入口](DEV-APP-SETUP.md)现有 Verify/Push/PullRequest/Status，每次仅一仓、按动作缩权、结束撤销。用户本轮仅授权工具任务分支推送和 main PR；不推游戏，不直推 main、强推、批准或合并，不回退 Owner。main 绕过与规则仍待独立审核，由 `chwan886` 最终批准。开发 App 与下表的生产发送 App、游戏只读 App 分离。

| 位置 | 设置 | 核实证据 |
| --- | --- | --- |
| 两仓 main Rules/branch protection | 强制 PR、独立 Review 至少 1 人、Code Owner review、所需检查、过期批准处理、禁强推和删除、限制绕过；两仓各自提供 CODEOWNERS | Rules 页面、有效规则 API、实际拒绝不合规合并的记录；独立开发身份与本人批准分离 |
| 游戏仓库变量 | `EXPLORER_AUTOBUILD_ENABLED=false`，确认实际 CI job/check 名及文件路径 | 设置截图/只读 API 回执，主控接口材料 |
| 工具 Environment 来源配置 | `GAME_CI_WORKFLOW_PATH` 为主控确认的 `.github/workflows/<name>.yml`；`GAME_REQUIRED_JOB_NAMES` 为精确 job 显示名 JSON 数组；`GAME_REQUIRED_CHECK_CONTEXTS` 为 PR 规则实际必需 context 的 JSON 数组 | 第一阶段报告、实际来源 run/jobs API及有效规则，对照 `needs` 覆盖全部 Fast/tools 检查；job 名与 context 分别核对，不自行猜测 |
| 两仓 Environment | 游戏 `explorer-dispatch`，工具 `architecture-delivery`；分别仅允许 `main`，核实私有仓库账户方案支持并实际生效 | Environment 分支限制及只读配置回执；PR 不得获取秘密 |
| 游戏发送 App | 仅安装到 `Architecture-Explorer`，Actions write；显式缩小 installation token 单仓/权限 | 安装仓库清单和权限清单 |
| 游戏 `explorer-dispatch` Environment | 变量 `EXPLORER_APP_CLIENT_ID`；秘密 `EXPLORER_APP_PRIVATE_KEY` | 只记录名称与归属，不输出值 |
| 工具读取 App | 与发送 App 分离；仅安装 `GameDemo02`，Contents read、Actions read、Pull requests read；兼容读取 classic protection 另需 Administration read | 安装/令牌权限、main 保护、来源 run/jobs、合并 PR/Review 读取结果；不授予写权限 |
| 工具 Environment | 变量 `GAME_READ_APP_CLIENT_ID`；秘密 `GAME_READ_APP_PRIVATE_KEY` | 只记录名称与归属，不输出值 |
| 工具 Environment 访问确认 | 审核工具仓库本身、日志/报告、工具包和索引读者均不超过游戏读者，才设 `INDEX_ACCESS_APPROVED=true`；缺失时包与索引均不能交付 | 双仓读者集合审阅日期、维护者与证据；同为 private 不足以确认 |
| 工具 Environment 绕过审阅 | 审核两仓 main 规则中全部管理员、App、机器人绕过项，只保留明确必要的特定身份或空名单，再设 `RULE_BYPASS_REVIEWED=true` | 维护者/日期、规则及绕过清单回执；变量不构成程序验证“从未绕过”的证明 |
| 工具 Unity 引用 | Secret `UNITY_REFERENCES_URL` 保存短期私有只读 HTTPS URL；变量 `UNITY_REFERENCES_SHA256` 保存不可变 ZIP 摘要 | [供应方案](UNITY-REFERENCE-SUPPLY.md)中的版本/许可、DLL/ZIP 指纹、有效期与续期责任；不能把签名 URL 当普通变量或输出到日志 |
| 工具产物权限 | 工具读者不超游戏读者；检查 Actions artifact retention 与下载权限 | 权限集合审阅和一次非授权访问被拒绝的证据 |

工具 `GITHUB_TOKEN` 只授予自身所需 `contents: read`，不用于跨仓库。App 私钥只在受保护 Environment 中；令牌按需生成、限制单仓/显式权限、job 结束自动吊销，不使用管理员 PAT。官方 [create-github-app-token](https://github.com/actions/create-github-app-token) 提供短期令牌；[Environment 文档](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)说明秘密只在保护规则满足后可用，私有仓库功能受账户方案约束。

C# worker 只读取显式程序集元数据，不执行目标程序集。Unity 引用不能使用本机绝对路径、假造类型或目标构建脚本。引用缺失时阻塞正式快照，报告缺少项。`Tools/ci-snapshot.ts` 要求清单里的准确 `unityVersion` 与游戏 `ProjectSettings/ProjectVersion.txt` 一致，每个 `references` 项有相对 DLL 路径 `path` 和实际文件 `sha256`，可显式给出合法预处理 `defines`；至少含 `UnityEngine.CoreModule.dll`，不得混入根聚合 `UnityEngine.dll`，同名 DLL 不重复。所有引用位于工具侧并逐个核对摘要。不要填假摘要或把一个 CoreModule 清单当成该游戏全部引用已经齐备。

即使引用包存在，也没有执行 Unity 实际程序集构建；C# 上下文诊断保留在索引和 manifest，出现时标记 `partial-semantic-context` 并说明限制，不能宣称完整语义分析或 Unity 编译成功。临时配置仅指向 runner checkout，缓存/输出位于工具侧，不复制 `config/local.json`。

2026-10-21 已核对官方 Actions 仓库及 tag 对应提交，工作流和游戏侧片段均固定完整 SHA，并注释主版本：[checkout v7](https://github.com/actions/checkout)、[upload-artifact v7](https://github.com/actions/upload-artifact)、[create-github-app-token v3](https://github.com/actions/create-github-app-token)。正式接入时对照工具工作流的固定版本/提交；本地示例不构成 GitHub 设置或远端执行证据。

## 首次接入顺序

严格依用户确定的顺序推进；第 3、5、6 步的远端动作需要对应授权，本轮未执行：

1. 游戏主控完成上一阶段 Fast CI、报告和 CODEOWNERS，提供实际检查名称、main 分支名及工作流位置。
2. 工具主控确定接收接口，完成工具构建、精确 SHA 扫描、验证及产物上传。
3. 工具主控＋你将接收工作流合入工具 main，手动验证一次，交付“接收端就绪材料”。
4. 游戏主控按已确认接口实现发送 job；保留独立启用开关，初始关闭。
5. 你配置受限身份、main 专用 Environment，审核合并游戏侧改动后开启自动触发。
6. 两位主控用一次真实 feature 合并联调，分别交付发送回执、工具运行与索引产物证据。

接收端就绪材料必须含实际工具 main SHA、工作流名/输入、有效保护规则、凭据权限/Environment 范围、Unity 引用指纹、手动 dispatch 的真实目标 run URL及成功产物、限制和回退方式。手动验证同样必须用具备真实独立 Review、精确合并 PR 和成功来源检查的 main SHA；若当前历史没有合格样本，应报告阻塞，不能为演示临时放宽验证。尚无这些证据时只交“本地实现完成/远端待验证”，不能称就绪。

## 真实端到端验证方案

在有权限的私有仓库、全部设置核实后执行；保留每项实际 SHA、run ID/URL、产物 ID/摘要和结果：

1. 工具 PR 在干净 Windows runner 仅用仓库夹具执行冻结还原、Typecheck、Test、前端与 C# 构建，确认 PR 无跨仓库秘密。
2. 用一个真实允许的游戏 main SHA 和已通过的来源 run 手动调用接收端。核对目标运行用的是工具 main，精确 checkout 游戏 SHA；比较 manifest、metadata.gitHead、配置/引用摘要、前后目标文件摘要。确认 Scan/Verify/Audit 和人工锚点待复核结果。
3. 发送非法来源/短 SHA/非 main 历史 SHA/不匹配来源 run，接收端必须失败；缺 Unity 引用、Git 无法读取或索引 SHA 不匹配也必须失败。诊断不可带源码/秘密到更宽权限位置。
4. 开启前核实开关关闭时 main 检查不发送；PR 打开、PR 未合并关闭、检查失败/取消都不发送；使用临时受控测试分支/失败用例验证，勿破坏生产保护规则或主分支历史。
5. 审核并合并一个真实 feature PR，保留独立 Review 与适用本人批准。main Fast/tools 成功后发送一次，核对发送回执的 targetRunId 与实际目标 run 一致；请求接受与目标最终成功分别记录。
6. 在受控缺失引用/无效配置场景证明目标失败会标红且可在 GitHub 重跑；发送端不把目标失败改写成成功，不撤销游戏合并。重跑产物以 run/attempt 隔离，不覆盖其他提交。
7. 两位主控分别交付发送回执、工具构建包、准确 SHA 的索引/审计/manifest 和界面证据。工具页面仅呈现人工说明与安全 GitHub 跳转，不出现虚构实时成功或审批。

## GitHub 入口

- 游戏：[PR 列表](https://github.com/chwan886/GameDemo02/pulls)、[Actions](https://github.com/chwan886/GameDemo02/actions)、[现有 Fast 工作流](https://github.com/chwan886/GameDemo02/actions/workflows/architecture.yml)、[规则](https://github.com/chwan886/GameDemo02/rules)。
- 工具：[PR 列表](https://github.com/chwan886/Architecture-Explorer/pulls)、[Actions](https://github.com/chwan886/Architecture-Explorer/actions)、[接收工作流](https://github.com/chwan886/Architecture-Explorer/actions/workflows/game-index.yml)、[规则](https://github.com/chwan886/Architecture-Explorer/rules)。

没有具体 PR/run 时使用列表入口，不编造编号。工作流文件尚未推送时对应入口可能没有运行；这不代表实时成功或部署就绪。

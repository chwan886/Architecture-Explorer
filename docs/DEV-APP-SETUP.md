# 两仓共享开发 App 入口

状态：**共享入口已实现并通过本地验证；真实工具和游戏单仓 Verify 已通过。** 已核实 App ID `5417611`、Client ID `Iv23lil3cvGyWUbx4yfS`、slug `chwan-dev-agent`、Installation ID `173913073`，以及两仓属于该 selected 安装。合并后本地新增只读 `-InspectMain`，复用原认证与撤销流程；五模式及本轮 API 适配源码尚未推送或进入工具 main。工具 PR/CI、main 核验及生产缺项分别以真实回执为准；本文不把功能实现等同于远端写入、CI 通过或生产就绪。

上一阶段用户授权使用 App **只推送 Architecture-Explorer 本次任务分支并创建以 main 为 base 的 PR**，不合并；游戏侧由工具主控执行的操作仅只读 Verify。共享入口交给游戏主控后，游戏推送/PR 仍由其取得对应授权再使用；工具主控不直接推游戏。随后用户报告两仓 PR 已合并，授权核验工具 main、整理生产接收端与 Unity 引用缺项，并在配置完成后使用游戏主控提供的准确 SHA/run/attempt 手动验收。`chwan886` 保留最终独立批准，自动发送继续关闭；该阶段没有扩大开发 App 权限。

## 身份、安装与权限

沿用两个现有仓库和 origin，不重新建仓、重装 App 或修改可见性：

- `chwan886/Architecture-Explorer`
- `chwan886/GameDemo02`

App 初次核实的注册和安装权限为 Contents、Pull requests、Workflows write，以及隐含 Metadata read。用户随后保存并接受 **Actions read** 用于单仓CI结果查询；2026-10-21T23:01:29Z 已由 API 核实 App 及安装均具备该只读权限。实际权限仍以每次 API 核实为准。不会增加 Actions write、Checks、Commit statuses、Administration、Secrets、Environments、Variables 或账号/组织权限。Workflows write 只用于工作流文件写入，不授权重跑、dispatch、配置 Actions 或修改规则。[权限参考](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)、[Git 访问权限](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-git-access)

安装应使用 Only on this account / Only select repositories。App JWT 能核对 selected、唯一账号安装及两个目标仓库的归属，但不能列举安装的完整仓库集合；单仓 IAT 列表也不能排除第三仓。**“恰好只安装上述两仓”仍待用户在 GitHub 安装设置 UI 核实并保留非秘密证据**；入口不为此额外铸造覆盖整个 installation 的 token。

本机私钥目录使用 `C:/Users/chwan/AppData/Local/ChwanDevAgent/keys`，不把 PEM 放入仓库、worktree、`.tmp`、构建包或聊天附件。开发 App 的私钥/token 不放入任何 GitHub Actions secret，不给 PR 检查。生产发送 App 和游戏只读 App 仍各自独立，使用各自 main 专用 Environment；不得复用开发身份替代它们。

## 五模式接口

两个主控均从同一绝对入口调用 `Tools/dev-app-auth.ps1`，使用工具仓库锁定的 Node/tsx；无需复制私钥或脚本到游戏工作区。`-Verify`、`-Push`、`-PullRequest`、`-Status`、`-InspectMain` 五选一。`-Repository` 仅接受上述两个完整仓库名，默认工具库以兼容原 Verify 命令；不接受任意 owner/repo、URL、API endpoint 或命令回调。

| 模式 | 必需参数与行为 | 单次 IAT 权限 |
| --- | --- | --- |
| `-Verify` | `-Repository` 可省略；核验指定仓库单仓范围和 `main` Git reference，只读 | `contents:read`，允许隐含 `metadata:read` |
| `-Push` | `-WorkingDirectory`、`-Branch codex/...`、`-ExpectedHead`；核验本地 origin/当前分支/准确 HEAD，只推指定任务分支 | `contents:write`；遍历待推历史，保守判断需要时附 `workflows:write` |
| `-PullRequest` | `-Branch codex/...`、`-ExpectedHead`、`-Title`、`-BodyFile`；可选 `-PrNumber` 更新已有 PR；base 固定 `main`，无 base 参数 | `contents:read`、`pull_requests:write` |
| `-Status` | `-ExpectedHead`、`-PrNumber`；先确认 PR 与准确 head，再读取实际可见的 CI 结果 | `contents:read`、`pull_requests:read`；仅 App 已实际具备时附 `actions:read` |
| `-InspectMain` | `-ExpectedHead` 为主控核实的完整 main SHA、`-PrNumber` 为真实已合并 PR；实读 main 必须相等，随后只读冻结 SHA 的合并/历史、规则、文件指纹和 main push CI | `contents:read`、`pull_requests:read`；仅 App 已实际具备时附 `actions:read` |

每个 token 只指定本次一个仓库，响应仓库集合、实际 permissions、到期时间和 `/installation/repositories` 必须符合请求。不会因 App 安装在两仓就默认取得两仓 token；不会省略 permissions 继承全部写权限。不固定 token 的长度或格式。[Installation token 契约](https://docs.github.com/en/rest/apps/apps?apiVersion=2026-03-10#create-an-installation-access-token-for-an-app)

`-ExpectedHead` 必须为已核实的完整 40 位 SHA。`-BodyFile` 必须是工具根内普通 UTF-8 文件，不经过链接，大小不超过 64 KiB，并拒绝 PEM 内容；不得包含凭据。PR 创建用 `POST /pulls`，更新仅 `PATCH /pulls/{n}` 的 `title/body`，禁止修改 base、head、state 或启用 auto-merge。操作前后核验同仓 head 分支/准确 SHA、base=`main`、PR 状态及作者；作者须为 `chwan-dev-agent[bot]`、`type=Bot`，并与公开 `/users/chwan-dev-agent%5Bbot%5D` 取得的 bot numeric ID 一致，不能把 App ID 当 bot ID。[PR REST](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10)、[官方 bot ID 示例](https://github.com/actions/create-github-app-token#create-a-git-committer-string-for-an-app-installation)

以下是已验证接口的命令模板。先替换真实任务分支、准确 SHA 和已准备正文路径；每次 `-ReceiptPath` 必须使用工具独立子目录内全新绝对 `.json` 路径，父目录已存在且不经过链接。示例名不代表已有回执，也不授权执行游戏写入。

```powershell
$entry = 'E:/Codex/worktrees/cd84/Architecture-Explorer/Tools/dev-app-auth.ps1'
$keyDirectory = 'C:/Users/chwan/AppData/Local/ChwanDevAgent/keys'

# 本轮游戏侧仅只读验证。
pwsh -NoLogo -NoProfile -File $entry -Verify -Repository chwan886/GameDemo02 -PrivateKeyDirectory $keyDirectory -ReceiptPath E:/Codex/worktrees/cd84/Architecture-Explorer/.tmp/dev-app-verify-game-001.json

# 本轮已授权的工具任务分支；不可换成 main 或游戏仓库。
pwsh -NoLogo -NoProfile -File $entry -Push -Repository chwan886/Architecture-Explorer -WorkingDirectory E:/Codex/worktrees/cd84/Architecture-Explorer -Branch 'codex/<工具本次任务分支>' -ExpectedHead '<准确40位SHA>' -PrivateKeyDirectory $keyDirectory -ReceiptPath E:/Codex/worktrees/cd84/Architecture-Explorer/.tmp/dev-app-push-tool-001.json
pwsh -NoLogo -NoProfile -File $entry -PullRequest -Repository chwan886/Architecture-Explorer -Branch 'codex/<工具本次任务分支>' -ExpectedHead '<同一准确40位SHA>' -Title '<已审阅标题>' -BodyFile E:/Codex/worktrees/cd84/Architecture-Explorer/.tmp/tool-pr-body.txt -PrivateKeyDirectory $keyDirectory -ReceiptPath E:/Codex/worktrees/cd84/Architecture-Explorer/.tmp/dev-app-pr-tool-001.json

# 以真实返回的 PR 编号读取同一准确 head；不是工作流重跑命令。
pwsh -NoLogo -NoProfile -File $entry -Status -Repository chwan886/Architecture-Explorer -ExpectedHead '<同一准确40位SHA>' -PrNumber '<真实PR编号>' -PrivateKeyDirectory $keyDirectory -ReceiptPath E:/Codex/worktrees/cd84/Architecture-Explorer/.tmp/dev-app-status-tool-001.json
```

更新既有 App PR 时，在同一 `-PullRequest` 模式加 `-PrNumber '<真实编号>'`；仍只更新 title/body。省略 `-ReceiptPath` 时只输出脱敏 JSON；交接和实际验收应保存全新回执。不要直接调用 TypeScript 入口，不运行 `gh auth login/setup-git`，不读取或回退到 Owner/GCM/CLI 现有凭据。

## 合并后的 main 只读核验

`-Status` 面向仍开放的 App PR 及 PR head；PR 合并后应使用 `-InspectMain`。后者要求显式 `-ExpectedHead` 和 `-PrNumber`：先取得单仓 main reference，与期望完整 SHA 精确比较；不一致即 `MAIN_HEAD_CHANGED_OR_MISMATCHED`，不临时改用新 main。后续内容读取固定该 SHA，main 分支读取发生变化也保留阻塞。它不会把核验时的 main SHA 自动选为正式索引的来源。

该模式核验固定仓库身份、private 可见性和默认 main、真实已合并 PR 的 base/作者/合并 SHA及其 main 历史、有效规则，以及允许路径的文件指纹。工具读取 `tool-ci.yml`、`game-index.yml`、CODEOWNERS；游戏读取 `architecture.yml`、发送合同和准确 SHA 的 `ProjectVersion.txt`。不输出完整源文件或未知 JSON 字段，不下载产物。main push runs 必须匹配 event、branch、准确 SHA和约定工作流；jobs 继续匹配实际 run ID、head SHA、attempt，返回实际 steps 和产物 ID/名称/大小/过期状态及规范 GitHub 页面链接。

业务核验请求仅 GET，不创建 PR、推送、dispatch、重跑或修改配置。认证本身仍按原协议 POST 签发窄权 token、最终 DELETE 撤销并以 GET 确认原 token 401。每次仅选择一个允许仓库，不因合并后核验而申请 Administration、Actions write、Environments 或 Variables 权限。

回执的 `mainInspection.blockers` 保留不可读、缺保护、CI 缺失/失败、文件异常等缺项。空 run/jobs、失败/跳过的必需检查或错误 SHA/attempt不能成为成功；游戏 `dispatch-explorer` 因关闭开关而跳过可与成功的 `fast-gate` 区分。`mainInspection.mainCi` 表示已读到的 main CI 结论；顶层 `outcome=passed` 只表示本次核验会话和凭据撤销通过。`mainInspection.productionReady` 始终为 `false`，`sourceTupleControllerConfirmed` 也不因核验自动变为 true。Environment、生产身份、访问/绕过人工审核、Unity 供应和真实 Game SHA index 验收仍须另行补证。

以下两条是完整绝对入口命令，已真实核验的工具 main 快照为 `72a4493e3cc33e8299e2c9bf0ba7e42a2c929368`，游戏 main 为 `3d448c5e4a6ac7148472a0e78b187674810fc118`，两仓 PR 均为真实 `#1`。用户已处理默认私钥目录，后续实测通过；命令可使用该真实目录，**每次仍重新核验唯一 PEM、ACL 和无链接边界**。调用前须确认这两个 SHA 仍是本次预期 main，并为每次回执采用全新文件名。main 核验不构成七字段 dispatch 输入已验收或生产接收端就绪。

```powershell
pwsh -NoLogo -NoProfile -NonInteractive -File E:/Codex/worktrees/cd84/Architecture-Explorer/Tools/dev-app-auth.ps1 -InspectMain -Repository chwan886/Architecture-Explorer -ExpectedHead 72a4493e3cc33e8299e2c9bf0ba7e42a2c929368 -PrNumber 1 -PrivateKeyDirectory C:/Users/chwan/AppData/Local/ChwanDevAgent/keys -ReceiptPath E:/Codex/worktrees/cd84/Architecture-Explorer/.tmp/main-inspection-tool-001.json
pwsh -NoLogo -NoProfile -NonInteractive -File E:/Codex/worktrees/cd84/Architecture-Explorer/Tools/dev-app-auth.ps1 -InspectMain -Repository chwan886/GameDemo02 -ExpectedHead 3d448c5e4a6ac7148472a0e78b187674810fc118 -PrNumber 1 -PrivateKeyDirectory C:/Users/chwan/AppData/Local/ChwanDevAgent/keys -ReceiptPath E:/Codex/worktrees/cd84/Architecture-Explorer/.tmp/main-inspection-game-001.json
```

本轮此前三个工具 `InspectMain` 会话已取得真实只读核验材料，回执分别保存，不把这些历史核验记成失败。之后第四次尝试发现默认目录中有两份 PEM，以 `EXACTLY_ONE_PEM_REQUIRED` 在预检停止；该次没有读取 PEM 内容、启动认证或申请 token。用户随后确认已处理目录，后续工具第六次、游戏第四次真实核验已通过认证与撤销，故这项历史阻塞已解除；原失败记录保留。目录权限合规仍不能替代“恰好一个 PEM”的身份选择要求。

恢复后的默认目录必须持续只含经确认属于 `chwan-dev-agent` 的一份 PEM，并满足原 ACL 和无链接要求。今后如需更换目录，由维护者处理真实文件并明确 `-PrivateKeyDirectory`；工具不按文件名、时间或逐个尝试决定身份，不擅自移动、删除、复制密钥或修复 ACL，不回退 Owner。生产游戏读取 App/发送 App 的私钥应与开发身份隔离。不得把 PEM 内容、签名 URL 或 token 发到聊天中。

当前真实核验回执为工具 `.tmp/production-main-tool-inspect-6.json` 与游戏 `.tmp/production-main-game-inspect-4.json`，两次均为单仓只读 token，最终 DELETE 204 且原 token 401。工具 PR #1 的 `mergeSha` 等于上述工具 main；main 运行的检查 job 成功，但生产打包 job 失败，整体 `mainCi=failure`，不能称完整 main CI 或生产接收已就绪。

游戏回执核实 PR #1 的 `mergeSha` 精确等于游戏 main；被审阅 head `98cbf53babd8ad1dd00eee299940556acd663060` 与 main 的 tree 均为 `c5c2cc1232973b3196b9f8e8859cca1c2a157e7f`，`headTreeMatchesMain=true`。[实际 main run](https://github.com/chwan886/GameDemo02/actions/runs/39694183685) 的 attempt 1 中 `fast-gate=success`、`dispatch-explorer=skipped`；这是关闭发送时的实际 CI 结果，不是 Unity Full、Release 或游戏运行时验证。游戏主控已另在交接消息确认准确七字段来源，但 Review、绕过名单及必需 context 仍待证明；不由该确认推导为生产就绪。人工合同仍为 `receiver_ready=false`；没有生成正式索引就绪证明。回执中的 `productionReady=false` 和来源主控确认标记不会被这些读取自动改为 true。

## PR 合并字段的 API 版本兼容

GitHub 官方将 `merge_commit_sha` 从 REST `2026-03-10` 的 PR 响应中移除，包括 PR 详情和提交关联 PR；仍使用该字段的来源校验不能靠缺字段推断“未合并”，也不能删掉精确合并 SHA 门禁。[官方 breaking changes](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes#version-2026-03-10)记录该变更；[支持版本清单](https://docs.github.com/en/rest/about-the-rest-api/api-versions#supported-api-versions)列明 `2022-11-28` 支持至 **2028-03-10**。

本地共用 `Tools/github-api-version.ts` 的 `githubApiVersion` 只对固定两仓的 `GET /repos/<repo>/pulls/<number>` 和 `GET /repos/<repo>/commits/<完整40位SHA>/pulls` 选择 `2022-11-28`，分页只允许已校验的 `page/per_page`；其他资源和方法保持 `2026-03-10`，包括 token 签发/撤销、PR 写操作及正式 workflow dispatch。后者继续要求当前版本实际返回目标 run 详情，不回退旧的 204 合同。开发入口与生产来源授权读取复用该选择函数；权限、精确 SHA、关联 PR、独立 Review、历史、来源 run/attempt 和只读门禁均未降低。

这项兼容修复及五模式源码已在本地独立提交 `1319bcb8e186f853b70510243b397aab5fc5403c`，尚未推送/进入 main；不能把本机核验成功写成 main 上生产来源授权已经修复。后续须交付独立审阅材料，经允许合入后，再使用准确来源七字段执行真实接收验证。

本轮新增实现的完整本地 `Tools/ci-check.ps1` 已 **Node 369/369 通过（JUnit 368 个 testcase），零失败、零跳过**，Typecheck、前端及 C# worker 构建成功；最新本地 JUnit 与日志位于工具 `test-results/`。这是独立于前轮 356 项历史的本地检查，不代表该兼容修复已在远端 main 执行，也不替代 Game SHA index 真实运行与产物验收。

## 凭据与 Git 传输边界

PowerShell 包装器先检查目录/文件 ACL 和路径链，拒绝链接/reparse point，要求恰好一个 PEM；允许读取主体仅当前用户、SYSTEM、Administrators，不自动修复 ACL。它不读取 PEM 内容，只将路径、非秘密 ACL 检查结果和文件身份经 stdin 交给锁定 Node。Node 再核验路径/文件身份，在进程内读取 PEM、签 App JWT 和铸造本次单仓 token。stdin ACL attestation 是可信包装器在当前用户边界内的记录，**不是防止同用户恶意进程伪造的密码学证明**。

Push 使用工具侧隔离的 bare Git 传输目录和受控 alternates 读取已核实源仓对象；不在源游戏目录执行写入、hooks 或借用源仓/Owner 配置。远端 URL 和完整 refspec 固定到所选仓库及 `refs/heads/codex/...`，禁止 main、tag、force、删除、`--all`、`--mirror`。传输进程清除继承 helper、askpass、HTTP extraheader 和全局/系统配置来源，只把本次内存 token 给专用 Git/helper 子进程环境；静态 helper 仅回应固定 HTTPS GitHub host/path，文件本身不含秘密。此令牌传递不进入源码 hooks、Setup、包管理器、测试、分析器、MCP、UI 或游戏进程。

不会修改原 origin、本机 global Git/GCM/CLI 配置或持久化凭据；JWT/token/Authorization 不进入 URL、命令行、配置、回执或日志。Git显式使用Windows Schannel信任、证书及吊销校验，不载整份系统配置；受限原始诊断只在内存映射固定错误分类，不输出原始 stderr/响应。待推历史的 workflow 判定采取保守策略，不能声称只按最终 diff 精确取到最少权限。Git/HTTP trace、`GH_DEBUG`、transcription 等不得暴露秘密。保留已有 commit author/committer 与历史，不为制造 App 作者而重写提交。

每次取得 token 后，无论动作成功或失败都在 `finally` 撤销：原 token `DELETE /installation/token` 必须 204，再以原 token 只读探测必须取得 401；未确认就不能报告整体通过。探测有界退避，401 立即停止，403/429 停止并报告未确认；签发与 DELETE 不自动重试。no-store/no-cache 只是排查措施，不宣称 GitHub 保证生效时限。回执分别记录实际远端动作和清理结果；最后 failed 不表示已经发生的推送/PR 被撤销，必须先核对真实回执，不能盲目重试。

## Status 的实际能力与限制

App 已配置并实际授予 Actions read 时，Status 读取准确 head 的真实 runs，以及相应 run attempt 的 jobs/steps，记录实际 run URL、attempt、命名 job 和结论；不重跑、取消或 dispatch。已完成的失败 job 会用同一个单仓 token 读取有限脱敏错误上下文；日志下载只允许固定 GitHub API 返回的受限 HTTPS Actions 存储主机，下载请求不携带 Authorization，拒绝后续跳转，限制时长和字节量。签名 URL、token、JWT、PEM 与原始错误响应不写回执；下载失败不掩盖 job 的失败结论。缺结果、未完成、失败、取消或读取受阻均如实记录，不把空列表、旧 SHA 或别的 attempt 当成功。回执顶层 `outcome` 表示查询与凭据撤销是否通过，CI 是否通过必须读取 `ci.outcome` 和实际 job 结论。[Workflow runs REST](https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2026-03-10)、[Job 日志 REST](https://docs.github.com/en/rest/actions/workflow-jobs?apiVersion=2026-03-10#download-job-logs-for-a-workflow-run)

没有 Actions read 时，仅尝试现有 token 可访问的 GraphQL `statusCheckRollup` 聚合，并核对 PR head/commit oid；HTTP 200 仍检查 GraphQL errors。null、错误或部分数据标为不可读；即使聚合是 SUCCESS，也不能冒充命名 CI、实际 run/产物证据或已满足分支规则。REST Checks/Commit statuses 另需相应 read 权限，本入口不增加这些权限，也不通过 Owner 认证补读。完整远端 CI 证据不足时保留未完成项。[Rollup 字段](https://docs.github.com/en/graphql/reference/commits#statuscheckrollup)、[GraphQL 权限需实际测试](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app#choosing-permissions-for-graphql-api-access)

## 已执行的认证验证

- `2026-10-21T22:11:34Z` 的工具单仓验证通过。目录及 PEM owner 为 Administrators；有效 Allow 仅当前用户、SYSTEM、Administrators，继承存在但无额外主体，路径链无 reparse point；没有修改真实 ACL。
- App JWT 核实 ID、Client ID、slug、owner；当时注册/安装权限恰为三项 write 和 Metadata read，无 Actions/Administration。唯一账号安装 `173913073` selected、未暂停，两仓 JWT membership 同安装；未证明安装没有第三仓。
- 当时 IAT 响应和实际仓库列表均仅工具库，Contents read；main ref 实读 SHA `e388133a859d6f5494d69a2d1dec0ab947c7ad83`。原定到期 `2026-10-21T23:11:34Z`，已提前撤销。
- [首次失败回执](evidence/dev-app/auth-verification-2026-10-21.json)：签发、单仓实读、DELETE 204 成功，但即时失效探测未确认；当时没记录状态，不能补写原因或401。
- [第二次通过回执](evidence/dev-app/auth-verification-2026-10-21-attempt2.json)：新建同样窄权 IAT，DELETE 204 后原 token 探测为 200、200、200、401，最后一次距开始约 2409 ms。这是本次实测，不是缓存原因结论或未来时间保证。[官方撤销契约](https://docs.github.com/en/rest/apps/installations?apiVersion=2026-03-10#revoke-an-installation-access-token)
- [共享入口游戏 Verify 回执](evidence/dev-app/shared-game-verify-2026-10-21.json)：真实游戏单仓只读验证通过，main ref SHA `f2761432cfa68140b7b095112cc5e0ee2fda3cd4`；注册权限仍为四项，没有 Actions read。
- 原认证核心及 Windows ACL/link 夹具通过，历史完整回归见 [验收记录](DELIVERY-VALIDATION.md)。这些记录未执行推送、PR、merge、dispatch、Owner fallback 或全局 Git 配置写入；共享四模式的新测试和实测由工具主控补录。

工具 Push/PR/Status 的实时回执保留在工具 `.tmp/shared-tool-{push,pr,ci}-*.json`，本轮本机回交报告使用全新路径并记录真实 PR、准确 head、CI 与限制，不为把远端回执写回已推提交而再次改变 head。真实报告绝对路径由工具主控回交；本文不预填未知 PR/run 编号或链接。

## 独立批准与待完成项

两位主控共享同一个 App，不能用它互相完成独立最终 Review。`chwan886` 审阅准确最终 head 并按 Code Owner/高风险门禁批准；App 不批准、不合并、不加入 main bypass。Contents write 不是任务分支专用权限，本机 guard 不能替代受保护 main。App 无 Administration，不能为自己改规则或秘密。CODEOWNERS 必须在 PR base branch 才用于该 PR 的自动请求/强制审阅，首次新增不能把 head 文件当成保护已生效。[独立 Review](https://docs.github.com/en/enterprise-cloud%40latest/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews)、[CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)

| 项目 | 当前情况 / 待交付证据 |
| --- | --- |
| App 与旧工具只读认证 | 已核实上述身份和安装归属；首失败及第二次通过回执保留 |
| 安装精确范围 | 待 UI 证明恰好两仓，没有第三仓 |
| 历史共享四模式入口 | 此阶段完整本地356项通过，零失败、零跳过；含原生SID别名、失败job日志脱敏、传输边界与真实额外授权拒绝，见验收记录。新增 InspectMain 的测试与实测单独记录 |
| 游戏 Verify | 真实游戏单仓只读验证已通过，见已入库脱敏回执；不直接推游戏 |
| 工具 Push / PR | 本轮已授权仅本次工具任务分支和 main PR；准确 SHA、App 作者 PR URL 和实际操作结果以本机回交报告/回执为准 |
| Status / 远端 CI | Actions read 已经真实 API 核实；已读到 PR #1 准确 head 的真实运行和失败 job，后续修复和最终 head 结果以本机回交报告为准 |
| InspectMain / 合并后核验 | 已新增本地单仓只读实现；main 必须匹配显式 ExpectedHead，不能等同生产就绪。历史两份 PEM 预检阻塞已由用户处理；最新工具6/游戏4真实会话通过认证与撤销，来源与结果见上文，源码尚未推送 |
| main / Code Owner 规则 | 待独立设置及实际验收，App 无 bypass |
| 生产身份 / Environment / Unity 引用 | 与开发 App 分离，仍按原交付合同接入与手测 |
| 自动发送 | 继续关闭，不随开发 App 验证、推送或建 PR 自动开启 |

未填项目不得替换成成功、虚构编号或链接；新增实际结果由工具主控按回执补录。权限不足或身份不符就报告，不自动扩大权限、改用 Owner、改写历史或撤销已经合并的游戏。

安装权限与 App 登记不匹配时，回执只记录固定权限名的有限等级和未知权限项数量；未知键和值不进入回执。入口以同一 JWT 对照指定安装端点，仍要求原精确权限校验通过，不因确认请求成功而忽略不匹配。此阶段不签发安装 token，故不存在需要撤销的已签发 token。

22:59 UTC 的安装列表及指定安装端点尚未返回 actions，入口安全停止；23:01 UTC 在安装 metadata GET 加非秘密随机查询参数后，完整身份/权限/单仓校验通过，并读到真实 CI，原 token 已撤销 204 且最终 401。这是当时的实测先后记录。

合并后核验版本将同一措施扩展到共享 GitHub JSON 适配器的所有 GET，用于重新观察可能变化的 App/安装、PR、规则、run 等数据；固定 job 日志下载仍采用其独立受限传输。随机参数仅补充 no-cache/no-store 请求头，不保证 GitHub 缓存行为，也不能据此前后差异推断旧响应根因。查询参数不包含凭据，固定来源、准确 SHA、身份、权限和撤销校验保持不变；POST 签发及 DELETE 撤销仍不自动重试。

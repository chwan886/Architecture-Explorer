# 两仓共享开发 App 入口

状态：**共享入口已实现并通过本地验证；真实工具和游戏单仓 Verify 已通过。** 已核实 App ID `5417611`、Client ID `Iv23lil3cvGyWUbx4yfS`、slug `chwan-dev-agent`、Installation ID `173913073`，以及两仓属于该 selected 安装。工具 PR/CI 的真实结果以本机回交报告为准；本文不把功能实现等同于远端写入或 CI 通过。

本轮用户已授权使用 App **只推送 Architecture-Explorer 本次任务分支并创建以 main 为 base 的 PR**，不合并；游戏侧本轮仅执行只读 Verify。共享入口交给游戏主控后，游戏推送/PR 仍由其取得对应授权再使用；工具主控不直接推游戏。`chwan886` 保留最终独立批准，自动发送继续关闭。

## 身份、安装与权限

沿用两个现有仓库和 origin，不重新建仓、重装 App 或修改可见性：

- `chwan886/Architecture-Explorer`
- `chwan886/GameDemo02`

App 初次核实的注册和安装权限为 Contents、Pull requests、Workflows write，以及隐含 Metadata read。用户本轮已选择增加 **Actions read** 用于单仓CI结果查询；需在App设置保存并由安装接受更新，实际是否生效以每次API核实为准。不会增加 Actions write、Checks、Commit statuses、Administration、Secrets、Environments、Variables 或账号/组织权限。Workflows write 只用于工作流文件写入，不授权重跑、dispatch、配置 Actions 或修改规则。[权限参考](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)、[Git 访问权限](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-git-access)

安装应使用 Only on this account / Only select repositories。App JWT 能核对 selected、唯一账号安装及两个目标仓库的归属，但不能列举安装的完整仓库集合；单仓 IAT 列表也不能排除第三仓。**“恰好只安装上述两仓”仍待用户在 GitHub 安装设置 UI 核实并保留非秘密证据**；入口不为此额外铸造覆盖整个 installation 的 token。

本机私钥目录使用 `C:/Users/chwan/AppData/Local/ChwanDevAgent/keys`，不把 PEM 放入仓库、worktree、`.tmp`、构建包或聊天附件。开发 App 的私钥/token 不放入任何 GitHub Actions secret，不给 PR 检查。生产发送 App 和游戏只读 App 仍各自独立，使用各自 main 专用 Environment；不得复用开发身份替代它们。

## 四模式接口

两个主控均从同一绝对入口调用 `Tools/dev-app-auth.ps1`，使用工具仓库锁定的 Node/tsx；无需复制私钥或脚本到游戏工作区。`-Verify`、`-Push`、`-PullRequest`、`-Status` 四选一。`-Repository` 仅接受上述两个完整仓库名，默认工具库以兼容原 Verify 命令；不接受任意 owner/repo、URL、API endpoint 或命令回调。

| 模式 | 必需参数与行为 | 单次 IAT 权限 |
| --- | --- | --- |
| `-Verify` | `-Repository` 可省略；核验指定仓库单仓范围和 `main` Git reference，只读 | `contents:read`，允许隐含 `metadata:read` |
| `-Push` | `-WorkingDirectory`、`-Branch codex/...`、`-ExpectedHead`；核验本地 origin/当前分支/准确 HEAD，只推指定任务分支 | `contents:write`；遍历待推历史，保守判断需要时附 `workflows:write` |
| `-PullRequest` | `-Branch codex/...`、`-ExpectedHead`、`-Title`、`-BodyFile`；可选 `-PrNumber` 更新已有 PR；base 固定 `main`，无 base 参数 | `contents:read`、`pull_requests:write` |
| `-Status` | `-ExpectedHead`、`-PrNumber`；先确认 PR 与准确 head，再读取实际可见的 CI 结果 | `contents:read`、`pull_requests:read`；仅 App 已实际具备时附 `actions:read` |

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

## 凭据与 Git 传输边界

PowerShell 包装器先检查目录/文件 ACL 和路径链，拒绝链接/reparse point，要求恰好一个 PEM；允许读取主体仅当前用户、SYSTEM、Administrators，不自动修复 ACL。它不读取 PEM 内容，只将路径、非秘密 ACL 检查结果和文件身份经 stdin 交给锁定 Node。Node 再核验路径/文件身份，在进程内读取 PEM、签 App JWT 和铸造本次单仓 token。stdin ACL attestation 是可信包装器在当前用户边界内的记录，**不是防止同用户恶意进程伪造的密码学证明**。

Push 使用工具侧隔离的 bare Git 传输目录和受控 alternates 读取已核实源仓对象；不在源游戏目录执行写入、hooks 或借用源仓/Owner 配置。远端 URL 和完整 refspec 固定到所选仓库及 `refs/heads/codex/...`，禁止 main、tag、force、删除、`--all`、`--mirror`。传输进程清除继承 helper、askpass、HTTP extraheader 和全局/系统配置来源，只把本次内存 token 给专用 Git/helper 子进程环境；静态 helper 仅回应固定 HTTPS GitHub host/path，文件本身不含秘密。此令牌传递不进入源码 hooks、Setup、包管理器、测试、分析器、MCP、UI 或游戏进程。

不会修改原 origin、本机 global Git/GCM/CLI 配置或持久化凭据；JWT/token/Authorization 不进入 URL、命令行、配置、回执或日志。Git显式使用Windows Schannel信任、证书及吊销校验，不载整份系统配置；受限原始诊断只在内存映射固定错误分类，不输出原始 stderr/响应。待推历史的 workflow 判定采取保守策略，不能声称只按最终 diff 精确取到最少权限。Git/HTTP trace、`GH_DEBUG`、transcription 等不得暴露秘密。保留已有 commit author/committer 与历史，不为制造 App 作者而重写提交。

每次取得 token 后，无论动作成功或失败都在 `finally` 撤销：原 token `DELETE /installation/token` 必须 204，再以原 token 只读探测必须取得 401；未确认就不能报告整体通过。探测有界退避，401 立即停止，403/429 停止并报告未确认；签发与 DELETE 不自动重试。no-store/no-cache 只是排查措施，不宣称 GitHub 保证生效时限。回执分别记录实际远端动作和清理结果；最后 failed 不表示已经发生的推送/PR 被撤销，必须先核对真实回执，不能盲目重试。

## Status 的实际能力与限制

App 已配置并实际授予 Actions read 时，Status 读取准确 head 的真实 runs，以及相应 run attempt 的 jobs，记录实际 run URL、attempt、命名 job 和结论；不重跑、取消或 dispatch。缺结果、未完成、失败、取消或读取受阻均如实记录，不把空列表、旧 SHA 或别的 attempt 当成功。[Workflow runs REST](https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2026-03-10)

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
| 共享四模式入口 | 本地344项完整回归及29项收尾针对验证通过；另10项Git诊断/alternates/nonff/HTTP Basic测试通过。真实写入以本机回交报告为准 |
| 游戏 Verify | 真实游戏单仓只读验证已通过，见已入库脱敏回执；不直接推游戏 |
| 工具 Push / PR | 本轮已授权仅本次工具任务分支和 main PR；准确 SHA、App 作者 PR URL 和实际操作结果以本机回交报告/回执为准 |
| Status / 远端 CI | Actions read 配置选择待用户答复；准确 head 的真实结果与可读范围以本机报告为准，无法读取则明确缺项 |
| main / Code Owner 规则 | 待独立设置及实际验收，App 无 bypass |
| 生产身份 / Environment / Unity 引用 | 与开发 App 分离，仍按原交付合同接入与手测 |
| 自动发送 | 继续关闭，不随开发 App 验证、推送或建 PR 自动开启 |

未填项目不得替换成成功、虚构编号或链接；新增实际结果由工具主控按回执补录。权限不足或身份不符就报告，不自动扩大权限、改用 Owner、改写历史或撤销已经合并的游戏。

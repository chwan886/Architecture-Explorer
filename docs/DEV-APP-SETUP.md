# 两仓开发身份 GitHub App 接入清单

状态：**App 尚未创建、安装或认证，不能据此推送或创建 PR。** 用户选定的暂名为 `chwan-dev-agent`，由两个主控用作开发身份；`chwan886` 保留最终独立批准。下列是待执行/核验清单，没有 App ID、installation ID、令牌、PR 或运行的已验证值。

此 App 只支持两个既有项目的任务分支推送和 PR 创建/更新。不改用现有 Owner 认证，不向 main 直接推送，不自动批准/合并，不加入 main bypass，不设置仓库规则，不开启 `EXPLORER_AUTOBUILD_ENABLED`。

## 创建与安装

由用户在 `chwan886` 的 GitHub Settings → Developer settings → GitHub Apps 中创建。名称必须在 GitHub 全局可用；`chwan-dev-agent` 只是候选名，冲突时先回交实际候选，不自行冒认已经创建。Homepage 可用拥有者现有账户主页，不需要为此建立服务。

本用途只使用 installation access token：不需要代表用户的 OAuth/device flow，不请求用户授权 token；没有 webhook 处理服务时停用 Active webhook，不填假地址。安装范围选 **Only on this account**，随后选 **Only select repositories**，仅勾选：

- `chwan886/Architecture-Explorer`
- `chwan886/GameDemo02`

不选 All repositories，不创建替代仓库或修改可见性。官方注册/安装步骤见 [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) 与 [Installing your own GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app)。

Repository permissions 仅设以下三项写权限，及 GitHub 隐含的 Metadata read：

| GitHub 名称 | API key | 等级 | 本次用途 |
| --- | --- | --- | --- |
| Contents | `contents` | Read and write | 经核对的任务分支 Git HTTPS 推送 |
| Pull requests | `pull_requests` | Read and write | 建立/更新以任务分支为 head 的 PR |
| Workflows | `workflows` | Read and write | 本轮涉及 `.github/workflows/` 的提交，必须具备更新工作流文件的权限 |
| Metadata | `metadata` | Read-only（隐含） | 识别安装与仓库 |

其余 Repository/Account/Organization permissions 均不授予，尤其不授予 Administration、Actions、Secrets、Environments、Variables、Checks 或 Commit statuses。**Workflows write 是工作流文件写权限，不是配置 Actions、修改规则或触发/重跑生产任务的授权。** GitHub 分别列出这些权限，工作流文件更新存在 Contents/Workflows 的组合要求；首次实际推送仍需证明该组合和安装生效。[GitHub App 权限参考](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)、[installation token 权限字段](https://docs.github.com/en/rest/apps/apps?apiVersion=2026-03-10#create-an-installation-access-token-for-an-app)

完成后由用户记录 App 的真实 name/slug、App ID、Client ID、installation ID、安装的两个仓库 ID 和权限清单。它们是接入元数据；不能记录私钥或 token。私钥由用户生成并保存在其选择的本机受保护存储，限制读取主体、准备撤销和轮换方式；不下载到仓库、worktree、`.tmp`、构建目录或聊天附件。本文件没有生成、接收或保存私钥。

## 三类 App 与凭据职责分开

| 身份 | 可访问范围 | 使用位置 | 不能复用到 |
| --- | --- | --- | --- |
| 开发 App（暂名 `chwan-dev-agent`） | 安装限两个项目；每次 token 进一步限当次单仓 | 本机一次推送或 PR 操作的短会话 | PR CI、main CI、交付 Environment、跨仓发送、游戏读取 |
| 游戏发送 App | 仅工具仓库 Actions write | 游戏 `explorer-dispatch` main-only Environment | 本机开发、游戏读取、规则配置 |
| 游戏只读 App | 仅游戏仓库、接收端所需只读权限 | 工具 `architecture-delivery` main-only Environment | 本机推送/建 PR、生产发送 |

开发 App 的私钥和 token **不写入任何 GitHub Actions secret 或工作流环境**。生产两套 App 继续使用各自独立私钥、安装和受保护 Environment；不把开发 App 的更宽写权限拿来替代它们。PR 仍只使用本仓 `GITHUB_TOKEN` 的受限权限和夹具，不能领取三种 App 的私钥/令牌。不得通过 PR 代码运行本机签名器或把 token 传给 Setup、包管理器、测试、分析器、MCP、UI 或游戏进程。

## 本机短期令牌与 Git 接入

首选由用户控制的本机签名/凭据会话：仅在授权的单次推送或建 PR 前，读取受保护私钥，在内存中生成 App JWT，向指定 installation 请求短期 token；响应只在内存中使用，不输出整个 JSON。installation token 当前有效期为一小时，可显式缩减到安装内的某个仓库和权限；它不能扩大 App 的原始权限。每位主控分别为当前仓库取 token，不默认给两个仓库同时写权限。不要把新 token 格式固定为 40 字符。[官方 installation 认证与缩减说明](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)

会话创建后先核对响应里的仓库集合、实际 permissions 和 `expires_at`：

- 工具操作只能取得 `Architecture-Explorer`；游戏操作只能取得 `GameDemo02`。
- 只有需要写 `.github/workflows/` 的推送会话才保留 `workflows:write`；只建 PR 时尽量进一步降为 Contents read / Pull requests write，按实际 endpoint 要求验证。
- 不申请 Administration 或 Owner 用户 token；缺权限/过期立即失败，不回退到 GCM 中的 `chwan886` 或其他现有账户。
- 日志只记 App/installation 元数据、仓库、分支、SHA、到期时间和操作结果；不输出 JWT、token、Authorization header 或私钥。

Git HTTPS 将 installation token 用作认证密码。官方示例把 token 放进 URL；本地接入不能照抄这种传递方式，以免 token 进入进程参数、remote、历史和诊断。保留原始 `https://github.com/chwan886/<repo>.git` origin，使用只在该次 `git` 调用中启用的临时 credential helper 或 askpass 子进程，通过受控管道/该子进程环境取得内存 token，返回静态用户名 `x-access-token` 与密码。此会话方案仍需实现和夹具/实机验证；本文件不是已有 helper 的声明。

临时 helper 必须满足：

1. 只对 `github.com`、HTTPS、当次确定的 `chwan886/<repo>.git` 路径响应，路径必须参与匹配；其他 host/path 失败。
2. 单次调用清空继承的 credential helper 链、askpass fallback 和 GitHub HTTP Authorization extraheader，再只设置本会话 helper。禁止交互式 fallback（`GIT_TERMINAL_PROMPT=0`）；不能在 App 认证失败后无意使用 Owner 凭据。
3. helper 文件如果需要落盘，只含固定程序逻辑/句柄引用，不含 token 或私钥；文件在用户批准的工具侧受限临时目录，仅创建该会话自己的文件。不得把秘密写入 `.git/config`、`.git-credentials`、`.env`、GCM 或用户全局 Git 配置。
4. 不启用 Git/GCM HTTP trace、`GIT_CURL_VERBOSE`、`GH_DEBUG`、PowerShell transcription 或输出完整子进程环境；报错不得附带 credential protocol 内容。token 不能作为 CLI 参数、URL userinfo、Base64 extraheader 或可见命令文本出现。
5. 推送前校验当前仓库 origin、分支、提交和完整 refspec；只允许此次任务分支，禁止 main/tag、`--all`、`--mirror`、删除与 force push。推送对象固定为 `HEAD:refs/heads/<已核实任务分支>`；不得让含密钥的交互结果拼接 shell 命令。
6. 调用结束关闭管道/子进程、清空会话环境和内存引用；可由签名器撤销该 token，或等待其短期失效。只移除本会话创建且绝对路径已核实的临时文件，不清理现有凭据或用户成果。

仓库 Contents write 本身不是分支级权限：它可能允许向未保护分支写入。GitHub 的权限粒度也不能单独保证“可建 PR 但永不能 merge”。所以本机 guard 不能替代受保护 main、必需检查、独立 Review 与空 bypass；在这些规则未实际生效前，不得声称 App 已被服务器限制到任务分支。

## GitHub CLI / PR 路径

如果已有来自官方渠道的 GitHub CLI，可由签名会话只向一次 `gh` 子进程注入 `GH_TOKEN`（以及固定 `GH_HOST=github.com`），在子进程结束后丢弃。CLI 官方支持通过环境变量进行无交互认证；`gh auth login --with-token` 面向 PAT 登录且可能持久化凭据，不作为本方案入口。不执行 `gh auth token`（会输出 token）、不执行全局 `gh auth setup-git`，不覆盖用户现有登录。[CLI 环境变量](https://cli.github.com/manual/gh_help_environment)、[CLI 登录行为](https://cli.github.com/manual/gh_auth_login)

installation token 不能访问所有用户类 endpoint；不能把 `gh auth status` 或 `/user` 的失败当作应切换 Owner 登录的理由。先用安装仓库列表/响应权限验证 token，并验证实际 PR endpoint 支持。若特定 CLI 版本对 App token 的 GraphQL 路径不兼容，采用 installation token 支持的 REST `POST /repos/{owner}/{repo}/pulls`，同样只在内存 header 中认证。记录真实 PR URL 和 `user.login`/作者类型，作者必须是已核实 App 的 bot；失败就停止，不换 Owner token。[创建 PR 的 API 权限与 token 支持](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10#create-a-pull-request)

PR 的仓库、head、base=main、标题、最终差异和 body 均应在请求前准备好。body 通过结构化参数或 UTF-8 文件提供，不在 shell 中拼接多行文本。创建成功后回交真实 PR URL，不编造编号，不自动合并或启用 auto-merge。

认证决定推送者及 PR 作者，不要求改写已有本地提交的 author/committer。保留既有提交与历史，分别记录 commit author、App pusher、PR bot 作者和 Owner Reviewer；不通过 amend、换邮箱或重写历史制造独立身份。

## Owner 独立批准与 main 规则

两位主控共享同一个开发 App，属于同一 GitHub 身份，不能互相以该 App 充当独立最终 Reviewer。App 作为作者推送并建 PR，`chwan886` 使用独立可信入口审阅准确最终 head，按 CODEOWNERS 及高风险/门禁规则批准；两个主控的分析与本地子代理 Review 不替代这条平台记录。GitHub PR 作者不能自批；新 push 还可能使已批准审阅失效，按有效规则重新核对。[官方必需 Review 说明](https://docs.github.com/en/enterprise-cloud%40latest/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews)

两仓 main 的 Ruleset/保护需强制 PR、必需 CI、独立批准、适用 Code Owner 批准和最新 push 复核，禁止强推/删除并不配置 App bypass。开发 App 无 Administration，不能为自己改规则、秘密、Environment 或可见性；这些由用户独立设置。

CODEOWNERS 必须存在于 PR 的 base branch 才用于自动请求/强制 Owner 审阅；本轮首次添加文件时，不能把 head 中新增 CODEOWNERS 当成该 PR 已受保护的证明。首次引入仍由 `chwan886` 手动审阅当前差异，纳入 main 并完成规则后，再用真实非草稿 PR 验证拒绝未授权合并。[官方 CODEOWNERS 行为](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)

## 就绪记录与待完成项

| 条目 | 当前状态 | 就绪所需证据 |
| --- | --- | --- |
| 实际 App name/slug、App ID、Client ID | 未创建 / null | 用户完成注册后的非秘密元数据 |
| Installation / 两仓选择 / 权限 | 未安装 / null | 精确两仓清单及仅三项 write、Metadata read；无 Administration |
| 本机私钥存储和短会话 | 未准备/未验证 | 安全存储范围、受控签名器、token 缩减与失效记录，无秘密输出 |
| Git helper / CLI / REST App 身份 | 未实现/未验证 | Owner fallback 被拒绝、单仓路径、无 token 落盘/日志、实际 App bot 作者证据 |
| 任务分支推送 / PR | 未执行 / URL=null | 两边各自收尾通过后的准确 SHA、真实远端分支及 App 作者 PR |
| main 与 Code Owner 规则 | 待用户设置/验收 | 必需检查与 Owner 审阅实际生效、App 无 bypass，拒绝不合规合并 |
| 生产两个 App / Environment / Unity 引用 | 与本开发 App 分离，仍待各自接入 | 原交付合同的独立配置和接收端手测 |
| 自动发送 | 继续关闭 | 不因开发 App 创建、推送或建 PR自动打开 |

权限扩大、替换身份或访问失败都不是自动重试 Owner 的理由。只有 App 已实际就绪、两边收尾验证通过且作用域仍匹配用户授权后，才进入各自任务分支推送/建 PR；本方案没有执行这些远端动作。

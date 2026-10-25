# 专用 GitHub App 开发入口

[简体中文](DEV-APP-SETUP.md) | [English](en/DEV-APP-SETUP.md)

此可选开发工具只负责验证 App、推送任务分支、创建或更新 PR、查询状态。项目运行和源码分析不需要 App。仓库、App、安装编号和密钥目录均来自显式本地配置，不依赖任何被分析项目或私有交付链。

## 配置

先完成常规 Windows 准备，安装 PowerShell 7、Git 和 `toolchain.lock.json` 锁定的 Node 及依赖。复制 [配置模板](../config/dev-app.example.json)到忽略的 `config/dev-app.local.json`，填写自己的 App ID、安装 ID、App slug、唯一 `owner/repository`、受保护 base 分支和绝对密钥目录。每份配置只授权一个仓库；工具没有默认账号、自动发现安装或默认目标仓库。

将一个 RSA PEM 密钥放在所有 Git 仓库之外的独立目录中。目录及文件只允许当前用户、SYSTEM 和 Administrators 访问，不接受其他主体的 Allow 权限；工具检查 SID、原始 DACL、全部路径组件和链接，不会自动修复 ACL。多份 PEM、目录联接、符号链接、硬链接或宽松权限均会拒绝。密钥只由 Node 在预检后读取，token 只在内存中使用，不进入命令行、文件或 Git 配置。

App 安装应选择需要操作的仓库。允许的权限上限是 Contents write、Pull requests write、Metadata read、可选 Workflows write 和 Actions read。更改工作流时才请求 Workflows write。工具拒绝 Administration、Actions write、Secrets、Checks、Commit statuses 等额外权限，不允许 bypass。每次签发的短期 token 必须再次证明只可见配置中的单一仓库，且权限与本次操作一致；结束或失败后撤销并验证旧 token 返回 401。

## 使用

以下占位符均需替换；配置、工作目录和 PR 正文使用绝对路径。默认只选择仓内锁定 Node，不从 PATH 猜测运行时；CI 或独立安装可用 `-NodeExecutable` 显式指定**同一锁定版本**的可执行文件。

```powershell
$config = 'C:/work/explorer/config/dev-app.local.json'
$work = 'C:/work/explorer'
./Tools/dev-app-auth.ps1 -ConfigFile $config -Verify
./Tools/dev-app-auth.ps1 -ConfigFile $config -Push -WorkingDirectory $work `
  -Branch codex/my-change -ExpectedHead '<完整40位提交SHA>'
./Tools/dev-app-auth.ps1 -ConfigFile $config -PullRequest `
  -Branch codex/my-change -ExpectedHead '<完整40位提交SHA>' `
  -Title 'Describe the resulting change' -BodyFile 'C:/work/explorer/.cache/pr-body.md'
./Tools/dev-app-auth.ps1 -ConfigFile $config -Status `
  -PrNumber 123 -ExpectedHead '<完整40位提交SHA>'
```

Push 仅接受当前干净工作目录的显式 `codex/` 分支及准确提交，origin 必须匹配配置；隔离 Git 配置、hooks、helper、环境注入和认证信息，只做非强制单分支推送。PR 必须指向配置中的 base、准确 head，并由实际 App bot 创建；可用 `-PrNumber` 更新该 bot 的同一 PR 标题与正文，不能改 base 或操作其他作者的 PR。工具不提供审批、合并、自动合并或仓库规则变更。

推送前先更新本地 `origin/<base>` 跟踪引用：它必须存在、为待推 head 的祖先，并与实时 GitHub base SHA 一致，否则拒绝推送。工作流权限依据该 base 到 head 的完整提交历史判断，包括先修改后撤回的工作流；base 中已有工作流本身不会扩大权限。获取公开 base 可用禁用 helper 的只读 fetch；私有仓库应通过独立授权的 App 读取方式准备本地对象，不能借用个人凭据完成推送。

任何验证、认证、推送、PR、权限或撤销失败都必须停止。**禁止回退个人账号、Git Credential Manager、`gh auth`、GitHub connector 或 `GH_TOKEN` / `GITHUB_TOKEN`。** 下载 PEM 并不会自动改变普通 Git 的推送账号；开发时必须使用这个入口。终端只输出不含凭据的结果，避免把真实本地配置和回执提交进仓库。预检在当前用户信任边界内工作，不是对同用户恶意进程的密码学证明。

## 人工审核与多人维护

main 应强制 PR、至少 1 人批准、Code Owner 批准、最后推送者之外批准、CI 通过和解决讨论，并禁止强推与删除。App 没有管理员权限和 bypass；仓库所有者修改保护是独立管理操作，不属于开发工具的凭据回退。

[CODEOWNERS](../.github/CODEOWNERS) 默认将所有文件交给人类维护者。新增协作者时先授予其仓库 write 权限，再将账号或组织团队加入同一规则行；机器人不列为 Code Owner。单人维护也可由 App 推送并开 PR、维护者批准和合并。批准前的最后一次推送应由机器人完成；维护者自行推送或更新分支后，需要另一名满足规则的审核者。

恢复 CODEOWNERS 的首次 PR 使用旧 base 分支，该文件尚不能为本 PR 自动指定 Code Owner。该 PR 仍受 1 人批准、最后推送审批和 CI 约束，维护者人工审查；合并后 CODEOWNERS 才对后续 PR 生效。详见 [GitHub 的 base 分支规则](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)。

## 回归

认证协议与窄 token 使用模拟 GitHub API 测试；真实 Git 隔离、Windows ACL、链接和 CLI 的无凭据回退检查进入 Windows 集成层。测试生成独立虚构密钥或不含凭据的占位数据，无需生产 PEM，不对真实仓库推送。参见[分层 CI](CI.md)。

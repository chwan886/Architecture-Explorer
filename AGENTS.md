# Development authentication

Use `Tools/dev-app-auth.ps1` with an explicit ignored local configuration for repository pushes and pull requests. See [the setup guide](docs/en/DEV-APP-SETUP.md).

- Push task branches and create/update PRs with the configured GitHub App installation identity only.
- If the App, key preflight, runtime, token scope, or revocation check fails, stop. Never fall back to personal credentials, Git Credential Manager, `gh auth`, a GitHub connector, or environment tokens for a push or PR mutation.
- Never approve, merge, enable auto-merge, bypass protection, or push to the base branch through this tool. A human reviews the final bot push and merges after CI passes.
- Keep private keys outside repositories. Keep actual configuration and receipts ignored. Never log, commit, or place an installation token in an argument or file.
- Administration of repository protection is a separate owner action requiring explicit user authorization. Do not grant the development App administration or bypass privileges.

# 开发鉴权

推送和创建、更新 PR 必须使用上述通用 App 入口与显式本地配置。任何认证、权限、撤销或预检失败都必须停止，禁止回退个人凭据。机器人只提交待审分支与 PR；人类审核最后一次机器人推送，并在 CI 通过后合并。

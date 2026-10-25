# 分层 CI

[简体中文](CI.md) | [English](en/CI.md)

工作流位于 [.github/workflows/ci.yml](../.github/workflows/ci.yml)。Pull Request、main / codex/public-release 分支 push 和手动触发均运行稳定的 `CI gate`，适合作为分支保护必需检查。远程运行情况须以实际 Actions 结果为准。

| 层 | 平台 | 检查范围 |
| --- | --- | --- |
| changes | Linux | CI 分组与门禁自测、变更路径选择、锁定运行时版本、文档链接与发布独立性检查 |
| fast | Linux | TypeScript 全项目类型检查、纯单元/契约测试 |
| integration | Windows | 真实 Python/C#、索引、文件安全、HTTP、STDIO、崩溃恢复与公开导出测试 |
| web | Linux | React DOM/导航、自定义端口代理测试、Vite 生产构建、构建产物上传 |
| gate | Linux | 所选层必须成功，未选择层必须明确跳过 |
| protected-check | Linux | 将 gate 的成功/失败传递给既有必需检查 `Tool / typecheck, tests and builds`，不重复运行测试 |

脚本自动枚举 `.test.ts`，每个文件只归属一层；新根目录测试默认进入 fast，新前端测试进入 web；新增真实分析器或本机权限测试应显式加入 integration 清单。所有产品测试均进入公开副本，文件与测试数量以各层实际 `--list`/TAP 输出为准。内容包、故事验收和发布隔离回归归入 integration。测试分组见 [ci-plan.mjs](../.github/scripts/ci-plan.mjs)。

## 变更选择

- 前端改动执行 fast 与 web。
- 分析器、服务、MCP、模型、配置及相关测试改动执行 fast 与 integration；共享 packages 改动额外执行 web。
- 工作流、依赖锁、运行时、TypeScript 和安装配置改动执行所有层。
- 纯文档改动不分配重型测试 runner，但仍执行 changes 与 CI gate。
- 手动触发、无法确定初始基线时执行所有层；Git diff 或计划失败会让 gate 失败。

每个测试文件只归属一层，避免重复全套运行。runner 预建自己的 `.cache`、`.tmp` 和结果目录，TAP 缺失或存在 fail、cancelled、skipped、todo 时均失败，避免权限测试被静默跳过。

## 锁定与权限

Node、pnpm、.NET SDK 版本取自 `toolchain.lock.json`，Python 集成层明确使用 3.11。依赖使用 pnpm frozen lockfile 和 NuGet locked restore。Windows 创建 runner 本机 SDK 目录联接，以适配现有测试中的 `.tools/dotnet/dotnet.exe` 路径。持久化回归需要同目录硬链接、loopback、子进程强杀与目录联接能力；受限时明确失败，不静默跳过。

Action 固定到 commit SHA，token 只读 `contents`，checkout 不保留凭据，不使用 `pull_request_target` 或仓库秘密。相同 PR/分支的新运行取消旧运行。生产前端和集成 TAP 保留 7 天。

兼容汇总检查保留原保护规则的精确名称，只有 `CI gate` 成功才成功；失败、取消、跳过或缺失结果均失败，无需为分层 CI 降低分支保护。

## 本地运行

先完成仓库的 Setup（包含真实分析器构建），然后从根目录运行：

```powershell
node --test .github/scripts/ci.test.mjs
node .github/scripts/check-doc-links.mjs
node Tools/export-public.mjs --check
node .github/scripts/ci-tests.mjs fast
node .github/scripts/ci-tests.mjs integration
node .github/scripts/ci-tests.mjs web
```

`--list` 可追加在任一测试层命令后，只查看分配。各层生成 `test-results/ci-<layer>.tap`。在限制 loopback、目录联接或文件权限的沙箱内，integration 会明确失败；需要允许这些测试能力后补验。

专用 App 的协议、身份和最小权限回归属于 fast；真实 Git 隔离、Windows 密钥 ACL、链接与 CLI 拒绝回退回归属于 integration。CI 只使用模拟 API、合成 token 和临时夹具，不需要生产 App 密钥，不推送真实仓库。

CI 不发布网站或包，不修改真实目标项目，也不证明运行时语义。远程 Actions、外部漏洞数据库和跨平台安装程序仍需单独验证。

# 开发交付接收端本地验收

日期：2026-10-21，America/Toronto。初始实现提交：`30407a794f9bb8a5a93854f12277c306b741be40`；本轮收尾实现提交：`1d7c4fa5d5154bb73ce83eeee770a5c486411d56`，分支 `codex/github-game-delivery`。

本轮完成工具侧实现、七字符串接口核对、本地独立提交与证据。**接收端尚未远端就绪**：没有推送、合并、创建凭据、配置 GitHub 或发送正式请求。统一回交材料为 [receiver-handoff-v1.txt](ReviewEvidence/receiver-handoff-v1.txt)。

## 实际执行

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 锁定环境准备 | 冻结 pnpm 还原、供应链策略验证、锁定 SDK worker 构建成功；未生成本机配置 | `Tools/ci-check.ps1 -Prepare` 的本地执行，`.tools` 为工具侧运行目录 |
| 最终 Typecheck / 全套测试 | Typecheck 成功；296/296 通过，0 失败、0 跳过 | [JUnit](evidence/delivery/local-junit.xml)、[检查摘要](evidence/delivery/local-checks.json)；完整控制台日志在工具侧 `test-results/` |
| 前端与 C# 构建 | Vite 成功；.NET SDK 10.0.402，worker 0 warning / 0 error | `test-results/frontend-build.txt`、`test-results/csharp-build.txt` |
| 工作流与脚本 | actionlint 1.7.12 校验两份工作流成功；PowerShell Parser 校验成功；官方 Actions 标签解析后固定为提交 SHA | `.github/workflows/`、`docs/DEVELOPMENT-DELIVERY.md` |
| 发送 / 接收合同 | 参考发送脚本经无网络夹具产生精确七个 string 输入，实际 workflow env 映射可同时通过授权与快照输入校验；请求回执仍为 `not-observed` | `tests/ci-contract.test.ts`，纳入 296 项 |
| 授权边界 | 非法仓库/ref/版本/SHA/run/attempt、无保护、缺必需检查、API 失败、错误合并 PR、自审/bot/旧 head/撤销/合并后补审均拒绝；聚合全部有效 Ruleset，真实独立批准人数须达到有效门限 | `tests/ci-authorize.test.ts`，纳入 296 项 |
| 索引边界 | Git 读取失败、空 HEAD、索引 SHA 不符、非 main、隐藏源文件变化、Unity 引用缺失/不匹配拒绝；真实 Scan/Verify/Audit 夹具保留待复核和人工文字 | `tests/ci-snapshot.test.ts`，纳入 296 项 |
| 引用 ZIP | 精确摘要、固定 HTTPS、不跟随跳转、根文件白名单，路径穿越、目录、链接、重名及错误摘要均拒绝；过期签名 URL 不进入错误诊断 | `tests/ci-references.test.ts`，纳入 296 项；测试字节从未用作 Unity 分析引用 |
| 工具所有权与访问门禁 | CODEOWNERS 覆盖敏感边界而不扩大到所有普通 UI；PR 无生产凭据，main 工具包须私有仓库与人工读者范围批准；来源授权失败不上传带引文工具包 | `tests/codeowners.test.ts`、`tests/ci-artifact-access.test.ts` |
| 包验证目录边界 | 创建前拒绝祖先 junction；删除前复核真实路径、目录身份及随机所有权；不删 base 或已替换路径，保留 junction 目标 | `tests/ci-smoke-directories.test.ts`，4 项实际通过，无跳过 |
| 完整工具包 | 包内 Node + tsx 实际启动后端，前端 HTTP 200，项目/图 API，真实 C#/Python 夹具分析 12 nodes / 5 edges / 2 files；17 个根依赖均在包内解析 | [本地包启动证据](evidence/delivery/package-smoke.json) |
| 页面 | 实际打开 `http://127.0.0.1:4311/?page=delivery`，总览、详情展开、阶段返回和 PR 外链目标正确；界面使用仓库夹具 | 下方截图与 `apps/web/src/delivery.test.ts` |

本机 Python 为 3.14.3；CI 固定 3.13.7。锁定的远端 Windows runner 与该 Python 版本组合尚未实际运行，不能用本机结果代替。前端保留既有 React Flow / Lucide `use client` 与大 chunk 警告，未修改门限掩盖警告。

首次沙箱执行因 loopback / junction 权限失败；完整本地权限重跑全部通过。干净环境另暴露语义存储测试夹具未建立 `.cache` 父目录，已在该夹具补建，未删除测试或减弱断言。CI 还会在任何必需测试跳过时失败。

独立审阅发现普通 `COMMENTED` 不应撤销已有批准，已修复并补测；继续要求准确 head、独立真实 User、合并前批准。包实际启动发现直接复制 pnpm 链接会破坏 tsx/esbuild 依赖，已改为隔离 staging 的离线冻结 hoisted 复制还原，无包内链接，并实际运行 esbuild 和完整包。

本轮包启动证据中的 `packageId` 是本地测试目录标识，`execution=local-check`、`runUrl=null`、`sourceDirty=true`，打包时 HEAD 为 `74a2f532c5dcb3b75b7477a2a13ac2f4e71eea06`，不是远端提交产物或干净提交包。初轮“不含游戏源码”的描述错误，现予更正：包未带完整游戏 checkout、本机配置、Git 凭据、Unity DLL 或缓存，但保留人工模型/锚点/文档中的游戏源码摘录；`model.json` 的 236 个锚点都有引文。工具仓库、日志、报告及两类产物须按游戏访问范围审核。新包的清单和 RUNNING.md 明确披露摘录，真实启动测试核实引文及人工模型字节保留。包仍需 Git、Python 与 .NET 运行环境及本机配置，不是安装器。

本轮本地子代理审阅发现并关闭：临时目录 junction/清理边界、多个 Ruleset 聚合顺序、实际审批人数不足门限三项问题。子代理审阅不替代 GitHub 上独立 Code Owner 的真实批准。Unity 仅交付[供应方案](UNITY-REFERENCE-SUPPLY.md)，尚无生产 DLL/ZIP、许可确认或长期续期方案。上述收尾时开发 App 尚未创建；后续已创建并完成本页末尾的只读认证验证，[App 清单](DEV-APP-SETUP.md)已同步真实身份与结果。Git/PR 写入认证仍未实现。

## 界面证据

![开发交付流程总览](evidence/delivery/overview.png)

![详细步骤与阶段 Inspector](evidence/delivery/details.png)

PR 链接实际打开固定的 `https://github.com/chwan886/GameDemo02/pulls`。内置浏览器当时未登录，私有仓库显示 GitHub 404 / Sign in；这证明目标跳转，不能据此声称已浏览私有 PR 内容。仓库访问另以原有 Git 认证的只读 API 核实，工具页面没有接收该认证。

## 尚未执行

- 本轮工作流未进入工具 main，远端 CI、workflow_dispatch 和 artifact 上传未运行，真实链接均无。
- 未使用生产游戏 SHA 扫描；没有借用本机 Unity DLL 或伪造 Unity 类型。真实引用供应及 fingerprint 待配置。
- 两仓 main 保护、独立 Review / Code Owner 门禁、两个受保护 Environment、开发 App 与独立的生产发送/读取 App、产物读者集合及开关仍需人工配置/核实。开发 App 只限 Contents/Pull requests/Workflows write、无 Administration、无 main bypass；未退回 Owner 身份推送。
- 游戏第一阶段仅按用户转交文档核对，未重读或修改游戏实现；其本地 349 项结果属于游戏主控报告，不是本工具执行的检查。
- 未运行 Unity Full / Release、真实 feature 合并或端到端联调；不以 Fast、夹具或 HTTP 请求接受冒充。

正式启用按 [交付合同的六步顺序](DEVELOPMENT-DELIVERY.md#首次接入顺序)继续；缺项未补齐时开关保持关闭。

## 后续开发 App 只读认证验证

用户创建 App 后，本轮仅授权本机认证验证。入口为 `Tools/dev-app-auth.ps1 -Verify`，实际过程及绝对命令见 [DEV-APP-SETUP.md](DEV-APP-SETUP.md)。App ID `5417611`、Client ID `Iv23lil3cvGyWUbx4yfS`、slug `chwan-dev-agent`、Installation ID `173913073` 均经真实 App JWT API 核实。

最终 `Tools/ci-check.ps1`：**321/321 通过，0 失败、0 跳过**，包含新增 14 项认证核心与 11 项实际 Windows ACL/link 测试；Typecheck、Vite、C# worker 均成功。独立子代理复核指出的未知签发状态、撤销异常路径和探测测试断言问题均已修正。新版完整 JUnit 与摘要独立保存在 [dev-app/full-junit.xml](evidence/dev-app/full-junit.xml)、[dev-app/local-checks.json](evidence/dev-app/local-checks.json)，此前 296 项交付验收证据不改写。

真实只读认证共两次，均只申请 `Architecture-Explorer` Contents read（服务端另含隐含 Metadata read），没有 GameDemo02 或 installation 全范围 token。首次在 DELETE 204 后即时探测未确认，保持 [failed 回执](evidence/dev-app/auth-verification-2026-10-21.json)。增加状态记录及有界只读探测后，[第二次 passed 回执](evidence/dev-app/auth-verification-2026-10-21-attempt2.json)证实权限、单仓可见范围、准确 main ref 实读、DELETE 204，以及同一原 token 最终 401。200、200、200、401 的实测序列完整保存，不能据此编造官方传播时间或缓存原因。

私钥目录/文件 ACL 只允许当前用户、SYSTEM、Administrators；受限继承与 owner Administrators 均明确记录，路径链不含链接。未更改真实权限。只在认证 Node 内存读取 PEM、签 JWT、持有 IAT；不输出/持久化这些秘密，不使用 Owner 或全局 Git/CLI 登录，生产 CI 不取得此 App 凭据。

仍待完成：安装恰好两仓的人工 UI 证据，Git/PR 写入认证入口、main/Environment/生产 App 与真实接收端验证。JWT 两仓正向 membership 和窄权 token 不能证明安装没有第三仓。本轮未推送、未建 PR、未合并、未 dispatch、未启用自动发送；接收端继续 `REMOTE_NOT_READY`。

## 共享入口与本次任务分支交付

上述只读入口现已扩展为单仓 Verify / Push / PullRequest / Status，合同与命令见 [共享 App 入口](DEV-APP-SETUP.md)。完整本地 `Tools/ci-check.ps1` **344/344 通过，零失败、零跳过**；Typecheck、前端与 C# 构建成功。收尾审阅后的通用 armor/准确 PR 编号防线与隔离 Git 配置，另经 29 项针对测试及 Typecheck 通过。证据：[共享回归 JUnit](evidence/dev-app/shared-full-junit.xml)、[检查摘要](evidence/dev-app/shared-checks.json)。

正反例覆盖两个允许仓库、每次只验证所选安装归属、单仓精确权限；互斥动作/非法仓库、main/ref/尾换行/SHA/正文路径与 armor；PR 精确 head/base/同仓/App bot ID、已有 PR 只更新 title/body、错误作者/关闭或歧义 PR 拒绝、未知 POST 不重试；CI 缺权限/错 SHA/错 PR/失败或未完成不报告成功。真实本地 Git 夹具核实 clean/HEAD/origin/危险配置、静态 helper 协议、清除继承凭据及隔离传输计划。未在夹具中读取真实 PEM 或访问远端。

[游戏只读真实回执](evidence/dev-app/shared-game-verify-2026-10-21.json)验证 `GameDemo02` main `f2761432cfa68140b7b095112cc5e0ee2fda3cd4`，IAT 只含该仓 Contents read 与 Metadata read，撤销 204 后原 token 最终 401；没有扫描或修改游戏工作目录。

本轮用户授权工具本次任务分支推送并创建 base=main PR；这些动作的实际 PR/head/App 作者/远端 CI，由本机回交报告 `.tmp/shared-app-handoff-20261021.txt` 及其脱敏 JSON 记录，不把本地通过当远端结果。自动发送保持关闭，禁止 Owner 回退、直推 main、强推、自动批准或合并；未扩大生产 CI 的凭据权限。

首次真实工具推送退出128，未确认成功；原IAT已撤销204+401，回执保留 `.tmp/shared-tool-push-1.json`。后续新增Git固定脱敏诊断、显式Schannel证书/吊销检查，**9/9** 无网络Git夹具及Typecheck通过，包含实际alternates精确SHA推送和非快进拒绝。旧失败原因未知，不将TLS配置差异直接写成已证实原因，也不恢复Owner凭据或降低TLS检查。

第二次真实推送明确为凭据helper失败，回执 `.tmp/shared-tool-push-2.json` 保留且IAT已撤销。随后在仅loopback的真实Git HTTP Basic协商中复现：Git合法重复 `capability[]` 被旧Map当标量拒绝。按[官方凭据协议](https://git-scm.com/docs/git-credential#_inputoutput_format)支持多值 capability[]/wwwauth[]/state[]，敏感标量重复继续拒绝，固定拒绝码不带原始值；新增HTTP Basic复现后 **10/10** Git测试及Typecheck通过。没有放宽host/path/username、TLS或Owner回退限制；真实远端结果仍以回交报告为准。

## Actions read 生效与首轮远端诊断

App 注册及安装的 Actions read 已于 `2026-10-21T23:01:29Z` 经完整 API 校验通过。此前不匹配回执保留，入口在签发 token 前停止；新增固定字段权限诊断及安装 metadata 非秘密随机参数后仍要求精确权限一致，不宣称已证实缓存根因。游戏随后再次只读 Verify 通过，IAT 仍只有游戏单仓 Contents read，撤销 204 并确认原 token 401，见本机 `.tmp/shared-game-verify-2.json`。

真实 [PR #1](https://github.com/chwan886/Architecture-Explorer/pull/1) 作者为 `chwan-dev-agent[bot]`。首个 head `c3a619fc1dc025ce16438266a0c195c942a3ca48` 的 [Tool CI 运行](https://github.com/chwan886/Architecture-Explorer/actions/runs/39688848223) 失败，不能用本地通过替代。Steps 与有限脱敏日志显示三项 MCP 测试在 `BridgeFiles.protect` 以 `RUNTIME_PERMISSIONS` 拒绝发布。诊断读取使用该仓 Actions read token；下载不转发 Authorization，签名 URL/凭据/原始响应不落盘，最终撤销 204 并确认 401。

排查发现旧 SDDL 检查把 trustee 别名与当前用户完整 SID 直接比较。现改用 Windows 原生 `RawSecurityDescriptor` 将别名展开成 SID，仍仅允许当前用户和 SYSTEM，不一般允许 LA、Administrators 或 Users，不跳过测试或放宽门禁。新夹具实际核实 LA 对应本机 RID500 时的精确身份等价，以及别的用户、BA/BU、错误描述符的拒绝。远端 runner 的实际 SID 未从旧日志取得，故不把该缺陷直接写成已证实的旧 runner 身份；最终修复结果以新 head 的真实运行验证。

后续准确 head、完整本地检查与真实 CI 结论由 `.tmp/shared-app-handoff-20261021.txt` 及同名 JSON 记录。生产 package job 在 PR 中按条件跳过；它不是测试跳过，PR 不取得生产 Environment/跨仓凭据。生产接收端仍未合入 main，不能由 PR CI 推导为已就绪。

本轮最终 `Tools/ci-check.ps1`：**355/355 通过，0 失败、0 跳过**，Typecheck、前端与 C# 构建成功。新证据独立保存：[最终 JUnit](evidence/dev-app/final-local-junit.xml)、[检查摘要](evidence/dev-app/final-local-checks.json)、[首轮真实 CI 脱敏回执](evidence/dev-app/initial-pr-ci-2026-10-21.json)、[Actions read 生效后的游戏单仓 Verify](evidence/dev-app/game-verify-actions-read-2026-10-21.json)。此前失败与历史回执不覆盖。

第二次真实 head `35d00533e40f780b567559843d896e6f449b33ce` 的 [运行](https://github.com/chwan886/Architecture-Explorer/actions/runs/39691686688) 仍在三项凭据发布测试被拒绝，[脱敏回执](evidence/dev-app/second-pr-ci-2026-10-21.json)保留；原生别名正反例未失败，不能声称别名修复已解决 runner 问题。正向 MCP 夹具原先依赖机器默认 DACL，现只在测试独占的新建 bridge 目录中显式准备当前用户与 SYSTEM 的受限 ACL，拒绝重置已存在目录。原符号链接攻击测试不预建目录；新增实际给该夹具加入 BA 显式权限的负例，验证真实发布拒绝、`published=false` 且无凭据/锁/审计文件残留。本轮只改夹具准备，生产权限边界保持严格。

夹具修正后完整本地 **356/356 通过，零失败、零跳过**，Typecheck、前端及 C# 构建成功；补查夹具 toolRoot 真实路径后，15 项实际 ACL/MCP 测试与 Typecheck 再次通过。[本次 JUnit](evidence/dev-app/fixture-local-junit.xml)、[检查摘要](evidence/dev-app/fixture-local-checks.json)。后续远端结果仍单独记录，不用该本地结果替代。

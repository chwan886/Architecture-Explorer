# 实现缺陷修复记录

[简体中文](REPAIRS.md) | [English](en/REPAIRS.md)

日期：2026-10-25（America/Toronto）。本记录对应[首轮审查](OPEN-SOURCE-REVIEW.md)的 F01–F11。每项先补能复现旧行为的回归，再修改实现；代码、测试与公开导出流程一起验证。没有修改或运行真实被分析项目。

## 修复结果

| ID | 修复 | 回归依据 |
| --- | --- | --- |
| F01 | 架构模型按实际序列化 UTF-8 字节检查 1 MiB 预算；超限 413，原模型保持可读。补充拒绝写入任何已授权目标目录。 | [architecture-api.test.ts](../tests/architecture-api.test.ts)：请求小于 512 KiB、pretty-print 大于 1 MiB 的旧版返回 200，修后拒绝；合法多字节模型往返与目标只读保护通过。 |
| F02 | runtime、架构模型、语义覆盖和扫描共用[文件锁协议](../packages/indexer/src/file-lock.ts)。预写完整进程记录后硬链接原子公布；仅在本机持有 PID 明确已退出时，按所有权代次串行回收。 | [persistence-lock.test.ts](../tests/persistence-lock.test.ts)：四入口真实强杀恢复、16 竞争者只一个进入、活进程/未知/外地主机/损坏记录/EPERM 不抢锁、旧格式和回收锁自身强杀恢复，18 项通过。独立审查发现等价路径绕过 guard，先跑红，再统一真实目录与 canonical guard key；大小写与 `/./` 均通过。 |
| F03 | C# 同名同签名局部函数使用声明所属符号与同签名声明序号消歧，不依赖行号。 | [csharp-bindings.test.ts](../tests/csharp-bindings.test.ts)：分支与嵌套块保持独立，插普通行或无关局部函数不变；不再合并两支调用。 |
| F04 | C# 边身份包含 dispatch 和 confidence；同语义重复调用继续合并证据，不同分发/置信关系分开。 | 同一真实分析器回归覆盖 `base.V()` 与虚调用的交换顺序，以及实际赋值与 ref 推断写入；新增 C# 回归旧版 3 失败，修后全部通过。 |
| F05 | Python 在进入类命名空间前解析并访问 bases、keywords；基类工厂、metaclass 和装饰器求值归属外层。 | [python-resolution.test.ts](../tests/python-resolution.test.ts)：类内同名成员不能成为自身基类；工厂返回的基类保持未知。 |
| F06 | Python 类局部导入不作为方法或 lambda 的词法闭包；保留模块与外层函数导入、类体本身导入的正确作用域。 | 同文件正反例覆盖 module/class/outer function aliases、重绑定和类局部 callable；错误目标不再生成。 |
| F07 | Python AST、定义和绑定计数按文件保存；模块名映射保留多候选，冲突声明按文件消歧并发出 `PY_AMBIGUOUS_MODULE`。 | `pkg.py` 与 `pkg/__init__.py` 都保留调用和读写；输入反序、持久缓存删除/恢复均可重复，歧义导入不选择目标。 |
| F08 | 投影、审计和命令行验收复用[源码位置支持判定](../packages/architecture-model/src/source-order.ts)。支持同一当前文件中的有效双端锚点，仅证明位置叙述。 | [evidence-audit.test.ts](../tests/evidence-audit.test.ts)：无过程选择器与跨过程位置叙述不再误报；陈旧、缺失、倒序、跨文件、非法范围和伪造引文仍被拒绝。未升级协议、跨请求或运行时顺序。 |
| F09 | 语义编辑 GET/PUT 同返完整 metadata；草稿持有自己的 viewRevision 与 overlayRevision，重载和连续保存均更新基线，不依赖 SSE。 | [SemanticWorkspace.test.ts](../apps/web/src/semantics/SemanticWorkspace.test.ts)、[semantic-api.test.ts](../tests/semantic-api.test.ts)：旧版重载仍发旧视图版本失败，修后无 SSE 和连续两次保存通过；缺版本的旧会话草稿保留但禁止盲目保存。 |
| F10 | 外部 detailed 入口按语义目标、代码反查或边端点展开父组并发起画布定位；显式目标清除会隐藏它的旧筛选。 | 上述组件测试及[真实 App 导航测试](../tests/semantic-app-navigation.test.ts)检查目标详细节点实际可见；旧筛选隐藏目标的追加反例也先红后绿。 |
| F11 | Vite 从选定配置读取并校验端口，仅解析配置文件，不访问目标 root；build 无需有效项目配置。 | [vite-config.test.ts](../tests/vite-config.test.ts)：真实临时 API 与 Vite 代理走非默认端口，覆盖 BOM、缺省端口和非法值。 |

## 锁的安全边界

锁不按年龄过期。活 PID、被系统拒绝的 PID 探测、外地主机和无法解析的旧记录均保守拒绝。旧 `pid:UUID` 可在确认进程退出后恢复；没有 PID 的旧 runtime token 无法证明归属，仍需在停止全部相关进程后人工核查处理。PID 被复用时会保守阻止回收，而不会抢占新进程。

协议使用同目录硬链接，要求底层文件系统支持此操作。回收采用有限递归与竞争预算，超出预算明确失败。突然断电、远程共享文件系统或恶意外部进程修改锁文件不在本轮已验证范围内。

## 缓存与兼容性

分析器版本由 `0.2.0` 提升为 `0.2.1`。正常扫描会重新计算上下文和事实；局部函数、调用/读写边及冲突模块的部分 ID 会变化，旧视图/MCP 快照需要重新获取。声明哈希算法未变化，源码未变化的声明不需要批量更新基准。

同一所有者中，在前方新增或删除同名同签名局部函数会改变后续声明序号。Python 冲突候选集合变化也可能改变相关身份；系统继续通过版本和指纹使受影响引用失效。旧 lastgood 与历史审计结果不会自动升级，验收应先 Scan 再 Audit。

## 发布相关结果

- 通用语义内容测试已改为独立内存夹具，并在没有私有模型和已有缓存的目录验证全部 11 项通过。
- 增加匿名公开快照导出及防泄露回归：不带原作者历史、remote、私有模型、运行目录、非示例配置或 `.env`。后续解耦已完成可选 JSON 内容包、通用种子和配置驱动故事验收；[发布审计](PUBLICATION.md)记录对应实现与隔离回归。
- 已加入原版 [PolyForm Noncommercial 1.0.0](../LICENSE)、[NOTICE](../NOTICE)和[双语许可说明](LICENSING.md)。它是非商业免费、商业另行书面授权的源码可见模式。
- CI 自动发现新测试，真实锁/发布导出/内容包/故事验收归 integration，自定义端口测试归 web。原专用内容验收改为自包含演示回归，全部产品测试进入公开版，不再排除测试文件。
- GitHub Actions 远程运行、依赖漏洞数据库、第三方许可清单、大图性能与全浏览器验收仍是后续工作；本轮本机通过不替代这些验证。

## 首轮修复验证记录

原工作树按层验证：fast **46/46**、integration **150/150**、web **83/83**，合计 **279/279**，0 失败、0 跳过；CI/文档检查器自测 **7/7**。TypeScript、Roslyn Release 与 Vite 生产构建通过。真实本机能力测试在允许硬链接、目录联接、loopback 与子进程强杀的环境执行。

以上为 F01–F11 初次修复时的 Windows 验证数量，不是后续解耦版本、GitHub Linux runner 或全新联网安装的结果。新版本增加内容包、故事验收和隐私检查回归，并用演示替换专用内容测试，最新数量以完整分层 TAP 为准。原有 Vite 依赖指令/ELK chunk 提示仍保留。

## 项目解耦回归

[semantic-seed.test.ts](../tests/semantic-seed.test.ts)验证两个独立项目、空模型、外部包、Worktree 与版本隔离、链接拒绝、并发原子导入及人工内容保护。[story-acceptance.test.ts](../tests/story-acceptance.test.ts)使用不会被执行的合成 Python 目标，覆盖配置选择、歧义、当前完整证据元数据、静态可信边界和旧命令兼容。

原专用模型与流程测试已替换为[演示模型验收](../tests/demo-architecture.test.ts)和[演示语义验收](../tests/demo-semantic-flows.test.ts)，不读取外部模型或定义。[公开导出回归](../tests/public-export.test.ts)保留全部通用实现和测试，同时拒绝私有项目标识、长引文和旧 Git 身份泄漏。可实跑的命令见[项目内容适配](CONTENT-PACKS.md)。

远程 Windows CI 还发现基线遗漏的账户别名处理。现复用原生 SDDL 解析，将 `LA` 展开为完整 SID 后仅接受当前用户与 SYSTEM；管理员组或其他用户不在白名单。[权限回归](../tests/bridge-permissions.test.ts)验证真实 Windows 解析、明确授权其他主体时拒绝发布及无凭据残留。测试夹具仅初始化全新且边界核对过的临时目录，不重置已有 ACL；现有分支保护通过兼容汇总检查继续生效。

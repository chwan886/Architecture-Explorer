# Unity 元数据引用供应方案

状态：**准确游戏 main 的本地审查包已制作并通过现有接收校验；私有托管、CI 权利/读者审阅和远端下载仍待配置。** 自动发送继续关闭。目标为 `3d448c5e4a6ac7148472a0e78b187674810fc118`、Unity `6000.6.5f1`，Win64 Development Player 静态切片，显式 `DEBUG`。真实包路径、49 DLL/ZIP 摘要、正反例和限制见[本地包交接](ReviewEvidence/unity-reference-package-v1.txt)。本方案只服务 Architecture-Explorer 的静态分析，不安装或启动 Unity，不打开游戏项目、不编译/执行游戏；本地 DLL 副本不代表 CI 已就绪。

## 首次手测采用的供应方式

采用“受权维护者从准确版本的受管 Editor 导出显式 DLL 清单 → 私有只读对象 → 有时限的 HTTPS 读取 → ZIP 与每 DLL 双重指纹核验”。优先使用用户已有的私有存储；尚未指定供应商，不为此新建通用制品服务或购买资源。

首次手测由维护者为一个不可变对象签发短时只读 URL，存入工具仓库 `architecture-delivery` Environment 的 **Secret `UNITY_REFERENCES_URL`**。`UNITY_REFERENCES_SHA256` 为同一 Environment 的普通变量，保存整个 ZIP 的真实小写 SHA256。签名 URL 本身具有访问能力，不能放普通变量、文档、日志、页面、回执或产物。它与游戏读取 App、跨仓发送 App 是三种不同用途的权限，不能复用私钥或管理员 PAT。GitHub 支持 Environment secrets，并建议通过环境变量等方式传递秘密；日志掩码不替代避免输出。参见[官方 Secrets 文档](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)。

现有下载接口只接受直接返回文件的 HTTPS URL，禁止凭据型 userinfo 和 fragment，`MaximumRedirection=0`。选择存储时必须验证一次请求能直接取得 ZIP，不可把需要 302 跳转的 GitHub Release/Actions 下载接口直接填进此入口，也不可为了某个供应商放开跳转。下载失败应只报告不含 URL/签名的固定错误与必要状态，设置明确超时；过期、缺失或错误指纹保持失败。

短 URL 是首次受控手测方案，**不是长期自动供应已完成**。开放持续自动发送前，必须确定续期责任和可用性：若现有私有存储支持 GitHub OIDC，可在另行审阅的最小改动中按每个 job 换取只读短期访问。信任需限定本工具仓库、准确工作流、`architecture-delivery` 和 main，存储权限限定特定不可变对象或前缀，不授予上传/删除。OIDC 的 claims 和 subject 格式需按实际仓库核实，不能照抄示例；目前没有添加 `id-token: write`、云角色、登录 Action 或自动续期代码。[GitHub OIDC 文档](https://docs.github.com/en/actions/concepts/security/openid-connect)说明这种短期换取机制。

## 由游戏主控和供应维护者交付的输入

| 项目 | 谁提供 | 必须可核对的内容 |
| --- | --- | --- |
| 目标版本 | 游戏主控 | 合规 main 的准确 SHA，以及该 SHA 中 `ProjectSettings/ProjectVersion.txt` 的完整 `m_EditorVersion`；不能仅填 Unity 6 或自行采用工具 README 的本机示例版本 |
| Editor 来源 | 供应维护者 | 匹配完整版本的官方 Hub/归档安装来源、发行标识、安装介质摘要或官方签名核验、操作系统/架构和安装模块清单；不把下载成功当成许可批准 |
| 运行源码范围 | 游戏主控 | 当前目标平台/后端、有效符号、所需 Unity 模块、包与显式第三方程序集，Editor/Tests 的排除范围；源码自身程序集不能作为外部引用再次加入 |
| 许可/接收人 | 权利持有人或其指定维护者 | 使用的条款/授权依据、内部 CI 取用与托管范围、允许的接收人、第三方 DLL 单独条件及复核日期；本方案不自行认定其可再分发 |
| 内容指纹 | 供应维护者 | 每个允许 DLL 的真实 SHA256、ZIP SHA256、固定对象版本、创建人与审阅者、对象撤销/过期策略 |
| 供应权限 | 用户/存储管理员 | 私有存储读者、一次性或短时读取方式、main-only Environment、URL 失效与轮换方式；不能扩大游戏资料及 Unity 软件的允许访问范围 |

Unity Hub 官方支持选择具体 Editor 版本及模块，未列出的版本可从官方归档安装；这给出供应来源，不表示本轮已经安装或导出。[官方安装说明](https://docs.unity.com/en-us/hub/add-editor)

当前 Unity 软件条款涉及授权用户及软件使用范围。维护者应对实际订阅、软件版本、托管方式和接收人确认适用权利；“只读取元数据”或“仓库 private”都不是再分发许可证明。本轮没有接受协议、操作许可证、上传 Unity 软件或将 Unity 源码交给分析器。[Unity Editor Software Terms](https://unity.com/legal/editor-terms-of-service/software)

## 离线导出步骤与读取边界

1. 游戏主控提供上述版本、源码 SHA 与引用/符号需求。供应维护者在独立、受管的授权环境准备准确 Editor；此环境不是游戏 CI checkout，也不使用用户机器路径作为流水线配置。首次记录缺项时保持 `null`，不填示例版本或假摘要。
2. 依据匹配版本的官方文档定位 Managed 程序集。Unity 的 Windows 文档给出版本化的 `Editor/Data/Managed` 位置；具体子目录与 facade/模块布局会随版本变化，必须按实际文件清单核实。导出过程只读普通 DLL 文件和版本/签名元数据，不加载执行程序集、不调用 Editor、不访问 `Library/ScriptAssemblies` 或触发目标项目导入/构建。[官方 Managed plug-ins 说明](https://docs.unity.com/en-us/engine/6000.3/manual/programming-environment/plug-ins/managed)
3. 显式列出所需 DLL，逐个核对真实路径属于批准的供应根、文件不是链接、文件名在当前接收白名单内、名称不重复、PE/CLI 元数据可读取；记录原相对路径、程序集身份和摘要。不要递归复制整个 Editor、`Library`、SDK、许可证、用户配置、游戏 DLL 或第三方资产库。
4. 模块、包和第三方依赖分开登记。Editor 自带 DLL 不能覆盖所有包命名空间；若命名空间只存在于由目标项目生成的程序集，当前无目标执行边界不能为其启动构建。应由维护者另交许可允许且版本可证明的预编译外部依赖，或明确缺失及部分语义范围；不得造占位 Unity 类型或加入目标自身已编译程序集掩盖源码缺失。
5. 在工具侧新的独立 staging 中，把选定 DLL 作为根文件复制，计算原文件与复制文件摘要并比较，生成 `references.json`。不修改原 Editor、游戏目录、人工模型或先前版本包。
6. ZIP 仅含根清单与 DLL 文件。ZIP 写入方式不能附带顶层文件夹或目录 entry；单独的来源/许可审阅记录放在受控存储的 sidecar，**不能塞进只接受 JSON/DLL 的 ZIP**。记录 ZIP 的真实 SHA256，按内容摘要创建不可变对象；不覆盖既有对象。
7. 审阅者核对原清单、导出副本、ZIP 条目、两个级别的摘要、许可记录与访问范围。随后才由用户配置 Secret URL 与 SHA256 变量，执行接收端真实手测。最新已完成本地准确版本/上下文核对、导出和离线校验；尚未上传、配置私有下载或执行生产取用。

本次包目录保留固定输入的离线制作脚本和审阅清单，拒绝链接/越界/重名/已存在输出，复制后核对摘要并创建无目录 entry 的 ZIP；它不自动执行游戏、不上传、不安装 Editor、不决定托管许可、不伪造类型。接收核验继续复用 `ci-references.ps1` 和 `prepareReferences`，没有另写扫描器或新增通用供应平台。离线 ZIP 校验使用本地文件传输适配器，不能替代 HTTPS 私有下载测试。

## 当前引用清单与兼容边界

`references.json` 的现行输入只有以下实际用途的字段；下列为结构占位示意，含尖括号的值必须由真实记录替换，不能直接投入 CI：

```json
{
  "unityVersion": "<目标SHA中的完整Editor版本>",
  "references": [
    { "path": "UnityEngine.CoreModule.dll", "sha256": "<该DLL的真实小写SHA256>" }
  ],
  "defines": []
}
```

- `unityVersion` 必须与目标 SHA 的 `ProjectVersion.txt` 精确相等，不能自动升到最新补丁。
- 每个 `path` 是 ZIP 根中获批准的 DLL 文件名；每个 `sha256` 是该文件的真实小写 SHA256。清单最多 512 项、1 MiB；ZIP 最大 256 MiB，条目展开总长最大 512 MiB。
- 当前工具要求 `UnityEngine.CoreModule.dll`，拒绝同名程序集和根聚合 `UnityEngine.dll` 混入；所有清单及 DLL 必须位于工具侧，逐个校验后只作 metadata reference。
- `defines` 是显式符号名数组；没有符号时使用空数组，不根据编辑器版本随意补 `UNITY_EDITOR`、平台、包或后端符号。

**不能把本工具的模块引用策略写成 Unity 完整编译合同。** 本次核对的 Unity 6000.3 Managed plug-ins 文档要求插件编译引用 Managed 下的 facade，并说明直接模块引用不受该插件编译工作流支持；本工具则有自己的 Roslyn 静态投影及上述 CoreModule 限制。这两者目的和支持范围不同。应以准确目标 Editor 的实际布局和首次静态扫描证据验证当前策略；若只能用与当前限制冲突的引用方案才能解析，正式快照应阻塞并单列兼容性评估，不能临时混入 facade、删掉检查或宣称完整语义成功。[官方插件编译引用说明](https://docs.unity.com/en-us/engine/6000.3/manual/programming-environment/plug-ins/managed)

Unity 的 asmdef 还包含平台限制、显式预编译引用、Define Constraints 和 Version Defines；版本定义可只对该程序集生效。[asmdef 格式](https://docs.unity.com/en-us/engine/6000.0/manual/programming-environment/script-compilation/assembly-definition-files/file-format)、[条件与版本定义](https://docs.unity.com/en-us/engine/6000.3/manual/programming-environment/script-compilation/assembly-definition-files/includes)。当前工具把 C# 源合到一个 Roslyn 上下文，并用统一 `defines`；asmdef 主要提供分组和显式依赖，不等价于复现 Unity 每个程序集的编译环境。不得通过收集一大包 DLL 就把该限制标为已解决。

即使没有 C# warning，结果仍是配置范围内的静态分析；不是 Unity Full、Player 构建或运行时验证。若有上下文诊断，按现有 manifest 标明 `partial-semantic-context`，保留缺失/歧义与未解析范围。首次供应验收应包含至少一项真实所需 Unity API 绑定和一项受控缺引用诊断，不能只检验 CoreModule 文件存在。

## 保密、轮换与失败处理

| 情形 | 必须发生的结果 |
| --- | --- |
| URL 缺失、过期、403、非 HTTPS、发生跳转或超时 | 下载步骤失败，日志不含签名 URL；不换成公共镜像、最新 Editor 或游戏构建 |
| ZIP/DLL 摘要不符、版本与目标 SHA 不符 | 阻塞索引；保持旧对象/旧有效配置记录，不刷新摘要掩盖差异 |
| ZIP 越界、链接、目录或重名 | 提取前拒绝；不运行其中任何文件 |
| 引用不完整或 asmdef 上下文不同 | 保留明确 partial 诊断或阻塞；由游戏主控/供应维护者确认缺项，不造类型，不自动改人工说明 |
| URL 即将失效但内容不变 | 只续签同一不可变对象并更换 Secret；核对 ZIP SHA256 不变。已过期 run 由授权者对原 SHA 重跑，保留新 attempt |
| Editor/包/平台/符号发生变化 | 新供应审阅、新 DLL/ZIP 摘要、新对象；更新成对的 URL/摘要并记录生效范围。回退也须选择兼容目标版本的旧对象 |
| 对象或读取权限泄漏 | 撤销读取能力，停止新的供应请求并保持自动发送关闭；在受控环境中重新签发、核对原 SHA 和访问记录 |

Unity DLL、原始 ZIP、签名 URL 和访问 token 不进入工具构建包、索引证据包、Git、公开 Pages/Release 或 UI。当前快照只导出引用文件名/指纹和版本，不复制 DLL；失败日志同样不得扩大其访问范围。工具构建包中可能已有游戏来源的人工模型/文档摘录，仍需单独遵循包的权限分类，不能因“不含 Unity DLL”推断它可公开。

## 首次供应验收与仍缺的材料

首先由用户/维护者指定并交付：真实 Editor 版本、所需 DLL/符号与包上下文、来源和许可确认、私有存储选择、固定 ZIP/DLL 摘要、Secret URL 的有效期及续期责任。当前这些生产值全部未提供/未核验。

在接收端合入受保护 main、相关 Environment 与受限身份配置完成后，手动 dispatch 使用符合 Review/main CI 条件的准确游戏 SHA/run/attempt。验收必须核对下载对象、版本与逐 DLL 摘要，Scan/Verify/Audit、只读前后摘要和最终 manifest，并证明缺引用/错误 pin/过期 URL 明确失败。记录真实目标 run 与产物；目前没有该生产验证链接。

自动发送仍保持关闭；短 URL 的持续续期未解决、引用的真实语义范围未核实、许可/访问范围未确认，任何一项都不能用文档完成或夹具通过替代。

# 战斗演示

[简体中文](README.md) | [English](README.en.md)

这个小型示例用于首次体验和 README 截图。所有源码均随工具仓库提供，不需要真实游戏、Unity 或外部项目。

- 四个 C# 文件展示回合调度 → 伤害规则 → 角色状态，以及界面读取 Health 的关系。
- 两个 Python 文件展示导入调用和函数内部的字典读写。
- 两种语言是独立示例，没有 HTTP/JSON 传输，不能把 Health/hp 视为跨语言数据流。
- 分析器只读取这些文件，不执行它们；职责与解释均是候选，没有人工确认记录。

完成根目录 README 中的 Setup 和 Build 后，运行：

```powershell
./Tools/explorer.ps1 -Task Dev -Config ./config/demo.json
```

从根目录运行上述命令。配置位于 [config/demo.json](../../config/demo.json)，职责模型位于 [model.json](../../architecture/models/combat-demo/model.json)，业务解释位于 [definitions.json](../../architecture/semantics/combat-demo/definitions.json)。

打开本机 4310 端口：系统总览可进入模块和组件；业务流程可切换双层对照；搜索 Health 后进入数据读写，再点击 Actor.cs 第 10 行的写入证据。

源码锚点和语义声明哈希与当前示例版本绑定。修改示例后需重新扫描，并更新模型锚点或重新核验绑定；不要复用过期哈希。截图使用相同示例在 1280×720 下实拍，仅展示仓库自带的合成内容。

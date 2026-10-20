# 源码分析 Worker

两个 Worker 只解析请求里的源码字符串，不 import、执行或构建被分析项目。
C# 仅额外读取明确配置的程序集元数据；不加载程序集执行，不运行 MSBuild 目标。

输入输出遵循 `docs/CONTRACT.md` 与 `packages/schema/src/index.ts`。
默认模式读取一个完整 JSON 请求并返回一个结果；`--persistent`（别名 `--server`）使用逐行 JSON 协议，收到 EOF 退出。
标准输出仅有协议 JSON，诊断位于结果中；进程级错误类型仅写 stderr。
所有 JSON 管道强制 UTF-8，证据列统一为 UTF-16，从 1 开始。

## C#

- 项目：`analyzers/csharp/ArchitectureExplorer.Analyzers.csproj`，目标 .NET 10。
- 固定 Roslyn `Microsoft.CodeAnalysis.CSharp 4.14.0`，NuGet lock 文件随源码保存。
- 入口产物：`analyzers/csharp/bin/Release/net10.0/ArchitectureExplorer.Analyzers.dll`。
- 支持声明、partial 合并、重载、继承/接口实现、类型引用、静态绑定调用、构造器、显式字段/属性读写、声明初始化、事件发布/订阅语法和明确处理器引用。
- lambda 与局部函数是独立作用域。lambda 身份由包含符号和作用域内序号组成，不使用行号；在同一方法前方插入新 lambda 可能改变后续匿名身份。相同签名的不同 lambda 参数不会合并。
- 虚调用的边表示编译器绑定的声明目标，`dispatch=virtual-declaration` 明确提示实际覆写未知。
- `ref/out` 只生成推断的潜在写入。属性 getter/setter 的任意副作用、集合元素变更、反射、动态调用、委托最终目标、Unity 生命周期时序不作完整建模。
- `nameof` 产生引用而非数据读取。复合赋值产生读写两类边。
- 缺失引用保留声明并返回编译上下文诊断；不为 Unity 等缺失类型创建假实现，不按名字猜调用目标。
- 真正语法错误返回 `CS_SYNTAX_*`、`severity=error`；缺少引用等语义上下文问题返回 warning。索引层遇到 error 保留上次有效索引，避免编辑过程的半成品语法覆盖完整地图。
- 没有显式基础类库时使用 Worker host 的可信基础运行时元数据；配置含 `mscorlib.dll` 或 `System.Private.CoreLib.dll` 时只使用显式引用集合。分析上下文与 Unity 每个 asmdef 的实际构建配置并不等价，合并模式不能验证程序集访问边界或实际游戏构建。

## Python

- 入口：`python -B analyzers/python/analyze.py`。
- 使用标准库 `ast` 与 `symtable` 进行语法/作用域解析，不需第三方包。
- 支持函数、类、参数、词法包含、导入与保守的直接函数绑定；实例方法、动态绑定或重绑定目标未确定时返回聚合诊断。
- 导入根取决于 `sys.path`，匹配到其他输入文件的导入调用标为推断，不能当成运行时导入验证。
- 装饰器可替换函数，因此相应调用降为推断。局部参数、重定义、局部赋值遮蔽的函数名不创建确认调用边。
- 字典/属性访问节点按**函数及根表达式**分开。两个函数中名为 `hp` 的键不自动共享身份；这提供可核验的静态访问位置，不能宣称跨函数对象别名或完整运行时数据流。
- 不推断 Python 实例属性的统一类型身份、不执行装饰器、不解析 monkey patch 或任意回调目标。

## 增量行为

持久进程按 scope、相对路径、hash 与源码内容复用 AST/SyntaxTree。C# 宏变化使解析缓存失效，引用元数据时间/长度变化使语义上下文失效。
删除文件移除树和相应结果。C# 在不可变 Compilation 中移除/增加变化树；为避免漏掉跨文件绑定变化，首版对该语言上下文保守重新生成语义关系。
因此没有每次重解析所有源码，但语义重绑定仍是合并上下文范围，并非完整的符号级增量分析。
每次返回 `info` 诊断 `incremental-parser`，其中有 `parsed=N; reused=N; removed=N`。

## 验证

先运行根目录的工具 bootstrap/build，然后执行：

```powershell
node node_modules/tsx/dist/cli.mjs --test tests/analyzers.test.ts
```

金标准涵盖重载、partial、字段复合读写、条件、事件、lambda/局部函数、缺少 Unity 引用、中文与 emoji 证据、Python 重绑定/作用域键、语法失败以及同进程修改/删除后的解析复用。
真实项目统计和端到端验收由主控文档记录；本说明不冒充运行时验证。

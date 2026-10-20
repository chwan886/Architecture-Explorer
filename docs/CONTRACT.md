# 实施契约 v1

本任务由用户批准。GameDemo02 只读，所有缓存、测试夹具和运行文件只能写工具仓库。

权威类型暂在 packages/schema/src/index.ts，主控负责 JSON Schema 与输出校验。不要自行改公共类型。

## 分析器

标准输入单个 JSON AnalyzerRequest（整次请求），标准输出单个 AnalyzerResult JSON，日志只写 stderr。不要 import/执行目标代码。文件由服务端授权读取后传入；Worker 仅解析内容。C# 可读取显式引用的程序集元数据，不能执行目标程序集。

stableId = category + ':' + SHA256(scopeId + '|' + category + '|' + key) 前24位十六进制。文件 ID category=file，key=正斜线相对路径。其他符号 key 必须含语言和完整语义身份，不用行号。每条重要关系带实际 evidenceIds。Evidence 行列从1开始；列统一 UTF-16，Python需转换。excerpt可选，必须来自源码。

C# Worker：analyzers/csharp/ArchitectureExplorer.Analyzers.csproj，产物同目录 bin/Release/net10.0/ArchitectureExplorer.Analyzers.dll。Python：analyzers/python/analyze.py。C# 引用缺失不能假造 Unity 类型。Python字典键不全局按字符串合并。未知调用保留诊断。DTO跨语言边如未验证就不自动生成。

## HTTP

GET /api/projects -> {projects: [{id,name,root}]}
GET /api/projects/:projectId/worktrees -> {worktrees: WorktreeInfo[]}
以下查询参数 scope=scopeId（projectId + ':' + worktreeId），所有响应同一scope与revision。
GET /api/status -> IndexStatus
GET /api/summary -> {metadata,counts:{nodes,edges,files},diagnostics,rootId}
GET /api/graph?rootId=&view=architecture|calls|data|impact&direction=both|up|down&depth=1&limit=80&kinds=&confidence= -> GraphResult
GET /api/search?q=&limit=40 -> {nodes: ArchitectureNode[],revision}
GET /api/nodes/:nodeId -> {node,parents:ArchitectureNode[],incoming:ArchitectureEdge[],outgoing:ArchitectureEdge[],relatedNodes:ArchitectureNode[],evidence:Evidence[],revision}
GET /api/evidence/:evidenceId -> {evidence,content:string,stale:boolean,revision}（content为有界源码上下文，按evidenceId读取，绝无任意path读取端点）
GET /api/diagnostics -> {diagnostics,revision}
POST /api/scan body {scope,full:boolean} -> {accepted:true}
GET /api/events?scope= -> SSE data: IndexStatus

architecture视图 rootId 为空显示 project 的直接系统/模块，指定root则显示其直接子节点；calls/data/impact需要选中节点。data从字段查看读写方法、从方法查看所读写字段。所有遍历有深度/节点预算，明确truncated，不做虚假连线。scope不存在/未授权则拒绝。

## 配置和命令

config/local.json被忽略，config/projects.example.json为模板。EXPLORER_CONFIG可覆盖配置文件。默认cacheDir=.cache，配置相对路径相对配置文件。浏览器不能提交任意扫描root。
Node CLI scan/watch/verify，接收 --project <id> --worktree <id>；dev默认服务 http://127.0.0.1:4310，生产静态输出dist。开发可同服务整合Vite或使用Vite代理，主控协调。

## 文件归属

- A: analyzers/**、tests/analyzer*.test.ts、tests/fixtures/analyzers/**。
- B: apps/web/**（含vite.config.ts，frontend import type from ../../../packages/schema/src/index 按路径适配）。
- C: apps/server/**、packages/indexer/**、tests/indexer*.test.ts、tests/fixtures/indexer/**。
- 主控: packages/schema/**、根配置、锁文件、Tools/**、其他tests/**、docs/**、README、config/**。

依赖与公共接口变更先发消息主控，不跑依赖安装、不修改对方目录。全部使用明确当前工具worktree路径。共享工作目录以文件归属隔离；不要假定子Agent有独立cwd。

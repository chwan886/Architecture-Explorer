# 系统架构升级公共契约

原始事实索引和分析器保持兼容。新增类型唯一来源为 packages/architecture-model/src/types.ts，主控维护；其他 Agent 不修改公共类型、App.tsx、server.ts、package.json 或锁文件。

模型文件：architecture/models/<projectId>/model.json。源代码根目录仍只来自配置；模型不包含绝对目录。业务系统、归属、流程初始均为候选；人工决策另存 reviews，且与当前源码指纹绑定。原始 parentId 不变。

API 全部要求配置授权的 scope。查询返回 metadata(scopeId/sourceRevision/modelRevision/viewRevision)。带 viewRevision 的详情、关系、证据在版本不符时返回409，禁止混合版本。

- GET /api/architecture?scope=&perspective=business|technical&rootId=&category= → ArchitectureView
- GET /api/architecture/entities/:id?scope=&viewRevision= → ArchitectureEntityDetail（业务定义逻辑ID）
- GET /api/architecture/relations/:id?scope=&viewRevision=&offset=&limit= → RelationMembers
- GET /api/architecture/flows?scope= → {metadata, flows: ResolvedBusinessFlow[]}
- GET /api/architecture/ownership?scope=&nodeId= → OwnershipResult
- GET /api/architecture/unclassified?scope=&viewRevision=&offset=&limit= → {metadata,nodes,offset,total,truncated}
- GET /api/architecture/evidence/:id?scope=&viewRevision= → 兼容 EvidenceContent
- GET /api/architecture/model?scope= → ModelEnvelope
- PUT /api/architecture/model?scope=，body {expectedRevision,model} → ModelEnvelope
- POST /api/architecture/review?scope=，body {expectedModelRevision,viewRevision,targetType,targetId,decision:confirmed|rejected|pending} → ModelEnvelope

没有项目模型时返回空模型，技术视角仍可用。所有模型写入在工具目录中校验、加锁、原子保存；模型编辑不触发源码扫描。人工确认系统定义不等于批量确认其归属规则。

Engine exports（packages/architecture-model/src/index.ts）：validateModel(value), modelRevision(model), buildProjection(index,model), architectureView(projection,index,perspective,rootId?,category?), entityDetail(projection,index,id), relationMembers(projection,index,id,offset?,limit?), ownership(projection,nodeId), reviewFingerprint(projection,targetType,id)。函数均纯计算；持久化及HTTP由主控集成。

业务投影：根→系统；systemId→其模块；moduleId→组件列表及复用代码入口。逻辑定义ID用于route/rootId；图节点用scope稳定nodeId，并通过ResolvedEntity.nodeId映射。技术视图默认4个C#程序集与Python/资源系统入口，之后复用事实图的下钻。

系统连线只由未拒绝、非冲突的owner归属和当前原始关系生成。participant/shared用于职责关联和流程参与，不能制造跨系统边。每个方向一条汇总边，保留所有memberEdgeIds；类别筛选后重新统计。原始读取/写入不升级为运行时数据传递。业务归属未确认时membershipPending=true，汇总线标待确认，保留底层confidenceCounts。

模型SourceAnchor必须包含当前索引文件内容哈希（UTF-8解码后，与事实索引一致）、精确行范围和quote。只可使用当前索引文件。哈希改变即标needs-review，不把旧行号静默当新证据；模型证据读取仅接受投影内ID。流程static-call必须找到真实成员调用边才可标静态确认；source-order必须有仍有效的锚点才标源码支持；协议、多请求及叙述顺序均标未验证，禁止运行时确认。

UI Agent只拥有apps/web/src/architecture/**与GraphCanvas.tsx的向后兼容展示扩展。导出ArchitectureWorkspace默认组件，props {scope, revision?, route:ArchitectureRoute, onRouteChange(route), onOpenCode(request:OpenCodeRequest)}；路由history在组件内部，scope变化清空。onOpenCode交给主控复用原代码地图。共享SourcePreview.tsx由主控提供，props {source:EvidenceContent, rootPath:string}。代码级请求守卫及8项导航回归必须保留。

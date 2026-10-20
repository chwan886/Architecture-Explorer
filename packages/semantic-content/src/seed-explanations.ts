// Authored candidate explanations reference the existing flow steps; these texts
// never create source calls, data-flow edges or runtime order evidence.
export interface CandidateExplanation {
  purpose: string;
  inputs: string[];
  processing: string[];
  outputs: string[];
  stateChanges: string[];
  conditions: string[];
  asyncBoundaries: string[];
}
const explanation = (purpose: string, inputs: string[], processing: string[], outputs: string[], stateChanges: string[] = [], conditions: string[] = [], asyncBoundaries: string[] = []): CandidateExplanation =>
  ({ purpose, inputs, processing, outputs, stateChanges, conditions, asyncBoundaries });

export const candidateExplanations: Record<string, CandidateExplanation> = {
  'claim-click': explanation('把领取按钮的意图交给命令入口。', ['用户点击领取按钮'], ['已注册回调以 claim 动作为参数调用 Send。'], ['领取命令意图'], [], ['回调只有发生点击时才会执行。'], ['源码证明回调中的调用；没有采集实际点击。']),
  'claim-send': explanation('为一次领取操作建立可重试的命令身份。', ['action=claim', '当前账号版本'], ['构造命令并交由 Session.Queue 设置请求身份，再进入派发入口。'], ['Pending 命令'], ['更新待发命令。'], ['需要现有账号状态。']),
  'claim-dispatch': explanation('在宿主空闲时派发待发意图。', ['Busy', 'Pending', '当前 State'], ['等待正在处理的请求结束，再创建 Request 协程。'], ['请求协程入口'], [], ['State 与 Pending 必须仍存在。'], ['协程调用边不证明协程已被调度完成。']),
  'claim-request': explanation('固定首发版本并序列化领取请求。', ['Pending', 'token', '命令路由'], ['将命令路由改为 v2；PreparePending 固定首发版本；序列化 JSON。'], ['path、JSON 和会话令牌'], ['设置首发 Pending.revision。'], ['路径为命令路由时才准备 Pending。'], ['Request 会等待 Busy；传输完成通过协程继续执行。']),
  'claim-http': explanation('按照客户端协议发送命令 JSON。', ['path', 'body', 'token'], ['封装 JSON 请求及 Bearer 会话信息。'], ['传输结果回调'], [], ['本机服务可达且请求获得响应才有正常结果。'], ['网络交付与服务端实际接收尚未运行验证。']),
  'claim-handler': explanation('把协议层的命令请求交给服务入口。', ['HTTP 路由、JSON、token'], ['匹配命令路由并通过 service 对象分派执行。'], ['服务执行请求'], [], ['请求匹配命令路由并通过解析。'], ['动态对象分派没有直接静态 calls 证明；HTTP 到达顺序未验证。']),
  'claim-execute': explanation('在共享事务入口检查身份、重放与版本。', ['会话', '请求标识', 'revision', '账号数据'], ['获取锁并开启事务；认证、加载账号；处理旧回执与版本冲突。'], ['可继续处理的账号和命令，或提前返回结果'], [], ['旧回执、身份或版本问题可能使执行提前返回。'], ['一次事务属于一次请求；不等同于跨请求执行轨迹。']),
  'claim-settle': explanation('先把驻守经过的时间补算为可领取储量。', ['成员与设施', '上次结算时间', '当前时间'], ['settle 中使用 rates 与经过时间累积 reserve；同一函数也处理修炼与探矿。'], ['更新后的 reserve'], ['修改储量及结算水位。'], ['受容量和时间上限约束。'], ['跨模块导入调用在当前索引中仅有 inferred 依据。']),
  'claim-transfer': explanation('将储量中的整数部分转入可消费余额。', ['reserve', 'action=claim'], ['逐种资源取整数、增加余额、保留储量小数部分。'], ['增加的 stones、iron、essence 余额'], ['减少对应 reserve，增加资源余额。'], ['只有 claim 分支执行此转账。'], ['分支源码不证明某次请求一定进入该分支。']),
  'claim-persist': explanation('让账号变化与请求回执在同一事务中持久保存。', ['处理后的账号', '请求摘要', '执行结果'], ['根据状态是否变化更新序号并保存账号；记录请求回执后提交。'], ['持久账号与可重放回执'], ['写 SQLite accounts、requests，并按条件更新 revision/snapshotSeq。'], ['并非所有失败或重放路径都会推进版本。'], ['提交后的响应发送不由这段源码证明已经完成。']),
  'claim-snapshot': explanation('向客户端提供包含资源余额的完整状态。', ['账号状态', '响应模式'], ['full 模式经 snapshot 构造公开状态，保留内部字段边界。'], ['完整 state 响应'], [], ['本阶段描述 full 响应路径。'], ['Python 字典到客户端 DTO 的值传递尚无运行时证明。']),
  'claim-return': explanation('将传输 JSON 解码为客户端响应对象。', ['HTTP 传输结果 JSON'], ['使用 JsonUtility 解析 SectResponse；错误与空响应另走保护分支。'], ['SectResponse 或失败结果'], [], ['必须获得可解析响应，且未因错误提前返回。'], ['没有采集实际收包；服务端发送与客户端接收是协议边界。']),
  'claim-prepare-call': explanation('在完整账号响应路径调用快照检查。', ['已解析 SectResponse'], ['Request 在保护分支之后调用 Session.PrepareResponse。'], ['进入会话快照检查'], [], ['非 401、未提前返回且走完整账号响应路径。'], ['解码到调用点只有同一方法源码顺序支持，不代表运行时必执行。']),
  'claim-check': explanation('避免旧快照覆盖新状态，并补充静态目录。', ['响应 snapshotSeq', '当前 State', '内容目录'], ['PrepareResponse 检查快照顺序，并按需要恢复静态内容引用。'], ['可应用的候选 State，或拒绝旧包'], ['可能补齐响应中的静态目录。'], ['过旧快照会被拒绝。']),
  'claim-apply': explanation('把通过检查的完整状态提交给宿主。', ['response.state'], ['在存在合法 state 的分支提交 Session.State。'], ['供后续页面读取的当前 State'], ['替换会话当前状态。'], ['response.state 非空；否则保留既有状态。'], ['提交后何时重绘取决于宿主生命周期。']),
  'claim-display': explanation('让资源控件从当前快照显示余额。', ['State.stones', 'State.iron', 'State.essence'], ['BuildShell 注册余额读取回调，由页面刷新机制读取并更新文本。'], ['资源控件文本'], ['改变控件显示值。'], ['存在有效页面与状态。'], ['控件刷新与网络事务没有同帧或同步执行证明。']),
  'battle-click': explanation('把普通挑战或守卫重试交给命令入口。', ['用户点击', 'region', '本场/守卫状态'], ['回调按重试条件选择 battle_start 或 battle_guard。'], ['开战命令意图'], [], ['满足当前界面的允许开战条件。'], ['用户点击没有运行时采集。']),
  'battle-request': explanation('为开战意图准备身份、版本与 JSON。', ['Pending', 'token', '开战参数'], ['场景模型折叠 Send→DispatchPending→Request 的请求准备职责。'], ['待发送的开战请求'], ['固定首发命令版本。'], ['合法 Pending 且宿主可发起请求。'], ['按钮到折叠请求阶段仅是解释关联，不伪造直接调用边。']),
  'battle-http': explanation('通过本机 HTTP 客户端发送开战意图。', ['path', 'body', 'token'], ['构造命令 JSON 请求并等待传输回调。'], ['传输结果'], [], ['连接与服务正常时才能取得成功结果。'], ['网络送达、接收与完成时刻均未运行验证。']),
  'battle-route': explanation('用共同事务规则接收开战命令。', ['账号会话', '请求标识', 'revision', '开战数据'], ['认证、回执去重、版本检查与时间补算后，进入规则命令入口。'], ['可执行规则意图或提前返回结果'], [], ['请求未被重放/冲突/认证分支提前结束。'], ['HTTP 分派和跨模块规则调用保持未验证。']),
  'battle-rules': explanation('从共享业务分派器转交 battle 命令。', ['action', 'data', 'state.last'], ['rules.command 识别 battle_ 前缀，再调用 combat 处理器。'], ['战斗命令处理请求'], [], ['action 以 battle_ 开头。'], ['当前 Python 跨模块调用为 inferred，不能标成静态确认。']),
  'battle-command': explanation('校验具体开战模式并选择创建入口。', ['action', 'value', 'locked'], ['普通和守卫分支分别校验条件，再调用 start。'], ['合法的 start 调用'], [], ['battle_start 或 battle_guard，且符合本场锁定与场景限制。']),
  'battle-start': explanation('创建服务端权威战斗实例。', ['有效技能', '装备属性', '遭遇配置', '策略'], ['生成双方角色，保存奖励、随机流和本场状态。'], ['combat.battle'], ['建立本场并设置掌门 activity。'], ['通过开战分支的条件检查。'], ['创建本场后仍需后续请求驱动补算；没有后台持续 tick。']),
  'battle-next-poll': explanation('在后续界面帧到期时发起新的轮询。', ['State', 'Busy', 'pollAt', 'fullPollAt'], ['Update 检查空闲和时间条件，选择动态或完整状态请求。'], ['新的 battle/state 请求'], ['设置下一轮询时间。'], ['已有 State、空闲且达到 pollAt。'], ['这是开战请求之后的独立请求，实际先后未运行验证。']),
  'battle-poll-execute': explanation('让新的查询请求也能推进权威状态。', ['会话', '当前账号', '查询路由'], ['battle/state 路由重新进入 execute，处理时间推进与事务保存。'], ['待补算的当前账号'], [], ['这是新 HTTP 请求，客户端不提交权威胜负。'], ['轮询与开战不属于同一调用栈。']),
  'battle-advance': explanation('按服务端时间与心跳预算推进固定步。', ['now', 'heartbeat', 'battle.last', 'active 状态'], ['检查心跳宽限并计算可补算的固定步，逐步调用 step。'], ['推进后的本场或中止结果'], ['推进 last/heartbeat 等本场水位。'], ['本场 active 且满足心跳条件；超出宽限可能中止。']),
  'battle-step': explanation('结算一个固定步内的动作、命中和终局条件。', ['角色', '待结算效果', '动作与飞剑'], ['处理到期效果和命中回调，再检查双方 HP 与胜负。'], ['本步状态，或 finish 调用'], ['可修改 HP、法力、状态与反馈。'], ['对应效果到期；胜负条件成立时进入终局。'], ['飞剑回调的全部动态分派仍有分析限制。']),
  'battle-finish': explanation('按终局类型发放奖励、解锁或处理连续战斗。', ['status', 'boss', 'rewards', 'continuous'], ['active 本场结束后，普通胜利推进资源/wave；守卫胜利开放矿格并给灵髓。'], ['本场 result 与条件奖励'], ['修改资源或 opened/essence，并设置 result/nextAt 等。'], ['胜利与失败、普通与守卫、连续模式具有不同分支。'], ['条件结果写入不是完整运行时数据传播证明。']),
  'battle-save': explanation('把补算结果与奖励写回账号。', ['更新后的本场和账号'], ['step/advance 返回后，execute 继续经营结算和事务保存。'], ['持久化账号与 snapshotSeq'], ['按状态变化写 SQLite 账号。'], ['需走到事务保存路径。'], ['本阶段是跨过程返回后的叙述关联，不宣称 finish 直接调用数据库。']),
  'battle-response': explanation('按查询模式返回动态战斗包或完整账号快照。', ['权威账号', '响应模式'], ['动态包提供 battle/locked/continuous/wave；完整 state 才覆盖经济和矿格。'], ['HTTP 响应对象'], [], ['由请求模式决定返回范围。'], ['响应生成与实际送达分开；精简包不代表已同步全部奖励。']),
  'battle-decode': explanation('解析战斗响应并判断是否需要补取全量状态。', ['JSON', 'battleOnly', 'combat.locked'], ['解析响应；动态战斗已解锁时进入重新请求全量状态的分支。'], ['可合并响应或全量查询意图'], [], ['收到有效 HTTP 结果；特殊错误分支可能提前返回。'], ['后续全量请求具有新的异步边界。']),
  'battle-full-state': explanation('取得能包含奖励与矿格变化的完整账号状态。', ['动态结束条件', '周期全量条件'], ['动态包且 locked=false 时立即重取 state；连续待续仍锁定时等待周期全量。'], ['新的 /v2/state 请求及其响应路径'], [], ['立即结束或后续周期全量分支。'], ['不能把所有终局都画成立刻解锁；多个请求的实际顺序未采集。']),
  'battle-prepare': explanation('在应用完整快照前检查顺序和目录。', ['snapshotSeq', 'revision', '静态目录'], ['PrepareResponse 拒绝旧快照，并补齐需要的内容引用。'], ['可应用的候选 State'], ['可能补全候选响应的目录。'], ['快照未过旧且响应可用。']),
  'battle-view': explanation('把已提交快照交给只读战斗表现。', ['State.combat'], ['宿主提交 State 后调用 SetState，视图据此更新表现对象。'], ['战斗视图快照'], ['更新视图快照及表现对象。'], ['存在合法响应状态。'], ['视图不承担权威伤害推算；画面播放与规则步没有同步时钟证明。']),
  'battle-hud': explanation('用当前快照刷新生命与法力显示。', ['hero.hp/maxHp', 'hero.mana/maxMana'], ['HUD 读取快照字段并计算进度条 value 与 title。'], ['生命条和法力条文本/数值'], ['改变 meter.value 与 title。'], ['对应角色和界面控件可用。'], ['HUD 帧、网络轮询和服务端固定步是独立频率。']),
};

export const candidateSummaryGroups = [
  { flowId: 'claim-reserve', id: 'claim-intent', title: '发起领取意图', stepIds: ['claim-click', 'claim-send', 'claim-dispatch'], purpose: '把用户操作组织为带身份、可等待派发的命令。' },
  { flowId: 'claim-reserve', id: 'claim-transport', title: '准备并发送请求', stepIds: ['claim-request', 'claim-http'], purpose: '固定命令版本并越过客户端传输边界。' },
  { flowId: 'claim-reserve', id: 'claim-gate', title: '校验请求与账号', stepIds: ['claim-handler', 'claim-execute'], purpose: '通过协议、身份、去重和版本约束进入规则处理。' },
  { flowId: 'claim-reserve', id: 'claim-economy', title: '结算并领取储量', stepIds: ['claim-settle', 'claim-transfer'], purpose: '先补算可领取储量，再按整数部分增加可消费余额。' },
  { flowId: 'claim-reserve', id: 'claim-commit', title: '保存并构造快照', stepIds: ['claim-persist', 'claim-snapshot'], purpose: '持久保存账号变化与回执，并组织完整状态响应。' },
  { flowId: 'claim-reserve', id: 'claim-present', title: '应用快照并显示余额', stepIds: ['claim-return', 'claim-prepare-call', 'claim-check', 'claim-apply', 'claim-display'], purpose: '解析、检查并提交合法快照，再由界面读取资源余额。' },
  { flowId: 'battle-start-poll-result', id: 'battle-intent', title: '提交挑战意图', stepIds: ['battle-click', 'battle-request', 'battle-http'], purpose: '选择挑战方式并发出有身份的开战请求。' },
  { flowId: 'battle-start-poll-result', id: 'battle-gate', title: '校验与分派开战', stepIds: ['battle-route', 'battle-rules', 'battle-command'], purpose: '通过事务入口和业务分支后进入战斗创建。' },
  { flowId: 'battle-start-poll-result', id: 'battle-create', title: '创建权威本场', stepIds: ['battle-start'], purpose: '由服务端建立角色、配置、策略和随机状态。' },
  { flowId: 'battle-start-poll-result', id: 'battle-heartbeat', title: '后续请求驱动固定步', stepIds: ['battle-next-poll', 'battle-poll-execute', 'battle-advance'], purpose: '用独立轮询请求和服务端时间推进本场。' },
  { flowId: 'battle-start-poll-result', id: 'battle-resolve', title: '命中与终局分支', stepIds: ['battle-step', 'battle-finish'], purpose: '结算固定步并按结果应用奖励、解锁或连续战斗条件。' },
  { flowId: 'battle-start-poll-result', id: 'battle-commit', title: '保存结果并选择响应', stepIds: ['battle-save', 'battle-response'], purpose: '把规则结果保存，明确动态包与完整快照的范围。' },
  { flowId: 'battle-start-poll-result', id: 'battle-present', title: '补取全量并刷新表现', stepIds: ['battle-decode', 'battle-full-state', 'battle-prepare', 'battle-view', 'battle-hud'], purpose: '按条件补取完整状态，再将快照交给只读视图和生命条。' },
];

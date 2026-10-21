export type DeliveryLane = 'human' | 'game' | 'tool';
export interface DeliveryLink { label: string; url: string }
export interface DeliveryStage {
  id: string; title: string; summary: string; lane: DeliveryLane; actor: string;
  manualReview?: boolean;
  input: string; output: string; trigger: string; pass: string; blocked: string; failure: string;
  steps: string[]; links: DeliveryLink[]; configuration?: string;
}

const game = 'https://github.com/chwan886/GameDemo02';
const tool = 'https://github.com/chwan886/Architecture-Explorer';
const link = (label: string, url: string): DeliveryLink => ({ label, url });
const guide = link('两仓交付合同与首次接入', `${tool}/blob/main/docs/DEVELOPMENT-DELIVERY.md`);
const rules = link('游戏分支规则', `${game}/rules`);
const gameWorkflow = link('游戏 Fast 与工具检查', `${game}/actions/workflows/architecture.yml`);
const indexWorkflow = link('工具提交索引流水线', `${tool}/actions/workflows/game-index.yml`);

/** This is a maintained process description, separate from analyzed source facts. */
export const deliveryStages: DeliveryStage[] = [
  {
    id: 'scope', title: '任务范围 / 变更分级', lane: 'human', actor: '用户确定目标；游戏主控与执行者界定范围',
    summary: '明确局部、功能或架构影响，并选择适用验证。',
    input: '任务目标、当前源码、长期规则与验收要求。', output: '范围、所有者、验收条件、风险与验证计划。',
    trigger: '开始任务，或已授权任务的范围发生实质变化。', pass: '目标与边界清楚；架构方向有授权；验证等级与风险相符。',
    blocked: '范围不清、架构方向未授权，或长期规则冲突未解决。', failure: '先修正范围或向用户说明具体冲突；保留已有成果。',
    steps: ['说明输入、预期行为、涉及模块和验收条件。', '按行为、契约、数据及所有者影响分级，不按文件数冒充低风险。', '日常游戏 Full 仅横屏；Release 再处理竖屏。远端 Fast 不代表 Unity Full。'],
    links: [link('游戏开发规则', `${game}/blob/main/Docs/Handbook/Development.md`), link('变更检测与批准', `${game}/blob/main/Docs/Handbook/ChangeControl.md`)],
  },
  {
    id: 'feature', title: 'feature 分支与 PR', lane: 'human', actor: '游戏执行者提交；游戏主控组织 PR',
    summary: '隔离变更，交付可审阅的差异和验证证据。',
    input: '已界定的任务与现有 main 基线。', output: 'feature 提交、PR、验证结果与交接说明。',
    trigger: '任务进入实现与审阅。', pass: 'PR 描述与最终差异一致，证据绑定实际提交。',
    blocked: '未提交差异、验证缺失、交接范围不明或与其他工作冲突。', failure: '在 feature 修复并重新提交；不清理或覆盖其他执行者成果。',
    steps: ['从既有仓库和历史创建 feature。', '记录实际执行的 Fast / Full / Release 及未运行项。', '用 PR 提供差异和证据；尚无具体 PR 时从列表进入。'],
    links: [link('游戏 PR 列表', `${game}/pulls`), link('游戏 Git 与 CI 规范', `${game}/blob/main/Docs/GitPolicy.md`)],
  },
  {
    id: 'checks-review', title: 'CI 检查 + 独立 Review', lane: 'game', manualReview: true, actor: 'GitHub Actions 执行检查；独立 Reviewer 审查',
    summary: '检查和独立审阅并行，两者均满足才能继续。',
    input: '同一候选 PR 提交、规则与验证计划。', output: 'CI 回执与独立 Review 记录。',
    trigger: 'PR 打开或候选提交更新。', pass: '所需检查成功且独立 Review 满足规则；候选更新后重新核对。',
    blocked: 'CI 失败、取消或缺失；Review 未完成、需修改或已过期。', failure: '修复 feature，重新检查并请求独立 Review；不得删除测试或弱化门禁。',
    steps: ['CI：Fast 与工具 / 文档合同检查。', '独立 Review：审查最终差异、风险和证据，不由实现者自批。', 'AND 门：检查通过且 Review 满足，不能互相替代；PR 检查不取得跨仓生产凭据。'],
    links: [gameWorkflow, link('游戏 PR / Review', `${game}/pulls`), rules], configuration: 'CODEOWNERS、必需检查和独立 Review 规则待游戏主控交接并由用户核实。',
  },
  {
    id: 'approval', title: '高风险 / 门禁变更本人批准', lane: 'human', actor: '用户通过独立入口批准；主控提供具体变更说明',
    summary: '仅高风险或门禁变更进入此条件分支。',
    input: '冻结的候选内容、风险理由、替代方案、兼容与回退及验证证据。', output: '绑定具体内容的本人批准，或不适用说明。',
    trigger: '变更分级或规则要求本人批准；普通低风险变更直接进入合并条件核对。', pass: '需要批准时已由本人独立批准当前内容；不需要时明确不适用。',
    blocked: '应批准而未批准、内容已变化，或硬约束 / 测试仍失败。', failure: '修复失败；变更内容后重新提交审阅。批准不能放行失败测试。',
    steps: ['判定是否涉及高风险、规则、门禁或未授权架构方向。', '适用时交本人独立批准，不从 payload 的 reviewed=true 或普通聊天生成批准。', '不适用时继续；不为每个低风险改动增加人工批准。'],
    links: [link('批准范围与部署边界', `${game}/blob/main/Docs/Handbook/ChangeControl.md`), rules], configuration: '独立身份与批准边界待配置 / 待核实；本页面没有批准操作。',
  },
  {
    id: 'merge', title: '合并受保护 main', lane: 'human', actor: '游戏主控 / 有权限的集成人；GitHub 规则限制合并',
    summary: '规则、检查、Review 与适用批准共同约束集成。',
    input: '满足合并条件的 PR。', output: '受保护 main 中的准确合并提交 SHA。',
    trigger: '所有必要条件满足并决定集成。', pass: '实际 main 保护有效；必需检查、独立审阅及适用批准均成立。',
    blocked: '规则未启用、存在绕过、基线变化、冲突或任何门禁未满足。', failure: '在 feature 修复或重新审查；不改写 main 历史。',
    steps: ['核对 ruleset / 分支保护、禁止绕过与 force push。', '核对合并内容对应的检查与独立 Review。', '合并进入既有 main，保留仓库历史与可见性。'],
    links: [rules, link('游戏 PR 列表', `${game}/pulls`)], configuration: '远端分支保护与绕过权限未在本页面实时核验；必须由用户配置并验收。',
  },
  {
    id: 'main-checks', title: 'main 检查', lane: 'game', actor: '游戏 GitHub Actions',
    summary: '只对受保护 main 的 push 核对 Fast 与工具检查。',
    input: '实际 main push 的准确 SHA 和来源 run。', output: '与该 SHA 绑定的成功检查及来源 run ID / URL。',
    trigger: '受保护 main 的 push。PR 打开、未合并关闭均不进入正式索引链。', pass: '本次 Fast 与工具检查都成功，运行未失败或取消。',
    blocked: '非 main push、检查失败 / 取消、必需报告缺失或来源 SHA 不一致。', failure: '游戏 CI 明确失败，修复后由真实 main 检查重新进入；不触发正式索引。',
    steps: ['运行游戏既有 Fast 和工具 / 文档合同检查。', '核对本次报告和提交，保留失败诊断。', '这些检查没有执行 Unity Full、Windows Player 或 Release。'],
    links: [gameWorkflow, link('游戏 Actions 运行列表', `${game}/actions`)], configuration: '第一阶段 CI 的报告与 CODEOWNERS 改造由游戏主控集成，本页仅说明接口。',
  },
  {
    id: 'dispatch', title: '跨仓库触发', lane: 'game', actor: '游戏 main CI 使用受限 GitHub App 短期令牌',
    summary: '传递固定来源仓库、准确游戏 SHA 与来源 run。',
    input: '成功 main 检查、固定仓库名、SHA、来源 run ID / URL。', output: '触发请求回执与真实工具目标 run 链接。',
    trigger: 'main 检查成功且用户已审核启用发送步骤。', pass: '受保护 Environment 授权；请求被接受并解析到真实目标 run。',
    blocked: '发送尚未启用、App / Environment 未配置、来源校验失败或目标 run 无法定位。', failure: '明确标记触发失败并保留回执；请求成功不等于目标构建成功。',
    steps: ['游戏侧发送步骤首次保持关闭；工具 main 合入并手验就绪后，再由用户审核启用。', 'workflow_dispatch 固定工具 main；跨仓触发权限与游戏只读权限分开。', '分别记录请求成功与目标运行结果；不把 HTTP 接受当构建通过。'],
    links: [gameWorkflow, indexWorkflow, guide], configuration: 'GitHub App、仅 main 可用的受保护 Environment / Secrets 和发送开关待用户配置。',
  },
  {
    id: 'tool-build', title: '工具构建', lane: 'tool', actor: 'Architecture-Explorer GitHub Actions',
    summary: '在受保护 main 的工具代码上冻结还原并完整检查。',
    input: '工具 main 代码、锁文件与已验证的触发输入。', output: '实际工具 SHA、检查结果、前端与 C# 分析器及运行依赖。',
    trigger: '目标工具 workflow_dispatch 经校验后启动。', pass: '干净 Windows runner 完成锁定环境、Typecheck、Test、前端与 C# 构建。',
    blocked: '来源 / SHA 不合法、工具 ref 非 main、锁定还原或任一检查失败。', failure: '目标流水线标红，保留必要诊断；有权限人员可在 GitHub 重跑。',
    steps: ['准备锁定 Node / pnpm / .NET / Python，冻结依赖还原。', 'Typecheck → Test → 前端与 C# worker 构建；PR 只用仓库夹具。', '工具包包含 TypeScript / tsx 后端、运行依赖和启动说明；dist 只含前端。'],
    links: [link('工具 PR / main CI', `${tool}/actions/workflows/tool-ci.yml`), indexWorkflow, link('工具构建脚本', `${tool}/blob/main/Tools/explorer.ps1`)],
  },
  {
    id: 'scan', title: '游戏精确 SHA 扫描与核验', lane: 'tool', actor: '工具流水线与既有只读分析器',
    summary: 'checkout 指定 SHA，复用 Scan → Verify → Audit。',
    input: '经 main 历史核验的准确游戏 SHA、临时 CI 配置与显式 Unity 引用。', output: '对应 SHA 的索引、审计报告、引用 / 配置指纹与限制。',
    trigger: '工具检查 / 构建成功，目标代码和引用已准备。', pass: '游戏 SHA 属于允许的 main 历史；metadata.gitHead 精确相等且非空；扫描前后源码与工作区未变。',
    blocked: 'Git 读取失败、SHA 不匹配、源码变动、Unity 引用缺失或指纹 / 校验不一致。', failure: '阻塞或明确记录降级范围；不能伪造 Unity 类型或宣称完整语义成功。',
    steps: ['准确 SHA checkout，不替换为“最新 main”；CI 缓存和输出只写工具侧。', '只解析代码与显式程序集元数据，不运行目标 Python、游戏构建或目标程序集。', '过期职责模型、解释和锚点保留“待复核”，不自动确认或改写人工文字。'],
    links: [indexWorkflow, link('索引边界与契约', `${tool}/blob/main/docs/CONTRACT.md`), link('证据审计说明', `${tool}/blob/main/docs/EVIDENCE-AUDIT.md`), guide], configuration: 'Unity 引用供应、引用摘要与游戏只读 App 权限待用户配置并核实。',
  },
  {
    id: 'artifacts', title: '产物及失败处理', lane: 'tool', actor: '工具 GitHub Actions 产出；主控 / 用户核对',
    summary: '分开保存工具包和每个游戏提交的快照证据包。',
    input: '通过核验的构建、索引、审计与追溯信息。', output: '工具构建包；游戏 SHA 索引 / 审计包；真实 run 与产物入口。',
    trigger: '必要检查通过后产出；失败时上传必要诊断并保持失败。', pass: '清单可追溯工具 / 游戏 SHA、配置 / 引用指纹、分析器版本、限制和运行链接，访问范围符合游戏权限。',
    blocked: '清单缺失、来源不一致，或索引访问范围比游戏仓库更广。', failure: '在 GitHub 查看失败和重跑；不撤销已合并游戏，不改写历史。',
    steps: ['不同提交产物互不覆盖；工具包与索引包分别下载。', '云索引首版是 CI 快照证据包；没有自动本地安装或缓存导入，不能覆盖 .cache 宣称可用。', '索引可能含源码摘录，必须放在权限合适的私有位置；不自动发布 Pages 或 Release。'],
    links: [link('工具运行 / 产物列表', `${tool}/actions`), link('游戏来源运行列表', `${game}/actions`), guide], configuration: '产物私密性、保留期与首次端到端验证待用户核实；当前页面不表示任何运行成功。',
  },
];

export const laneLabels: Record<DeliveryLane, string> = { human: '人工操作', game: '游戏仓库 · GitHub 自动任务', tool: '工具仓库 · GitHub 自动任务' };
export const activationOrder = ['游戏主控完成 Fast 报告、CODEOWNERS 与交接', '工具接收游戏侧接口与证据', '工具 main 合入并手动验收就绪', '游戏集成发送步骤，初始保持关闭', '用户审核受限身份、Environment 后启用', '真实 feature 经联合验证后核对两仓 run 与产物'];

/** Render only HTTPS links within these two repositories and supported entry points. */
export function safeGitHubUrl(value: string): string | undefined {
  if (/[\\\s\u0000-\u001f\u007f]/u.test(value) || !/^https:\/\/github\.com\/chwan886\/(Architecture-Explorer|GameDemo02)(?:\/|$)/.test(value)) return;
  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== value && /[\\\s\u0000-\u001f\u007f]/u.test(decoded)) return;
    if (decoded.split(/[/?#]/).some(part => part === '.' || part === '..')) return;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) return;
    if (!/^\/chwan886\/(?:Architecture-Explorer|GameDemo02)\/(?:pulls|rules|actions(?:\/workflows\/[\w.-]+\.ya?ml|\/runs\/\d+(?:\/artifacts\/\d+)?)?|blob\/main\/[A-Za-z0-9_./-]+)$/.test(url.pathname)) return;
    return url.href;
  } catch { return; }
}

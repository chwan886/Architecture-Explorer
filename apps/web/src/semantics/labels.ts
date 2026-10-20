export const modeLabels = { explanation: '业务解释', code: '代码实现', compare: '双层对照' };
export const statusLabels = { current: '当前有效', stale: '源码已变化', missing: '实现缺失', ambiguous: '匹配不唯一', conflict: '归属冲突' };
export const originLabels = { curated: '源码整理', 'rule-generated': '规则候选', 'ai-suggested': 'AI 候选', 'human-edited': '人工编辑' };
export const verificationLabels = { 'static-confirmed': '静态确认', 'source-supported': '源码支持', inferred: '有据推断', unverified: '顺序未验证' };
export const relationLabels = { 'direct-call': '直接调用', 'indirect-call': '间接调用', dependency: '依赖', 'data-access': '数据读写', event: '事件', 'source-order': '源码顺序', protocol: '协议关联', 'request-boundary': '跨请求边界', related: '相关' };
export const controlLabels = { condition: '条件分支', loop: '循环', async: '异步', 'early-return': '提前返回', 'request-boundary': '跨请求' };
export const reviewLabels = { pending: '待复核', confirmed: '人工确认', rejected: '已拒绝', 'needs-review': '需要重新复核' };

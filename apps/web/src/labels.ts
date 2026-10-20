import type { Confidence, EdgeKind, NodeKind } from '../../../packages/schema/src/index';

export const nodeLabels: Record<NodeKind, string> = { project: '项目', system: '系统', module: '模块', file: '文件', class: '类', interface: '接口', struct: '结构体', enum: '枚举', method: '方法', function: '函数', field: '字段', property: '属性', event: '事件', parameter: '参数', resource: '资源', data: '数据' };
export const edgeLabels: Record<EdgeKind, string> = { contains: '包含', inherits: '继承', implements: '实现', references: '引用', imports: '导入', calls: '调用', reads: '读取', writes: '写入', initializes: '初始化', passes: '参数传递', returns: '返回', subscribes: '订阅', unsubscribes: '取消订阅', publishes: '发布', 'contract-mapping': '契约映射' };
export const confidenceLabels: Record<Confidence, string> = { 'static-confirmed': '静态确认', 'runtime-verified': '运行验证', inferred: '有据推断' };
export const expandableKinds = new Set<NodeKind>(['project', 'system', 'module', 'file', 'class', 'interface', 'struct', 'enum']);
export const formatTime = (value?: string) => value ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) : '尚未建立索引';
export const shortPath = (value?: string) => value?.replaceAll('\\', '/').split('/').slice(-2).join('/') || '项目结构';

import { randomBytes, randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IndexManager } from '../../../packages/indexer/src/indexer.ts';
import { contentHash } from '../../../packages/schema/src/index.ts';
import { validateEntityRef, validatePresentation } from '../../../packages/control-protocol/src/index.ts';
import type { AnalysisPresentation, BridgeActivity, BrowserCurrent, BrowserState, ControlCommand, ControlSubmit, PresentationReceipt, QueryService, ResolvedPresentation, ViewSession } from '../../../packages/control-protocol/src/types.ts';
import { BridgeFiles, BridgeIdentity, bridgeFailure as fail, secureEqual } from './bridge-auth.ts';
import { QUERY_ACTIVITY_LIMIT, queryActivityCompleted, queryActivityFailed, queryActivityTitle } from './bridge-activity.ts';

const TTL = 5 * 60_000, SESSION_TTL = 90_000, LEASE_TTL = 120_000;
const active = new Set(['pending', 'received', 'presented']);
interface Session { owner: string; csrf: string; view: ViewSession; lastCommand?: string; optOutRevision?: number; activities?: BridgeActivity[] }
interface ActivityTarget { sessionId: string; bindingId: string; snapshotId: string; scopeId: string; activityId: string }
interface Binding { id: string; sessionId: string; expires: number; userRevision: number; controlRevision: number; consumed: boolean }
interface RecordEntry { commandId: string; payloadHash: string; presentation?: AnalysisPresentation; receipt: PresentationReceipt; expires: number;
  sessionId?: string; bindingId?: string; sequence: number; expectedUserRevision?: number; expectedControlRevision?: number; serverEpoch: string }
const canonical = (value: unknown): string => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object'
  ? '{' + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}' : JSON.stringify(value);
function object(value: unknown, keys: string[], required = keys): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !(key in value))) throw fail('INVALID_ARGUMENT', '参数字段缺失或包含未支持字段');
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max = 128): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x1f]/.test(value)) throw fail('INVALID_ARGUMENT', `${name} 无效`);
  return value;
}
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw fail('INVALID_ARGUMENT', '版本必须为非负安全整数'); return value as number; }
const now = () => Date.now();

export class BridgeBroker {
  readonly files: BridgeFiles;
  readonly identity: BridgeIdentity;
  private sessions = new Map<string, Session>();
  private bindings = new Map<string, Binding>();
  private records = new Map<string, RecordEntry>();
  private streams = new Map<string, Set<ServerResponse>>();
  private queue: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private eventSequence = 0;
  private activitySequence = 0;
  constructor(readonly app: FastifyInstance, readonly manager: IndexManager, readonly query: QueryService) {
    this.files = new BridgeFiles(manager.config); this.identity = new BridgeIdentity(this.files);
  }
  authenticatePrivate = (request: FastifyRequest) => this.identity.authenticate(request);
  async initialize(): Promise<void> {
    const bytes = await this.files.read('state.json'); if (!bytes) return;
    const input = object(JSON.parse(bytes.toString('utf8')), ['schemaVersion', 'records']);
    if (input.schemaVersion !== '1.0' || !Array.isArray(input.records) || input.records.length > 64) throw fail('CORRUPT_STATE', '联动缓存格式无效', 503);
    for (const item of input.records) {
      const value = object(item, ['commandId', 'payloadHash', 'presentation', 'receipt', 'expires', 'sessionId', 'bindingId', 'sequence', 'expectedUserRevision', 'expectedControlRevision', 'serverEpoch'], ['commandId', 'payloadHash', 'receipt', 'expires', 'sequence', 'serverEpoch']);
      text(value.commandId, 'commandId'); text(value.payloadHash, 'payloadHash');
      if (!Number.isFinite(value.expires) || !Number.isSafeInteger(value.sequence)) throw fail('CORRUPT_STATE', '联动缓存时间或序号无效', 503);
      if (value.presentation) validatePresentation(value.presentation);
      const record = value as unknown as RecordEntry;
      record.expires = Math.min(record.expires, now() + TTL);
      const receipt = object(record.receipt, ['commandId', 'presentationId', 'status', 'sessionId', 'userRevision', 'controlRevision', 'message', 'updatedAt', 'actual', 'action', 'openUrl'], ['commandId', 'presentationId', 'status', 'message', 'updatedAt']);
      if (receipt.commandId !== record.commandId || !['pending', 'received', 'presented', 'conflict', 'failed', 'expired', 'superseded'].includes(String(receipt.status))) throw fail('CORRUPT_STATE', '联动回执格式无效', 503);
      if (!(receipt.action === 'clear' && receipt.presentationId === '')) text(receipt.presentationId, 'presentationId', 128);
      text(receipt.message, 'message', 2048);
      if (!Number.isFinite(Date.parse(String(receipt.updatedAt)))) throw fail('CORRUPT_STATE', '联动回执时间无效', 503);
      if (receipt.openUrl !== undefined) record.receipt.openUrl = `http://127.0.0.1:${this.manager.config.port ?? 4310}/?bridge=${encodeURIComponent(record.commandId)}`;
      // Browser identities and leases never survive a server instance restart.
      record.sessionId = undefined; record.bindingId = undefined;
      if (active.has(record.receipt.status)) {
        record.receipt.status = record.expires <= now() ? 'expired' : 'pending';
        record.receipt.message = '服务实例已变化；等待明确配对并重新核验快照，未自动重放。';
        record.receipt.sessionId = undefined;
      }
      this.records.set(record.commandId, record); this.sequence = Math.max(this.sequence, record.sequence);
    }
  }
  private async serial<T>(action: () => Promise<T> | T): Promise<T> {
    const pending = this.queue.catch(() => {}).then(async () => {
      const checkpoint = { sessions: structuredClone(this.sessions), bindings: structuredClone(this.bindings), records: structuredClone(this.records), sequence: this.sequence };
      try { return await action(); }
      catch (error) { this.sessions = checkpoint.sessions; this.bindings = checkpoint.bindings; this.records = checkpoint.records; this.sequence = checkpoint.sequence; throw error; }
    });
    this.queue = pending.catch(() => {}); return pending;
  }
  private async persist() {
    const records = [...this.records.values()].sort((a, b) => a.sequence - b.sequence).slice(-64);
    this.records = new Map(records.map(record => [record.commandId, record]));
    await this.files.write('state.json', { schemaVersion: '1.0', records });
  }
  async publishRuntime(port = this.manager.config.port ?? 4310) { await this.serial(async () => { await this.identity.publish(port); await this.persist(); }); }
  private notify(sessionId: string) {
    const event = `id: ${++this.eventSequence}\nevent: control\ndata: ${JSON.stringify({ sessionId, serverEpoch: this.identity.serverEpoch })}\n\n`;
    for (const stream of this.streams.get(sessionId) ?? []) if (!stream.destroyed) stream.write(event);
  }
  private owner(request: FastifyRequest): string | undefined {
    const cookies = (request.headers.cookie ?? '').split(';').map(part => part.trim().split('='));
    const value = cookies.find(([key]) => key === 'ae_bridge_owner')?.[1];
    return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
  }
  private getSession(request: FastifyRequest, sessionId: unknown, csrf?: unknown): Session {
    const id = text(sessionId, 'sessionId'), session = this.sessions.get(id);
    if (!session || !this.owner(request) || !secureEqual(this.owner(request)!, session.owner)) throw fail('SESSION_FORBIDDEN', '页面会话不属于当前浏览器', 403);
    if (csrf !== undefined && (typeof csrf !== 'string' || !secureEqual(csrf, session.csrf))) throw fail('CSRF_REJECTED', '页面 CSRF 校验失败', 403);
    if (now() - Date.parse(session.view.lastSeenAt) > SESSION_TTL) { this.revoke(session, '页面心跳已失联。'); throw fail('SESSION_EXPIRED', '页面会话已过期，请重新开启联动', 409); }
    return session;
  }
  private update(record: RecordEntry, status: PresentationReceipt['status'], message: string) {
    const bounded = message.replace(/[\x00-\x1f]/g, ' ').slice(0, 2048) || '联动状态已更新。';
    record.receipt = { ...record.receipt, status, message: bounded, updatedAt: new Date().toISOString() };
    if (!active.has(status)) record.presentation = undefined;
    if (record.sessionId) this.notify(record.sessionId);
  }
  private revoke(session: Session, message: string) {
    session.view.allowControl = false;
    session.optOutRevision = session.view.userRevision;
    if (session.view.bindingId) this.bindings.delete(session.view.bindingId);
    session.view.bindingId = undefined;
    session.activities = undefined;
    for (const record of this.records.values()) if (record.sessionId === session.view.sessionId && active.has(record.receipt.status)) this.update(record, 'conflict', message);
    this.notify(session.view.sessionId);
  }
  private expire() {
    for (const session of this.sessions.values()) if (now() - Date.parse(session.view.lastSeenAt) > SESSION_TTL && session.view.allowControl) this.revoke(session, '页面心跳已失联，已停止联动。');
    for (const binding of this.bindings.values()) if (binding.expires <= now()) {
      this.bindings.delete(binding.id); const session = this.sessions.get(binding.sessionId); if (session?.view.bindingId === binding.id) { session.view.bindingId = undefined; session.activities = undefined; }
      for (const record of this.records.values()) if (record.bindingId === binding.id && ['pending', 'received'].includes(record.receipt.status)) this.update(record, 'conflict', '配对租约已过期，未重放延迟命令。');
    }
    for (const record of this.records.values()) if (record.expires <= now() && active.has(record.receipt.status)) this.update(record, 'expired', '联动命令已过期，未使用新快照替代。');
  }
  private binding(id: unknown): { binding: Binding; session: Session } {
    this.expire(); const binding = this.bindings.get(text(id, 'bindingId'));
    const session = binding && this.sessions.get(binding.sessionId);
    if (!binding || !session || !session.view.allowControl) throw fail('BINDING_EXPIRED', '配对已失效，请重新选择允许联动的页面', 409);
    return { binding, session };
  }
  /** A query has no browser target. Only the single already-bound page for this exact snapshot may observe it. */
  private activityContext(session: Session, snapshotId?: string) {
    const binding = session.view.bindingId ? this.bindings.get(session.view.bindingId) : undefined;
    const record = session.lastCommand ? this.records.get(session.lastCommand) : undefined;
    const presentation = record?.presentation;
    if (!session.view.allowControl || now() - Date.parse(session.view.lastSeenAt) > SESSION_TTL
      || !binding || binding.expires <= now() || binding.sessionId !== session.view.sessionId
      || !record || !presentation || !active.has(record.receipt.status) || record.expires <= now()
      || record.sessionId !== session.view.sessionId || record.bindingId !== binding.id
      || session.view.scopeId !== `${presentation.projectId}:${presentation.worktreeId}`
      || snapshotId !== undefined && presentation.snapshotId !== snapshotId) return undefined;
    return { binding, record, presentation };
  }
  private async startActivity(operation: string, args: Record<string, unknown>): Promise<ActivityTarget | undefined> {
    const title = queryActivityTitle(operation), snapshotId = args.snapshotId;
    if (!title || typeof snapshotId !== 'string') return undefined;
    return this.serial(() => {
      this.expire();
      const eligible = [...this.sessions.values()].flatMap(session => {
        const context = this.activityContext(session, snapshotId); return context ? [{ session, ...context }] : [];
      });
      // Even an identical snapshot in several bound tabs is not an explicit query target.
      if (eligible.length !== 1) return undefined;
      const { session, binding, record, presentation } = eligible[0], timestamp = new Date().toISOString();
      const activity: BridgeActivity = { id: randomUUID(), sequence: ++this.activitySequence, kind: 'query', operation, title,
        message: '正在查询当前快照；结果不会自动改变画布。', status: 'running', startedAt: timestamp, updatedAt: timestamp,
        scopeId: session.view.scopeId!, snapshotId, indexSnapshotId: presentation.indexSnapshotId, commandId: record.commandId };
      session.activities = [...(session.activities ?? []), activity].slice(-QUERY_ACTIVITY_LIMIT);
      this.notify(session.view.sessionId);
      return { sessionId: session.view.sessionId, bindingId: binding.id, snapshotId, scopeId: session.view.scopeId!, activityId: activity.id };
    });
  }
  private async finishActivity(target: ActivityTarget | undefined, operation: string, outcome: { result: unknown } | { error: unknown }) {
    if (!target) return;
    await this.serial(() => {
      this.expire(); const session = this.sessions.get(target.sessionId), context = session && this.activityContext(session, target.snapshotId);
      if (!session || !context || context.binding.id !== target.bindingId || session.view.scopeId !== target.scopeId) return;
      const activity = session.activities?.find(item => item.id === target.activityId);
      if (!activity) return;
      activity.status = 'error' in outcome ? 'failed' : 'completed'; activity.updatedAt = new Date().toISOString();
      activity.message = 'error' in outcome ? queryActivityFailed(outcome.error) : queryActivityCompleted(operation, outcome.result);
      this.notify(target.sessionId);
    });
  }
  async executeQuery(operation: string, args: Record<string, unknown>): Promise<unknown> {
    // Observability must never change the query result or substitute a presentation receipt.
    const target = await this.startActivity(operation, args).catch(() => undefined);
    let result: unknown;
    try { result = await this.query.dispatch(operation, args); }
    catch (error) { await this.finishActivity(target, operation, { error }).catch(() => {}); throw error; }
    await this.finishActivity(target, operation, { result }).catch(() => {}); return result;
  }
  private bind(sessionId: unknown): { binding: Binding; session: Session } {
    this.expire(); const session = this.sessions.get(text(sessionId, 'sessionId'));
    if (!session || !session.view.allowControl || now() - Date.parse(session.view.lastSeenAt) > SESSION_TTL) throw fail('SESSION_NOT_OPTED_IN', '页面尚未允许联动或已离线', 409);
    if (session.view.bindingId && this.bindings.has(session.view.bindingId)) throw fail('SESSION_BUSY', '页面已有有效配对，不能争抢；请在页面退出后重新连接', 409);
    const binding: Binding = { id: randomBytes(24).toString('hex'), sessionId: session.view.sessionId, expires: now() + LEASE_TTL,
      userRevision: session.view.userRevision, controlRevision: session.view.controlRevision, consumed: false };
    this.bindings.set(binding.id, binding); session.view.bindingId = binding.id;
    return { binding, session };
  }
  private expected(binding: Binding, session: Session, user: unknown, control: unknown) {
    const noExpected = user === undefined && control === undefined;
    if ((user === undefined) !== (control === undefined) || (noExpected && binding.consumed)) throw fail('REVISION_REQUIRED', '后续控制必须明确提供当前人工与控制版本', 409);
    const expectedUser = noExpected ? binding.userRevision : revision(user), expectedControl = noExpected ? binding.controlRevision : revision(control);
    if (session.view.userRevision !== expectedUser || session.view.controlRevision !== expectedControl) throw fail('CONTROL_CONFLICT', '页面已有人工作业或其他控制更新，未覆盖当前上下文', 409);
    return { expectedUser, expectedControl };
  }
  private async deliver(record: RecordEntry, binding: Binding, session: Session): Promise<ResolvedPresentation> {
    if (!record.presentation || record.expires <= now()) throw fail('COMMAND_EXPIRED', '离线命令已过期', 409);
    const resolved = await this.query.resolve(record.presentation);
    if (record.presentation.projectId + ':' + record.presentation.worktreeId !== resolved.snapshot.scopeId) throw fail('SCOPE_MISMATCH', '查询结果不属于目标 Scope', 409);
    record.sessionId = session.view.sessionId; record.bindingId = binding.id; record.serverEpoch = this.identity.serverEpoch;
    record.expectedUserRevision = session.view.userRevision; record.expectedControlRevision = session.view.controlRevision;
    record.expires = Math.min(record.expires, now() + TTL, Date.parse(resolved.snapshot.expiresAt));
    record.receipt = { ...record.receipt, status: 'pending', sessionId: session.view.sessionId, userRevision: session.view.userRevision, controlRevision: session.view.controlRevision,
      message: '已排队，等待页面接收并核验；尚未确认呈现。', updatedAt: new Date().toISOString() };
    binding.consumed = true; binding.expires = now() + LEASE_TTL; session.lastCommand = record.commandId;
    this.notify(session.view.sessionId); return resolved;
  }
  async control(operation: string, input: Record<string, unknown>): Promise<unknown> {
    return this.serial(async () => {
      this.expire();
      if (operation === 'list_view_sessions') {
        object(input, []);
        return { sessions: [...this.sessions.values()].filter(session => session.view.allowControl && now() - Date.parse(session.view.lastSeenAt) <= SESSION_TTL).map(session => { const { bindingId: _secret, ...view } = session.view; return view; }) };
      }
      if (operation === 'attach_view_session') {
        object(input, ['sessionId']); const attached = this.bind(input.sessionId);
        const offline = [...this.records.values()].filter(record => !record.sessionId && record.receipt.status === 'pending' && record.presentation && record.expires > now()).sort((a, b) => b.sequence - a.sequence)[0];
        if (offline) {
          try { await this.deliver(offline, attached.binding, attached.session); }
          catch (error) { this.update(offline, 'failed', `离线结果未重放：${(error as Error).message}`); }
        }
        await this.persist(); return { bindingId: attached.binding.id, session: attached.session.view };
      }
      if (operation === 'status') {
        object(input, ['commandId']); const record = this.records.get(text(input.commandId, 'commandId'));
        if (!record) throw fail('COMMAND_NOT_FOUND', '联动命令不存在', 404);
        if (record.presentation && active.has(record.receipt.status)) {
          try { await this.query.resolve(record.presentation); }
          catch (error) { this.update(record, 'expired', `查询快照已失效：${(error as Error).message}`); }
        }
        await this.persist(); return record.receipt;
      }
      if (operation === 'submit') return this.submit(input);
      if (operation === 'clear') {
        object(input, ['bindingId', 'expectedUserRevision', 'expectedControlRevision', 'commandId'], ['bindingId', 'expectedUserRevision', 'expectedControlRevision']);
        const id = input.commandId === undefined ? randomUUID() : text(input.commandId, 'commandId');
        const payloadHash = contentHash(canonical({ operation, ...input })); const previous = this.records.get(id);
        if (previous) { if (previous.payloadHash !== payloadHash) throw fail('COMMAND_ID_CONFLICT', 'commandId 已用于不同内容', 409); return previous.receipt; }
        const { binding, session } = this.binding(input.bindingId);
        this.expected(binding, session, input.expectedUserRevision, input.expectedControlRevision);
        for (const record of this.records.values()) if (record.sessionId === session.view.sessionId && active.has(record.receipt.status)) this.update(record, 'superseded', '联动图层已清除，保留人工上下文。');
        const receipt: PresentationReceipt = { commandId: id, presentationId: '', status: 'superseded', action: 'clear', sessionId: session.view.sessionId,
          userRevision: session.view.userRevision, controlRevision: ++session.view.controlRevision, message: '已清除服务端联动呈现；页面将拉取清除通知。', updatedAt: new Date().toISOString() };
        this.records.set(id, { commandId: id, payloadHash, receipt, expires: now() + TTL, sequence: ++this.sequence, serverEpoch: this.identity.serverEpoch });
        session.lastCommand = id; binding.consumed = true; binding.expires = now() + LEASE_TTL;
        await this.persist(); this.notify(session.view.sessionId); return receipt;
      }
      throw fail('UNSUPPORTED_OPERATION', '不支持的控制操作');
    });
  }
  private async submit(input: Record<string, unknown>): Promise<PresentationReceipt> {
    object(input, ['presentation', 'bindingId', 'expectedUserRevision', 'expectedControlRevision', 'commandId'], ['presentation']); validatePresentation(input.presentation);
    const presentation = input.presentation, id = input.commandId === undefined ? randomUUID() : text(input.commandId, 'commandId');
    const payloadHash = contentHash(canonical(input)); const previous = this.records.get(id);
    if (previous) { if (previous.payloadHash !== payloadHash) throw fail('COMMAND_ID_CONFLICT', 'commandId 已用于不同内容', 409); return previous.receipt; }
    const resolved = await this.query.resolve(presentation);
    let target: { binding: Binding; session: Session } | undefined;
    if (input.bindingId !== undefined) target = this.binding(input.bindingId);
    else {
      const eligible = [...this.sessions.values()].filter(session => session.view.allowControl && now() - Date.parse(session.view.lastSeenAt) <= SESSION_TTL);
      if (eligible.length > 1) throw fail('AMBIGUOUS_SESSION', '有多个允许联动的页面，请明确attach目标', 409);
      if (eligible.length === 1) throw fail('SESSION_REQUIRED', '请先明确 attach 允许联动的目标页面，不能隐式取得控制权', 409);
    }
    if (target) this.expected(target.binding, target.session, input.expectedUserRevision, input.expectedControlRevision);
    else if (input.expectedUserRevision !== undefined || input.expectedControlRevision !== undefined) throw fail('NO_SESSION', '没有可校验页面版本的会话', 409);
    const expires = Math.min(now() + TTL, Date.parse(resolved.snapshot.expiresAt));
    if (!Number.isFinite(expires) || expires <= now()) throw fail('STALE_SNAPSHOT', '查询快照已过期', 409);
    const receipt: PresentationReceipt = { commandId: id, presentationId: presentation.presentationId, status: 'pending', action: 'present',
      message: target ? '等待页面接收，尚未确认呈现。' : '没有已允许的页面；已保存离线待呈现结果，打开后允许联动并attach。', updatedAt: new Date().toISOString(),
      ...(!target ? { openUrl: `http://127.0.0.1:${this.manager.config.port ?? 4310}/?bridge=${encodeURIComponent(id)}` } : {}) };
    const record: RecordEntry = { commandId: id, payloadHash, presentation, receipt, expires, sequence: ++this.sequence, serverEpoch: this.identity.serverEpoch };
    for (const old of this.records.values()) if (active.has(old.receipt.status) && (target ? old.sessionId === target.session.view.sessionId : !old.sessionId)) this.update(old, 'superseded', '已有较新的显式呈现命令。');
    if (target) await this.deliver(record, target.binding, target.session);
    this.records.set(id, record); await this.persist(); return record.receipt;
  }
  async bootstrap(request: FastifyRequest) {
    return this.serial(() => {
      if (request.headers['sec-fetch-site'] === 'cross-site') throw fail('CROSS_SITE_REJECTED', '不能从其他网站创建联动页面会话', 403);
      this.expire(); if (this.sessions.size >= 64) { for (const [id, session] of this.sessions) if (now() - Date.parse(session.view.lastSeenAt) > SESSION_TTL) this.sessions.delete(id); }
      if (this.sessions.size >= 64) throw fail('SESSION_LIMIT', '页面会话达到预算，请关闭旧页面', 429);
      const owner = this.owner(request) ?? randomBytes(32).toString('hex'), sessionId = randomBytes(24).toString('hex'), csrf = randomBytes(32).toString('hex');
      const state: BrowserState = { userRevision: 0, controlRevision: 0, allowControl: false, label: 'Architecture Explorer', visible: true };
      const session: Session = { owner, csrf, view: { ...state, sessionId, serverEpoch: this.identity.serverEpoch, lastSeenAt: new Date().toISOString() } };
      this.sessions.set(sessionId, session);
      return { owner, bootstrap: { sessionId, csrf, serverEpoch: this.identity.serverEpoch, state } };
    });
  }
  async state(request: FastifyRequest, input: Record<string, unknown>) {
    return this.serial(async () => {
      object(input, ['sessionId', 'csrf', 'state']); const session = this.getSession(request, input.sessionId, input.csrf);
      const state = object(input.state, ['userRevision', 'controlRevision', 'allowControl', 'scopeId', 'label', 'visible'], ['userRevision', 'controlRevision', 'allowControl', 'label', 'visible']);
      revision(state.userRevision); revision(state.controlRevision); text(state.label, 'label', 120);
      if (typeof state.allowControl !== 'boolean' || typeof state.visible !== 'boolean') throw fail('INVALID_ARGUMENT', '页面状态布尔字段无效');
      if (state.scopeId !== undefined) this.manager.scope(text(state.scopeId, 'scopeId'));
      if ((state.userRevision as number) < session.view.userRevision || (state.controlRevision as number) < session.view.controlRevision) throw fail('CONTROL_CONFLICT', '页面状态版本已过期', 409);
      if (state.allowControl && !session.view.allowControl && session.optOutRevision !== undefined && (state.userRevision as number) <= session.optOutRevision)
        throw fail('CONTROL_CONFLICT', '退出后需要新的明确用户授权，旧心跳不能重新启用联动', 409);
      const userChanged = state.userRevision !== session.view.userRevision;
      if ((state.controlRevision as number) > session.view.controlRevision + 1) throw fail('CONTROL_CONFLICT', '控制版本不能跳过已确认命令', 409);
      if (userChanged) for (const record of this.records.values()) if (record.sessionId === session.view.sessionId && ['pending', 'received'].includes(record.receipt.status)) this.update(record, 'conflict', '用户已开始新的操作，取消延迟控制。');
      session.view = { ...session.view, ...state as unknown as BrowserState, lastSeenAt: new Date().toISOString() };
      if (!state.allowControl && (session.view.bindingId || session.optOutRevision !== undefined)) this.revoke(session, '用户已关闭联动。');
      await this.persist(); return session.view;
    });
  }
  async current(request: FastifyRequest, sessionId: unknown): Promise<BrowserCurrent> {
    return this.serial(async () => {
      this.expire(); const session = this.getSession(request, sessionId);
      const record = session.lastCommand ? this.records.get(session.lastCommand) : undefined;
      let command: ControlCommand | undefined;
      if (record?.presentation && active.has(record.receipt.status) && record.sessionId === session.view.sessionId && session.view.allowControl) {
        try {
          const resolved = await this.query.resolve(record.presentation);
          command = { commandId: record.commandId, serverEpoch: this.identity.serverEpoch, sessionId: session.view.sessionId, bindingId: record.bindingId!, sequence: record.sequence,
            expiresAt: new Date(record.expires).toISOString(), expectedUserRevision: record.expectedUserRevision!, expectedControlRevision: record.expectedControlRevision!, resolved };
        } catch (error) { this.update(record, 'expired', `查询快照已失效：${(error as Error).message}`); await this.persist(); }
      }
      const context = this.activityContext(session);
      const activities = context ? (session.activities ?? []).filter(item => item.scopeId === session.view.scopeId && item.snapshotId === context.presentation.snapshotId).map(item => ({ ...item })) : [];
      return { session: session.view, command, pending: record?.receipt, activities };
    });
  }
  async ack(request: FastifyRequest, input: Record<string, unknown>) {
    return this.serial(async () => {
      object(input, ['sessionId', 'csrf', 'commandId', 'status', 'userRevision', 'controlRevision', 'actual', 'message'], ['sessionId', 'csrf', 'commandId', 'status', 'userRevision', 'controlRevision']);
      const session = this.getSession(request, input.sessionId, input.csrf), record = this.records.get(text(input.commandId, 'commandId'));
      if (!record || record.sessionId !== session.view.sessionId || session.lastCommand !== record.commandId) throw fail('COMMAND_NOT_FOUND', '命令不属于当前页面或已被替代', 404);
      const user = revision(input.userRevision), control = revision(input.controlRevision);
      if (!['received', 'presented', 'conflict', 'failed'].includes(String(input.status))) throw fail('INVALID_ARGUMENT', '回执状态无效');
      if (input.message !== undefined) text(input.message, 'message', 512);
      if (record.receipt.status === 'presented' && input.status === 'presented') {
        if (user !== record.receipt.userRevision || control !== record.receipt.controlRevision || canonical(input.actual) !== canonical(record.receipt.actual)) throw fail('ACK_MISMATCH', '重复成功回执内容不一致', 409);
        return record.receipt;
      }
      if (!['pending', 'received'].includes(record.receipt.status) || record.expires <= now()) throw fail('CONTROL_CONFLICT', '命令已结束或过期', 409);
      if (input.status === 'conflict' || input.status === 'failed') {
        if (user < session.view.userRevision || control < session.view.controlRevision) throw fail('CONTROL_CONFLICT', '回执来自旧页面版本', 409);
        session.view.userRevision = user; session.view.controlRevision = control;
        this.update(record, input.status as 'conflict' | 'failed', input.message as string || '页面未应用控制，保留人工上下文。');
      } else {
        if (user !== record.expectedUserRevision || session.view.userRevision !== user || control !== record.expectedControlRevision! + (input.status === 'presented' ? 1 : 0)
          || session.view.controlRevision !== record.expectedControlRevision && !(input.status === 'presented' && session.view.controlRevision === control)) throw fail('CONTROL_CONFLICT', '页面人工或控制版本已变化，未接受成功回执', 409);
        const resolved = await this.query.resolve(record.presentation!);
        if (input.status === 'presented') {
          const actual = object(input.actual, ['scopeId', 'indexSnapshotId', 'focusNodeId', 'visibleNodeIds', 'visibleEdgeIds', 'evidenceId'], ['scopeId', 'indexSnapshotId', 'visibleNodeIds', 'visibleEdgeIds']);
          text(actual.scopeId, 'scopeId'); text(actual.indexSnapshotId, 'indexSnapshotId');
          if (actual.focusNodeId !== undefined) validateEntityRef(actual.focusNodeId);
          if (actual.evidenceId !== undefined) text(actual.evidenceId, 'evidenceId', 256);
          if (actual.scopeId !== record.presentation!.projectId + ':' + record.presentation!.worktreeId || actual.indexSnapshotId !== record.presentation!.indexSnapshotId) throw fail('ACK_MISMATCH', '页面显示的 Scope 或源码快照不匹配', 409);
          if (record.presentation!.focusNodeId && canonical(actual.focusNodeId) !== canonical(record.presentation!.focusNodeId)) throw fail('ACK_MISMATCH', '页面焦点与命令不匹配', 409);
          for (const key of ['visibleNodeIds', 'visibleEdgeIds'] as const) if (!Array.isArray(actual[key]) || (actual[key] as unknown[]).length > 200 || (actual[key] as unknown[]).some(id => typeof id !== 'string' || id.length > 256)) throw fail('INVALID_ARGUMENT', '页面可见实体超出预算');
          const allowedNodes = new Set([...(resolved.codeGraph?.nodes.map(node => node.id) ?? []), ...(resolved.architecture?.graph.nodes.map(node => node.id) ?? []),
            ...(resolved.semantic?.flow?.codeNodes.map(node => node.id) ?? []), ...(resolved.semantic?.flow?.summaryNodes.map(node => node.id) ?? []), ...(resolved.semantic?.flow?.detailNodes.map(node => node.id) ?? [])]);
          const allowedEdges = new Set([...(resolved.codeGraph?.edges.map(edge => edge.id) ?? []), ...(resolved.architecture?.graph.edges.map(edge => edge.id) ?? []),
            ...(resolved.semantic?.flow?.codeEdges.map(edge => edge.id) ?? []), ...(resolved.semantic?.flow?.summaryEdges.map(edge => edge.id) ?? []), ...(resolved.semantic?.flow?.detailEdges.map(edge => edge.id) ?? [])]);
          if ((actual.visibleNodeIds as string[]).some(id => !allowedNodes.has(id)) || (actual.visibleEdgeIds as string[]).some(id => !allowedEdges.has(id))) throw fail('ACK_MISMATCH', '页面回执包含不属于解析结果的图实体', 409);
          const requestedNodes = [...record.presentation!.highlightedNodeIds, ...(record.presentation!.focusNodeId ? [record.presentation!.focusNodeId] : [])];
          const architectureView = record.presentation!.targetView === 'systems' || record.presentation!.targetView === 'technical';
          const requiredNodes = architectureView ? resolved.highlights.architectureNodeIds : requestedNodes.map(ref => ref.id);
          const requiredEdges = architectureView ? resolved.highlights.architectureEdgeIds : record.presentation!.highlightedEdgeIds.map(ref => ref.id);
          if (requiredNodes.some(id => !(actual.visibleNodeIds as string[]).includes(id)) || requiredEdges.some(id => !(actual.visibleEdgeIds as string[]).includes(id))) throw fail('ACK_MISMATCH', '请求的焦点或高亮尚未实际显示', 409);
          if (resolved.evidence && actual.evidenceId !== resolved.evidence.evidence.id) throw fail('ACK_MISMATCH', '页面尚未显示本次解析的指定源码证据', 409);
          if (actual.evidenceId !== undefined && actual.evidenceId !== resolved.evidence?.evidence.id) throw fail('ACK_MISMATCH', '页面源码证据不属于此命令的解析结果', 409);
          record.receipt.actual = actual as unknown as PresentationReceipt['actual']; session.view.controlRevision = control;
        }
        this.update(record, input.status as 'received' | 'presented', input.status === 'presented' ? '页面已确认完成呈现。' : '页面已收到，等待真实布局与源码一致性检查。');
      }
      record.receipt.userRevision = user; record.receipt.controlRevision = control;
      await this.persist(); return record.receipt;
    });
  }
  async leave(request: FastifyRequest, input: Record<string, unknown>) {
    return this.serial(async () => { object(input, ['sessionId', 'csrf']); const session = this.getSession(request, input.sessionId, input.csrf); this.revoke(session, '用户退出联动，保留当前人工上下文。'); await this.persist(); return session.view; });
  }
  stream(request: FastifyRequest, sessionId: unknown, response: ServerResponse) {
    const session = this.getSession(request, sessionId); const id = session.view.sessionId;
    const streams = this.streams.get(id) ?? new Set(); streams.add(response); this.streams.set(id, streams);
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    this.notify(id); const timer = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n'); }, 25000); timer.unref();
    const cleanup = () => { clearInterval(timer); streams.delete(response); if (!streams.size) this.streams.delete(id); };
    response.on('close', cleanup); request.raw.on('aborted', cleanup);
  }
  async close() {
    for (const streams of this.streams.values()) for (const stream of streams) stream.end(); this.streams.clear(); await this.queue.catch(() => {});
    if (this.identity.published) {
      try { await this.files.removeRuntime(this.identity.serverEpoch); }
      catch (error) { if ((error as { code?: string }).code !== 'RUNTIME_LOCKED') throw error; /* Never race another publisher's cleanup. */ }
    }
  }
}

export async function registerBridgeRoutes(app: FastifyInstance, manager: IndexManager, query: QueryService): Promise<BridgeBroker> {
  const broker = new BridgeBroker(app, manager, query); await broker.initialize();
  app.get('/api/bridge/hello', async request => broker.identity.hello(text((request.query as Record<string, unknown>).nonce, 'nonce', 64)));
  const privateOptions = { bodyLimit: 128 * 1024, preHandler: async (request: FastifyRequest) => broker.authenticatePrivate(request) };
  app.post('/api/bridge/private/query', privateOptions, async request => {
    const body = object(request.body, ['operation', 'arguments']);
    const args = body.arguments; if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('INVALID_ARGUMENT', 'arguments 必须为对象');
    return broker.executeQuery(text(body.operation, 'operation', 80), object(args, Object.keys(args), []));
  });
  app.post('/api/bridge/private/control', privateOptions, async request => {
    const body = object(request.body, ['operation', 'arguments']);
    const args = body.arguments; if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('INVALID_ARGUMENT', 'arguments 必须为对象');
    return broker.control(text(body.operation, 'operation', 80), object(args, Object.keys(args), []));
  });
  app.get('/api/bridge/browser/bootstrap', async (request, reply) => {
    const value = await broker.bootstrap(request); reply.header('Set-Cookie', `ae_bridge_owner=${value.owner}; Path=/api/bridge/browser; HttpOnly; SameSite=Strict`); return value.bootstrap;
  });
  app.post('/api/bridge/browser/state', async request => broker.state(request, request.body as Record<string, unknown>));
  app.get('/api/bridge/browser/current', async request => broker.current(request, (request.query as Record<string, unknown>).sessionId));
  app.post('/api/bridge/browser/ack', { bodyLimit: 64 * 1024 }, async request => broker.ack(request, request.body as Record<string, unknown>));
  app.post('/api/bridge/browser/leave', async request => broker.leave(request, request.body as Record<string, unknown>));
  app.get('/api/bridge/browser/events', async (request, reply) => {
    // Authenticate before hijack so failure remains a normal bounded JSON error.
    await broker.current(request, (request.query as Record<string, unknown>).sessionId);
    reply.hijack(); broker.stream(request, (request.query as Record<string, unknown>).sessionId, reply.raw);
  });
  app.addHook('preClose', async () => broker.close());
  return broker;
}

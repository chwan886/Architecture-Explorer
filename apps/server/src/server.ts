import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import Fastify, { type FastifyRequest } from 'fastify';
import { graph, nodeDetail, search, IndexManager } from '../../../packages/indexer/src/index.ts';
import { AccessError, authorizedFile } from '../../../packages/indexer/src/security.ts';
import type { Confidence, EdgeKind, IndexStatus } from '../../../packages/schema/src/index.ts';
import type { ServerResponse } from 'node:http';
import { registerArchitectureRoutes } from './architecture.ts';
import { registerSemanticRoutes } from './semantics.ts';
import { BridgeQueryService } from './bridge-query.ts';
import { registerBridgeRoutes, type BridgeBroker } from './bridge-control.ts';

declare module 'fastify' { interface FastifyInstance { bridgeBroker: BridgeBroker } }

const kinds = new Set<EdgeKind>(['contains', 'inherits', 'implements', 'references', 'imports', 'calls', 'reads', 'writes', 'initializes', 'passes', 'returns', 'subscribes', 'unsubscribes', 'publishes', 'contract-mapping']);
const confidences = new Set<Confidence>(['static-confirmed', 'runtime-verified', 'inferred']);
const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
function parameter(request: FastifyRequest, name: string): string | undefined {
  const value = (request.query as Record<string, unknown> | undefined)?.[name];
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 1024) throw bad(`无效的 ${name} 参数`);
  return value;
}
function integer(request: FastifyRequest, name: string, fallback: number, max: number): number {
  const raw = parameter(request, name); if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) throw bad(`${name} 必须为 1–${max} 的整数`);
  return value;
}
function values<T extends string>(request: FastifyRequest, name: string, valid: Set<T>): T[] | undefined {
  const raw = parameter(request, name); if (!raw) return undefined;
  const result = raw.split(',') as T[];
  if (result.some(value => !valid.has(value))) throw bad(`${name} 包含不支持的值`);
  return result;
}

export async function createServer(manager: IndexManager) {
  const app = Fastify({ logger: false, bodyLimit: 4096, requestTimeout: 15000, forceCloseConnections: true,
    routerOptions: { maxParamLength: 256 }, ajv: { customOptions: { removeAdditional: false } } });
  const port = manager.config.port ?? 4310;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, '127.0.0.1:5173', 'localhost:5173']);
  const origins = new Set([...hosts].map(host => `http://${host}`));
  const streams = new Set<ServerResponse>();
  app.addHook('preClose', async () => {
    for (const stream of streams) stream.end();
    streams.clear();
  });
  app.addHook('onRequest', async (request, reply) => {
    if (!hosts.has((request.headers.host ?? '').toLowerCase())) throw new AccessError('仅接受明确的本机 Host，拒绝远程 Host／DNS 重绑定');
    const origin = request.headers.origin;
    if (origin && !origins.has(origin)) throw new AccessError('此请求的 Origin 未授权');
    const privateBridge = request.url.split('?')[0].startsWith('/api/bridge/private/');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && ((!origin && !privateBridge) || !(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json'))) {
      throw new AccessError('写入索引操作必须来自本机网站并使用 application/json');
    }
    reply.header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY').header('Referrer-Policy', 'no-referrer');
  });
  app.setErrorHandler((error, _request, reply) => {
    const failure = error as { statusCode?: number; message?: string; code?: string };
    const status = typeof failure.statusCode === 'number' ? failure.statusCode : 500;
    reply.code(status >= 400 && status <= 599 ? status : 500).send({ error: failure.message || '本地服务处理失败', ...(failure.code ? { code: failure.code } : {}) });
  });
  const scope = (request: FastifyRequest) => manager.scope(parameter(request, 'scope'));
  const index = (request: FastifyRequest) => {
    const runtime = scope(request);
    if (!runtime.index) throw Object.assign(new Error(runtime.status.state === 'failed' ? runtime.status.message : '索引尚未就绪，请等待扫描完成'), { statusCode: 409 });
    return runtime.index;
  };
  const architecture = registerArchitectureRoutes(app, manager);
  const semantic = registerSemanticRoutes(app, manager, architecture);
  const bridgeBroker = await registerBridgeRoutes(app, manager, new BridgeQueryService(manager, architecture, semantic));
  app.decorate('bridgeBroker', bridgeBroker);

  app.get('/api/projects', async () => ({ projects: manager.config.projects.map(project => ({ id: project.id, name: project.name, root: project.root })) }));
  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/worktrees', async request => {
    if (!manager.config.projects.some(project => project.id === request.params.projectId)) throw new AccessError('项目未授权');
    return { worktrees: manager.worktrees.get(request.params.projectId) ?? [] };
  });
  app.get('/api/status', async request => scope(request).status);
  app.get('/api/summary', async request => {
    const current = index(request);
    return { metadata: current.metadata, counts: { nodes: current.nodes.length, edges: current.edges.filter(edge => edge.kind !== 'contains').length, files: current.files.length },
      diagnostics: [...current.diagnostics, ...scope(request).failureDiagnostics], rootId: current.nodes.find(node => node.kind === 'project')?.id };
  });
  app.get('/api/graph', async request => {
    const view = parameter(request, 'view') ?? 'architecture'; const direction = parameter(request, 'direction');
    if (!['architecture', 'calls', 'data', 'impact'].includes(view)) throw bad('不支持的图视图');
    if (direction && !['both', 'up', 'down'].includes(direction)) throw bad('不支持的追踪方向');
    return graph(index(request), { rootId: parameter(request, 'rootId') ?? parameter(request, 'focusId'), view: view as 'architecture' | 'calls' | 'data' | 'impact',
      direction: direction as 'both' | 'up' | 'down' | undefined, depth: integer(request, 'depth', 1, 5), limit: integer(request, 'limit', 80, 200),
      kinds: values(request, 'kinds', kinds), confidence: values(request, 'confidence', confidences) });
  });
  app.get('/api/search', async request => search(index(request), parameter(request, 'q') ?? '', integer(request, 'limit', 40, 100)));
  app.get<{ Params: { nodeId: string } }>('/api/nodes/:nodeId', async request => nodeDetail(index(request), request.params.nodeId));
  app.get<{ Params: { evidenceId: string } }>('/api/evidence/:evidenceId', async request => manager.evidence(scope(request).id, request.params.evidenceId));
  app.get('/api/diagnostics', async request => { const current = index(request); return { diagnostics: [...current.diagnostics, ...scope(request).failureDiagnostics], revision: current.metadata.revision }; });
  app.post('/api/scan', { schema: { body: { type: 'object', additionalProperties: false, required: ['scope'], properties: { scope: { type: 'string', maxLength: 128 }, full: { type: 'boolean' } } } } }, async (request, reply) => {
    const body = request.body as { scope: string; full?: boolean };
    manager.scope(body.scope);
    void manager.requestScan(body.scope, body.full ?? false).catch(() => { /* Status carries scan failures. */ });
    return reply.code(202).send({ accepted: true });
  });
  app.get('/api/events', async (request, reply) => {
    const runtime = scope(request);
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.raw.write(`data: ${JSON.stringify(runtime.status)}\n\n`);
    const listener = (status: IndexStatus) => {
      if (status.scopeId === runtime.id && !reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(status)}\n\n`);
    };
    manager.on('status', listener);
    const modelListener = (value: { projectId: string; modelRevision: string }) => {
      if (value.projectId === runtime.project.id && !reply.raw.destroyed) reply.raw.write(`event: architecture-model\ndata: ${JSON.stringify({ ...value, scopeId: runtime.id })}\n\n`);
    };
    manager.on('architecture-model', modelListener);
    const semanticListener = (value: { scopeId: string; overlayRevision: string }) => {
      if (value.scopeId === runtime.id && !reply.raw.destroyed) reply.raw.write(`event: semantic-model\ndata: ${JSON.stringify(value)}\n\n`);
    };
    manager.on('semantic-model', semanticListener);
    const heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(': keepalive\n\n'); }, 25000);
    heartbeat.unref();
    const cleanup = () => { clearInterval(heartbeat); manager.off('status', listener); manager.off('architecture-model', modelListener); manager.off('semantic-model', semanticListener); streams.delete(reply.raw); };
    request.raw.on('aborted', cleanup); reply.raw.on('close', cleanup);
  });
  const staticRoot = path.join(manager.config.toolRoot, 'dist');
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
  app.get('/*', async (request, reply) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname.startsWith('/api/')) return reply.code(404).send({ error: 'API 不存在' });
    let relative: string;
    try { relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\//, ''); }
    catch { throw bad('无效 URL 编码'); }
    if (relative !== 'index.html' && !relative.startsWith('assets/') && relative !== 'favicon.svg') return reply.code(404).send({ error: '文件不存在' });
    try {
      const file = await authorizedFile(staticRoot, relative);
      if ((await stat(file)).size > 16 * 1024 * 1024) throw new Error('静态资源过大');
      reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'");
      return reply.type(mime[path.extname(file)] ?? 'application/octet-stream').send(await readFile(file));
    } catch (error) {
      if (error instanceof AccessError) throw error;
      return reply.code(404).send({ error: '网站尚未构建。开发时运行 pnpm web，生产时先运行 pnpm build。' });
    }
  });
  app.addHook('onClose', async () => { await manager.close(); });
  return app as typeof app & { bridgeBroker: typeof bridgeBroker };
}

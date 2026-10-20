import path from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { request } from 'node:http';
import type { LoadedConfig } from '../../../packages/indexer/src/config.ts';
import type { BridgeRuntime } from '../../../packages/control-protocol/src/types.ts';

export class BridgeClientError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
const fail = (code: string, message: string): never => { throw new BridgeClientError(code, message); };
const MAX_RESPONSE = 4 * 1024 * 1024;

/** No tool accepts a URL, path, executable or token. The operator's fixed config is the only locator. */
export class BridgeClient {
  constructor(private readonly config: LoadedConfig) {}
  private async runtime(): Promise<BridgeRuntime> {
    const file = path.join(this.config.cacheDir, 'bridge', 'runtime.json');
    try {
      const relative = path.relative(this.config.toolRoot, file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('UNSAFE_RUNTIME', 'MCP 凭据必须位于工具缓存中');
      let current = this.config.toolRoot;
      for (const part of relative.split(path.sep)) {
        current = path.join(current, part);
        if ((await lstat(current)).isSymbolicLink()) fail('UNSAFE_RUNTIME', 'MCP 凭据路径不能经过链接或 Junction');
      }
      if (path.resolve(await realpath(file)).toLowerCase() !== path.resolve(file).toLowerCase()) fail('UNSAFE_RUNTIME', 'MCP 凭据路径发生重定向');
      const info = await lstat(file);
      if (!info.isFile() || info.size > 8192) fail('UNSAFE_RUNTIME', 'MCP 凭据格式无效');
      const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
      const value = raw as BridgeRuntime;
      if (!raw || typeof raw !== 'object' || Object.keys(raw).some(key => !['schemaVersion', 'serverEpoch', 'port', 'token'].includes(key)) ||
        value.schemaVersion !== '1.0' || value.port !== (this.config.port ?? 4310) ||
        typeof value.serverEpoch !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(value.serverEpoch) ||
        typeof value.token !== 'string' || !/^[a-zA-Z0-9_-]{32,256}$/.test(value.token)) fail('UNSAFE_RUNTIME', 'MCP 凭据与固定配置不一致');
      return value;
    } catch (error) {
      if (error instanceof BridgeClientError) throw error;
      return fail('SERVICE_NOT_RUNNING', 'Architecture Explorer 尚未运行，或本机联动凭据不可读取。请先启动网站服务。');
    }
  }
  private http(runtime: BridgeRuntime, route: string, body?: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request({ host: '127.0.0.1', port: runtime.port, path: route, method: payload === undefined ? 'GET' : 'POST',
        headers: payload === undefined ? {} : { 'Content-Type': 'application/json', Authorization: `Bearer ${runtime.token}`, 'Content-Length': Buffer.byteLength(payload) },
        signal: AbortSignal.timeout(20000), agent: false }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE) { response.destroy(); reject(new BridgeClientError('RESPONSE_TOO_LARGE', '查询结果超过 4 MiB，请缩小图形范围')); }
          else chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            if ((response.statusCode ?? 500) >= 300 && (response.statusCode ?? 500) < 400) return reject(new BridgeClientError('SERVICE_IDENTITY', '拒绝本地服务重定向'));
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reject(new BridgeClientError('INVALID_RESPONSE', '本地服务返回了无效结果'));
            const result = parsed as Record<string, unknown>;
            if ((response.statusCode ?? 500) >= 400) return reject(new BridgeClientError(typeof result.code === 'string' ? result.code : `HTTP_${response.statusCode}`, typeof result.error === 'string' ? result.error : '本地服务拒绝请求'));
            resolve(result);
          } catch { reject(new BridgeClientError('INVALID_RESPONSE', '本地服务没有返回有效 JSON')); }
        });
        response.on('error', () => reject(new BridgeClientError('COMMUNICATION_FAILED', '本地服务连接中断，请重试查询；展示状态需通过回执确认')));
      });
      req.on('error', () => reject(new BridgeClientError('SERVICE_UNREACHABLE', '无法连接已配置的本机服务。请确认网站运行、端口一致，随后重新查询。')));
      req.end(payload);
    });
  }
  private async authenticated(): Promise<BridgeRuntime> {
    const runtime = await this.runtime();
    const nonce = randomBytes(32).toString('hex');
    const hello = await this.http(runtime, `/api/bridge/hello?nonce=${nonce}`);
    const expected = createHmac('sha256', runtime.token).update(`${nonce}|${runtime.serverEpoch}`).digest('hex');
    const actual = typeof hello.proof === 'string' && /^[a-f0-9]{64}$/.test(hello.proof) ? Buffer.from(hello.proof, 'hex') : Buffer.alloc(0);
    if (hello.serverEpoch !== runtime.serverEpoch || actual.length !== 32 || !timingSafeEqual(actual, Buffer.from(expected, 'hex'))) fail('SERVICE_IDENTITY', '本机服务身份校验失败；未发送联动令牌');
    return runtime;
  }
  async query(operation: string, args: Record<string, unknown>): Promise<unknown> {
    return this.http(await this.authenticated(), '/api/bridge/private/query', { operation, arguments: args });
  }
  async control(operation: string, args: Record<string, unknown>): Promise<unknown> {
    return this.http(await this.authenticated(), '/api/bridge/private/control', { operation, arguments: args });
  }
}

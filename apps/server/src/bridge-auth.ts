import path from 'node:path';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, open, rename, unlink } from 'node:fs/promises';
import type { FastifyRequest } from 'fastify';
import type { LoadedConfig } from '../../../packages/indexer/src/config.ts';
import type { BridgeRuntime } from '../../../packages/control-protocol/src/types.ts';
import { authorizedFile, ensureCacheDirectory, readAuthorized } from '../../../packages/indexer/src/security.ts';
import { withFileLock } from '../../../packages/indexer/src/file-lock.ts';

const execute = promisify(execFile);
export const bridgeFailure = (code: string, message: string, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
export function secureEqual(a: string, b: string): boolean {
  const one = Buffer.from(a), two = Buffer.from(b);
  return one.length === two.length && timingSafeEqual(one, two);
}
/** Resolve native SDDL trustee aliases before comparing exact principals. */
export async function windowsRuntimeDaclIsPrivate(sddl: string, currentSid: string): Promise<boolean> {
  if (!/^S-1-(?:\d+-)+\d+$/.test(currentSid) || sddl.length > 64 * 1024) return false;
  const descriptor = sddl.split(/\r?\n/).find(line => line.startsWith('D:'));
  if (!descriptor) return false;
  const script = String.raw`
$ErrorActionPreference='Stop'
$descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($env:AE_RUNTIME_ACL_SDDL)
if($null -eq $descriptor.DiscretionaryAcl){throw 'DACL required'}
$aces=@($descriptor.DiscretionaryAcl | ForEach-Object {@{type=$_.AceType.ToString();sid=$_.SecurityIdentifier.Value}})
@{aceCount=$descriptor.DiscretionaryAcl.Count;aces=$aces} | ConvertTo-Json -Compress
`;
  try {
    const powershell = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const result = await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 5000, maxBuffer: 8192, env: { ...process.env, AE_RUNTIME_ACL_SDDL: descriptor } });
    const parsed = JSON.parse(result.stdout);
    const allowed = ['AccessAllowed', 'AccessAllowedObject', 'AccessAllowedCallback', 'AccessAllowedCallbackObject'];
    const denied = ['AccessDenied', 'AccessDeniedObject', 'AccessDeniedCallback', 'AccessDeniedCallbackObject'];
    return Number.isSafeInteger(parsed.aceCount) && parsed.aceCount > 0 && Array.isArray(parsed.aces) && parsed.aces.length === parsed.aceCount &&
      parsed.aces.some((ace: { type?: unknown }) => typeof ace?.type === 'string' && allowed.includes(ace.type)) &&
      parsed.aces.every((ace: { type?: unknown; sid?: unknown }) => typeof ace?.type === 'string' && typeof ace.sid === 'string' && /^S-1-(?:\d+-)+\d+$/.test(ace.sid) &&
        (allowed.includes(ace.type) ? ace.sid === 'S-1-5-18' || ace.sid === currentSid : denied.includes(ace.type)));
  } catch { return false; }
}
export class BridgeFiles {
  readonly directory: string;
  constructor(readonly config: LoadedConfig) { this.directory = path.join(config.cacheDir, 'bridge'); }
  private relative(name: string) { return path.relative(this.config.toolRoot, path.join(this.directory, name)).replaceAll('\\', '/'); }
  async protect(): Promise<void> {
    await ensureCacheDirectory(this.directory, this.config.toolRoot);
    if (process.platform === 'win32') {
      const system = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32');
      const identity = await execute(path.join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 5000, maxBuffer: 8192 });
      const sid = identity.stdout.trim().match(/"(S-1-(?:\d+-)+\d+)"\s*$/)?.[1];
      if (!sid) throw bridgeFailure('RUNTIME_PERMISSIONS', '无法取得当前 Windows 用户 SID；未发布 MCP 凭据', 503);
      await execute(path.join(system, 'icacls.exe'), [this.directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'],
        { windowsHide: true, timeout: 10000, maxBuffer: 8192 });
      // /grant:r does not remove old explicit grants to other principals.
      // Inspect native SDDL and fail closed rather than publishing into one.
      const auditName = `acl-${randomBytes(12).toString('hex')}.tmp`;
      const auditPath = path.join(this.directory, auditName);
      try {
        await execute(path.join(system, 'icacls.exe'), [this.directory, '/save', auditPath, '/q'], { windowsHide: true, timeout: 10000, maxBuffer: 8192 });
        const audit = await readAuthorized(this.config.toolRoot, this.relative(auditName), 64 * 1024);
        const sddl = audit.toString('utf16le').replace(/^\uFEFF/, '');
        // Resolve aliases natively, then compare exact SIDs; LA and BA are not blanket exemptions.
        if (!await windowsRuntimeDaclIsPrivate(sddl, sid))
          throw bridgeFailure('RUNTIME_PERMISSIONS', '联动目录存在其他主体的显式访问权限；未发布 MCP 凭据', 503);
      } finally { await unlink(auditPath).catch(() => {}); }
    } else await chmod(this.directory, 0o700);
  }
  async read(name: 'runtime.json' | 'state.json'): Promise<Buffer | undefined> {
    try { return await readAuthorized(this.config.toolRoot, this.relative(name), 2 * 1024 * 1024); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async write(name: 'runtime.json' | 'state.json', value: unknown): Promise<void> {
    await ensureCacheDirectory(this.directory, this.config.toolRoot);
    const relative = this.relative(name);
    try { await authorizedFile(this.config.toolRoot, relative); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw bridgeFailure('QUEUE_TOO_LARGE', '联动缓存超过预算', 413);
    const temporary = path.join(this.directory, `${name}.${randomBytes(12).toString('hex')}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await ensureCacheDirectory(this.directory, this.config.toolRoot);
      await rename(temporary, path.join(this.directory, name));
    } finally { await unlink(temporary).catch(() => {}); }
  }
  async removeRuntime(epoch: string): Promise<void> {
    await this.publication(async () => {
      const bytes = await this.read('runtime.json'); if (!bytes) return;
      const value = JSON.parse(bytes.toString('utf8')) as BridgeRuntime;
      if (value.serverEpoch === epoch) await unlink(path.join(this.directory, 'runtime.json'));
    });
  }
  async publication<T>(action: () => Promise<T>): Promise<T> {
    return withFileLock({ toolRoot: this.config.toolRoot, lockPath: path.join(this.directory, 'runtime.lock'),
      locked: () => bridgeFailure('RUNTIME_LOCKED', '另一个服务实例正在发布凭据，或锁的持有者无法验证，未覆盖现有实例', 409) }, action);
  }
}
export class BridgeIdentity {
  readonly token = randomBytes(32).toString('hex');
  readonly serverEpoch = randomBytes(24).toString('hex');
  published = false;
  constructor(readonly files: BridgeFiles) {}
  authenticate(request: FastifyRequest): void {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ') || !secureEqual(header.slice(7), this.token))
      throw bridgeFailure('UNAUTHORIZED', 'MCP 私有通道需要独立身份认证', 401);
  }
  hello(nonce: string) {
    if (!/^[a-fA-F0-9]{64}$/.test(nonce)) throw bridgeFailure('INVALID_NONCE', 'nonce 必须为 64 位十六进制');
    return { serverEpoch: this.serverEpoch, proof: createHmac('sha256', this.token).update(nonce + '|' + this.serverEpoch).digest('hex') };
  }
  async publish(port: number): Promise<void> {
    return this.files.publication(() => this.publishLocked(port));
  }
  private async publishLocked(port: number): Promise<void> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw bridgeFailure('INVALID_PORT', '联动端口必须为有效本机服务端口');
    await this.files.protect();
    const old = await this.files.read('runtime.json');
    if (old) {
      const previous = JSON.parse(old.toString('utf8')) as BridgeRuntime;
      if (!previous || Object.keys(previous).some(key => !['schemaVersion', 'serverEpoch', 'port', 'token'].includes(key)) || previous.schemaVersion !== '1.0'
        || !Number.isInteger(previous.port) || previous.port < 1024 || previous.port > 65535 || !/^[a-zA-Z0-9_-]{16,128}$/.test(previous.serverEpoch)
        || !/^[a-zA-Z0-9_-]{32,256}$/.test(previous.token)) throw bridgeFailure('CORRUPT_RUNTIME', '现有联动凭据描述格式无效；未覆盖未知实例', 503);
      if (previous.serverEpoch !== this.serverEpoch && Number.isInteger(previous.port) && previous.port >= 1024 && previous.port <= 65535 && typeof previous.token === 'string') {
        const nonce = randomBytes(32).toString('hex');
        let alive = false;
        try {
          const response = await fetch(`http://127.0.0.1:${previous.port}/api/bridge/hello?nonce=${nonce}`, { redirect: 'error', signal: AbortSignal.timeout(1000) });
          const answer = await response.json() as { serverEpoch?: string; proof?: string };
          const expected = createHmac('sha256', previous.token).update(nonce + '|' + previous.serverEpoch).digest('hex');
          alive = response.ok && answer.serverEpoch === previous.serverEpoch && typeof answer.proof === 'string' && secureEqual(answer.proof, expected);
        } catch { /* A dead runtime may be replaced after a successful new listen. */ }
        if (alive) throw bridgeFailure('RUNTIME_IN_USE', '同一工具缓存已有运行中的联动服务，未覆盖其凭据', 409);
      }
    }
    await this.files.write('runtime.json', { schemaVersion: '1.0', serverEpoch: this.serverEpoch, port, token: this.token } satisfies BridgeRuntime);
    this.published = true;
  }
}

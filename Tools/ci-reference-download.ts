import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lstat, open, realpath } from 'node:fs/promises';

export const UNITY_ASSET_REPOSITORY = 'chwan886/Architecture-Explorer' as const;
const repositoryUrl = `https://api.github.com/repos/${UNITY_ASSET_REPOSITORY}`;
const byteLimit = 256 * 1024 * 1024;
type DownloadCode = 'UNITY_ASSET_INPUT_REJECTED' | 'UNITY_ASSET_PRIVATE_REPOSITORY_REQUIRED' | 'UNITY_ASSET_METADATA_REJECTED'
  | 'UNITY_ASSET_NETWORK_FAILED' | 'UNITY_ASSET_REDIRECT_REJECTED' | 'UNITY_ASSET_DOWNLOAD_STATUS_REJECTED'
  | 'UNITY_ASSET_BYTE_LIMIT' | 'UNITY_ASSET_SIZE_MISMATCH' | 'UNITY_ASSET_HASH_MISMATCH' | 'UNITY_ASSET_OUTPUT_REJECTED';
export class UnityAssetDownloadError extends Error {
  readonly code: DownloadCode;
  constructor(code: DownloadCode) { super(code); this.name = 'UnityAssetDownloadError'; this.code = code; }
}
function need(value: unknown, code: DownloadCode): asserts value { if (!value) throw new UnityAssetDownloadError(code); }
export interface UnityAssetInput { assetId: string; sha256: string }
export interface UnityAssetReceipt {
  schemaVersion: 1; outcome: 'verified'; source: 'github-release-asset'; repository: typeof UNITY_ASSET_REPOSITORY;
  assetId: string; sha256: string; bytes: number; redirected: boolean;
}
function validateInput(input: UnityAssetInput): void {
  need(input && typeof input.assetId === 'string' && /^[1-9][0-9]{0,19}$/.test(input.assetId) && input.assetId.length <= 20 &&
    !/[\x00-\x20\x7f]/.test(input.assetId) && Number.isSafeInteger(Number(input.assetId)), 'UNITY_ASSET_INPUT_REJECTED');
  need(typeof input.sha256 === 'string' && /^[a-f0-9]{64}$/.test(input.sha256) && input.sha256.length === 64, 'UNITY_ASSET_INPUT_REJECTED');
}
/** No URL, alternate repository or credential fallback is accepted by this mode. */
export function parseUnityAssetInput(env: NodeJS.ProcessEnv): UnityAssetInput {
  need(env.GITHUB_ACTIONS === 'true' && env.GITHUB_SERVER_URL === 'https://github.com' && env.GITHUB_REPOSITORY === UNITY_ASSET_REPOSITORY &&
    env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_REF_PROTECTED === 'true', 'UNITY_ASSET_INPUT_REJECTED');
  const result = { assetId: env.UNITY_REFERENCES_ASSET_ID!, sha256: env.UNITY_REFERENCES_SHA256! };
  validateInput(result); return Object.freeze(result);
}
function object(value: unknown): Record<string, any> {
  need(value !== null && typeof value === 'object' && !Array.isArray(value), 'UNITY_ASSET_METADATA_REJECTED');
  return value as Record<string, any>;
}
export function isApprovedUnityAssetRedirect(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 8192 || /[\x00-\x20\x7f\\#]/.test(raw)) return false;
  try {
    const url = new URL(raw), authority = raw.split('://')[1]?.split('/')[0];
    return url.protocol === 'https:' && url.hostname === 'release-assets.githubusercontent.com' && !url.port &&
      !url.username && !url.password && !url.hash && authority !== undefined && !authority.includes('@');
  } catch { return false; }
}
async function jsonBody(response: Response): Promise<Record<string, any>> {
  need(response.status === 200 && !response.redirected && response.body, 'UNITY_ASSET_METADATA_REJECTED');
  const parts: Uint8Array[] = []; let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
      if (size > 1024 * 1024) { await reader.cancel().catch(() => {}); throw new UnityAssetDownloadError('UNITY_ASSET_METADATA_REJECTED'); }
      parts.push(next.value);
    }
    return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))));
  } finally { reader.releaseLock(); }
}

/** Pure transfer orchestration: injected fetch and sink; no filesystem, URL logging or target execution. */
export async function transferUnityReferenceAsset(input: UnityAssetInput, token: string,
  writeChunk: (chunk: Uint8Array) => Promise<void>, send: typeof fetch = fetch): Promise<UnityAssetReceipt> {
  try {
    validateInput(input);
    need(typeof token === 'string' && token.length > 0 && !/[\x00-\x20\x7f]/.test(token), 'UNITY_ASSET_INPUT_REJECTED');
    const signal = AbortSignal.timeout(120000);
    const apiGet = (url: string, accept: string) => send(url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal,
      headers: { authorization: `Bearer ${token}`, accept, 'X-GitHub-Api-Version': '2026-03-10', 'user-agent': 'Architecture-Explorer-private-unity-metadata' } });
    const repo = await jsonBody(await apiGet(repositoryUrl, 'application/vnd.github+json'));
    need(repo.full_name === UNITY_ASSET_REPOSITORY && repo.private === true && repo.visibility === 'private', 'UNITY_ASSET_PRIVATE_REPOSITORY_REQUIRED');
    const assetUrl = `${repositoryUrl}/releases/assets/${input.assetId}`;
    const metadata = await jsonBody(await apiGet(assetUrl, 'application/vnd.github+json'));
    need(Number.isSafeInteger(metadata.id) && String(metadata.id) === input.assetId && metadata.url === assetUrl && metadata.state === 'uploaded' &&
      Number.isSafeInteger(metadata.size) && metadata.size > 0 && metadata.size <= byteLimit && metadata.digest === `sha256:${input.sha256}`, 'UNITY_ASSET_METADATA_REJECTED');
    let response = await apiGet(assetUrl, 'application/octet-stream'), redirected = false;
    need(!response.redirected, 'UNITY_ASSET_REDIRECT_REJECTED');
    if (response.status === 302) {
      const location = response.headers.get('location');
      need(isApprovedUnityAssetRedirect(location), 'UNITY_ASSET_REDIRECT_REJECTED');
      await response.body?.cancel().catch(() => {});
      // A fresh request carries no API authorization, cookies, provider defaults or third-hop capability.
      response = await send(location, { method: 'GET', redirect: 'manual', credentials: 'omit', signal,
        headers: { accept: 'application/octet-stream', 'user-agent': 'Architecture-Explorer-private-unity-metadata' } });
      redirected = true;
    }
    need(response.status === 200 && !response.redirected && response.body, 'UNITY_ASSET_DOWNLOAD_STATUS_REJECTED');
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null) need(/^[0-9]+$/.test(declaredLength) && Number(declaredLength) <= byteLimit && Number(declaredLength) === metadata.size, 'UNITY_ASSET_SIZE_MISMATCH');
    const hash = createHash('sha256'); let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > byteLimit || size > metadata.size) { await reader.cancel().catch(() => {}); throw new UnityAssetDownloadError('UNITY_ASSET_BYTE_LIMIT'); }
        hash.update(next.value);
        try { await writeChunk(next.value); } catch { throw new UnityAssetDownloadError('UNITY_ASSET_OUTPUT_REJECTED'); }
      }
    } finally { reader.releaseLock(); }
    need(size === metadata.size, 'UNITY_ASSET_SIZE_MISMATCH');
    need(hash.digest('hex') === input.sha256, 'UNITY_ASSET_HASH_MISMATCH');
    return Object.freeze({ schemaVersion: 1, outcome: 'verified', source: 'github-release-asset', repository: UNITY_ASSET_REPOSITORY,
      assetId: input.assetId, sha256: input.sha256, bytes: size, redirected });
  } catch (error) {
    if (error instanceof UnityAssetDownloadError) throw error;
    throw new UnityAssetDownloadError('UNITY_ASSET_NETWORK_FAILED');
  }
}

async function noLinks(absolute: string): Promise<void> {
  let current = path.parse(absolute).root;
  for (const part of path.relative(current, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    need(!(await lstat(current)).isSymbolicLink(), 'UNITY_ASSET_OUTPUT_REJECTED');
  }
}
/** Writes only the existing tool-side .ci-references directory; neither old files nor target roots are accepted. */
export async function downloadUnityReferenceAsset(input: UnityAssetInput, token: string, toolRoot: string,
  send: typeof fetch = fetch): Promise<UnityAssetReceipt> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    validateInput(input); need(path.isAbsolute(toolRoot), 'UNITY_ASSET_OUTPUT_REJECTED');
    await noLinks(toolRoot); const root = await realpath(toolRoot);
    const directory = path.join(root, '.ci-references'); await noLinks(directory);
    need((await lstat(directory)).isDirectory(), 'UNITY_ASSET_OUTPUT_REJECTED');
    const destination = path.join(directory, 'metadata.zip');
    file = await open(destination, 'wx', 0o600);
    const created = await file.stat({ bigint: true });
    const receipt = await transferUnityReferenceAsset(input, token, async chunk => {
      let offset = 0;
      while (offset < chunk.byteLength) { const written = await file!.write(chunk, offset, chunk.byteLength - offset, null);
        need(written.bytesWritten > 0, 'UNITY_ASSET_OUTPUT_REJECTED'); offset += written.bytesWritten; }
    }, send);
    await file.sync();
    const observed = await lstat(destination, { bigint: true });
    need(observed.isFile() && !observed.isSymbolicLink() && observed.dev === created.dev && observed.ino === created.ino &&
      observed.size === BigInt(receipt.bytes), 'UNITY_ASSET_OUTPUT_REJECTED');
    return receipt;
  } catch (error) {
    if (error instanceof UnityAssetDownloadError) throw error;
    throw new UnityAssetDownloadError('UNITY_ASSET_OUTPUT_REJECTED');
  } finally { await file?.close().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    need(process.argv.length === 2, 'UNITY_ASSET_INPUT_REJECTED');
    const input = parseUnityAssetInput(process.env), token = process.env.UNITY_REFERENCES_READ_TOKEN;
    need(token, 'UNITY_ASSET_INPUT_REJECTED');
    const result = await downloadUnityReferenceAsset(input, token, fileURLToPath(new URL('..', import.meta.url)));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof UnityAssetDownloadError ? error.code : 'UNITY_ASSET_OUTPUT_REJECTED'); process.exitCode = 1;
  }
}

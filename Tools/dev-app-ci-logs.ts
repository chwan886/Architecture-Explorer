/** Narrow read-only transport for a failed job already bound to the selected PR head/attempt. */
const repositories = ['chwan886/Architecture-Explorer', 'chwan886/GameDemo02'];
const limit = 4 * 1024 * 1024;
export type CiLogDiagnostic = { outcome: 'read'; excerpt: string[]; truncated: boolean; byteCount: number }
  | { outcome: 'unreadable'; reason: string };

function excerpt(text: string, token: string) {
  // The signed download URL and raw response never enter receipts. Redact known credential forms
  // before selecting bounded error context; diagnostics remain untrusted plain text.
  const sanitized = text.replaceAll(token, '[credential redacted]').replaceAll(encodeURIComponent(token), '[credential redacted]')
    .replace(/-----BEGIN [^-\r\n]+-----[\s\S]*?(?:-----END [^-\r\n]+-----|$)/gi, '[key material redacted]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [credential redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[credential redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[JWT redacted]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[URL omitted]')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  const lines = sanitized.split(/\r?\n/), chosen = new Set<number>(), strong: number[] = [], fallback: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    const content = lines[index].replace(/^\d{4}-\d\d-\d\dT\S+\s+/, '').trimStart();
    if (/^[✔✓]\s/.test(content)) continue; // Successful test titles often describe rejected errors/failures.
    if (/^0\s+Error\(s\)\s*$/i.test(content) || /^\$ErrorActionPreference\s*=/.test(content)) continue;
    if (/##\[error\]|(?:^|\s)(?:✖|not ok\b)|\bERR_[A-Z_]+\b|AssertionError/i.test(content)) strong.push(index);
    else if (/\berror\b|\bfailed\b|\bexception\b/i.test(content)) fallback.push(index);
  }
  // Prefer actual terminal markers and the most recent failure context over early setup/test wording.
  for (const index of (strong.length ? strong : fallback).reverse()) {
    for (let context = Math.max(0, index - 2); context <= Math.min(lines.length - 1, index + 8) && chosen.size < 60; context++) chosen.add(context);
    if (chosen.size >= 60) break;
  }
  if (!chosen.size) for (let index = Math.max(0, lines.length - 20); index < lines.length; index++) chosen.add(index);
  let remaining = 12000;
  const selected = [...chosen].sort((a, b) => a - b).map(index => {
    const value = lines[index].slice(0, Math.min(1000, remaining)); remaining -= value.length; return value;
  }).filter(Boolean);
  return { excerpt: selected, truncated: chosen.size < lines.length || remaining === 0 };
}

/** GitHub documents a 302 and one-minute signed URL. No authentication is forwarded to storage. */
export async function readCiJobLog(repository: string, jobId: number, token: string, fetcher: typeof fetch = fetch): Promise<CiLogDiagnostic> {
  if (!repositories.includes(repository) || !Number.isSafeInteger(jobId) || jobId <= 0 || !token) return { outcome: 'unreadable', reason: 'CI_LOG_ARGUMENT_INVALID' };
  try {
    const signal = AbortSignal.timeout(20000);
    const response = await fetcher(`https://api.github.com/repos/${repository}/actions/jobs/${jobId}/logs`, { method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10',
        'cache-control': 'no-cache, no-store', 'user-agent': 'chwan-dev-agent-local-verification' } });
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (response.status !== 302 || !location) return { outcome: 'unreadable', reason: 'CI_LOG_REDIRECT_UNAVAILABLE' };
    const target = new URL(location);
    if (target.protocol !== 'https:' || target.username || target.password || target.port || target.hash ||
      !/^productionresults[a-z0-9]*\.blob\.core\.windows\.net$/.test(target.hostname)) return { outcome: 'unreadable', reason: 'CI_LOG_DOWNLOAD_LOCATION_REJECTED' };
    const download = await fetcher(target, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal,
      headers: { accept: 'text/plain', 'cache-control': 'no-cache, no-store' } });
    if (download.status !== 200 || !download.body) { await download.body?.cancel().catch(() => {}); return { outcome: 'unreadable', reason: 'CI_LOG_DOWNLOAD_FAILED' }; }
    if (Number(download.headers.get('content-length')) > limit) { await download.body.cancel().catch(() => {}); return { outcome: 'unreadable', reason: 'CI_LOG_SIZE_LIMIT' }; }
    const reader = download.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); return { outcome: 'unreadable', reason: 'CI_LOG_SIZE_LIMIT' }; }
      chunks.push(next.value);
    }
    const bytes = Buffer.concat(chunks, size), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const diagnostic = excerpt(text, token);
    bytes.fill(0);
    return { outcome: 'read', ...diagnostic, byteCount: size };
  } catch { return { outcome: 'unreadable', reason: 'CI_LOG_TRANSPORT_FAILED' }; }
}

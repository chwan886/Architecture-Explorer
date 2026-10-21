import test from 'node:test';
import assert from 'node:assert/strict';
import { readCiJobLog } from '../Tools/dev-app-ci-logs.ts';

const repo = 'chwan886/Architecture-Explorer', token = 'fixture-secret-never-record';
const signed = 'https://productionresultssa19.blob.core.windows.net/actions-results/job-logs.txt?sig=fixture-signed-secret';
function mocked(responses: Response[]) {
  const calls: { url: string; options?: RequestInit }[] = [];
  const fetcher = (async (input: URL | RequestInfo, options?: RequestInit) => {
    calls.push({ url: String(input), options });
    assert.ok(responses.length, 'No unexpected request');
    return responses.shift()!;
  }) as typeof fetch;
  return { calls, fetcher };
}
const redirect = (location = signed) => new Response(null, { status: 302, headers: { location } });

test('job logs send App authorization only to fixed API and return bounded plain error context without signatures or credentials', async () => {
  const f = mocked([redirect(), new Response(`setup\nerror: ${token}\nBearer other-secret\nghs_otherfixturetoken\neyJabc.abc.abc\n${signed}\nend`)]);
  const result = await readCiJobLog(repo, 8, token, f.fetcher);
  assert.equal(result.outcome, 'read');
  assert.equal(f.calls[0].url, `https://api.github.com/repos/${repo}/actions/jobs/8/logs`);
  assert.equal(new Headers(f.calls[0].options?.headers).get('authorization'), `Bearer ${token}`);
  assert.equal(f.calls[0].options?.redirect, 'manual');
  assert.equal(new Headers(f.calls[1].options?.headers).get('authorization'), null);
  assert.equal(f.calls[1].options?.credentials, 'omit');
  assert.equal(f.calls[1].options?.redirect, 'error');
  const serialized = JSON.stringify(result);
  for (const forbidden of [token, 'other-secret', 'ghs_otherfixturetoken', 'eyJabc.abc.abc', signed, 'fixture-signed-secret']) assert.ok(!serialized.includes(forbidden));
});

test('repository and job identity reject before HTTP; untrusted download locations never receive a request', async () => {
  const empty = mocked([]);
  for (const [repository, id] of [['other/repo', 8], [repo, 0], [repo, 1.5]] as const) assert.equal((await readCiJobLog(repository, id, token, empty.fetcher)).outcome, 'unreadable');
  assert.equal(empty.calls.length, 0);
  for (const location of ['http://productionresultssa19.blob.core.windows.net/log', 'https://evil.example/log', 'https://productionresultssa19.blob.core.windows.net.evil.example/log',
    'https://user:pass@productionresultssa19.blob.core.windows.net/log', 'https://productionresultssa19.blob.core.windows.net:444/log', signed + '#fragment', '/relative']) {
    const f = mocked([redirect(location)]), result = await readCiJobLog(repo, 8, token, f.fetcher);
    assert.equal(result.outcome, 'unreadable'); assert.equal(f.calls.length, 1);
  }
});

test('HTTP failures, redirect chains, oversized bodies and raw errors fail without exposing bodies or URLs', async () => {
  for (const responses of [[new Response(token, { status: 403 })], [redirect(), redirect()], [redirect(), new Response(token, { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } })],
    [redirect(), new Response(new Uint8Array(4 * 1024 * 1024 + 1))]]) {
    const f = mocked(responses), result = await readCiJobLog(repo, 8, token, f.fetcher);
    assert.equal(result.outcome, 'unreadable'); assert.ok(!JSON.stringify(result).includes(token));
  }
  const throwing = (async () => { throw Error(`${token} ${signed}`); }) as typeof fetch;
  assert.deepEqual(await readCiJobLog(repo, 8, token, throwing), { outcome: 'unreadable', reason: 'CI_LOG_TRANSPORT_FAILED' });
});

test('log context is bounded and suppresses key armor, ANSI and control sequences', async () => {
  const body = Array.from({ length: 200 }, (_, index) => `error ${index} ${'x'.repeat(1500)}`).join('\n') +
    '\n✖ error -----BEGIN PRIVATE KEY-----\nfixture pem\n-----END PRIVATE KEY-----\n\u001b[31mred\u0000\n' + 'y'.repeat(15000);
  const f = mocked([redirect(), new Response(body)]), result = await readCiJobLog(repo, 8, token, f.fetcher);
  assert.equal(result.outcome, 'read');
  if (result.outcome !== 'read') return;
  assert.ok(result.excerpt.length <= 60 && result.excerpt.join('').length <= 12000);
  assert.ok(result.excerpt.every(line => line.length <= 1000));
  assert.equal(result.truncated, true);
  assert.ok(!JSON.stringify(result).includes('fixture pem'));
  assert.ok(result.excerpt.some(line => line.includes('[key material redacted]')));
  assert.ok(!result.excerpt.join('').includes('\u001b') && !result.excerpt.join('').includes('\u0000'));
  const partial = mocked([redirect(), new Response('error -----BEGIN PRIVATE KEY-----\nfixture incomplete pem')]);
  const partialResult = await readCiJobLog(repo, 8, token, partial.fetcher);
  assert.equal(partialResult.outcome, 'read');
  assert.ok(!JSON.stringify(partialResult).includes('fixture incomplete pem'));
});

test('late real failure survives many passing test titles that describe failed/error cases', async () => {
  const passed = Array.from({ length: 100 }, (_, index) => `2026-10-21T23:00:00Z ✔ rejects failed/error/AssertionError/ERR_FIXTURE ${index}`).join('\n');
  const body = `${passed}\n2026-10-21T23:01:00Z ✖ actual broken test\nnot ok 101 - actual broken test\nAssertionError: exact expected value did not match\n  expected: clean\n  actual: dirty\n##[error]Process completed with exit code 1.`;
  const f = mocked([redirect(), new Response(body)]), result = await readCiJobLog(repo, 8, token, f.fetcher);
  assert.equal(result.outcome, 'read');
  if (result.outcome !== 'read') return;
  const text = result.excerpt.join('\n');
  assert.match(text, /✖ actual broken test/);
  assert.match(text, /expected: clean/);
  assert.match(text, /actual: dirty/);
  assert.ok(!text.includes('ERR_FIXTURE 0'));
});

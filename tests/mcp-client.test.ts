import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { BridgeClient } from '../apps/mcp/src/client.ts';
import { TOOL_ROOT, type LoadedConfig } from '../packages/indexer/src/config.ts';

test('sidecar does not disclose its bearer to a wrong service, redirect or mismatched configured port', async () => {
  const temporary = path.join(TOOL_ROOT, '.tmp'); await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, 'mcp-identity-')), cacheDir = path.join(directory, 'cache');
  await mkdir(path.join(cacheDir, 'bridge'), { recursive: true });
  let bearerSeen = false, mode = 'wrong';
  const server = createServer((request, reply) => {
    bearerSeen ||= !!request.headers.authorization;
    if (mode === 'redirect') { reply.writeHead(302, { location: 'http://example.invalid/capture' }); reply.end('{}'); }
    else { reply.setHeader('Content-Type', 'application/json'); reply.end(JSON.stringify({ serverEpoch: 'a'.repeat(48), proof: '0'.repeat(64) })); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  const config = { toolRoot: TOOL_ROOT, cacheDir, port } as LoadedConfig;
  const runtime = { schemaVersion: '1.0', serverEpoch: 'a'.repeat(48), port, token: 'b'.repeat(64) };
  const file = path.join(cacheDir, 'bridge/runtime.json'); await writeFile(file, JSON.stringify(runtime));
  try {
    const client = new BridgeClient(config);
    await assert.rejects(client.query('list_projects', {}), (error: any) => error.code === 'SERVICE_IDENTITY');
    mode = 'redirect'; await assert.rejects(client.query('list_projects', {}), (error: any) => error.code === 'SERVICE_IDENTITY');
    await writeFile(file, JSON.stringify({ ...runtime, port: port + 1 }));
    await assert.rejects(client.query('list_projects', {}), (error: any) => error.code === 'UNSAFE_RUNTIME');
    assert.equal(bearerSeen, false, 'no unverified service may receive the fixed runtime token');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.ok(directory.startsWith(path.join(TOOL_ROOT, '.tmp', 'mcp-identity-'))); await rm(directory, { recursive: true, force: true });
  }
});

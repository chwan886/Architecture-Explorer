import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, loadConfigFromFile } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const configFile = path.join(root, 'apps/web/vite.config.ts');

test('Vite proxies to the configured nondefault API port without inspecting target roots', async () => {
  await mkdir(path.join(root, '.tmp'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.tmp/vite-config-'));
  const previous = process.env.EXPLORER_CONFIG;
  const api = createHttpServer((request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ path: request.url, marker: 'configured-api' })); });
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
    const address = api.address(); assert.ok(address && typeof address !== 'string');
    const file = path.join(directory, 'config.json');
    await writeFile(file, '\uFEFF' + JSON.stringify({ port: address.port, projects: [{ root: './not-a-real-project' }] }));
    process.env.EXPLORER_CONFIG = file;
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile, undefined, 'silent', undefined, 'native');
    assert.equal(loaded?.config.server?.proxy?.['/api'], `http://127.0.0.1:${address.port}`);
    vite = await createServer({ configFile, configLoader: 'native', cacheDir: path.join(directory, 'vite-cache'), logLevel: 'silent', server: { host: '127.0.0.1', port: 0, strictPort: false }, optimizeDeps: { noDiscovery: true, include: [] } });
    await vite.listen();
    const web = vite.httpServer!.address(); assert.ok(web && typeof web !== 'string');
    const response = await fetch(`http://127.0.0.1:${web.port}/api/status`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { path: '/api/status', marker: 'configured-api' });
    for (const port of [0, 1023, 65536, 4310.5, '4311', null]) {
      await writeFile(file, JSON.stringify({ port }));
      await assert.rejects(loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile, undefined, 'silent', undefined, 'native'), /port/);
    }
    await writeFile(file, '{}');
    const defaults = await loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile, undefined, 'silent', undefined, 'native');
    assert.equal(defaults?.config.server?.proxy?.['/api'], 'http://127.0.0.1:4310');
    process.env.EXPLORER_CONFIG = path.join(directory, 'missing.json');
    await assert.rejects(loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile, undefined, 'silent', undefined, 'native'), /Cannot read API port/);
    assert.ok(await loadConfigFromFile({ command: 'build', mode: 'production' }, configFile, undefined, 'silent', undefined, 'native'), 'production build does not require a local project configuration');
  } finally {
    if (previous === undefined) delete process.env.EXPLORER_CONFIG; else process.env.EXPLORER_CONFIG = previous;
    await vite?.close();
    await new Promise<void>(resolve => api.close(() => resolve()));
    assert.ok(directory.startsWith(path.join(root, '.tmp/vite-config-')));
    await rm(directory, { recursive: true, force: true });
  }
});

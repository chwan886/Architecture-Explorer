import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { TOOL_ROOT } from '../packages/indexer/src/config.ts';
import { canonical, ensureCacheDirectory, isWithin } from '../packages/indexer/src/security.ts';
import { createSmokeDirectory, removeSmokeDirectory } from './ci-smoke-directories.ts';

// Real package runtime check. All target code is an isolated tool-owned fixture, never the game checkout.
assert.ok(process.env.CI_PACKAGE_ROOT, 'CI_PACKAGE_ROOT is required');
const requestedPackage = path.resolve(process.env.CI_PACKAGE_ROOT);
assert.ok((await stat(requestedPackage)).isDirectory(), 'Package directory must already exist');
const packageRoot = await ensureCacheDirectory(requestedPackage, TOOL_ROOT);
assert.ok(isWithin(path.join(TOOL_ROOT, '.ci-output'), packageRoot), 'Smoke package must be in the tool output directory');
assert.notEqual(canonical(path.join(TOOL_ROOT, '.ci-output')), canonical(packageRoot));
const manifest = JSON.parse((await readFile(path.join(packageRoot, 'build-manifest.json'), 'utf8')).replace(/^\uFEFF/, ''));
assert.equal(manifest.containsGameSourceExcerpts, true, 'Package must disclose curated game source excerpts');
const modelPath = 'architecture/models/game-demo-02/model.json';
const original = await readFile(path.join(TOOL_ROOT, modelPath)), copied = await readFile(path.join(packageRoot, modelPath));
assert.ok(original.equals(copied), 'Packaging must preserve human model/anchor bytes');
const quotes = JSON.parse(copied.toString('utf8')).anchors.filter((anchor: { quote?: string }) => typeof anchor.quote === 'string' && anchor.quote.length > 0);
assert.ok(quotes.length > 0, 'This package includes real curated source quotes');
const instructions = await readFile(path.join(packageRoot, 'RUNNING.md'), 'utf8');
assert.match(instructions, /includes game source excerpts/);
assert.doesNotMatch(instructions, /No[^\n]*game source[^\n]*included/);
const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const require = createRequire(path.join(packageRoot, 'package.json')), dependencies: Record<string, string> = {};
for (const dependency of Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies })) {
  let file: string;
  try { file = require.resolve(dependency); } catch { file = require.resolve(`${dependency}/package.json`); }
  assert.ok(isWithin(packageRoot, file), `Dependency escaped the package: ${dependency}`);
  dependencies[dependency] = path.relative(packageRoot, file);
}
for (const forbidden of ['config/local.json', '.git', '.tools/dotnet', '.ci-references', 'game']) {
  await assert.rejects(stat(path.join(packageRoot, forbidden)), { code: 'ENOENT' });
}
const ownedFixture = await createSmokeDirectory(path.join(TOOL_ROOT, '.tmp'), TOOL_ROOT, 'package-runtime-');
const fixture = ownedFixture.directory;
// A fresh owned directory is removed at the end, never a pre-existing local index/cache.
const ownedCache = await createSmokeDirectory(packageRoot, TOOL_ROOT, 'smoke-cache-');
const cache = ownedCache.directory;
const reservation = createServer();
await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
const address = reservation.address(); assert.ok(address && typeof address !== 'string');
const port = address.port;
await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
const source = 'raise RuntimeError("package smoke target Python must not execute")\nvalue = 1\n';
await mkdir(path.join(fixture, 'target/src'), { recursive: true });
await writeFile(path.join(fixture, 'target/src/sample.py'), source);
await writeFile(path.join(fixture, 'target/src/Actor.cs'), 'public class PackageActor { public int Health; public int ReadHealth() => Health; }\n');
const config = path.join(fixture, 'config.json');
await writeFile(config, JSON.stringify({ port, cacheDir: cache, python: 'python', dotnet: path.join(TOOL_ROOT, '.tools/dotnet/dotnet.exe'),
  projects: [{ id: 'package-smoke', name: 'Packaged runtime fixture', root: path.join(fixture, 'target'), include: ['src'], exclude: [] }] }));
const lock = JSON.parse(await readFile(path.join(packageRoot, 'toolchain.lock.json'), 'utf8'));
const child = spawn(path.join(packageRoot, `.tools/node-v${lock.node.version}-win-x64/node.exe`),
  ['--import', 'tsx', 'apps/server/src/main.ts'], { cwd: packageRoot, windowsHide: true, shell: false,
    env: { ...process.env, EXPLORER_CONFIG: config, TSX_DISABLE_CACHE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', spawnError: Error | undefined;
child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; }); child.on('error', error => { spawnError = error; });
const endpoint = `http://127.0.0.1:${port}`;
try {
  let summary: any;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw Error(`Package server failed (${child.exitCode}): ${stderr}`);
    try { const result = await fetch(`${endpoint}/api/summary?scope=package-smoke:primary`, { signal: AbortSignal.timeout(2000) }); if (result.ok) { summary = await result.json(); break; } }
    catch { /* Only the owned fixture service may still be starting. */ }
    await delay(250);
  }
  assert.ok(summary, `Package fixture did not become ready: ${stdout}\n${stderr}`);
  assert.ok(summary.counts.nodes > 0 && summary.metadata.coverage.languages.includes('python') && summary.metadata.coverage.languages.includes('csharp'));
  assert.ok(!summary.diagnostics.some((item: { severity: string }) => item.severity === 'error'));
  assert.equal((await fetch(endpoint, { signal: AbortSignal.timeout(5000) })).status, 200);
  assert.equal((await fetch(`${endpoint}/api/graph?scope=package-smoke:primary&view=architecture`, { signal: AbortSignal.timeout(5000) })).status, 200);
  assert.equal((await fetch(`${endpoint}/api/projects`, { signal: AbortSignal.timeout(5000) })).status, 200);
  assert.equal(await readFile(path.join(fixture, 'target/src/sample.py'), 'utf8'), source);
  await ensureCacheDirectory(path.join(TOOL_ROOT, 'test-results'), TOOL_ROOT);
  await writeFile(path.join(TOOL_ROOT, 'test-results/package-smoke.json'), JSON.stringify({ outcome: 'passed', execution: manifest.execution, runUrl: manifest.runUrl,
    sourceDirty: manifest.sourceDirty, toolSha: manifest.toolSha, packageId: path.basename(packageRoot), containsGameSourceExcerpts: true, sourceQuoteAnchorCount: quotes.length,
    humanModelBytesPreserved: true, runtime: 'bundled Node + tsx', counts: summary.counts, languages: summary.metadata.coverage.languages, dependencies,
    tested: ['all root dependencies resolve inside artifact', 'server startup', 'built frontend HTTP 200', 'C# and Python fixture analysis', 'code graph API', 'project API',
      'target Python not executed', 'curated game source excerpts preserved and disclosed', 'no complete target checkout, local config, Git credentials or Unity DLLs bundled'] }, null, 2) + '\n');
  console.log(`Package runtime and ${quotes.length} preserved/disclosed source quote anchors verified.`);
} finally {
  if (child.exitCode === null && !spawnError) {
    const closed = new Promise<void>(resolve => child.once('close', () => resolve())); child.kill();
    await Promise.race([closed, delay(2000)]);
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'Package process did not stop; keep its fixture for diagnosis');
  }
  await removeSmokeDirectory(ownedCache);
  await removeSmokeDirectory(ownedFixture);
}

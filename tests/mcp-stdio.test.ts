import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createServer as netServer } from 'node:net';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from '../apps/server/src/server.ts';
import { IndexManager, loadConfig, TOOL_ROOT } from '../packages/indexer/src/index.ts';
import { runWorker } from '../packages/indexer/src/workers.ts';
import type { AnalysisPresentation, BrowserBootstrap, ControlCommand, SnapshotDescriptor } from '../packages/control-protocol/src/types.ts';

async function availablePort(): Promise<number> {
  const server = netServer(); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port; await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); return port;
}
test('real SDK stdio → authenticated broker → index/evidence → browser protocol acknowledgement', { timeout: 90000 }, async () => {
  const temp = path.join(TOOL_ROOT, '.tmp'); await mkdir(temp, { recursive: true });
  const directory = await mkdtemp(path.join(temp, 'mcp-stdio-'));
  const target = path.join(directory, 'target'), tool = path.join(directory, 'tool');
  await mkdir(path.join(target, 'src'), { recursive: true }); await mkdir(tool);
  await writeFile(path.join(target, 'src/actions.py'), 'def start(value):\n    return finish(value)\n\ndef finish(value):\n    return value + 1\n');
  const port = await availablePort(), configPath = path.join(directory, 'projects.json');
  await writeFile(configPath, JSON.stringify({ projects: [{ id: 'mcp-fixture', name: 'MCP fixture', root: './target', include: ['src'], exclude: [] }], cacheDir: './tool/cache', port }));
  const config = { ...await loadConfig(configPath), toolRoot: tool };
  const manager = new IndexManager(config, { worker: (language, input, settings) => runWorker(language, input, { ...settings, toolRoot: TOOL_ROOT }) });
  await manager.initialize(); await manager.requestScan('mcp-fixture:primary');
  assert.equal(manager.scope('mcp-fixture:primary').status.state, 'synced');
  const app = await createServer(manager);
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(TOOL_ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(TOOL_ROOT, 'apps/mcp/src/main.ts'), '--config', configPath], cwd: TOOL_ROOT, stderr: 'pipe' });
  const client = new Client({ name: 'architecture-explorer-protocol-test', version: '1.0' });
  let diagnostics = ''; transport.stderr?.on('data', chunk => { diagnostics += String(chunk); });
  try {
    await app.listen({ host: '127.0.0.1', port }); await app.bridgeBroker.publishRuntime();
    await client.connect(transport);
    const list = await client.listTools(); assert.ok(list.tools.some(tool => tool.name === 'show_flow'));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args }); assert.equal(result.isError, undefined, JSON.stringify(result));
      return result.structuredContent as Record<string, any>;
    };
    assert.equal((await call('list_projects')).projects[0].id, 'mcp-fixture');
    const trees = await call('list_worktrees', { projectId: 'mcp-fixture' }); assert.ok(trees.worktrees.length);
    const snapshot = await call('begin_analysis', { projectId: 'mcp-fixture', worktreeId: 'primary' }) as unknown as SnapshotDescriptor;
    const matches = await call('search_architecture', { snapshotId: snapshot.snapshotId, query: 'start' });
    const node = matches.matches.find((match: { ref: { layer: string }; label: string }) => match.ref.layer === 'code' && match.label === 'start'); assert.ok(node);
    const details = await call('get_node_details', { snapshotId: snapshot.snapshotId, ref: node.ref }); assert.ok(details.detail);
    const graph = await call('get_related_graph', { snapshotId: snapshot.snapshotId, nodeId: node.ref.id, view: 'calls', direction: 'down', depth: 2, limit: 20 });
    const edge = graph.graph.edges.find((item: { kind: string }) => item.kind === 'calls'); assert.ok(edge);
    const evidenceId = edge.evidenceIds[0]; const evidence = await call('get_source_evidence', { snapshotId: snapshot.snapshotId, evidenceId }); assert.match(evidence.content, /finish\(value\)/);
    const bootstrap = await app.inject({ url: '/api/bridge/browser/bootstrap', headers: { host: `127.0.0.1:${port}` } });
    assert.equal(bootstrap.statusCode, 200, bootstrap.body); const browser = bootstrap.json<BrowserBootstrap>();
    const cookie = String(bootstrap.headers['set-cookie']).split(';')[0];
    const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, cookie, 'content-type': 'application/json' };
    const state = await app.inject({ method: 'POST', url: '/api/bridge/browser/state', headers, payload: { sessionId: browser.sessionId, csrf: browser.csrf, state: { ...browser.state, allowControl: true } } }); assert.equal(state.statusCode, 200, state.body);
    const attached = await call('attach_view_session', { sessionId: browser.sessionId });
    const receipt = await call('open_architecture', { snapshotId: snapshot.snapshotId, targetView: 'code', focusNodeId: node.ref, highlightedNodeIds: [node.ref], highlightedEdgeIds: [{ layer: 'code', id: edge.id }], bindingId: attached.bindingId, expectedUserRevision: 0, expectedControlRevision: 0 });
    assert.equal(receipt.status, 'pending');
    const current = await app.inject({ url: `/api/bridge/browser/current?sessionId=${browser.sessionId}`, headers }); assert.equal(current.statusCode, 200, current.body);
    const command = current.json<{ command: ControlCommand }>().command; assert.ok(command);
    assert.equal(command.resolved.snapshot.indexSnapshotId, snapshot.indexSnapshotId);
    assert.ok(command.resolved.codeGraph!.nodes.some(item => item.id === node.ref.id));
    const ack = await app.inject({ method: 'POST', url: '/api/bridge/browser/ack', headers, payload: { sessionId: browser.sessionId, csrf: browser.csrf, commandId: receipt.commandId, status: 'presented', userRevision: 0, controlRevision: 1, actual: { scopeId: snapshot.scopeId, indexSnapshotId: snapshot.indexSnapshotId, focusNodeId: node.ref, visibleNodeIds: command.resolved.codeGraph!.nodes.map(item => item.id), visibleEdgeIds: command.resolved.codeGraph!.edges.map(item => item.id) } } }); assert.equal(ack.statusCode, 200, ack.body);
    assert.equal((await call('get_presentation_status', { commandId: receipt.commandId })).status, 'presented');
    const unknown = await client.callTool({ name: 'get_node_details', arguments: { snapshotId: snapshot.snapshotId, ref: { layer: 'code', id: 'invented-id' } } }); assert.equal(unknown.isError, true);
    const runtime = manager.scope(snapshot.scopeId); runtime.index = { ...runtime.index!, metadata: { ...runtime.index!.metadata, revision: 'new-index' } };
    const stale = await client.callTool({ name: 'get_source_evidence', arguments: { snapshotId: snapshot.snapshotId, evidenceId } }); assert.equal(stale.isError, true); assert.match(JSON.stringify(stale), /STALE|过期|变化/);
    assert.equal(diagnostics, '', 'stdout/stderr must stay free from unexpected startup diagnostics');
  } finally {
    await client.close().catch(() => {}); await transport.close().catch(() => {}); await app.close();
    assert.ok(directory.startsWith(path.join(TOOL_ROOT, '.tmp', 'mcp-stdio-'))); await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

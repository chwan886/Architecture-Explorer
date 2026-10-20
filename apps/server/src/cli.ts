import { IndexManager, loadConfig } from '../../../packages/indexer/src/index.ts';

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name); if (index < 0) return undefined;
  const value = args[index + 1]; if (!value || value.startsWith('--')) throw new Error(`${name} 缺少值`);
  return value;
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!['scan', 'watch', 'verify'].includes(command)) throw new Error('用法：scan|watch|verify [--project id] [--worktree primary] [--full] [--config path]');
  const config = await loadConfig(option(args, '--config'));
  const manager = new IndexManager(config); await manager.initialize();
  const projectId = option(args, '--project') ?? config.projects[0].id;
  const worktreeId = option(args, '--worktree') ?? 'primary'; const scopeId = `${projectId}:${worktreeId}`;
  manager.scope(scopeId);
  manager.on('status', status => { if (status.scopeId === scopeId) console.log(JSON.stringify(status)); });
  if (command === 'verify') {
    try { const result = await manager.verify(scopeId); console.log(JSON.stringify(result)); if (!result.valid) process.exitCode = 1; }
    finally { await manager.close(); }
    return;
  }
  if (command === 'watch') {
    await manager.startWatching(scopeId);
    const close = () => { void manager.close().then(() => process.exit(0)); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
    await manager.requestScan(scopeId);
    return;
  }
  try {
    await manager.requestScan(scopeId, args.includes('--full'));
    const runtime = manager.scope(scopeId);
    if (runtime.status.state === 'failed') throw new Error(runtime.status.message);
    console.log(JSON.stringify({ metadata: runtime.index?.metadata, counts: { nodes: runtime.index?.nodes.length, edges: runtime.index?.edges.length, evidence: runtime.index?.evidence.length } }));
  } finally { await manager.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

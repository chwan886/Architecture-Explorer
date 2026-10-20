import { IndexManager, loadConfig } from '../../../packages/indexer/src/index.ts';
import { createServer } from './server.ts';

async function main() {
  const config = await loadConfig();
  const manager = new IndexManager(config); await manager.initialize();
  const app = await createServer(manager);
  await app.listen({ host: '127.0.0.1', port: config.port ?? 4310 });
  console.log(`Architecture Explorer API：http://127.0.0.1:${config.port ?? 4310}（目标项目只读）`);
  const close = () => { void app.close().then(() => process.exit(0)); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  for (const scope of manager.scopes.values()) {
    await manager.startWatching(scope.id);
    void manager.requestScan(scope.id);
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

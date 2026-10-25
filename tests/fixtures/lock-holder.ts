import { readFile } from 'node:fs/promises';
import { BridgeFiles } from '../../apps/server/src/bridge-auth.ts';
import { ArchitectureService } from '../../apps/server/src/architecture.ts';
import { SemanticStore } from '../../apps/server/src/semantic-store.ts';
import { withFileLock } from '../../packages/indexer/src/file-lock.ts';
import type { LoadedConfig } from '../../packages/indexer/src/config.ts';
import { IndexManager, type ScopeRuntime } from '../../packages/indexer/src/indexer.ts';

const [kind, configPath] = process.argv.slice(2);
const config: LoadedConfig = JSON.parse(await readFile(configPath, 'utf8'));
const hold = () => {
  process.send?.('locked');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
if (kind === 'runtime') await new BridgeFiles(config).publication(async () => hold());
else if (kind === 'model') {
  const service = new ArchitectureService({ config, emit() {} } as unknown as IndexManager);
  const current = await service.model('fixture');
  await service.save({ project: config.projects[0], id: 'fixture:primary' } as ScopeRuntime, current.modelRevision, model => { hold(); return model; });
} else if (kind === 'semantic') {
  const store = new SemanticStore(config), current = await store.read('fixture', 'fixture:primary');
  await store.save('fixture', 'fixture:primary', current.overlayRevision, overlay => { hold(); return overlay; });
} else if (kind === 'scan') {
  const manager = new IndexManager(config, { worker: async () => ({ nodes: [], edges: [], evidence: [], diagnostics: [] }) });
  await manager.initialize();
  manager.on('status', status => { if (status.message === '读取文件哈希并核对 Git 状态') hold(); });
  await manager.requestScan('fixture:primary');
} else if (kind === 'file') {
  await withFileLock({ toolRoot: config.toolRoot, lockPath: process.argv[4], locked: () => new Error('Fixture lock is held') }, async () => hold());
} else throw new Error('Unknown lock fixture');

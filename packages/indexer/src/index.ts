export { loadConfig, TOOL_ROOT, type LoadedConfig } from './config.ts';
export { IndexManager, type ManagerOptions } from './indexer.ts';
export { graph, search, nodeDetail, type GraphOptions } from './graph.ts';
export { AccessError, authorizedFile, readAuthorized, createFilePolicy, isWithin } from './security.ts';
export { discoverWorktrees, gitState } from './git.ts';

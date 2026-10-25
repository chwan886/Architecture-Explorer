import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../indexer/src/config.ts';
import { seedSemanticDefinitions } from './src/import.ts';

export const seedUsage = 'Usage: pnpm seed-semantics --project ID [--config FILE] [--worktree ID] [--content-pack DIRECTORY] [--dry-run]';
export function parseSeedArguments(args: string[]) {
  const result: { projectId?: string; configFile?: string; worktreeId?: string; contentPackDirectory?: string; dryRun?: boolean; help?: boolean } = {};
  const names = new Map([['--project', 'projectId'], ['--config', 'configFile'], ['--worktree', 'worktreeId'], ['--content-pack', 'contentPackDirectory']] as const);
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error(`Duplicate argument: ${arg}`);
    seen.add(arg);
    if (arg === '--help') { result.help = true; continue; }
    if (arg === '--dry-run') { result.dryRun = true; continue; }
    const key = names.get(arg as '--project');
    if (!key || !args[i + 1]?.trim() || args[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete argument: ${arg}`);
    result[key] = args[++i];
  }
  if (!result.help && !result.projectId) throw new Error('An explicit --project ID is required');
  return result;
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const parsed = parseSeedArguments(args);
  if (parsed.help) { console.log(seedUsage); return; }
  const config = await loadConfig(parsed.configFile);
  const result = await seedSemanticDefinitions(config, parsed.projectId!, parsed);
  console.log(JSON.stringify({ projectId: result.projectId, scopeId: result.scopeId, written: result.written, reason: result.reason,
    outputPath: result.outputPath, flows: result.definitions.flows.map(flow => ({ id: flow.id, groups: flow.groups.length, steps: flow.steps.length, bindings: flow.steps.flatMap(step => step.bindings).length })) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); console.error(seedUsage); process.exitCode = 1; });
}

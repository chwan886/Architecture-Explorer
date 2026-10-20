import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../../../packages/indexer/src/config.ts';
import { BridgeClient } from './client.ts';
import { ExplorerTools, MCP_INSTRUCTIONS } from './tools.ts';

async function main() {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--config' && args[1])) throw new Error('仅支持固定启动参数 --config <Architecture Explorer 配置>');
  const config = await loadConfig(args[1]);
  const tools = new ExplorerTools(new BridgeClient(config));
  const server = new Server({ name: 'architecture-explorer', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.definitions }));
  server.setRequestHandler(CallToolRequestSchema, async request => tools.call(request.params.name, request.params.arguments ?? {}));
  const close = () => { void server.close().finally(() => { process.exitCode = 0; }); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  await server.connect(new StdioServerTransport());
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Architecture Explorer MCP 启动失败'); process.exitCode = 1; });

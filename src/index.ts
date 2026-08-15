// IMPORTANT: stdout is reserved for MCP JSON-RPC framing.
// All diagnostics MUST go to stderr (use logger from ./logger.ts).
// Never use console.log anywhere reachable from this entry point.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { attachShutdownHandlers } from './browser.ts';
import { logger } from './logger.ts';
import { errResult, tools } from './tools/registry.ts';

async function main(): Promise<void> {
  const server = new McpServer(
    { name: 'browser-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  for (const def of tools) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: def.inputShape,
      },
      (async (args: unknown) => {
        try {
          const result = await def.handler((args ?? {}) as never);
          return result as unknown as never;
        } catch (err) {
          logger.error(`tool ${def.name} threw`, String(err));
          return errResult(err) as unknown as never;
        }
      }) as never,
    );
  }

  attachShutdownHandlers();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`browser-mcp ready (${tools.length} tools)`);
}

main().catch((err: unknown) => {
  logger.error('fatal', String(err));
  process.exit(1);
});

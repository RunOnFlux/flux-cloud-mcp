#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `flux-cloud-mcp ready (api ${config.apiUrl}, keys ${config.ownerWif && config.payerWif ? 'configured' : 'missing'})\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`flux-cloud-mcp failed to start: ${(error as Error).message}\n`);
  process.exit(1);
});

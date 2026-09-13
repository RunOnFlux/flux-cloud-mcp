#!/usr/bin/env node
/**
 * Inspect a deployed app through the MCP server: spec summary, components
 * (decrypted for private apps when the owner key is set), reachability, and
 * the last log lines of one component.
 *
 *   FLUX_ID_PRIVATE_KEY=<wif> node scripts/inspect.mjs <app> [component] [lines]
 *
 * The key is read from the environment only and never printed.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [name, component, linesArg] = process.argv.slice(2);
if (!name) {
  console.error('usage: node scripts/inspect.mjs <app> [component] [lines]');
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
if (process.env.FLUX_ID_PRIVATE_KEY) env.FLUX_ID_PRIVATE_KEY = process.env.FLUX_ID_PRIVATE_KEY;

const client = new Client({ name: 'flux-cloud-mcp-inspect', version: '0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'dist/index.js')],
    env,
    stderr: 'pipe',
  }),
);
const call = async (tool, args) => {
  const result = await client.callTool({ name: tool, arguments: args }, undefined, {
    timeout: 5 * 60 * 1000,
  });
  return JSON.parse(result.content[0].text);
};

const app = await call('flux_get_app', { name });
if (!app.found) {
  console.log(app.message);
} else {
  console.log(
    `${app.summary.name}: ${app.instances.running}/${app.instances.wanted} instances, ${app.daysLeft} days left, private=${app.summary.private}`,
  );
  console.log(
    `components (${app.components.source}): ${app.components.names.join(', ') || '(none)'}${app.components.note ? ` - ${app.components.note}` : ''}`,
  );
  for (const c of app.summary.components)
    console.log(
      `  ${c.name}: ${c.image} ${c.cpu}cpu/${c.ramMb}MB/${c.hddGb}GB ports ${c.ports.join(',')} -> ${c.containerPorts.join(',')}`,
    );
  for (const f of app.reachability.findings) console.log(`  - ${f}`);
  const logs = await call('flux_get_app_logs', { name, component, lines: Number(linesArg ?? 20) });
  if (logs.error) console.log(`logs: ${logs.error}`);
  else {
    console.log(`logs from ${logs.node} (${logs.container}):`);
    console.log(typeof logs.logs === 'string' ? logs.logs : JSON.stringify(logs.logs, null, 2));
  }
}
await client.close();

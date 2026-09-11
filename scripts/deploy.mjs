#!/usr/bin/env node
/**
 * Deploy (register or update) a Flux app specification through the MCP
 * server itself, from the command line.
 *
 *   FLUX_ID_PRIVATE_KEY=<wif> FLUX_PAYMENT_PRIVATE_KEY=<wif> \
 *     node scripts/deploy.mjs deploy/cloudmcp.json [--confirm] [--wait]
 *
 * Without --confirm it prints the plan (price, balance, warnings) and spends
 * nothing. With --wait it polls until the app is accepted and running.
 * Keys are read from the environment only and are never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const args = process.argv.slice(2);
const specPath = args.find((a) => !a.startsWith('--'));
const confirm = args.includes('--confirm');
const wait = args.includes('--wait');
if (!specPath) {
  console.error('usage: node scripts/deploy.mjs <spec.json> [--confirm] [--wait]');
  process.exit(1);
}
for (const name of ['FLUX_ID_PRIVATE_KEY', 'FLUX_PAYMENT_PRIVATE_KEY']) {
  if (!process.env[name]) {
    console.error(`${name} is not set`);
    process.exit(1);
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'dist/index.js')],
  env: {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    FLUX_ID_PRIVATE_KEY: process.env.FLUX_ID_PRIVATE_KEY,
    FLUX_PAYMENT_PRIVATE_KEY: process.env.FLUX_PAYMENT_PRIVATE_KEY,
  },
  stderr: 'pipe',
});
const client = new Client({ name: 'flux-cloud-mcp-deploy', version: '0' });
await client.connect(transport);

const call = async (name, toolArgs = {}) => {
  const result = await client.callTool({ name, arguments: toolArgs });
  return JSON.parse(result.content[0].text);
};

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const identity = await call('flux_get_identity');
console.log(
  `owner ${identity.fluxId}  payer ${identity.paymentAddress}  balance ${identity.balance?.spendableFlux ?? '?'} FLUX`,
);
if (spec.owner && spec.owner !== identity.fluxId) {
  throw new Error(
    `spec owner ${spec.owner} does not match the configured key's Flux ID ${identity.fluxId}`,
  );
}

const result = await call('flux_deploy_app', { spec, confirm });
const { log, ...summary } = result;
console.log(JSON.stringify(summary, null, 2));
if (log?.length) console.log(`log: ${log.join(' | ')}`);
if (result.error) process.exitCode = 1;

if (confirm && wait && result.executed) {
  const previousHash = result.previous?.hash;
  for (;;) {
    const status = await call('flux_wait_for_app', {
      name: result.result.name,
      txid: result.result.txid,
      previousHash,
      timeoutSeconds: 300,
    });
    console.log(
      `confirmations ${status.paymentConfirmations}  accepted ${status.accepted ? 'yes' : 'no'}  instances ${status.instances.running}/${status.instances.wanted}`,
    );
    if (status.done) {
      console.log(JSON.stringify(status.urls, null, 2));
      break;
    }
  }
}
await client.close();

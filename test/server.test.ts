import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

const SPENDING_OR_CHANGING = ['flux_deploy_app', 'flux_control_app', 'flux_cancel_app'];

async function listTools(hosted: boolean) {
  const server = createServer(loadConfig({}), { hosted });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

for (const hosted of [false, true]) {
  test(`every tool says whether it is read-only or changes apps (${hosted ? 'hosted' : 'local'})`, async () => {
    const tools = await listTools(hosted);
    assert.equal(tools.length, 15);
    for (const tool of tools) {
      const changes = SPENDING_OR_CHANGING.includes(tool.name);
      assert.equal(tool.annotations?.readOnlyHint, !changes, tool.name);
      if (changes) assert.equal(tool.annotations?.destructiveHint, true, tool.name);
    }
  });
}

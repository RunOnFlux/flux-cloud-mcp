#!/usr/bin/env node
/**
 * Hosted entry point: the same server over Streamable HTTP, stateless.
 *
 * Every POST /mcp gets a fresh server and transport, so any instance behind a
 * load balancer can answer any request and nothing lives between calls. The
 * process holds no keys; tools that need them take them as arguments.
 *
 * Responses stream as SSE with a 10 s keepalive, which keeps Flux's domain
 * gateway (25 s inactivity timeout) from cutting long tool calls.
 */

import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config.js';
import { createServer, SERVER_VERSION } from './server.js';

const config = loadConfig();
const port = Number(process.env.PORT ?? 3000);

const LANDING = `Flux Cloud MCP server ${SERVER_VERSION}

MCP endpoint: POST /mcp (Streamable HTTP, stateless)
Health:       GET  /healthz

Add it to your MCP host as a remote server with the URL <this host>/mcp.
Read-only tools need no keys. To deploy, the agent creates a dedicated key
pair with flux_generate_keys and you fund its payment address.

Source and local (stdio) version: https://github.com/RunOnFlux/flux-cloud-mcp
`;

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
  );
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    json(res, 405, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: this server is stateless, use POST' },
      id: null,
    });
    return;
  }
  const server = createServer(config, { hosted: true });
  // No sessionIdGenerator: stateless mode.
  const transport = new StreamableHTTPServerTransport({ keepAliveMs: 10000 });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

const httpServer = createHttpServer((req, res) => {
  cors(res);
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname === '/mcp') {
    handleMcp(req, res).catch((error: unknown) => {
      process.stderr.write(`mcp request failed: ${(error as Error).message}\n`);
      if (!res.headersSent) {
        json(res, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    });
    return;
  }
  if (url.pathname === '/healthz') {
    json(res, 200, { status: 'ok', version: SERVER_VERSION });
    return;
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(LANDING);
    return;
  }
  res.writeHead(404);
  res.end();
});

httpServer.listen(port, () => {
  process.stderr.write(`flux-cloud-mcp http listening on :${port} (hosted mode, no keys held)\n`);
});

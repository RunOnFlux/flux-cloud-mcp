/**
 * The Flux Cloud MCP server: tools, resources and prompts.
 *
 * Every price shown to an agent is the Flux Cloud USD price. The consensus
 * minimum is never surfaced as a quote.
 */

import { createConnection } from 'node:net';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from './config.js';
import { toFlux } from './chain.js';
import {
  api,
  appLocations,
  execute,
  explorer,
  plan,
  publishedSpec,
  waitForApp,
  walletFromConfig,
  type EnterpriseInput,
} from './deploy.js';
import { GOTCHAS, OVERVIEW, PRICING, SPEC_FORMAT } from './docs.js';
import { FluxClient, instanceEndpoint } from './fluxapi.js';
import { currentSession, generateIdentity, identityFromWif } from './keys.js';
import {
  DEFAULT_USD_RATES,
  estimateQuote,
  fetchFluxUsdRate,
  fetchUsdRates,
  quoteFromNetwork,
} from './pricing.js';
import {
  BLOCKS_PER_MONTH,
  buildSpecification,
  componentsOf,
  durabilityWarnings,
  expireOf,
  formatSpecification,
  normalizePublished,
  validateSpecification,
  type AppComponent,
  type AppSpec,
  type PublishedAppSpec,
} from './spec.js';

export const SERVER_NAME = 'flux-cloud';
export const SERVER_VERSION = '0.2.5';

// ---------------------------------------------------------------------------
// Schemas shared by several tools
// ---------------------------------------------------------------------------

const ComponentSchema = z.object({
  name: z.string().max(63).optional().describe('Component name. Defaults to the app name.'),
  description: z.string().max(256).optional(),
  repotag: z.string().describe('Docker image with an explicit tag, e.g. "nginx:1.27-alpine".'),
  ports: z.array(z.number().int()).default([]).describe('Public ports. Prefer 31000-39999.'),
  containerPorts: z
    .array(z.number().int())
    .default([])
    .describe('Ports the container listens on, parallel to ports.'),
  domains: z
    .array(z.string())
    .default([])
    .describe('Custom domain per port, "" for none. Parallel to ports.'),
  environmentParameters: z.array(z.string()).default([]).describe('"KEY=value" strings, max 20.'),
  commands: z.array(z.string()).default([]).describe('Container Cmd, max 20 strings.'),
  containerData: z
    .string()
    .describe('Persisted path, e.g. "r:/data" (r: = replicated across instances).'),
  cpu: z.number().describe('Cores, 0.1 to 15 in 0.1 steps.'),
  ram: z.number().int().describe('MB, 100 to 59000 in steps of 100.'),
  hdd: z.number().int().describe('GB, 1 to 820.'),
  repoauth: z.string().default('').describe('"user:token" for a private registry, else "".'),
});

const SpecSchema = z.object({
  version: z.literal(8).default(8),
  name: z.string().min(1).max(63),
  description: z.string().min(1).max(256),
  owner: z
    .string()
    .optional()
    .describe('Flux ID. Defaults to the configured FLUX_ID_PRIVATE_KEY identity.'),
  compose: z.array(ComponentSchema).min(0).max(10),
  instances: z.number().int().min(1).max(100).default(3),
  contacts: z.array(z.string()).default([]),
  geolocation: z
    .array(z.string())
    .default([])
    .describe('e.g. ["acEU"] allow Europe, ["a!cAS"] deny Asia.'),
  expire: z
    .number()
    .int()
    .min(1)
    .max(1056000)
    .default(BLOCKS_PER_MONTH)
    .describe('Term in blocks; 88000 = 1 month.'),
  nodes: z.array(z.string()).default([]),
  staticip: z.boolean().default(false),
  enterprise: z.string().default(''),
});

const SimpleComponentSchema = z.object({
  name: z.string().max(63).optional(),
  description: z.string().max(256).optional(),
  image: z.string().describe('Docker image with an explicit tag.'),
  ports: z
    .array(
      z.object({
        containerPort: z.number().int().min(1).max(65535),
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe('Public port; auto-picked from 31000-39999 when omitted.'),
        domain: z.string().optional(),
      }),
    )
    .optional(),
  env: z.union([z.record(z.string(), z.string()), z.array(z.string())]).optional(),
  commands: z.array(z.string()).optional(),
  dataPath: z
    .string()
    .optional()
    .describe('Path inside the container to persist. Default "/data".'),
  replicateData: z
    .boolean()
    .optional()
    .describe('Replicate the data path across instances. Default true.'),
  cpu: z.number().describe('Cores, 0.1 to 15 in 0.1 steps.'),
  ram: z.number().int().describe('MB, multiple of 100.'),
  hdd: z.number().int().describe('GB.'),
  repoauth: z.string().optional(),
});

const SimpleAppSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(63)
    .describe(
      'Unique app name: letters, digits, inner hyphens. Not starting with "flux" or "zel".',
    ),
  description: z.string().max(256).optional(),
  components: z.array(SimpleComponentSchema).min(1).max(10),
  instances: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Copies on distinct nodes. Default 3.'),
  months: z
    .number()
    .positive()
    .max(12)
    .optional()
    .describe('Term in network months (88000 blocks each). Default 1.'),
  expireBlocks: z
    .number()
    .int()
    .min(1)
    .max(1056000)
    .optional()
    .describe('Exact term in blocks; overrides months.'),
  contacts: z.array(z.string()).max(5).optional(),
  geolocation: z.array(z.string()).max(10).optional(),
  nodes: z.array(z.string()).optional(),
  staticip: z.boolean().optional(),
});

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

function ownerOf(config: Config, explicit?: string | undefined): string {
  if (explicit) return explicit;
  if (!config.ownerWif) {
    throw new Error('No owner: set FLUX_ID_PRIVATE_KEY or pass an explicit owner.');
  }
  return identityFromWif(config.ownerWif).zelid;
}

function requireOwnerWif(config: Config): string {
  if (!config.ownerWif)
    throw new Error('FLUX_ID_PRIVATE_KEY is not configured; this action needs the app owner key.');
  return config.ownerWif;
}

function summarizeSpec(spec: AppSpec | PublishedAppSpec) {
  const expire = expireOf(spec);
  return {
    name: spec.name,
    owner: spec.owner,
    instances: spec.instances,
    termBlocks: expire,
    termMonths: Number((expire / BLOCKS_PER_MONTH).toFixed(2)),
    components: componentsOf(spec).map((c) => ({
      name: c.name,
      image: c.repotag,
      cpu: c.cpu,
      ramMb: c.ram,
      hddGb: c.hdd,
      ports: c.ports,
      containerPorts: c.containerPorts,
    })),
    private: Boolean(spec.enterprise),
  };
}

function describeQuote(q: {
  usd: number;
  flux: number;
  fluxDiscountPercent: number | string;
  months: number;
  usdPerMonth: number;
  fluxUsdRate: number | null;
  source: string;
}) {
  return {
    priceUsd: q.usd,
    priceUsdPerMonth: q.usdPerMonth,
    termMonths: q.months,
    payFlux: q.flux,
    payInFluxDiscountPercent: q.fluxDiscountPercent,
    fluxUsdRate: q.fluxUsdRate,
    source: q.source,
    note: 'Prices are Flux Cloud USD prices converted to FLUX at market rate.',
  };
}

function urlsFor(spec: PublishedAppSpec | AppSpec, locations: Array<{ ip: string }>) {
  const lower = spec.name.toLowerCase();
  const components = componentsOf(spec);
  const shared = [`https://${lower}.app.runonflux.io`];
  for (const c of components)
    for (const p of c.ports) shared.push(`https://${lower}_${p}.app.runonflux.io`);
  const direct = locations.flatMap((l) => {
    const host = l.ip.split(':')[0];
    return components.flatMap((c) => c.ports.map((p) => `http://${host}:${p}`));
  });
  return { shared, direct };
}

/** HTTP probe with a short timeout; never throws. */
async function probeHttp(
  url: string,
  timeoutMs = 6000,
): Promise<{ status: number | null; error: string | null }> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: null, error: /abort|timeout/i.test(message) ? 'timeout' : 'no http response' };
  }
}

/** Raw TCP connect, which is exactly what the domain gateway's health check does. */
function probeTcp(host: string, port: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

interface DirectProbe {
  host: string;
  port: number;
  tcp: boolean;
  http: number | null;
}

/**
 * What the probes mean, stated carefully: the shared *.app.runonflux.io
 * domain only serves HTTP over TCP, and answers 503 when no instance accepts a
 * TCP connection on the app port. That is a fault only if the app is meant to
 * be a web service on that port; a UDP game server, a worker with no
 * listener, or a service on another port is healthy and still shows 503.
 */
async function reachability(
  spec: PublishedAppSpec | AppSpec,
  locations: Array<{ ip: string }>,
  explicitPorts?: number[],
) {
  const lower = spec.name.toLowerCase();
  const ports =
    explicitPorts && explicitPorts.length
      ? explicitPorts
      : componentsOf(spec).flatMap((c) => c.ports);
  const hosts = locations.map((l) => l.ip.split(':')[0] ?? l.ip);
  const domainUrl = `https://${lower}.app.runonflux.io/`;
  const [domain, direct] = await Promise.all([
    probeHttp(domainUrl),
    Promise.all(
      hosts.flatMap((host) =>
        ports.map(async (port): Promise<DirectProbe> => {
          const [tcp, http] = await Promise.all([
            probeTcp(host, port),
            probeHttp(`http://${host}:${port}/`),
          ]);
          return { host, port, tcp, http: http.status };
        }),
      ),
    ),
  ]);
  const tcpOk = direct.filter((d) => d.tcp).length;
  const httpOk = direct.filter((d) => d.http !== null).length;
  const findings: string[] = [];
  const isPrivate = Boolean(spec.enterprise) && !(explicitPorts && explicitPorts.length);

  if (domain.status === 503) {
    findings.push(
      'Shared domain answers 503: the domain gateway found no instance accepting TCP connections on the app port. The gateway only serves HTTP over TCP, so this is a fault only if the app is meant to be a web service on that port.',
    );
  } else if (domain.status === null && tcpOk > 0 && httpOk === 0) {
    findings.push(
      'Shared domain connects but the service behind it is not HTTP, so browsers cannot use it; clients should use ip:port.',
    );
  } else if (domain.status === null) {
    findings.push(
      `Shared domain did not answer (${domain.error}). A newly accepted app gets its domain within a few minutes.`,
    );
  } else {
    findings.push(`Shared domain answers HTTP ${domain.status}.`);
  }

  if (isPrivate) {
    findings.push(
      'Private (enterprise) app: its ports are encrypted, so pass `ports` to probe the instances directly.',
    );
  } else if (!ports.length) {
    findings.push('The app exposes no ports, so it is not reachable from outside by design.');
  } else if (!hosts.length) {
    findings.push('No running instance to probe yet.');
  } else if (tcpOk === 0) {
    findings.push(
      `Nothing accepts TCP connections on port(s) ${ports.join(', ')} on any of ${hosts.length} instance(s). If the app should serve on that port: check the process listens on containerPort and binds 0.0.0.0 (not 127.0.0.1); flux_get_app_logs shows what it bound. If the app is UDP-only or has no listener, this is expected.`,
    );
  } else if (httpOk === 0) {
    findings.push(
      `Instances accept TCP on port(s) ${ports.join(', ')} but do not speak HTTP there. The app is up; use ip:port directly, the shared domain cannot serve non-HTTP protocols.`,
    );
  } else {
    findings.push(
      `${httpOk}/${direct.length} direct probes answered HTTP; the app serves HTTP on its port.`,
    );
  }
  return {
    domain: { url: domainUrl, status: domain.status, error: domain.error },
    direct,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface ServerOptions {
  /**
   * Hosted mode: the server holds no keys. Tools that need them take
   * `fluxIdPrivateKey` and `paymentPrivateKey` as call arguments, used in
   * memory for that call only and never logged or stored.
   */
  hosted?: boolean;
}

const KeysShape = {
  fluxIdPrivateKey: z
    .string()
    .optional()
    .describe(
      'WIF private key of the Flux ID that owns the app. Use a dedicated key from flux_generate_keys, never a main wallet key.',
    ),
  paymentPrivateKey: z
    .string()
    .optional()
    .describe(
      'WIF private key of the Flux address that pays. Fund it with only what you intend to spend.',
    ),
};

type KeyArgs = { fluxIdPrivateKey?: string | undefined; paymentPrivateKey?: string | undefined };

function withKeys(base: Config, args: KeyArgs): Config {
  return {
    ...base,
    ownerWif: args.fluxIdPrivateKey?.trim() || base.ownerWif,
    payerWif: args.paymentPrivateKey?.trim() || base.payerWif,
  };
}

const LOCAL_INSTRUCTIONS =
  'Deploy and manage apps on Flux Cloud, the decentralized cloud. Read the flux://guide/overview resource first. ' +
  'All prices are Flux Cloud USD prices (converted to FLUX for payment). Always show the user the USD quote from ' +
  'flux_quote_app and get their agreement before calling flux_deploy_app with confirm=true, which spends FLUX.';

const HOSTED_INSTRUCTIONS =
  LOCAL_INSTRUCTIONS +
  ' This is the hosted server: it stores no keys. Read-only tools need none. Tools that sign or pay take ' +
  'fluxIdPrivateKey and paymentPrivateKey as arguments, used only for that call. NEVER ask the user for the keys of ' +
  'a wallet they use elsewhere: call flux_generate_keys to create a dedicated pair, tell the user to fund the payment ' +
  'address with only the amount needed, and reuse that pair in later calls. Remind the user to save the keys.';

export function createServer(baseConfig: Config, options: ServerOptions = {}): McpServer {
  const hosted = options.hosted === true;
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: hosted ? HOSTED_INSTRUCTIONS : LOCAL_INSTRUCTIONS },
  );

  /**
   * Register a tool whose handler receives the effective config: in hosted
   * mode the call's own keys (if any) layered over the base config.
   */
  function tool<S extends z.ZodRawShape>(
    name: string,
    meta: { title: string; description: string; inputSchema: S },
    handler: (args: z.infer<z.ZodObject<S>>, config: Config) => Promise<ToolResult>,
  ): void {
    const inputSchema = (hosted ? { ...meta.inputSchema, ...KeysShape } : meta.inputSchema) as S;
    const callback = (async (args: unknown) => {
      const typed = args as z.infer<z.ZodObject<S>> & KeyArgs;
      return handler(typed, withKeys(baseConfig, typed));
    }) as ToolCallback<S>;
    server.registerTool(name, { ...meta, inputSchema }, callback);
  }

  // ----- resources --------------------------------------------------------

  const guides: Array<[string, string, string, string]> = [
    [
      'overview',
      'Flux Cloud overview for agents',
      'How identity, deployment, pricing and reachability work.',
      OVERVIEW,
    ],
    [
      'spec-format',
      'Flux v8 app specification',
      'Field-by-field reference for the app specification.',
      SPEC_FORMAT,
    ],
    [
      'pricing',
      'Flux Cloud pricing',
      'The USD rate card, discounts and how FLUX amounts are derived.',
      PRICING,
    ],
    [
      'gotchas',
      'Flux Cloud gotchas',
      'Failure modes that are easy to hit and how this server avoids them.',
      GOTCHAS,
    ],
  ];
  for (const [slug, title, description, text] of guides) {
    server.registerResource(
      `guide-${slug}`,
      `flux://guide/${slug}`,
      { title, description, mimeType: 'text/markdown' },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] }),
    );
  }

  // ----- prompts ----------------------------------------------------------

  server.registerPrompt(
    'deploy_on_flux',
    {
      title: 'Deploy an app on Flux Cloud',
      description: 'Walks through describing, pricing, confirming and deploying an app.',
      argsSchema: { app: z.string().describe('What to deploy, in plain words.') },
    },
    ({ app }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `I want to deploy this on Flux Cloud: ${app}\n\n` +
              'Steps: 1) call flux_get_identity to confirm keys and balance; 2) call flux_build_spec with sensible ' +
              'resources and validate it with flux_validate_spec; 3) call flux_quote_app and show me the USD price and ' +
              'the FLUX to pay; 4) only after I agree, call flux_deploy_app with confirm=true; 5) call flux_wait_for_app ' +
              'and give me the URLs. If the payment address is underfunded, tell me the address and how much to send.',
          },
        },
      ],
    }),
  );

  /**
   * FluxOS names the container of a compose app `<component>_<app>`; legacy
   * single-container apps are just `<app>`. Pick a running node when none is given.
   */
  async function resolveContainer(
    name: string,
    component: string | undefined,
    nodeIp: string | undefined,
  ): Promise<{ target: string; container: string }> {
    const lb = api(baseConfig);
    const [spec, locations] = await Promise.all([publishedSpec(lb, name), appLocations(lb, name)]);
    if (!spec) throw new Error(`${name} is not registered on the network.`);
    const target = nodeIp ?? locations[0]?.ip;
    if (!target) throw new Error(`${name} has no running instance.`);
    const components = componentsOf(spec);
    let container = name;
    if (Array.isArray(spec.compose)) {
      const chosen = component ?? (components.length === 1 ? components[0]?.name : undefined);
      if (!chosen) {
        throw new Error(
          `${name} has ${components.length} components; pass component (one of ${components.map((c) => c.name).join(', ')}).`,
        );
      }
      container = `${chosen}_${name}`;
    }
    return { target, container };
  }

  // ----- identity ---------------------------------------------------------

  tool(
    'flux_get_identity',
    {
      title: 'Show the configured Flux identity and balance',
      description:
        'Returns the Flux ID (app owner address), the payment address and its spendable FLUX balance with its USD value. ' +
        'Explains what to configure if keys are missing. Never returns private keys.',
      inputSchema: {},
    },
    async (_args, config) => {
      try {
        const owner = config.ownerWif ? identityFromWif(config.ownerWif) : undefined;
        const payer = config.payerWif ? identityFromWif(config.payerWif) : undefined;
        let balance:
          { totalFlux: number; spendableFlux: number; spendableUsd: number | null } | undefined;
        let rate: number | null = null;
        if (payer) {
          const [bal, r] = await Promise.all([
            explorer(config).balance(payer.fluxAddress),
            fetchFluxUsdRate(config.ratesUrl).catch(() => null),
          ]);
          rate = r;
          balance = {
            totalFlux: toFlux(bal.total),
            spendableFlux: toFlux(bal.spendable),
            spendableUsd: r === null ? null : Number((toFlux(bal.spendable) * r).toFixed(2)),
          };
        }
        return ok({
          fluxId: owner?.zelid ?? null,
          paymentAddress: payer?.fluxAddress ?? null,
          balance: balance ?? null,
          fluxUsdRate: rate,
          configured: { ownerKey: Boolean(owner), paymentKey: Boolean(payer) },
          ...(owner && payer
            ? {}
            : {
                setup: hosted
                  ? 'No keys were passed. Run flux_generate_keys once, then pass fluxIdPrivateKey and paymentPrivateKey to tools that need them.'
                  : 'Set FLUX_ID_PRIVATE_KEY (owner) and FLUX_PAYMENT_PRIVATE_KEY (payer) in the MCP server environment, or run flux_generate_keys.',
              }),
          ...(payer && balance && balance.spendableFlux === 0
            ? {
                fund: `Send FLUX to ${payer.fluxAddress} before deploying. Exchanges and wallets like SSP, Zelcore and Kucoin support FLUX.`,
              }
            : {}),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  tool(
    'flux_generate_keys',
    {
      title: 'Generate a new Flux ID and payment key pair',
      description:
        'Creates two fresh private keys (WIF): one for the Flux ID that will own apps, one for the address that pays. ' +
        'The response contains the secrets; store them in the MCP server environment as FLUX_ID_PRIVATE_KEY and ' +
        'FLUX_PAYMENT_PRIVATE_KEY, then restart the server. Nothing is stored or sent anywhere by this tool.',
      inputSchema: {},
    },
    async (_args, _config) => {
      const owner = generateIdentity();
      const payer = generateIdentity();
      return ok({
        fluxId: { address: owner.zelid, privateKeyWif: owner.wif },
        payment: { address: payer.fluxAddress, privateKeyWif: payer.wif },
        env: { FLUX_ID_PRIVATE_KEY: owner.wif, FLUX_PAYMENT_PRIVATE_KEY: payer.wif },
        next: hosted
          ? [
              'Show both private keys to the user and tell them to save them; they cannot be recovered.',
              'Pass them as fluxIdPrivateKey and paymentPrivateKey in later tool calls.',
              `The user funds ${payer.fluxAddress} with only the FLUX needed for their deployments.`,
            ]
          : [
              'Save both private keys somewhere safe; they cannot be recovered.',
              'Put the env values into the MCP server configuration and restart it.',
              `Send FLUX to ${payer.fluxAddress} to fund deployments.`,
            ],
      });
    },
  );

  // ----- pricing ----------------------------------------------------------

  tool(
    'flux_get_pricing',
    {
      title: 'Get the Flux Cloud rate card',
      description:
        'Returns the current USD rate card, the live FLUX/USD rate, the pay-in-FLUX discount and instant USD estimates for ' +
        'a few reference sizes. Use flux_quote_app for the exact price of a specific app.',
      inputSchema: {},
    },
    async (_args, config) => {
      try {
        const [rates, fluxUsd] = await Promise.all([
          fetchUsdRates(config.statsUrl),
          fetchFluxUsdRate(config.ratesUrl).catch(() => null),
        ]);
        const owner = '1FluxCloudPricingExample00000000000';
        const sample = (cpu: number, ram: number, hdd: number, instances: number) =>
          buildSpecification({
            name: 'example',
            owner,
            components: [{ image: 'nginx:1.27', cpu, ram, hdd, ports: [{ containerPort: 80 }] }],
            instances,
          });
        const examples = [
          { label: 'tiny: 0.3 cpu, 300 MB, 3 GB, 3 instances', spec: sample(0.3, 300, 3, 3) },
          { label: 'small: 1 cpu, 1000 MB, 10 GB, 3 instances', spec: sample(1, 1000, 10, 3) },
          { label: 'medium: 2 cpu, 4000 MB, 40 GB, 3 instances', spec: sample(2, 4000, 40, 3) },
          { label: 'large: 4 cpu, 8000 MB, 100 GB, 3 instances', spec: sample(4, 8000, 100, 3) },
        ].map(({ label, spec }) => ({
          size: label,
          ...(fluxUsd
            ? describeQuote(estimateQuote(spec, rates, fluxUsd))
            : { priceUsd: estimateQuote(spec, rates, 1).usd }),
        }));
        return ok({
          currency: 'USD',
          perMonth: {
            per01Cpu: rates.cpu,
            per100MbRam: rates.ram,
            perGbSsd: rates.hdd,
            perEnterprisePort: rates.port,
            nodePinningOrPrivateApp: rates.scope,
            staticIp: rates.staticip,
            minimumPerApp: rates.minUSDPrice,
            globalMultiplier: rates.multiplier,
          },
          discounts: {
            payInFluxPercent: Number((100 - rates.fluxmultiplier * 100).toFixed(2)),
            smallApp: '20% when total < 3 cpu, < 6000 MB, < 150 GB and fewer than 4 instances',
            mediumApp: '10% when total < 7 cpu, < 29000 MB, < 370 GB and fewer than 4 instances',
            primaryStandbyStorage: '20% when a component uses g: storage',
            term: '3% at 3+ months, 6% at 6+, 12% at 9+',
          },
          formula:
            'monthly USD = ceil2((cpu*rate*10 + ram*rate/100 + hdd*rate + surcharges) / 3) * instances, min $0.99; FLUX = USD / rate * (1 - discount)',
          fluxUsdRate: fluxUsd,
          blocksPerMonth: BLOCKS_PER_MONTH,
          examples,
          ratesSource: rates === DEFAULT_USD_RATES ? 'bundled' : config.statsUrl,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ----- spec building & validation --------------------------------------

  tool(
    'flux_build_spec',
    {
      title: 'Build a Flux app specification from a simple description',
      description:
        'Turns images, ports, resources and a term into a complete, correctly formatted v8 specification, with public ' +
        'ports auto-picked and data replication enabled. Returns the spec plus local validation errors and warnings.',
      inputSchema: {
        ...SimpleAppSchema.shape,
        owner: z
          .string()
          .optional()
          .describe('Flux ID that will own the app. Defaults to the configured or passed key.'),
      },
    },
    async ({ owner, ...input }, config) => {
      try {
        const spec = buildSpecification({ ...input, owner: ownerOf(config, owner) });
        const errors = validateSpecification(spec);
        return ok({
          spec,
          valid: errors.length === 0,
          errors,
          warnings: durabilityWarnings(spec),
          summary: summarizeSpec(spec),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  tool(
    'flux_validate_spec',
    {
      title: 'Validate a specification locally and on the network',
      description:
        'Runs the local rule checks, then asks a FluxOS node to verify the specification exactly as it would at registration ' +
        '(image reachable, architecture, ports, name availability). Returns the node-formatted spec on success.',
      inputSchema: {
        spec: SpecSchema,
        network: z.boolean().default(true).describe('Also verify on a FluxOS node.'),
      },
    },
    async ({ spec, network }, config) => {
      try {
        const formatted = formatSpecification({ ...spec, owner: ownerOf(config, spec.owner) });
        const errors = validateSpecification(formatted);
        const warnings = durabilityWarnings(formatted);
        if (errors.length || !network)
          return ok({ valid: errors.length === 0, errors, warnings, spec: formatted });
        const existing = await publishedSpec(api(config), formatted.name);
        const action = existing ? 'update' : 'register';
        if (existing && existing.owner !== formatted.owner) {
          return ok({
            valid: false,
            errors: [`name ${formatted.name} is taken by ${existing.owner}`],
            warnings,
            spec: formatted,
          });
        }
        const path = existing
          ? '/apps/verifyappupdatespecifications'
          : '/apps/verifyappregistrationspecifications';
        const nodeFormatted = await api(config).post<AppSpec>(path, formatted, {
          timeoutMs: 120000,
        });
        return ok({
          valid: true,
          action,
          errors: [],
          warnings,
          spec: nodeFormatted,
          summary: summarizeSpec(nodeFormatted),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  tool(
    'flux_quote_app',
    {
      title: 'Quote the price of an app in USD and FLUX',
      description:
        'Returns the Flux Cloud price for registering the given specification, or for updating it if an app of that name ' +
        'already exists (the unused part of the current term is credited). Price is in USD with the FLUX amount at market rate.',
      inputSchema: { spec: SpecSchema },
    },
    async ({ spec }, config) => {
      try {
        const formatted = formatSpecification({ ...spec, owner: ownerOf(config, spec.owner) });
        const errors = validateSpecification(formatted);
        if (errors.length) return ok({ valid: false, errors });
        const [quote, existing] = await Promise.all([
          quoteFromNetwork(api(config), formatted),
          publishedSpec(api(config), formatted.name),
        ]);
        return ok({
          action: existing ? 'update' : 'register',
          ...describeQuote(quote),
          app: summarizeSpec(formatted),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ----- deploy -----------------------------------------------------------

  const EnterpriseSchema = z
    .object({
      compose: z.array(ComponentSchema).min(1).max(10),
      contacts: z.array(z.string()).default([]),
    })
    .optional()
    .describe(
      'Make the app private: these components and contacts are encrypted so only the nodes running the app can read them. ' +
        'When set, spec.compose should be [] and spec.enterprise "".',
    );

  tool(
    'flux_deploy_app',
    {
      title: 'Deploy (register or update) an app and pay for it',
      description:
        'Validates the specification on a node, quotes it, and with confirm=true signs it with the Flux ID, broadcasts ' +
        'it and pays the quoted FLUX from the payment address. Without confirm it only returns the plan (price, balance, ' +
        'warnings) and spends nothing. Registers a new name or updates an existing app of the same owner. Then call ' +
        'flux_wait_for_app with the returned txid.',
      inputSchema: {
        spec: SpecSchema,
        enterprise: EnterpriseSchema,
        confirm: z
          .boolean()
          .default(false)
          .describe('Set true to actually sign, broadcast and pay.'),
      },
    },
    async ({ spec, enterprise, confirm }, config) => {
      const log: string[] = [];
      try {
        const enterpriseInput: EnterpriseInput | undefined = enterprise
          ? {
              compose: enterprise.compose.map((c) => c as AppComponent),
              contacts: enterprise.contacts,
            }
          : undefined;
        const prepared = await plan(
          config,
          { ...spec, owner: ownerOf(config, spec.owner) },
          {
            enterprise: enterpriseInput,
            log: (m) => log.push(m),
          },
        );
        const summary = {
          action: prepared.action,
          app: summarizeSpec(
            enterpriseInput
              ? { ...prepared.spec, compose: enterpriseInput.compose }
              : prepared.formatted,
          ),
          price: describeQuote(prepared.quote),
          payment: {
            payer: prepared.payer,
            balanceFlux: prepared.balanceFlux,
            requiredFlux: prepared.requiredFlux,
            funded: prepared.funded,
            to: prepared.deployment.address,
          },
          warnings: prepared.warnings,
          previous: prepared.previous
            ? {
                hash: prepared.previous.hash,
                height: prepared.previous.height,
                expire: prepared.previous.expire,
              }
            : null,
        };
        if (!confirm) {
          return ok({
            ...summary,
            executed: false,
            next: prepared.funded
              ? 'Call again with confirm=true to deploy.'
              : `Fund ${prepared.payer} with at least ${prepared.requiredFlux} FLUX.`,
          });
        }
        const result = await execute(config, prepared, (m) => log.push(m));
        return ok({
          ...summary,
          executed: true,
          result,
          urls: urlsFor(prepared.formatted, []),
          next: `Call flux_wait_for_app with name "${result.name}" and txid "${result.txid}". Acceptance usually takes 2-10 minutes.`,
          log,
        });
      } catch (error) {
        return {
          ...fail(error),
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: (error as Error).message, log }, null, 2),
            },
          ],
        };
      }
    },
  );

  tool(
    'flux_wait_for_app',
    {
      title: 'Wait for a deployment to be accepted and its instances to run',
      description:
        'Polls the network for up to timeoutSeconds (default 45 to fit hosts with a 60 s tool timeout, max 600). Returns payment confirmations, whether the ' +
        'spec was accepted, and the running instances with URLs. Safe to call repeatedly until done=true.',
      inputSchema: {
        name: z.string(),
        txid: z
          .string()
          .optional()
          .describe('Payment txid from flux_deploy_app, to report confirmations.'),
        previousHash: z
          .string()
          .optional()
          .describe('For updates: the hash of the previous spec, so acceptance means a new hash.'),
        timeoutSeconds: z.number().int().min(10).max(600).default(45),
      },
    },
    async ({ name, txid, previousHash, timeoutSeconds }, config) => {
      try {
        const result = await waitForApp(config, name, {
          txid,
          previousHash,
          timeoutMs: timeoutSeconds * 1000,
        });
        return ok({
          done: result.done,
          timedOut: result.timedOut,
          paymentConfirmations: result.paymentConfirmations,
          accepted: result.accepted
            ? {
                hash: result.accepted.hash,
                height: result.accepted.height,
                expiresAtHeight: result.accepted.height + expireOf(result.accepted),
              }
            : null,
          instances: {
            running: result.instances.length,
            wanted: result.wantedInstances,
            nodes: result.instances.map((l) => l.ip),
          },
          urls: result.accepted ? urlsFor(result.accepted, result.instances) : null,
          next: result.done ? 'Deployed.' : 'Call again to keep waiting.',
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ----- inspect ----------------------------------------------------------

  tool(
    'flux_get_app',
    {
      title: 'Get a deployed app: spec, status, instances, URLs',
      description:
        'Looks up any app on the network by name and returns its published specification, expiry, running instances, URLs ' +
        'and a reachability check: probes the shared domain (HTTP) and each instance port (TCP and HTTP) and explains what a 503 means, including when it is expected for non-web apps.',
      inputSchema: {
        name: z.string(),
        ports: z
          .array(z.number().int())
          .optional()
          .describe(
            'Ports to probe on instances; needed for private apps whose ports are encrypted.',
          ),
      },
    },
    async ({ name, ports }, config) => {
      try {
        const lb = api(config);
        const [spec, locations, info] = await Promise.all([
          publishedSpec(lb, name),
          appLocations(lb, name),
          lb.get<{ blocks: number }>('/daemon/getinfo', { timeoutMs: 20000 }),
        ]);
        if (!spec)
          return ok({ found: false, name, message: `${name} is not registered on the network.` });
        const expiresAt = spec.height + expireOf(spec);
        const blocksLeft = expiresAt - info.blocks;
        return ok({
          found: true,
          summary: summarizeSpec(spec),
          registeredAtHeight: spec.height,
          expiresAtHeight: expiresAt,
          blocksLeft,
          daysLeft: Number(((blocksLeft * 30) / 86400).toFixed(1)),
          hash: spec.hash,
          instances: {
            running: locations.length,
            wanted: spec.instances,
            nodes: locations.map((l) => ({ ip: l.ip, since: l.runningSince ?? null })),
          },
          urls: urlsFor(spec, locations),
          reachability: await reachability(spec, locations, ports),
          spec,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  tool(
    'flux_list_my_apps',
    {
      title: 'List apps owned by the configured Flux ID',
      description:
        'Lists every app registered by the owner (or a given Flux ID) with expiry and instance counts.',
      inputSchema: {
        owner: z.string().optional().describe('Flux ID to list; defaults to the configured one.'),
        nameContains: z.string().optional().describe('Only apps whose name contains this text.'),
      },
    },
    async ({ owner, nameContains }, config) => {
      try {
        const zelid = ownerOf(config, owner);
        const lb = api(config);
        const [apps, info, allLocations] = await Promise.all([
          lb.get<PublishedAppSpec[]>(
            `/apps/globalappsspecifications?owner=${encodeURIComponent(zelid)}`,
            { timeoutMs: 60000 },
          ),
          lb.get<{ blocks: number }>('/daemon/getinfo', { timeoutMs: 20000 }),
          lb.get<Array<{ name: string; ip: string }>>('/apps/locations', { timeoutMs: 60000 }),
        ]);
        const running = new Map<string, number>();
        for (const l of allLocations) running.set(l.name, (running.get(l.name) ?? 0) + 1);
        const needle = nameContains?.toLowerCase();
        const rows = apps
          .filter((app) => !needle || app.name.toLowerCase().includes(needle))
          .map((app) => {
            const blocksLeft = app.height + expireOf(app) - info.blocks;
            return {
              name: app.name,
              version: app.version,
              instances: { running: running.get(app.name) ?? 0, wanted: app.instances },
              blocksLeft,
              daysLeft: Number(((blocksLeft * 30) / 86400).toFixed(1)),
              components: componentsOf(app).map(
                (c) => `${c.name} ${c.repotag} ${c.cpu}cpu/${c.ram}MB/${c.hdd}GB`,
              ),
              private: Boolean(app.enterprise),
              url: `https://${app.name.toLowerCase()}.app.runonflux.io`,
            };
          });
        return ok({ owner: zelid, count: rows.length, apps: rows });
      } catch (error) {
        return fail(error);
      }
    },
  );

  tool(
    'flux_get_app_logs',
    {
      title: 'Read container logs from a running instance',
      description:
        'Fetches the last N log lines of an app (or one component of it) from one of the nodes running it. Requires the owner key.',
      inputSchema: {
        name: z.string(),
        component: z.string().optional().describe('Component name for multi-component apps.'),
        lines: z.number().int().min(1).max(2000).default(200),
        nodeIp: z
          .string()
          .optional()
          .describe('ip[:port] of the instance; defaults to the first running one.'),
      },
    },
    async ({ name, component, lines, nodeIp }, config) => {
      try {
        const session = currentSession(requireOwnerWif(config));
        const { target, container } = await resolveContainer(name, component, nodeIp);
        const node = new FluxClient(instanceEndpoint(target), config.requestTimeoutMs);
        const logs = await node.get<string[] | string>(`/apps/applog/${container}/${lines}`, {
          session,
          timeoutMs: 60000,
        });
        return ok({ node: target, container, logs });
      } catch (error) {
        return fail(error);
      }
    },
  );

  tool(
    'flux_get_app_stats',
    {
      title: 'Get live resource usage of a running instance',
      description:
        'CPU, memory and network stats of the containers of an app on one node. Requires the owner key.',
      inputSchema: {
        name: z.string(),
        component: z.string().optional().describe('Component name for multi-component apps.'),
        nodeIp: z.string().optional(),
      },
    },
    async ({ name, component, nodeIp }, config) => {
      try {
        const session = currentSession(requireOwnerWif(config));
        const { target, container } = await resolveContainer(name, component, nodeIp);
        const node = new FluxClient(instanceEndpoint(target), config.requestTimeoutMs);
        const stats = await node.get<unknown>(`/apps/appstats/${container}`, {
          session,
          timeoutMs: 60000,
        });
        return ok({ node: target, container, stats });
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ----- control ----------------------------------------------------------

  tool(
    'flux_control_app',
    {
      title: 'Restart, redeploy or remove app instances',
      description:
        'restart: restarts containers. redeploy: pulls the image again and recreates containers (hard=true also wipes data). ' +
        'remove: uninstalls from nodes; the registration stays and the network re-spawns it elsewhere, so use flux_cancel_app ' +
        'to stop paying. Scope is one node (nodeIp) or every node running the app (global). Requires the owner key.',
      inputSchema: {
        name: z.string(),
        action: z.enum(['restart', 'redeploy', 'remove']),
        scope: z.enum(['node', 'global']).default('global'),
        nodeIp: z
          .string()
          .optional()
          .describe('Required for scope=node; also the node the global command is sent through.'),
        hard: z.boolean().default(false).describe('For redeploy: also delete the app data.'),
      },
    },
    async ({ name, action, scope, nodeIp, hard }, config) => {
      try {
        const session = currentSession(requireOwnerWif(config));
        const target = nodeIp ?? (await appLocations(api(config), name))[0]?.ip;
        if (!target) throw new Error(`${name} has no running instance.`);
        const node = new FluxClient(instanceEndpoint(target), config.requestTimeoutMs);
        const global = scope === 'global';
        const path =
          action === 'restart'
            ? `/apps/apprestart/${name}/${global}`
            : action === 'redeploy'
              ? `/apps/redeploy/${name}/${hard}/${global}`
              : `/apps/appremove/${name}/true/${global}`;
        const result = await node.raw('GET', path, { session, timeoutMs: 120000 });
        return ok({ node: target, action, scope, result });
      } catch (error) {
        return fail(error);
      }
    },
  );

  tool(
    'flux_cancel_app',
    {
      title: 'Cancel an app (stop it and stop paying)',
      description:
        'Ends an app early by updating its term so it expires within about an hour. The network then uninstalls it everywhere. ' +
        'With confirm=true this signs and pays the (usually minimal) update; without it, returns the plan.',
      inputSchema: { name: z.string(), confirm: z.boolean().default(false) },
    },
    async ({ name, confirm }, config) => {
      try {
        const existing = await publishedSpec(api(config), name);
        if (!existing) throw new Error(`${name} is not registered.`);
        const owner = ownerOf(config);
        if (existing.owner !== owner)
          throw new Error(`${name} is owned by ${existing.owner}, not by ${owner}.`);
        if (existing.enterprise) {
          throw new Error(
            'Private (enterprise) apps must be cancelled with flux_deploy_app: resend the components with a short expire.',
          );
        }
        const spec = { ...normalizePublished(existing), expire: 120 };
        const log: string[] = [];
        const prepared = await plan(config, spec, { log: (m) => log.push(m) });
        if (!confirm)
          return ok({
            executed: false,
            price: describeQuote(prepared.quote),
            funded: prepared.funded,
            next: 'Call again with confirm=true.',
          });
        const result = await execute(config, prepared, (m) => log.push(m));
        return ok({
          executed: true,
          result,
          next: `The app expires about an hour after the update is accepted. Verify with flux_get_app "${name}".`,
          log,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ----- network ----------------------------------------------------------

  tool(
    'flux_get_network_info',
    {
      title: 'Network overview',
      description:
        'Node counts by tier, current block height, FLUX/USD rate and the deployment payment address.',
      inputSchema: {},
    },
    async (_args, config) => {
      try {
        const lb = api(config);
        const [count, info, deployment, rate] = await Promise.all([
          lb.get<Record<string, number>>('/daemon/getzelnodecount', { timeoutMs: 30000 }),
          lb.get<{ blocks: number; version?: number }>('/daemon/getinfo', { timeoutMs: 20000 }),
          lb.get<{ address: string }>('/apps/deploymentinformation', { timeoutMs: 30000 }),
          fetchFluxUsdRate(config.ratesUrl).catch(() => null),
        ]);
        return ok({
          nodes: {
            total: count.total,
            enabled: count['stable'] ?? count.enabled ?? null,
            cumulus: count['cumulus-enabled'] ?? null,
            nimbus: count['nimbus-enabled'] ?? null,
            stratus: count['stratus-enabled'] ?? null,
          },
          blockHeight: info.blocks,
          blocksPerMonth: BLOCKS_PER_MONTH,
          fluxUsdRate: rate,
          deploymentAddress: deployment.address,
          api: config.apiUrl,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}

export { walletFromConfig };

/**
 * Deploying an app is two halves that must agree:
 *
 *   1. A signed specification message, handed to one FluxOS node and gossiped
 *      to the network. The node answers with a 64-character hash and keeps the
 *      message in a temporary store for one hour.
 *   2. An on-chain payment to the network deployment address carrying that
 *      hash in an OP_RETURN. When nodes index the transaction they pair it with
 *      the stored message, check the amount, and publish the app globally.
 *
 * If the payment never lands the message just expires and nothing is spent.
 * The amount paid is the Flux Cloud USD quote converted to FLUX. Consensus
 * would accept far less, but that minimum is checked here only as a guard:
 * underpaying it burns the FLUX with no refund, since the message is dropped
 * silently and the same hash cannot be paid twice.
 */

import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import { Explorer, buildPayment, selectSpendable, toFlux, SATOSHIS } from './chain.js';
import { FluxClient, findHealthyNodes, instanceEndpoint, type HealthyNode } from './fluxapi.js';
import { currentSession, identityFromWif, signMessage, type Identity } from './keys.js';
import { agreedAppPublicKey, encryptEnterprise } from './enterprise.js';
import {
  consensusMinimumFlux,
  quoteFromNetwork,
  type DeploymentInformation,
  type Quote,
} from './pricing.js';
import {
  REGISTER_TYPE,
  UPDATE_TYPE,
  durabilityWarnings,
  formatSpecification,
  signablePayload,
  validateSpecification,
  type AppComponent,
  type AppSpec,
  type PublishedAppSpec,
  type SpecInput,
} from './spec.js';

const TEMP_MESSAGE_TTL_MS = 3600 * 1000;
const FEE_ALLOWANCE_SAT = 100000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Wallet {
  owner: Identity;
  payer: Identity;
}

export function walletFromConfig(config: Config): Wallet {
  if (!config.ownerWif) {
    throw new Error(
      'FLUX_ID_PRIVATE_KEY is not configured. Run flux_generate_keys, or set it to the WIF of your Flux ID.',
    );
  }
  if (!config.payerWif) {
    throw new Error(
      'FLUX_PAYMENT_PRIVATE_KEY is not configured. Run flux_generate_keys, or set it to the WIF of a funded Flux address.',
    );
  }
  return { owner: identityFromWif(config.ownerWif), payer: identityFromWif(config.payerWif) };
}

export function api(config: Config): FluxClient {
  return new FluxClient(config.apiUrl, config.requestTimeoutMs);
}

export function explorer(config: Config): Explorer {
  return new Explorer(config.explorerUrls);
}

export async function publishedSpec(
  client: FluxClient,
  name: string,
): Promise<PublishedAppSpec | null> {
  try {
    const raw = await client.raw('GET', `/apps/appspecifications/${name}`, { timeoutMs: 30000 });
    const payload = raw as { status: string; data: PublishedAppSpec };
    return payload.status === 'success' && payload.data?.name === name ? payload.data : null;
  } catch {
    return null;
  }
}

export interface Location {
  ip: string;
  name: string;
  broadcastedAt?: string;
  expireAt?: string;
  hash?: string;
  runningSince?: string;
  osUptime?: number;
  staticIp?: boolean;
}

export async function appLocations(client: FluxClient, name: string): Promise<Location[]> {
  const raw = (await client.raw('GET', `/apps/location/${name}`, { timeoutMs: 30000 })) as {
    status: string;
    data: Location[];
  };
  return raw.status === 'success' && Array.isArray(raw.data) ? raw.data : [];
}

/**
 * The instance to send an owner-authenticated call to: the first running one,
 * or the one the caller names, which must be in the app's own location list.
 * The owner's session goes with the request, and on the hosted server so does
 * a request from wherever it runs, so a free-form address would hand both to
 * any host the caller picks. A bare IP matches an instance on any port.
 */
export function pickInstance(
  name: string,
  locations: Array<Pick<Location, 'ip'>>,
  nodeIp?: string,
): string {
  const wanted = nodeIp?.trim();
  if (!wanted) {
    const first = locations[0]?.ip;
    if (!first) throw new Error(`${name} has no running instance.`);
    return first;
  }
  const wantedEndpoint = instanceEndpoint(wanted);
  const hostOnly = !wanted.includes(':');
  const found = locations.find((location) => {
    let endpoint: string;
    try {
      endpoint = instanceEndpoint(location.ip);
    } catch {
      return false;
    }
    return (
      endpoint === wantedEndpoint ||
      (hostOnly && endpoint.startsWith(`${wantedEndpoint.replace(/:\d+$/, '')}:`))
    );
  });
  if (!found) {
    const running = locations.map((location) => location.ip).join(', ');
    throw new Error(
      `${wanted} is not running ${name}. Pass the address of one of its instances${running ? `: ${running}` : ''}.`,
    );
  }
  return found.ip;
}

/**
 * The addresses FluxOS pairs a deployment payment with (fluxapps.addressMultisig
 * and addressMultisigB in ZelBack/config/default.js; explorerService counts no
 * others). The address a node reports is checked against them, so the node
 * answering /apps/deploymentinformation cannot have the payment sent to itself.
 */
export const DEPLOYMENT_ADDRESSES: readonly string[] = [
  't3NryfAQLGeFs9jEoeqsxmBN2QLRaRKFLUX',
  't3aGJvdtd8NR6GrnqnRuVEzH6MbrXuJFLUX',
];

export function checkDeploymentAddress(address: string): string {
  if (!DEPLOYMENT_ADDRESSES.includes(address)) {
    throw new Error(
      `The network reported ${JSON.stringify(address)} as the deployment address, which is not a Flux deployment address. Nothing was paid.`,
    );
  }
  return address;
}

/**
 * Paths at which two specifications differ, compared by value: key order is
 * ignored, everything else (types included) must match.
 */
export function specDifferences(expected: unknown, actual: unknown, at = 'spec'): string[] {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return [at];
    if (expected.length !== actual.length) return [`${at}.length`];
    return expected.flatMap((item, i) => specDifferences(item, actual[i], `${at}[${i}]`));
  }
  if (
    expected !== null &&
    actual !== null &&
    typeof expected === 'object' &&
    typeof actual === 'object'
  ) {
    const a = expected as Record<string, unknown>;
    const b = actual as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((key) =>
      key in a && key in b ? specDifferences(a[key], b[key], `${at}.${key}`) : [`${at}.${key}`],
    );
  }
  return Object.is(expected, actual) ? [] : [at];
}

/**
 * The hash FluxOS gives a signed app message: sha256 hex of type, version,
 * the formatted spec, timestamp and signature (registryManager
 * registerAppGlobalyApi, advancedWorkflows updateAppGlobaly). Computed here so
 * the payment carries the hash of the message that was signed, not whatever
 * the node answered.
 */
export function messageHash(
  type: string,
  formatted: AppSpec,
  timestamp: number,
  signature: string,
): string {
  return createHash('sha256')
    .update(signablePayload(formatted, timestamp, type) + signature)
    .digest('hex');
}

/**
 * Where to send a registration. The load balancer at FLUX_API_URL comes
 * first: sessions are self-signed and valid on every node, so no affinity is
 * needed and it is the most reliable front door. If it refuses, a few healthy
 * nodes from the deterministic list are probed and tried in turn. Enterprise
 * specs skip the balancer, since only ArcaneOS nodes can decrypt them. A
 * pinned FLUX_NODE_URL is used alone.
 */
export async function selectNodes(
  config: Config,
  {
    arcane = false,
    count = 3,
    log = () => {},
  }: { arcane?: boolean; count?: number; log?: (m: string) => void } = {},
): Promise<Array<() => Promise<FluxClient[]>>> {
  if (config.nodeUrl) {
    return [async () => [new FluxClient(config.nodeUrl as string, config.requestTimeoutMs)]];
  }
  const probe = async () => {
    const nodes = await findHealthyNodes(api(config), count, { arcane, log });
    return nodes.map((node: HealthyNode) => node.client);
  };
  if (arcane) return [probe];
  return [async () => [api(config)], probe];
}

/** Whether an error means "this node cannot serve right now" rather than "the request is wrong". */
function isNodeSideFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Unavailable|still reconciling|ECONNRESET|ECONNREFUSED|timeout|timed out|HTTP 5\d\d|fetch failed/i.test(
    message,
  );
}

export interface EnterpriseInput {
  compose: AppComponent[];
  contacts: string[];
}

export interface Plan {
  action: 'register' | 'update';
  spec: AppSpec;
  /**
   * The node's formatting of the spec, which is what gets signed. It has been
   * checked to say exactly what `spec` says; only key order may differ.
   */
  formatted: AppSpec;
  previous: PublishedAppSpec | null;
  quote: Quote;
  consensusMinimumFlux: number;
  deployment: DeploymentInformation;
  height: number;
  payer: string;
  balanceFlux: number;
  requiredFlux: number;
  funded: boolean;
  warnings: string[];
  node: FluxClient;
}

/**
 * Everything needed to decide whether a deployment can proceed, without
 * signing, spending or broadcasting anything.
 */
export async function plan(
  config: Config,
  input: SpecInput & { name: string },
  options: { enterprise?: EnterpriseInput | undefined; log?: (m: string) => void } = {},
): Promise<Plan> {
  const { log = () => {} } = options;
  const wallet = walletFromConfig(config);
  const lb = api(config);

  const spec = formatSpecification({ ...input, owner: wallet.owner.zelid });
  const isEnterprise = Boolean(options.enterprise) || Boolean(spec.enterprise);
  const errors = validateSpecification(
    options.enterprise ? { ...spec, compose: options.enterprise.compose } : spec,
  );
  if (errors.length) throw new Error(`Specification is not valid:\n- ${errors.join('\n- ')}`);

  const [previous, nodeSources] = await Promise.all([
    publishedSpec(lb, spec.name),
    selectNodes(config, { arcane: isEnterprise, log }),
  ]);
  const action = previous ? 'update' : 'register';
  if (previous && previous.owner !== wallet.owner.zelid) {
    throw new Error(
      `${spec.name} is already registered on the network by ${previous.owner}. Pick another name.`,
    );
  }

  const verifyPath =
    action === 'update'
      ? '/apps/verifyappupdatespecifications'
      : '/apps/verifyappregistrationspecifications';

  // Try the balancer, then probed nodes; a validation error is final, a
  // node-side failure moves on to the next candidate. What comes back must be
  // the specification that was sent (key order aside): it is what gets signed,
  // so a node that changed an image, a command or an env value would otherwise
  // have the owner sign its version.
  let node: FluxClient | undefined;
  let candidate = spec;
  let formatted: AppSpec | undefined;
  let encrypted: AppSpec | undefined;
  let lastError: unknown;
  for (const source of nodeSources) {
    if (node) break;
    const attempts = await source();
    if (options.enterprise && !encrypted) {
      // Several ArcaneOS nodes must agree on the key the components are
      // encrypted to, or one node could have them encrypted to itself. A
      // pinned FLUX_NODE_URL is trusted alone, as it is for everything else.
      const publicKey = await agreedAppPublicKey(attempts, spec.owner, spec.name, {
        minimum: config.nodeUrl ? 1 : 2,
      });
      encrypted = encryptEnterprise(publicKey, spec, options.enterprise);
    }
    const toVerify = encrypted ?? spec;
    for (const attempt of attempts) {
      try {
        const reply = await attempt.post<AppSpec>(verifyPath, toVerify, { timeoutMs: 120000 });
        const changed = specDifferences(toVerify, reply);
        if (changed.length) {
          lastError = new Error(
            `${attempt.baseUrl} answered with a different specification (${changed.slice(0, 5).join(', ')})`,
          );
          log(`${(lastError as Error).message}; nothing was signed, trying another node`);
          continue;
        }
        formatted = reply;
        candidate = toVerify;
        node = attempt;
        break;
      } catch (error) {
        lastError = error;
        if (!isNodeSideFailure(error)) throw error;
        log(
          `${attempt.baseUrl} could not verify (${(error as Error).message}), trying another node`,
        );
      }
    }
  }
  if (!node || !formatted) {
    throw new Error(
      `No node could verify the specification: ${lastError instanceof Error ? lastError.message : String(lastError)}. Try again in a minute.`,
    );
  }
  if (options.enterprise) log('enterprise components encrypted for the network');
  log(`node ${node.baseUrl} validated the specification (${action})`);

  const [quote, deployment, info, balance] = await Promise.all([
    quoteFromNetwork(lb, candidate),
    lb.get<DeploymentInformation>('/apps/deploymentinformation', { timeoutMs: 30000 }),
    lb.get<{ blocks: number }>('/daemon/getinfo', { timeoutMs: 20000 }),
    explorer(config).balance(wallet.payer.fluxAddress),
  ]);
  checkDeploymentAddress(deployment.address);
  const height = info.blocks;

  const minimum = consensusMinimumFlux(candidate, deployment.price, height);
  const requiredSat = Math.round(quote.flux * SATOSHIS) + FEE_ALLOWANCE_SAT;

  const warnings = durabilityWarnings(
    options.enterprise ? { ...spec, compose: options.enterprise.compose } : spec,
  );
  if (quote.flux < minimum) {
    warnings.push(
      `The network quoted ${quote.flux} FLUX but consensus needs at least ${minimum} FLUX; the payment will be raised to ${minimum} FLUX.`,
    );
  }

  return {
    action,
    spec: candidate,
    formatted,
    previous,
    quote,
    consensusMinimumFlux: minimum,
    deployment,
    height,
    payer: wallet.payer.fluxAddress,
    balanceFlux: toFlux(balance.spendable),
    requiredFlux: toFlux(requiredSat),
    funded: balance.spendable >= requiredSat,
    warnings,
    node,
  };
}

export interface DeployResult {
  action: 'register' | 'update';
  name: string;
  messageHash: string;
  messageExpiresAt: string;
  txid: string;
  paidFlux: number;
  paidUsd: number;
  feeFlux: number;
  deploymentAddress: string;
}

/** Sign, broadcast the message, then pay for it. Spends FLUX. */
export async function execute(
  config: Config,
  prepared: Plan,
  log: (m: string) => void = () => {},
): Promise<DeployResult> {
  const wallet = walletFromConfig(config);
  if (!prepared.funded) {
    throw new Error(
      `Payer ${prepared.payer} holds ${prepared.balanceFlux} FLUX spendable but needs about ${prepared.requiredFlux} FLUX. Fund the address and try again.`,
    );
  }

  const type = prepared.action === 'update' ? UPDATE_TYPE : REGISTER_TYPE;
  const timestamp = Date.now();
  const signature = signMessage(
    signablePayload(prepared.formatted, timestamp, type),
    wallet.owner.wif,
  );
  const session = currentSession(wallet.owner.wif);
  const message = { type, version: 1, appSpecification: prepared.formatted, timestamp, signature };
  const hash = messageHash(type, prepared.formatted, timestamp, signature);
  const answered = await prepared.node.post<string>(
    prepared.action === 'update' ? '/apps/appupdate' : '/apps/appregister',
    message,
    { session, timeoutMs: 180000 },
  );
  if (answered !== hash) {
    throw new Error(
      `${prepared.node.baseUrl} answered with message hash ${JSON.stringify(answered)}, but the signed message hashes to ${hash}. Nothing was paid.`,
    );
  }
  log(`message broadcast, hash ${hash}`);

  // Re-check against a fresh price table and height right before spending:
  // consensus enforces the interval in force where the payment CONFIRMS.
  const lb = api(config);
  const [freshDeployment, info] = await Promise.all([
    lb.get<DeploymentInformation>('/apps/deploymentinformation', { timeoutMs: 30000 }),
    lb.get<{ blocks: number }>('/daemon/getinfo', { timeoutMs: 20000 }),
  ]);
  checkDeploymentAddress(freshDeployment.address);
  if (freshDeployment.address !== prepared.deployment.address) {
    throw new Error('Deployment address changed between quote and payment; nothing was paid.');
  }
  const minimum = consensusMinimumFlux(prepared.spec, freshDeployment.price, info.blocks + 5);
  const payFlux = Math.max(prepared.quote.flux, minimum);
  const amountSat = Math.round(payFlux * SATOSHIS);

  const chain = explorer(config);
  const utxos = selectSpendable(await chain.utxos(wallet.payer.fluxAddress));
  const payment = buildPayment({
    wif: wallet.payer.wif,
    to: freshDeployment.address,
    amountSat,
    message: hash,
    utxos,
    height: info.blocks,
  });
  const txid = await chain.broadcast(payment.hex);
  log(`paid ${payFlux} FLUX, txid ${txid}`);

  return {
    action: prepared.action,
    name: prepared.formatted.name,
    messageHash: hash,
    messageExpiresAt: new Date(timestamp + TEMP_MESSAGE_TTL_MS).toISOString(),
    txid,
    paidFlux: payFlux,
    paidUsd: prepared.quote.usd,
    feeFlux: toFlux(payment.fee),
    deploymentAddress: freshDeployment.address,
  };
}

export interface WaitResult {
  accepted: PublishedAppSpec | null;
  paymentConfirmations: number;
  instances: Location[];
  wantedInstances: number;
  done: boolean;
  timedOut: boolean;
}

/**
 * Poll until the message is accepted and instances run, within `timeoutMs`.
 * Returns partial progress on timeout so a caller can simply call again.
 */
export async function waitForApp(
  config: Config,
  name: string,
  options: {
    txid?: string | undefined;
    previousHash?: string | undefined;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<WaitResult> {
  const { txid, previousHash, timeoutMs = 5 * 60 * 1000, pollMs = 20000 } = options;
  const lb = api(config);
  const chain = explorer(config);
  const deadline = Date.now() + timeoutMs;
  let confirmations = 0;
  let accepted: PublishedAppSpec | null = null;
  let instances: Location[] = [];

  for (;;) {
    if (txid && confirmations < 1) {
      confirmations = Number(
        (await chain.transaction(txid).catch(() => ({ confirmations: 0 }))).confirmations ?? 0,
      );
    }
    const current = await publishedSpec(lb, name);
    if (current && (!previousHash || current.hash !== previousHash)) accepted = current;
    if (accepted) instances = await appLocations(lb, name);
    const wanted = accepted?.instances ?? 0;
    const done = Boolean(accepted) && instances.length >= wanted;
    const remaining = deadline - Date.now();
    if (done || remaining <= 1000) {
      return {
        accepted,
        paymentConfirmations: confirmations,
        instances,
        wantedInstances: wanted,
        done,
        timedOut: !done,
      };
    }
    await sleep(Math.min(pollMs, remaining));
  }
}

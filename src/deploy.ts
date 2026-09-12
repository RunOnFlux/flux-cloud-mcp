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

import type { Config } from './config.js';
import { Explorer, buildPayment, selectSpendable, toFlux, SATOSHIS } from './chain.js';
import { FluxClient, findHealthyNodes, type HealthyNode } from './fluxapi.js';
import { currentSession, identityFromWif, signMessage, type Identity } from './keys.js';
import { encryptEnterprise } from './enterprise.js';
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
  /** The node's own formatting of the spec: this is what gets signed. */
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
  // node-side failure moves on to the next candidate.
  let node: FluxClient | undefined;
  let candidate = spec;
  let formatted: AppSpec | undefined;
  let lastError: unknown;
  for (const source of nodeSources) {
    if (node) break;
    for (const attempt of await source()) {
      try {
        let toVerify = spec;
        if (options.enterprise) {
          const session = currentSession(wallet.owner.wif);
          toVerify = await encryptEnterprise(attempt, session, spec, options.enterprise);
        }
        formatted = await attempt.post<AppSpec>(verifyPath, toVerify, { timeoutMs: 120000 });
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
  const hash = await prepared.node.post<string>(
    prepared.action === 'update' ? '/apps/appupdate' : '/apps/appregister',
    message,
    { session, timeoutMs: 180000 },
  );
  if (typeof hash !== 'string' || hash.length !== 64) {
    throw new Error(`Node returned an unexpected message hash: ${JSON.stringify(hash)}`);
  }
  log(`message broadcast, hash ${hash}`);

  // Re-check against a fresh price table and height right before spending:
  // consensus enforces the interval in force where the payment CONFIRMS.
  const lb = api(config);
  const [freshDeployment, info] = await Promise.all([
    lb.get<DeploymentInformation>('/apps/deploymentinformation', { timeoutMs: 30000 }),
    lb.get<{ blocks: number }>('/daemon/getinfo', { timeoutMs: 20000 }),
  ]);
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

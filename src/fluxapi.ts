/**
 * FluxOS HTTP client.
 *
 * Every FluxOS response is `{ status: 'success' | 'error', data }`; `unwrap`
 * turns the error shape into a thrown Error with the node's message.
 *
 * POST bodies are sent as text/plain, never application/json. FluxOS installs
 * `express.json()` globally, but the handlers this server needs
 * (/apps/appregister, /apps/appupdate, /apps/calculatefiatandfluxprice,
 * /apps/verifyapp*specifications, /apps/getpublickey) read the raw request
 * stream themselves. With a JSON content type the middleware has already
 * consumed the stream, the handler's 'end' listener never fires and the
 * request hangs until a gateway 504. The payload is still JSON text.
 */

import type { Session } from './keys.js';

export interface FluxResponse<T> {
  status: 'success' | 'error';
  data: T;
}

interface FluxErrorData {
  code?: number | string;
  name?: string;
  message?: string;
}

export class FluxApiError extends Error {
  constructor(
    message: string,
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = 'FluxApiError';
  }
}

export function unwrap<T>(payload: unknown, endpoint: string): T {
  const response = payload as FluxResponse<T> | undefined;
  if (response && response.status === 'success') return response.data;
  if (response && response.status === 'error') {
    const data = response.data as FluxErrorData | string;
    const message =
      typeof data === 'string' ? data : (data?.message ?? data?.name ?? 'unknown FluxOS error');
    throw new FluxApiError(`${endpoint}: ${message}`, endpoint);
  }
  throw new FluxApiError(
    `${endpoint}: unexpected response ${JSON.stringify(payload).slice(0, 300)}`,
    endpoint,
  );
}

export function sessionHeader(session: Session): string {
  return JSON.stringify(session);
}

export interface RequestOptions {
  body?: unknown;
  session?: Session | undefined;
  timeoutMs?: number;
}

export class FluxClient {
  constructor(
    public readonly baseUrl: string,
    private readonly defaultTimeoutMs = 60000,
  ) {}

  async raw(
    method: 'GET' | 'POST',
    pathname: string,
    options: RequestOptions = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'text/plain';
      body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }
    if (options.session) headers.zelidauth = sessionHeader(options.session);

    const url = `${this.baseUrl}${pathname}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(options.timeoutMs ?? this.defaultTimeoutMs),
      });
    } catch (error) {
      throw new FluxApiError(`${url}: ${(error as Error).message}`, pathname);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new FluxApiError(`${url}: HTTP ${response.status} ${text.slice(0, 200)}`, pathname);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new FluxApiError(`${url}: non-JSON response ${text.slice(0, 200)}`, pathname);
    }
  }

  async get<T>(pathname: string, options: RequestOptions = {}): Promise<T> {
    return unwrap<T>(await this.raw('GET', pathname, options), pathname);
  }

  async post<T>(pathname: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    return unwrap<T>(await this.raw('POST', pathname, { ...options, body }), pathname);
  }
}

// ---------------------------------------------------------------------------
// Node discovery
// ---------------------------------------------------------------------------

export interface NodeCandidate {
  endpoint: string;
  ip: string;
  tier: string;
}

interface DeterministicNode {
  ip: string;
  tier: string;
  network: string;
}

export interface NodeHealth {
  outgoing: number;
  incoming: number;
  ok: boolean;
  arcaneVersion: string | undefined;
}

/** FluxOS refuses registrations on nodes with fewer peers than this. */
export const MIN_OUTGOING_PEERS = 8;
export const MIN_INCOMING_PEERS = 4;

export async function listNodeEndpoints(api: FluxClient): Promise<NodeCandidate[]> {
  const nodes = await api.get<DeterministicNode[]>('/daemon/viewdeterministiczelnodelist', {
    timeoutMs: 120000,
  });
  return nodes
    .filter((node) => node.ip && node.network === 'ipv4')
    .map((node) => {
      const [ip, port] = node.ip.split(':');
      return { endpoint: `http://${ip}:${port ?? '16127'}`, ip: ip ?? '', tier: node.tier };
    });
}

export async function nodeHealth(node: FluxClient): Promise<NodeHealth> {
  const [outgoing, incoming, info] = await Promise.all([
    node.get<unknown[]>('/flux/connectedpeersinfo', { timeoutMs: 12000 }),
    node.get<unknown[]>('/flux/incomingconnectionsinfo', { timeoutMs: 12000 }),
    node
      .get<{ flux?: { arcaneVersion?: string } }>('/flux/info', { timeoutMs: 12000 })
      .catch(() => undefined),
  ]);
  return {
    outgoing: outgoing.length,
    incoming: incoming.length,
    ok: outgoing.length >= MIN_OUTGOING_PEERS && incoming.length >= MIN_INCOMING_PEERS,
    arcaneVersion: info?.flux?.arcaneVersion,
  };
}

function shuffle<T>(list: T[]): T[] {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = copy[i] as T;
    copy[i] = copy[j] as T;
    copy[j] = a;
  }
  return copy;
}

export interface HealthyNode extends NodeCandidate {
  client: FluxClient;
  health: NodeHealth;
}

/**
 * Probe random nodes until `count` of them meet the peer thresholds. With
 * `arcane` only ArcaneOS nodes qualify: they alone hold the key that
 * decrypts enterprise specifications, so only they can validate or accept one.
 */
export async function findHealthyNodes(
  api: FluxClient,
  count: number,
  options: {
    arcane?: boolean;
    batchSize?: number;
    maxProbes?: number;
    log?: (m: string) => void;
  } = {},
): Promise<HealthyNode[]> {
  const { arcane = false, batchSize = 12, maxProbes = 240, log = () => {} } = options;
  const pool = shuffle(await listNodeEndpoints(api));
  const healthy: HealthyNode[] = [];
  let probed = 0;

  while (healthy.length < count && probed < Math.min(maxProbes, pool.length)) {
    const batch = pool.slice(probed, probed + batchSize);
    probed += batch.length;
    const results = await Promise.all(
      batch.map(async (candidate) => {
        const client = new FluxClient(candidate.endpoint);
        try {
          const health = await nodeHealth(client);
          if (!health.ok) return undefined;
          if (arcane && !health.arcaneVersion) return undefined;
          return { ...candidate, client, health };
        } catch {
          return undefined;
        }
      }),
    );
    for (const result of results) if (result) healthy.push(result);
    log(`probed ${probed} nodes, ${healthy.length} usable`);
  }

  if (!healthy.length) {
    throw new Error(
      `No ${arcane ? 'ArcaneOS ' : ''}FluxOS node with enough peers found after probing ${probed} candidates`,
    );
  }
  return healthy.slice(0, count);
}

/** `http://ip:port` for an app instance reported by /apps/location. */
export function instanceEndpoint(ip: string): string {
  const [host, port] = ip.split(':');
  return `http://${host}:${port ?? '16127'}`;
}

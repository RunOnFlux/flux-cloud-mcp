/**
 * Runtime configuration, read from the environment the MCP host passes in.
 *
 * Two independent keys are used, exactly as the Flux network models them:
 *
 *   FLUX_ID_PRIVATE_KEY       WIF of the Flux ID (ZelID). It is the app owner:
 *                             it signs registration messages and API sessions.
 *                             It never holds funds.
 *   FLUX_PAYMENT_PRIVATE_KEY  WIF of a Flux transparent address (t1...). It
 *                             holds FLUX and pays deployment fees on-chain.
 *
 * Both are optional: without them every read-only tool still works, and the
 * server can generate a fresh pair for the user.
 */

export interface Config {
  ownerWif: string | undefined;
  payerWif: string | undefined;
  /** Load-balanced FluxOS API, fine for reads and price quotes. */
  apiUrl: string;
  /** A specific FluxOS node to use for sessions and registrations, if pinned. */
  nodeUrl: string | undefined;
  explorerUrls: string[];
  statsUrl: string;
  ratesUrl: string;
  /** Deployment address override, only for testing. */
  requestTimeoutMs: number;
}

const DEFAULT_EXPLORERS = ['https://explorer.runonflux.io', 'https://flux-explorer.sspwallet.io'];

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const explorers = optional(env.FLUX_EXPLORER_URLS)
    ?.split(',')
    .map((url) => url.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return {
    ownerWif: optional(env.FLUX_ID_PRIVATE_KEY),
    payerWif: optional(env.FLUX_PAYMENT_PRIVATE_KEY),
    apiUrl: (optional(env.FLUX_API_URL) ?? 'https://api.runonflux.io').replace(/\/$/, ''),
    nodeUrl: optional(env.FLUX_NODE_URL)?.replace(/\/$/, ''),
    explorerUrls: explorers && explorers.length ? explorers : DEFAULT_EXPLORERS,
    statsUrl: (optional(env.FLUX_STATS_URL) ?? 'https://stats.runonflux.io').replace(/\/$/, ''),
    ratesUrl: (optional(env.FLUX_RATES_URL) ?? 'https://viprates.runonflux.io').replace(/\/$/, ''),
    requestTimeoutMs: Number(optional(env.FLUX_REQUEST_TIMEOUT_MS) ?? 60000),
  };
}

/**
 * Pricing.
 *
 * Flux Cloud has two price tables and this server deliberately quotes only one:
 *
 *   USD table   what Flux Cloud (home.runonflux.io) charges. Per-resource USD
 *               rates, a $0.99 minimum, hardware and term discounts, converted
 *               to FLUX at market rate with a 5% discount for paying in FLUX.
 *               Served by every node at POST /apps/calculatefiatandfluxprice.
 *               THIS IS THE PRICE.
 *
 *   chain table what consensus enforces as the bare minimum for a message to
 *               be accepted (messageVerifier.js). It has no USD floor and is
 *               several times lower. It is used here only as a safety guard
 *               before broadcasting a payment, never shown as a quote.
 */

import type { FluxClient } from './fluxapi.js';
import type { AppSpec } from './spec.js';
import { BLOCKS_PER_MONTH, isPortEnterprise, totalResources } from './spec.js';

export interface UsdRates {
  cpu: number;
  ram: number;
  hdd: number;
  minPrice: number;
  port: number;
  scope: number;
  staticip: number;
  fluxmultiplier: number;
  multiplier: number;
  minUSDPrice: number;
}

/** Bundled fallback, identical to ZelBack/config/default.js `usdprice` (Sept 2026). */
export const DEFAULT_USD_RATES: UsdRates = {
  cpu: 0.15,
  ram: 0.05,
  hdd: 0.02,
  minPrice: 0.01,
  port: 2,
  scope: 4,
  staticip: 2,
  fluxmultiplier: 0.95,
  multiplier: 1,
  minUSDPrice: 0.99,
};

export interface ChainPriceInterval {
  height: number;
  cpu: number;
  ram: number;
  hdd: number;
  minPrice: number;
  port: number;
  scope: number;
  staticip: number;
}

export interface DeploymentInformation {
  price: ChainPriceInterval[];
  address: string;
  minimumInstances?: number;
  maximumInstances?: number;
  minBlocksAllowance?: number;
  maxBlocksAllowance?: number;
  blocksLasting?: number;
}

export interface Quote {
  /** The price, in US dollars, for the whole term. */
  usd: number;
  /** FLUX to send for the whole term, at market rate, with the pay-in-FLUX discount applied. */
  flux: number;
  /** Discount in percent for paying with FLUX rather than card. */
  fluxDiscountPercent: number | string;
  /** Term length in blocks and in network months. */
  expireBlocks: number;
  months: number;
  usdPerMonth: number;
  /** FLUX/USD market rate implied by the quote. */
  fluxUsdRate: number | null;
  source: 'flux-cloud' | 'local-estimate';
}

/** Live USD quote from the network, for a registration or an update of an existing app. */
export async function quoteFromNetwork(api: FluxClient, spec: AppSpec): Promise<Quote> {
  const price = await api.post<{ usd: number; flux: number; fluxDiscount: number | string }>(
    '/apps/calculatefiatandfluxprice',
    spec,
    { timeoutMs: 60000 },
  );
  const months = spec.expire / BLOCKS_PER_MONTH;
  const usd = Number(price.usd);
  const flux = Number(price.flux);
  const discount = typeof price.fluxDiscount === 'number' ? price.fluxDiscount : 0;
  const rate = flux > 0 && usd > 0 ? (usd / flux) * (1 - discount / 100) : null;
  return {
    usd,
    flux,
    fluxDiscountPercent: price.fluxDiscount,
    expireBlocks: spec.expire,
    months: round2(months),
    usdPerMonth: months > 0 ? round2(usd / months) : usd,
    fluxUsdRate: rate === null ? null : Number(rate.toFixed(4)),
    source: 'flux-cloud',
  };
}

export async function fetchUsdRates(statsUrl: string): Promise<UsdRates> {
  try {
    const response = await fetch(`${statsUrl}/apps/getappspecsusdprice`, {
      signal: AbortSignal.timeout(10000),
    });
    const payload = (await response.json()) as { status: string; data: UsdRates };
    if (payload.status === 'success' && payload.data && payload.data.cpu) return payload.data;
  } catch {
    // fall through to the bundled table
  }
  return DEFAULT_USD_RATES;
}

/** FLUX price in USD, the way FluxOS derives it: BTC/USD from the rates service times FLUX/BTC. */
export async function fetchFluxUsdRate(ratesUrl: string): Promise<number> {
  const response = await fetch(`${ratesUrl}/rates`, { signal: AbortSignal.timeout(10000) });
  const payload = (await response.json()) as [
    Array<{ code: string; rate: number }>,
    Record<string, number>,
  ];
  const usd = payload[0]?.find((rate) => rate.code === 'USD');
  const fluxInBtc = payload[1]?.FLUX;
  if (!usd || fluxInBtc === undefined) throw new Error('Rates service returned no FLUX/USD rate');
  return usd.rate * fluxInBtc;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function ceil2(value: number): number {
  return Math.ceil(value * 100) / 100;
}

/**
 * Monthly USD price of a specification, mirroring appPricePerMonth() with the
 * USD table. Per-instance price is a third of the resource total (one
 * instance of three), then multiplied out to the instance count.
 */
export function usdPerMonth(spec: AppSpec, rates: UsdRates = DEFAULT_USD_RATES): number {
  const res = totalResources(spec);
  const enterprisePorts = spec.compose.flatMap((c) => c.ports.filter(isPortEnterprise)).length;
  let total = res.cpu * rates.cpu * 10 + (res.ram * rates.ram) / 100 + res.hdd * rates.hdd;
  if (spec.nodes.length || spec.enterprise) total += rates.scope;
  if (spec.staticip) total += rates.staticip;
  total += enterprisePorts * rates.port;

  let price = ceil2(total / 3);
  const extra = spec.instances - 1;
  if (extra > 0) {
    if (price < 0.5 && extra > 2) price += extra * 0.5;
    else price = (Math.ceil(price * extra * 100) + Math.ceil(price * 100)) / 100;
  }
  if (price < rates.minUSDPrice) price = Number(rates.minUSDPrice.toFixed(2));
  return price;
}

/**
 * Local mirror of the Flux Cloud USD price for a NEW registration, used for
 * instant what-if estimates and to sanity check the network's answer. It does
 * not know about update credits or marketplace multipliers, so the network
 * quote stays authoritative.
 */
export function estimateUsd(spec: AppSpec, rates: UsdRates = DEFAULT_USD_RATES): number {
  const months = spec.expire / BLOCKS_PER_MONTH;
  let price = Number((usdPerMonth(spec, rates) * months).toFixed(2));

  const res = totalResources(spec);
  if (spec.instances < 4) {
    if (res.cpu < 3 && res.ram < 6000 && res.hdd < 150) price *= 0.8;
    else if (res.cpu < 7 && res.ram < 29000 && res.hdd < 370) price *= 0.9;
  }
  if (spec.compose.some((c) => c.containerData.includes('g:'))) price *= 0.8;

  price = Number((price * rates.multiplier).toFixed(2));
  if (price < rates.minUSDPrice) price = rates.minUSDPrice;

  if (months >= 9) price *= 0.88;
  else if (months >= 6) price *= 0.94;
  else if (months >= 3) price *= 0.97;
  price = Number(price.toFixed(2));
  if (price < rates.minUSDPrice) price = rates.minUSDPrice;
  return price;
}

export function estimateQuote(spec: AppSpec, rates: UsdRates, fluxUsdRate: number): Quote {
  const usd = estimateUsd(spec, rates);
  const months = spec.expire / BLOCKS_PER_MONTH;
  return {
    usd,
    flux: round2((usd / fluxUsdRate) * rates.fluxmultiplier),
    fluxDiscountPercent: round2(100 - rates.fluxmultiplier * 100),
    expireBlocks: spec.expire,
    months: round2(months),
    usdPerMonth: months > 0 ? round2(usd / months) : usd,
    fluxUsdRate: Number(fluxUsdRate.toFixed(4)),
    source: 'local-estimate',
  };
}

// ---------------------------------------------------------------------------
// Consensus floor. Guard only; never quoted.
// ---------------------------------------------------------------------------

export function chainInterval(table: ChainPriceInterval[], height: number): ChainPriceInterval {
  const applicable = table.filter((entry) => entry.height < height);
  const last = applicable[applicable.length - 1];
  if (!last) throw new Error(`No chain price interval applies at height ${height}`);
  return last;
}

function chainPerMonth(spec: AppSpec, interval: ChainPriceInterval): number {
  const res = totalResources(spec);
  const enterprisePorts = spec.compose.flatMap((c) => c.ports.filter(isPortEnterprise)).length;
  let total = res.cpu * interval.cpu * 10 + (res.ram * interval.ram) / 100 + res.hdd * interval.hdd;
  if (spec.nodes.length || spec.enterprise) total += interval.scope;
  if (spec.staticip) total += interval.staticip;
  total += enterprisePorts * interval.port;
  let price = ceil2(total / 3);
  const extra = spec.instances - 1;
  if (extra > 0) {
    if (price < 0.5 && extra > 2) price += extra * 0.5;
    else price = (Math.ceil(price * extra * 100) + Math.ceil(price * 100)) / 100;
  }
  return price;
}

/**
 * The minimum FLUX consensus will accept for this message at `height`
 * (messageVerifier.js). For updates the network additionally credits the
 * unused part of the previous term, so the true minimum is lower still; using
 * the registration formula errs on the safe side.
 */
export function consensusMinimumFlux(
  spec: AppSpec,
  table: ChainPriceInterval[],
  height: number,
): number {
  const interval = chainInterval(table, height);
  const required = ceil2(chainPerMonth(spec, interval) * (spec.expire / BLOCKS_PER_MONTH));
  return Math.max(required, interval.minPrice);
}

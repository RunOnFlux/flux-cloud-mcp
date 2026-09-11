/**
 * Flux blockchain access over the public Insight explorer API, plus
 * construction of the deployment payment.
 *
 * A registration payment is an ordinary transparent transaction with two
 * outputs that matter: `amount` FLUX to the network deployment address, and an
 * OP_RETURN carrying the 64-character message hash. Nodes index exactly that
 * pair; nothing else about the payer is consulted, which is why the payment
 * key and the owner Flux ID are independent.
 */

import utxolib from '@runonflux/utxo-lib';

const NETWORK = utxolib.networks.flux;
const TX_VERSION = 4; // sapling
const TX_VERSION_GROUP_ID = 0x892f2085;
const TX_EXPIRY_DELTA = 30; // blocks
export const DUST_LIMIT = 546;
const FEE_PER_BYTE = 1;
const COINBASE_MATURITY = 100;
export const SATOSHIS = 1e8;

export interface Utxo {
  txid: string;
  vout: number;
  satoshis: number;
  confirmations: number;
  coinbase: boolean;
}

export interface Balance {
  total: number;
  spendable: number;
  utxos: Utxo[];
  spendableUtxos: Utxo[];
}

export function toFlux(satoshis: number): number {
  return Number((satoshis / SATOSHIS).toFixed(8));
}

export class Explorer {
  constructor(
    private readonly urls: string[],
    private readonly timeoutMs = 30000,
  ) {}

  private async request(
    method: 'GET' | 'POST',
    pathname: string,
    body?: unknown,
  ): Promise<unknown> {
    let lastError: Error | undefined;
    for (const base of this.urls) {
      try {
        const response = await fetch(`${base}${pathname}`, {
          method,
          headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`);
        return JSON.parse(text) as unknown;
      } catch (error) {
        lastError = new Error(`${base}${pathname}: ${(error as Error).message}`);
      }
    }
    throw lastError ?? new Error('No explorer configured');
  }

  async height(): Promise<number> {
    const status = (await this.request('GET', '/api/sync')) as {
      blockChainHeight?: number;
      height?: number;
    };
    const height = Number(status.blockChainHeight ?? status.height);
    if (!Number.isFinite(height)) throw new Error('Explorer returned no block height');
    return height;
  }

  async utxos(address: string): Promise<Utxo[]> {
    const list = (await this.request('GET', `/api/addr/${address}/utxo`)) as Array<
      Record<string, unknown>
    >;
    return (Array.isArray(list) ? list : []).map((u) => ({
      txid: String(u.txid),
      vout: Number(u.vout),
      satoshis: Number(u.satoshis),
      confirmations: Number(u.confirmations ?? 0),
      coinbase: Boolean(u.coinbase),
    }));
  }

  async balance(address: string): Promise<Balance> {
    const utxos = await this.utxos(address);
    const spendable = selectSpendable(utxos);
    const sum = (list: Utxo[]) => list.reduce((acc, u) => acc + u.satoshis, 0);
    return { total: sum(utxos), spendable: sum(spendable), utxos, spendableUtxos: spendable };
  }

  async broadcast(rawtx: string): Promise<string> {
    const result = (await this.request('POST', '/api/tx/send', { rawtx })) as {
      txid?: string | { result?: string };
      result?: string;
    };
    const txid =
      typeof result?.txid === 'object' ? result.txid?.result : (result?.txid ?? result?.result);
    if (!txid) throw new Error(`Broadcast returned no txid: ${JSON.stringify(result)}`);
    return String(txid);
  }

  async transaction(txid: string): Promise<{ confirmations?: number; blockheight?: number }> {
    return (await this.request('GET', `/api/tx/${txid}`)) as { confirmations?: number };
  }
}

/** Coinbase outputs are unspendable until mature; unconfirmed inputs are avoided. */
export function selectSpendable(utxos: Utxo[]): Utxo[] {
  return utxos.filter((u) => {
    if (u.coinbase && u.confirmations < COINBASE_MATURITY) return false;
    return u.confirmations >= 1;
  });
}

/** 148 bytes per p2pkh input, 34 per standard output, 10 overhead, plus the OP_RETURN. */
export function estimateSize(
  inputCount: number,
  outputCount: number,
  opReturnBytes: number,
): number {
  const opReturn = opReturnBytes ? 9 + opReturnBytes + 2 : 0;
  return inputCount * 148 + outputCount * 34 + 10 + opReturn;
}

export interface InputSelection {
  inputs: Utxo[];
  total: number;
  fee: number;
  change: number;
}

/** Greedily pick the fewest inputs covering amount + fee, recomputing the fee as inputs are added. */
export function selectInputs(
  utxos: Utxo[],
  amountSat: number,
  opReturnBytes: number,
): InputSelection {
  const sorted = [...utxos].sort((a, b) => b.satoshis - a.satoshis);
  const chosen: Utxo[] = [];
  let total = 0;
  for (const utxo of sorted) {
    chosen.push(utxo);
    total += utxo.satoshis;
    const withChange = estimateSize(chosen.length, 2, opReturnBytes) * FEE_PER_BYTE;
    const withoutChange = estimateSize(chosen.length, 1, opReturnBytes) * FEE_PER_BYTE;
    if (total >= amountSat + withChange) {
      return { inputs: chosen, total, fee: withChange, change: total - amountSat - withChange };
    }
    if (total >= amountSat + withoutChange && total - amountSat - withoutChange < DUST_LIMIT) {
      return { inputs: chosen, total, fee: total - amountSat, change: 0 };
    }
  }
  const needed =
    amountSat + estimateSize(Math.max(chosen.length, 1), 2, opReturnBytes) * FEE_PER_BYTE;
  throw new Error(
    `Insufficient funds: have ${toFlux(total)} FLUX spendable, need about ${toFlux(needed)} FLUX`,
  );
}

export interface PaymentParams {
  wif: string;
  to: string;
  amountSat: number;
  message: string;
  utxos: Utxo[];
  height: number;
  maxFeeSat?: number;
}

export interface SignedPayment {
  hex: string;
  txid: string;
  fee: number;
  change: number;
  inputs: number;
  sizeBytes: number;
}

/** Build and sign the deployment payment. */
export function buildPayment({
  wif,
  to,
  amountSat,
  message,
  utxos,
  height,
  maxFeeSat = 1000000,
}: PaymentParams): SignedPayment {
  const keyPair = utxolib.ECPair.fromWIF(wif, NETWORK);
  const changeAddress = keyPair.getAddress();
  const opReturnBytes = Buffer.byteLength(message, 'utf8');
  if (opReturnBytes > 80) throw new Error('OP_RETURN payload exceeds 80 bytes');

  const { inputs, fee, change } = selectInputs(utxos, amountSat, opReturnBytes);
  if (fee > maxFeeSat)
    throw new Error(`Refusing to sign: fee ${fee} sat exceeds cap ${maxFeeSat} sat`);

  const builder = new utxolib.TransactionBuilder(NETWORK, fee);
  builder.setVersion(TX_VERSION);
  builder.setVersionGroupId(TX_VERSION_GROUP_ID);
  builder.setExpiryHeight(height + TX_EXPIRY_DELTA);

  inputs.forEach((utxo) => builder.addInput(utxo.txid, utxo.vout));
  builder.addOutput(to, amountSat);
  if (change >= DUST_LIMIT) builder.addOutput(changeAddress, change);
  builder.addOutput(utxolib.script.nullData.output.encode(Buffer.from(message, 'utf8')), 0);

  inputs.forEach((utxo, index) => {
    builder.sign(index, keyPair, undefined, utxolib.Transaction.SIGHASH_ALL, utxo.satoshis);
  });

  const tx = builder.build();
  const hex = tx.toHex();
  return { hex, txid: tx.getId(), fee, change, inputs: inputs.length, sizeBytes: hex.length / 2 };
}

declare module '@runonflux/utxo-lib' {
  export interface Network {
    messagePrefix: string;
    bip32: { public: number; private: number };
    pubKeyHash: number;
    scriptHash: number;
    wif: number;
  }

  export interface ECPairInstance {
    compressed: boolean;
    d: { toBuffer(size: number): Buffer };
    getAddress(): string;
    getPublicKeyBuffer(): Buffer;
    toWIF(): string;
  }

  export const networks: { flux: Network; bitcoin: Network; [name: string]: Network };

  export const ECPair: {
    fromWIF(wif: string, network?: Network): ECPairInstance;
    makeRandom(options?: { network?: Network; compressed?: boolean }): ECPairInstance;
  };

  export class Transaction {
    static SIGHASH_ALL: number;
    toHex(): string;
    getId(): string;
  }

  export class TransactionBuilder {
    constructor(network: Network, maximumFeeRate?: number);
    setVersion(version: number): void;
    setVersionGroupId(id: number): void;
    setExpiryHeight(height: number): void;
    addInput(txid: string, vout: number): number;
    addOutput(scriptPubKeyOrAddress: string | Buffer, value: number): number;
    sign(
      index: number,
      keyPair: ECPairInstance,
      redeemScript: Buffer | undefined,
      hashType: number,
      witnessValue: number,
    ): void;
    build(): Transaction;
  }

  export const script: {
    nullData: { output: { encode(data: Buffer): Buffer } };
  };
}

/**
 * Key material and signatures.
 *
 *   Flux ID (ZelID)  a Bitcoin-style P2PKH address ("1..."), derived from a
 *                    secp256k1 key. Owns apps, signs messages and sessions.
 *   Payment address  a Flux transparent address ("t1...") from a second key.
 *                    Holds FLUX and pays deployment fees.
 *
 * Both use the same WIF encoding (version byte 0x80), so one WIF can be read
 * as either identity; which role it plays is decided by the caller.
 */

import { randomBytes } from 'node:crypto';
import utxolib from '@runonflux/utxo-lib';
import bitcoinMessage from 'bitcoinjs-message';

export interface Identity {
  wif: string;
  publicKey: string;
  /** Flux ID / ZelID: the app owner address ("1..."). */
  zelid: string;
  /** Flux transparent address ("t1..."), the one that can hold FLUX. */
  fluxAddress: string;
}

function keyPairFromWif(wif: string) {
  try {
    return utxolib.ECPair.fromWIF(wif, utxolib.networks.flux);
  } catch (error) {
    throw new Error(`Not a valid WIF private key: ${(error as Error).message}`, { cause: error });
  }
}

export function identityFromWif(wif: string): Identity {
  const flux = keyPairFromWif(wif);
  const bitcoin = utxolib.ECPair.fromWIF(wif, utxolib.networks.bitcoin);
  return {
    wif,
    publicKey: flux.getPublicKeyBuffer().toString('hex'),
    zelid: bitcoin.getAddress(),
    fluxAddress: flux.getAddress(),
  };
}

export function generateIdentity(): Identity {
  const pair = utxolib.ECPair.makeRandom({ network: utxolib.networks.flux, compressed: true });
  return identityFromWif(pair.toWIF());
}

/**
 * Standard Bitcoin signed-message signature, base64. This is what FluxOS
 * `signatureVerifier.verifySignature` checks for a "1..." owner.
 */
export function signMessage(message: string, wif: string): string {
  const pair = keyPairFromWif(wif);
  return bitcoinMessage.sign(message, pair.d.toBuffer(32), pair.compressed).toString('base64');
}

export function verifyMessage(message: string, zelid: string, signature: string): boolean {
  try {
    return bitcoinMessage.verify(message, zelid, signature);
  } catch {
    return false;
  }
}

export interface Session {
  zelid: string;
  signature: string;
  loginPhrase: string;
}

/**
 * A self-issued FluxOS session.
 *
 * FluxOS accepts a login phrase it never issued as long as it starts with a
 * 13-digit millisecond timestamp less than 16 hours old, is 40-70 characters
 * long, and is signed by the ZelID (verificationHelperUtils.verifyUserSession).
 * That means one signed phrase authenticates against every node on the
 * network, with no login round-trip and no node affinity.
 */
export function createSession(ownerWif: string): Session {
  const identity = identityFromWif(ownerWif);
  const loginPhrase = `${Date.now()}${randomBytes(16).toString('hex')}`;
  return { zelid: identity.zelid, signature: signMessage(loginPhrase, ownerWif), loginPhrase };
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
let cachedSession: { session: Session; wif: string; issuedAt: number } | undefined;

/** The same session for the whole process, re-issued well before it ages out. */
export function currentSession(ownerWif: string): Session {
  if (
    cachedSession &&
    cachedSession.wif === ownerWif &&
    Date.now() - cachedSession.issuedAt < SESSION_TTL_MS
  ) {
    return cachedSession.session;
  }
  cachedSession = { session: createSession(ownerWif), wif: ownerWif, issuedAt: Date.now() };
  return cachedSession.session;
}

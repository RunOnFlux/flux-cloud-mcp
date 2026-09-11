/**
 * Enterprise (private) specifications.
 *
 * A v8 enterprise app publishes an empty `compose` and carries the real
 * components and contacts encrypted in the `enterprise` field. Layout, from
 * enterpriseHelper.js decryptEnterpriseFromSession:
 *
 *   base64( RSA-OAEP-SHA256(256 bytes)( base64 text of AES-256 key )
 *           || nonce(12) || AES-256-GCM ciphertext || tag(16) )
 *
 * The RSA block wraps the BASE64 TEXT of the AES key, not the raw bytes; raw
 * bytes decrypt fine and then fail one step later as "Invalid key length".
 *
 * Only ArcaneOS nodes hold the private half, so only they can validate or
 * accept an enterprise registration.
 */

import {
  constants,
  createCipheriv,
  createPublicKey,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { FluxClient } from './fluxapi.js';
import type { Session } from './keys.js';
import type { AppComponent, AppSpec } from './spec.js';

function toPublicKey(raw: string): KeyObject {
  const s = raw.trim();
  if (s.includes('-----BEGIN')) return createPublicKey(s);
  return createPublicKey({ key: Buffer.from(s, 'base64'), format: 'der', type: 'spki' });
}

export function buildEnterpriseBlob(publicKey: KeyObject, plaintextJson: string): string {
  const aesKey = randomBytes(32);
  const encryptedKey = publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(aesKey.toString('base64')),
  );
  if (encryptedKey.length !== 256) {
    throw new Error(`Expected a 256-byte RSA block (RSA-2048), got ${encryptedKey.length}`);
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, nonce);
  const body = Buffer.concat([cipher.update(plaintextJson, 'utf8'), cipher.final()]);
  return Buffer.concat([encryptedKey, nonce, body, cipher.getAuthTag()]).toString('base64');
}

/**
 * Encrypt `compose` and `contacts` into the envelope. The node's app public
 * key is fetched through an owner session (a 'user' privileged endpoint).
 */
export async function encryptEnterprise(
  node: FluxClient,
  session: Session,
  spec: AppSpec,
  plaintext: { compose: AppComponent[]; contacts: string[] },
): Promise<AppSpec> {
  const raw = await node.post<string>(
    '/apps/getpublickey',
    { owner: spec.owner, name: spec.name },
    { session, timeoutMs: 60000 },
  );
  const publicKey = toPublicKey(raw);
  const blob = buildEnterpriseBlob(
    publicKey,
    JSON.stringify({ contacts: plaintext.contacts, compose: plaintext.compose }),
  );
  return { ...spec, contacts: [], compose: [], enterprise: blob };
}

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
  createDecipheriv,
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

/**
 * Decrypt a node's session-encrypted payload: base64(nonce(12) || ciphertext || tag(16))
 * under an AES-256-GCM key we generated (enterpriseHelper.js encryptWithAesSession).
 */
export function decryptSessionPayload(base64Payload: string, aesKey: Buffer): string {
  const raw = Buffer.from(base64Payload, 'base64');
  if (raw.length < 28) throw new Error('Session payload too short');
  const nonce = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(12, raw.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', aesKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/** The header value FluxOS expects: RSA-OAEP-SHA256 of the base64 TEXT of the AES key, base64. */
export function sessionKeyHeader(publicKey: KeyObject, aesKey: Buffer): string {
  return publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(aesKey.toString('base64')),
  ).toString('base64');
}

export interface PrivateSpecContent {
  compose: AppComponent[];
  contacts: string[];
}

/**
 * Fetch the decrypted components of a private app as its owner. The node
 * checks the session is the app owner, decrypts the spec and re-encrypts it
 * for a one-off AES key of ours. Only ArcaneOS nodes can do this.
 */
export async function fetchPrivateSpec(
  node: FluxClient,
  session: Session,
  owner: string,
  name: string,
): Promise<PrivateSpecContent> {
  const raw = await node.post<string>(
    '/apps/getpublickey',
    { owner, name },
    { session, timeoutMs: 60000 },
  );
  const publicKey = toPublicKey(raw);
  const aesKey = randomBytes(32);
  const spec = await node.get<{ enterprise?: string }>(
    `/apps/appspecifications/${encodeURIComponent(name)}/true`,
    {
      session,
      headers: { 'enterprise-key': sessionKeyHeader(publicKey, aesKey) },
      timeoutMs: 60000,
    },
  );
  if (!spec.enterprise) throw new Error(`Node returned no enterprise payload for ${name}`);
  const parsed = JSON.parse(decryptSessionPayload(spec.enterprise, aesKey)) as PrivateSpecContent;
  return { compose: parsed.compose ?? [], contacts: parsed.contacts ?? [] };
}

/** What can be shown about a private component without leaking its secrets. */
export function sanitizeComponent(c: AppComponent): {
  name: string;
  image: string;
  ports: number[];
  containerPorts: number[];
  cpu: number;
  ramMb: number;
  hddGb: number;
} {
  return {
    name: c.name,
    image: c.repotag,
    ports: c.ports,
    containerPorts: c.containerPorts,
    cpu: c.cpu,
    ramMb: c.ram,
    hddGb: c.hdd,
  };
}

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
import { createSession, generateIdentity, type Session } from './keys.js';
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
 * The key an app's enterprise content is encrypted to, taken only when at
 * least `minimum` ArcaneOS nodes return the same one and none returns another.
 * A single node's answer would let that node have the secrets encrypted to a
 * key of its own. /apps/getpublickey needs a user session but not the owner's,
 * so the nodes are asked with a throwaway identity: the owner's session, valid
 * on every node for hours, is not handed to nodes picked for this.
 */
export async function agreedAppPublicKey(
  nodes: Array<Pick<FluxClient, 'post' | 'baseUrl'>>,
  owner: string,
  name: string,
  { minimum = 2 }: { minimum?: number } = {},
): Promise<KeyObject> {
  const session = createSession(generateIdentity().wif);
  const answers = await Promise.all(
    nodes.map(async (node) => {
      try {
        const raw = await node.post<string>(
          '/apps/getpublickey',
          { owner, name },
          { session, timeoutMs: 60000 },
        );
        const key = toPublicKey(raw);
        return { key, der: key.export({ type: 'spki', format: 'der' }).toString('base64') };
      } catch {
        return undefined;
      }
    }),
  );
  const keys = answers.filter((answer) => answer !== undefined);
  if (new Set(keys.map((answer) => answer.der)).size > 1) {
    throw new Error(
      'ArcaneOS nodes returned different encryption keys for this app; nothing was encrypted. Try again.',
    );
  }
  const [agreed] = keys;
  if (!agreed || keys.length < minimum) {
    throw new Error(
      `${keys.length} of ${nodes.length} ArcaneOS nodes returned the app's encryption key; ${minimum} must agree before private components are encrypted to it. Try again.`,
    );
  }
  return agreed.key;
}

/** Encrypt `compose` and `contacts` into the envelope, to the app's public key. */
export function encryptEnterprise(
  publicKey: KeyObject,
  spec: AppSpec,
  plaintext: { compose: AppComponent[]; contacts: string[] },
): AppSpec {
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

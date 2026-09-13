import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  constants,
  createCipheriv,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
} from 'node:crypto';
import { decryptSessionPayload, sanitizeComponent, sessionKeyHeader } from '../src/enterprise.js';

/** What enterpriseHelper.js does on the node with the key we sent. */
function nodeSideEncrypt(plaintext: string, base64AesKey: string): string {
  const key = Buffer.from(base64AesKey, 'base64');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64');
}

test('the session key header unwraps on the node to the base64 text of the AES key', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const aesKey = randomBytes(32);
  const header = sessionKeyHeader(publicKey, aesKey);
  const unwrapped = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(header, 'base64'),
  ).toString('utf8');
  assert.equal(unwrapped, aesKey.toString('base64'));
});

test('a node session payload decrypts back to the private spec content', () => {
  const aesKey = randomBytes(32);
  const content = JSON.stringify({ contacts: [], compose: [{ name: 'web', repotag: 'x:1' }] });
  const payload = nodeSideEncrypt(content, aesKey.toString('base64'));
  assert.equal(decryptSessionPayload(payload, aesKey), content);
  assert.throws(() => decryptSessionPayload(payload, randomBytes(32)));
});

test('sanitized components carry no secrets', () => {
  const clean = sanitizeComponent({
    name: 'web',
    description: 'd',
    repotag: 'ghcr.io/x/y:1',
    ports: [31873],
    domains: [''],
    environmentParameters: ['API_KEY=secret'],
    commands: ['--token=secret'],
    containerPorts: [8080],
    containerData: '/data',
    cpu: 0.5,
    ram: 500,
    hdd: 5,
    repoauth: 'user:token',
  });
  assert.deepEqual(Object.keys(clean), [
    'name',
    'image',
    'ports',
    'containerPorts',
    'cpu',
    'ramMb',
    'hddGb',
  ]);
  assert.equal(JSON.stringify(clean).includes('secret'), false);
  assert.equal(JSON.stringify(clean).includes('token'), false);
});

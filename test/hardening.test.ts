import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import {
  DEPLOYMENT_ADDRESSES,
  checkDeploymentAddress,
  messageHash,
  pickInstance,
  specDifferences,
} from '../src/deploy.js';
import { agreedAppPublicKey } from '../src/enterprise.js';
import { instanceEndpoint } from '../src/fluxapi.js';
import { formatSpecification, type AppSpec } from '../src/spec.js';

/** cloudmcp's own update at height 3096903, as stored by the network. */
const onChain = JSON.parse(
  readFileSync(new URL('./fixtures/cloudmcp-update.json', import.meta.url), 'utf8'),
) as {
  type: string;
  appSpecifications: AppSpec;
  timestamp: number;
  signature: string;
  hash: string;
};

test('instanceEndpoint accepts only an IPv4 address with an optional port', () => {
  assert.equal(instanceEndpoint('203.0.113.7'), 'http://203.0.113.7:16127');
  assert.equal(instanceEndpoint('203.0.113.7:16137'), 'http://203.0.113.7:16137');
  for (const bad of [
    '',
    'example.com',
    'example.com:16127',
    '203.0.113.7:16127/apps/x?',
    '203.0.113.7:16127#',
    'user@203.0.113.7',
    '203.0.113.7:0',
    '203.0.113.7:70000',
    '203.0.113.256',
    '[::1]:16127',
    '203.0.113.7:16127:1',
  ]) {
    assert.throws(() => instanceEndpoint(bad), /Not a node address/, bad);
  }
});

test("pickInstance only targets one of the app's own instances", () => {
  const locations = [{ ip: '198.51.100.1:16137' }, { ip: '198.51.100.2' }];
  assert.equal(pickInstance('web', locations), '198.51.100.1:16137');
  assert.equal(pickInstance('web', locations, '198.51.100.1:16137'), '198.51.100.1:16137');
  assert.equal(pickInstance('web', locations, '198.51.100.1'), '198.51.100.1:16137');
  assert.equal(pickInstance('web', locations, '198.51.100.2:16127'), '198.51.100.2');
  assert.throws(() => pickInstance('web', locations, '198.51.100.1:16127'), /not running web/);
  assert.throws(() => pickInstance('web', locations, '203.0.113.9'), /not running web/);
  assert.throws(() => pickInstance('web', locations, '127.0.0.1:3000'), /not running web/);
  assert.throws(() => pickInstance('web', locations, 'evil.example:80'), /Not a node address/);
  assert.throws(() => pickInstance('web', []), /no running instance/);
  assert.throws(() => pickInstance('web', [], '198.51.100.1'), /not running web/);
});

test('only the Flux deployment addresses are paid', () => {
  for (const address of DEPLOYMENT_ADDRESSES)
    assert.equal(checkDeploymentAddress(address), address);
  assert.throws(
    () => checkDeploymentAddress('t1LUs6quf7TB2zVZmexqPQdnqmrFMGZGjV6'),
    /Nothing was paid/,
  );
  assert.throws(() => checkDeploymentAddress(''), /Nothing was paid/);
});

test('specDifferences ignores key order and reports any change of value', () => {
  const spec = onChain.appSpecifications;
  const reordered = Object.fromEntries(Object.entries(spec).reverse());
  assert.deepEqual(specDifferences(spec, reordered), []);

  const swapped = structuredClone(spec);
  (swapped.compose[0] as { repotag: string }).repotag = 'attacker/image:latest';
  assert.deepEqual(specDifferences(spec, swapped), ['spec.compose[0].repotag']);

  const added = { ...structuredClone(spec), extra: 1 };
  assert.deepEqual(specDifferences(spec, added), ['spec.extra']);

  const retyped = { ...structuredClone(spec), instances: String(spec.instances) };
  assert.deepEqual(specDifferences(spec, retyped), ['spec.instances']);

  const env = structuredClone(spec);
  env.compose[0]?.environmentParameters.push('EXTRA=1');
  assert.deepEqual(specDifferences(spec, env), ['spec.compose[0].environmentParameters.length']);
});

test('messageHash reproduces the hash the network gave a real app message', () => {
  const formatted = formatSpecification(onChain.appSpecifications);
  assert.equal(JSON.stringify(formatted), JSON.stringify(onChain.appSpecifications));
  assert.equal(
    messageHash(onChain.type, formatted, onChain.timestamp, onChain.signature),
    onChain.hash,
  );
  assert.notEqual(
    messageHash(onChain.type, formatted, onChain.timestamp + 1, onChain.signature),
    onChain.hash,
  );
});

function pemKey(): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({
    type: 'spki',
    format: 'pem',
  }) as string;
}

function fakeNode(answer: string | Error, seen: unknown[] = []) {
  return {
    baseUrl: 'http://198.51.100.9:16127',
    async post<T>(_path: string, _body: unknown, options?: { session?: unknown }): Promise<T> {
      seen.push(options?.session);
      if (answer instanceof Error) throw answer;
      return answer as T;
    },
  };
}

test('the enterprise key is taken only when ArcaneOS nodes agree on it', async () => {
  const key = pemKey();
  const owner = '196GJWyLxzAw3MirTT7Bqs2iGpUQio29GH';

  const sessions: unknown[] = [];
  const agreed = await agreedAppPublicKey(
    [fakeNode(key, sessions), fakeNode(key, sessions), fakeNode(new Error('down'), sessions)],
    owner,
    'web',
  );
  assert.equal(agreed.export({ type: 'spki', format: 'pem' }), key);
  // Asked with a throwaway identity, never the owner's session.
  for (const session of sessions) {
    assert.notEqual((session as { zelid: string }).zelid, owner);
  }

  await assert.rejects(
    agreedAppPublicKey([fakeNode(key), fakeNode(pemKey()), fakeNode(key)], owner, 'web'),
    /different encryption keys/,
  );
  await assert.rejects(
    agreedAppPublicKey([fakeNode(key), fakeNode(new Error('down'))], owner, 'web'),
    /2 must agree/,
  );
  const pinned = await agreedAppPublicKey([fakeNode(key)], owner, 'web', { minimum: 1 });
  assert.equal(pinned.export({ type: 'spki', format: 'pem' }), key);
});

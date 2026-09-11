import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession,
  generateIdentity,
  identityFromWif,
  signMessage,
  verifyMessage,
} from '../src/keys.js';

test('a generated identity derives both a Flux ID and a Flux address from one key', () => {
  const id = generateIdentity();
  assert.match(id.zelid, /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/);
  assert.match(id.fluxAddress, /^t1[1-9A-HJ-NP-Za-km-z]{33}$/);
  assert.equal(identityFromWif(id.wif).zelid, id.zelid);
  assert.equal(identityFromWif(id.wif).fluxAddress, id.fluxAddress);
});

test('signatures verify against the Flux ID with the Bitcoin message scheme', () => {
  const id = generateIdentity();
  const signature = signMessage('hello flux', id.wif);
  assert.equal(verifyMessage('hello flux', id.zelid, signature), true);
  assert.equal(verifyMessage('hello flux!', id.zelid, signature), false);
});

test('a self-issued session satisfies the FluxOS phrase rules', () => {
  const id = generateIdentity();
  const session = createSession(id.wif);
  assert.equal(session.zelid, id.zelid);
  assert.ok(session.loginPhrase.length >= 40 && session.loginPhrase.length <= 70);
  const stamp = Number(session.loginPhrase.slice(0, 13));
  assert.ok(Math.abs(Date.now() - stamp) < 5000);
  assert.equal(verifyMessage(session.loginPhrase, id.zelid, session.signature), true);
});

test('an invalid WIF is rejected with a clear error', () => {
  assert.throws(() => identityFromWif('not-a-key'), /Not a valid WIF/);
});

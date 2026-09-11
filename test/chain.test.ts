import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPayment,
  estimateSize,
  selectInputs,
  selectSpendable,
  DUST_LIMIT,
} from '../src/chain.js';
import { generateIdentity } from '../src/keys.js';

const utxo = (satoshis: number, confirmations = 10, coinbase = false) => ({
  txid: 'a'.repeat(64),
  vout: 0,
  satoshis,
  confirmations,
  coinbase,
});

test('immature coinbase and unconfirmed outputs are not spendable', () => {
  const spendable = selectSpendable([
    utxo(1e8, 0),
    utxo(1e8, 50, true),
    utxo(1e8, 150, true),
    utxo(1e8, 1),
  ]);
  assert.equal(spendable.length, 2);
});

test('input selection covers amount plus an honest fee', () => {
  const selection = selectInputs([utxo(5e8), utxo(1e8)], 2e8, 64);
  assert.equal(selection.inputs.length, 1);
  assert.equal(selection.fee, estimateSize(1, 2, 64));
  assert.equal(selection.change, 5e8 - 2e8 - selection.fee);
  assert.throws(() => selectInputs([utxo(1e8)], 2e8, 64), /Insufficient funds/);
});

test('a payment carries the hash in an OP_RETURN and pays the deployment address', () => {
  const payer = generateIdentity();
  const hash = 'f'.repeat(64);
  const payment = buildPayment({
    wif: payer.wif,
    to: 't3NryfAQLGeFs9jEoeqsxmBN2QLRaRKFLUX',
    amountSat: 193200000,
    message: hash,
    utxos: [{ ...utxo(3e8), txid: 'b'.repeat(64) }],
    height: 2925000,
  });
  assert.equal(payment.inputs, 1);
  assert.ok(payment.fee < 1000);
  assert.ok(payment.change > DUST_LIMIT);
  assert.match(payment.txid, /^[0-9a-f]{64}$/);
  // the OP_RETURN payload is the ascii hash
  assert.ok(payment.hex.includes(Buffer.from(hash, 'utf8').toString('hex')));
  assert.throws(
    () =>
      buildPayment({
        wif: payer.wif,
        to: 't3NryfAQLGeFs9jEoeqsxmBN2QLRaRKFLUX',
        amountSat: 1,
        message: 'x'.repeat(81),
        utxos: [utxo(3e8)],
        height: 1,
      }),
    /80 bytes/,
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpecification, BLOCKS_PER_MONTH } from '../src/spec.js';
import {
  DEFAULT_USD_RATES,
  consensusMinimumFlux,
  estimateQuote,
  estimateUsd,
  usdPerMonth,
} from '../src/pricing.js';

const OWNER = '196GJWyLxzAw3MirTT7Bqs2iGpUQio29GH';
const app = (cpu: number, ram: number, hdd: number, instances = 3, months = 1) =>
  buildSpecification({
    name: 'p',
    owner: OWNER,
    components: [{ image: 'a:1', cpu, ram, hdd, ports: [{ containerPort: 80 }] }],
    instances,
    months,
  });

test('the worked example from the pricing guide', () => {
  // (0.75 + 0.25 + 0.10) / 3 = 0.37 per instance, x3 = 1.11/month
  assert.equal(usdPerMonth(app(0.5, 500, 5)), 1.11);
  // small-app discount 0.8 -> 0.888, floored to the $0.99 minimum
  assert.equal(estimateUsd(app(0.5, 500, 5)), 0.99);
});

test('bigger apps are priced per resource and discounted by term', () => {
  const monthly = usdPerMonth(app(4, 8000, 100));
  // cpu 6 + ram 4 + hdd 2 = 12 / 3 = 4 per instance, x3 = 12
  assert.equal(monthly, 12);
  // 3 instances and > 3 cpu: medium-app 10% discount applies
  assert.equal(estimateUsd(app(4, 8000, 100)), 10.8);
  // 12 months: 12 x 10.8 = 129.6, then 12% off
  assert.equal(estimateUsd(app(4, 8000, 100, 3, 12)), 114.05);
  // 4 instances: no hardware discount at all
  assert.equal(estimateUsd(app(4, 8000, 100, 4)), 16);
});

test('FLUX amount applies the pay-in-FLUX discount at the market rate', () => {
  const quote = estimateQuote(app(4, 8000, 100), DEFAULT_USD_RATES, 0.05);
  assert.equal(quote.usd, 10.8);
  assert.equal(quote.flux, 205.2); // 10.8 / 0.05 * 0.95
  assert.equal(quote.fluxDiscountPercent, 5);
  assert.equal(quote.usdPerMonth, 10.8);
  assert.equal(quote.source, 'local-estimate');
});

test('the consensus floor is far below the USD quote and never shown as a price', () => {
  const table = [
    {
      height: -1,
      cpu: 0.03,
      ram: 0.01,
      hdd: 0.004,
      minPrice: 0.01,
      port: 0.4,
      scope: 0.8,
      staticip: 0.4,
    },
  ];
  const spec = app(4, 8000, 100);
  const minimum = consensusMinimumFlux(spec, table, 2900000);
  // cpu 1.2 + ram 0.8 + hdd 0.4 = 2.4 / 3 = 0.8 per instance, x3 = 2.4 FLUX/month
  assert.equal(minimum, 2.4);
  const quote = estimateQuote(spec, DEFAULT_USD_RATES, 0.05);
  assert.ok(quote.flux > minimum * 10);
  assert.equal(consensusMinimumFlux({ ...spec, expire: 1 }, table, 2900000), 0.01);
  assert.equal(spec.expire, BLOCKS_PER_MONTH);
});

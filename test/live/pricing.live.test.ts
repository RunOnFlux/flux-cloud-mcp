/**
 * Differential test: the local USD estimate must match what the network
 * quotes for new registrations. Run with `yarn test:live` (needs internet).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.js';
import { FluxClient } from '../../src/fluxapi.js';
import { estimateUsd, fetchUsdRates, quoteFromNetwork } from '../../src/pricing.js';
import { buildSpecification } from '../../src/spec.js';

const live = process.env.FLUX_LIVE_TESTS === '1';
const OWNER = '196GJWyLxzAw3MirTT7Bqs2iGpUQio29GH';

const cases = [
  { cpu: 0.5, ram: 500, hdd: 5, instances: 3, months: 1 },
  { cpu: 1, ram: 1000, hdd: 10, instances: 3, months: 1 },
  { cpu: 2, ram: 4000, hdd: 40, instances: 3, months: 3 },
  { cpu: 4, ram: 8000, hdd: 100, instances: 3, months: 1 },
  { cpu: 4, ram: 8000, hdd: 100, instances: 5, months: 12 },
  { cpu: 8, ram: 32000, hdd: 400, instances: 1, months: 6 },
];

test('local USD estimate matches the network quote', { skip: !live }, async () => {
  const config = loadConfig();
  const api = new FluxClient(config.apiUrl);
  const rates = await fetchUsdRates(config.statsUrl);
  for (const c of cases) {
    const spec = buildSpecification({
      name: `mcpdiff${Math.random().toString(36).slice(2, 8)}`,
      owner: OWNER,
      components: [
        { image: 'nginx:1.27', cpu: c.cpu, ram: c.ram, hdd: c.hdd, ports: [{ containerPort: 80 }] },
      ],
      instances: c.instances,
      months: c.months,
    });
    const network = await quoteFromNetwork(api, spec);
    const local = estimateUsd(spec, rates);
    assert.equal(
      local,
      network.usd,
      `${JSON.stringify(c)}: local ${local} vs network ${network.usd}`,
    );
    assert.ok(network.flux > 0);
  }
});

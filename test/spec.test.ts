import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKS_PER_MONTH,
  buildSpecification,
  durabilityWarnings,
  formatSpecification,
  signablePayload,
  validateSpecification,
} from '../src/spec.js';

const OWNER = '196GJWyLxzAw3MirTT7Bqs2iGpUQio29GH';

test('formatSpecification reproduces the FluxOS key order byte for byte', () => {
  const spec = formatSpecification({
    name: 'demo',
    description: 'd',
    owner: OWNER,
    compose: [
      {
        name: 'web',
        description: 'w',
        repotag: 'nginx:1.27',
        ports: [31080],
        domains: [''],
        environmentParameters: [],
        commands: [],
        containerPorts: [80],
        containerData: 'r:/data',
        cpu: 0.5,
        ram: 500,
        hdd: 5,
      },
    ],
    instances: 3,
    expire: BLOCKS_PER_MONTH,
  });
  assert.deepEqual(Object.keys(spec), [
    'version',
    'name',
    'description',
    'owner',
    'compose',
    'instances',
    'contacts',
    'geolocation',
    'expire',
    'nodes',
    'staticip',
    'enterprise',
  ]);
  assert.deepEqual(Object.keys(spec.compose[0]!), [
    'name',
    'description',
    'repotag',
    'ports',
    'domains',
    'environmentParameters',
    'commands',
    'containerPorts',
    'containerData',
    'cpu',
    'ram',
    'hdd',
    'repoauth',
  ]);
  assert.equal(spec.enterprise, '');
  assert.equal('datacenter' in spec, false);
  assert.equal(validateSpecification(spec).length, 0);
  assert.equal(
    signablePayload(spec, 1700000000000, 'fluxappregister'),
    `fluxappregister1${JSON.stringify(spec)}1700000000000`,
  );
});

test('buildSpecification fills in ports, names and replication from simple inputs', () => {
  const spec = buildSpecification({
    name: 'myshop',
    owner: OWNER,
    components: [
      { image: 'nginx:1.27', cpu: 0.5, ram: 500, hdd: 5, ports: [{ containerPort: 80 }] },
      {
        image: 'postgres:16',
        cpu: 1,
        ram: 1000,
        hdd: 20,
        dataPath: '/var/lib/postgresql/data',
        env: { POSTGRES_PASSWORD: 'x' },
      },
    ],
    months: 3,
  });
  assert.equal(spec.compose.length, 2);
  assert.equal(spec.compose[0]!.name, 'myshop1');
  assert.equal(spec.compose[1]!.name, 'myshop2');
  const port = spec.compose[0]!.ports[0]!;
  assert.ok(port >= 31000 && port <= 39999);
  assert.deepEqual(spec.compose[0]!.containerPorts, [80]);
  assert.deepEqual(spec.compose[0]!.domains, ['']);
  assert.equal(spec.compose[1]!.containerData, 'r:/var/lib/postgresql/data');
  assert.deepEqual(spec.compose[1]!.environmentParameters, ['POSTGRES_PASSWORD=x']);
  assert.equal(spec.expire, 3 * BLOCKS_PER_MONTH);
  assert.equal(spec.instances, 3);
  assert.deepEqual(validateSpecification(spec), []);
  // deterministic: the same name always maps to the same ports
  assert.equal(
    buildSpecification({
      name: 'myshop',
      owner: OWNER,
      components: [{ image: 'a:1', cpu: 0.1, ram: 100, hdd: 1, ports: [{ containerPort: 1 }] }],
    }).compose[0]!.ports[0],
    port,
  );
});

test('validateSpecification catches the rules FluxOS enforces', () => {
  const base = buildSpecification({
    name: 'ok',
    owner: OWNER,
    components: [{ image: 'nginx:1.27', cpu: 0.5, ram: 500, hdd: 5 }],
  });
  const errorsFor = (patch: Partial<typeof base>) => validateSpecification({ ...base, ...patch });
  assert.match(errorsFor({ name: 'fluxthing' }).join(), /start with "zel" or "flux"/);
  assert.match(errorsFor({ name: '-bad' }).join(), /inner hyphens/);
  assert.match(errorsFor({ instances: 0 }).join(), /instances/);
  assert.match(errorsFor({ expire: 2000000 }).join(), /expire/);
  assert.match(errorsFor({ owner: 't1abc' }).join(), /Flux ID/);
  const badComponent = {
    ...base.compose[0]!,
    cpu: 0.55,
    ram: 250,
    hdd: 0,
    ports: [22],
    containerPorts: [22],
    domains: [''],
  };
  const errors = errorsFor({ compose: [badComponent] }).join('\n');
  assert.match(errors, /cpu must be/);
  assert.match(errors, /ram must be/);
  assert.match(errors, /hdd must be/);
  assert.match(errors, /port 22 is reserved/);
  assert.match(
    errorsFor({ compose: [{ ...base.compose[0]!, repotag: 'nginx' }] }).join(),
    /explicit tag/,
  );
});

test('durabilityWarnings flags node-local data and enterprise ports', () => {
  const spec = buildSpecification({
    name: 'w',
    owner: OWNER,
    components: [
      {
        image: 'a:1',
        cpu: 0.1,
        ram: 100,
        hdd: 1,
        replicateData: false,
        ports: [{ containerPort: 80, port: 8080 }],
      },
    ],
  });
  const warnings = durabilityWarnings(spec).join('\n');
  assert.match(warnings, /node-local/);
  assert.match(warnings, /enterprise port/);
});

test('legacy published specs are normalized to v8 shape', async () => {
  const { componentsOf, expireOf, normalizePublished } = await import('../src/spec.js');
  const legacy = {
    version: 3,
    name: 'Old',
    description: 'legacy',
    owner: OWNER,
    repotag: 'x/y:1',
    ports: [31001],
    containerPorts: [80],
    domains: [''],
    environmentParameters: [],
    commands: [],
    containerData: '/data',
    cpu: 0.5,
    ram: 500,
    hdd: 5,
    instances: 3,
    contacts: [],
    geolocation: [],
    nodes: [],
    staticip: false,
    enterprise: '',
    hash: 'h',
    height: 100,
  };
  assert.equal(componentsOf(legacy).length, 1);
  assert.equal(componentsOf(legacy)[0]!.repotag, 'x/y:1');
  assert.equal(expireOf(legacy), BLOCKS_PER_MONTH);
  const normalized = normalizePublished(legacy);
  assert.equal(normalized.version, 3);
  assert.equal(normalized.compose[0]!.name, 'Old');
  assert.equal(normalized.expire, BLOCKS_PER_MONTH);
});

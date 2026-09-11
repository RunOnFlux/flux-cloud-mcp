/**
 * Flux v8 application specifications.
 *
 * The owner signs `JSON.stringify(formattedSpec)` and FluxOS re-formats the
 * spec server-side before verifying, so key ORDER is part of the contract:
 * `formatSpecification` reproduces `specificationFormatter()` in
 * ZelBack/src/services/utils/appUtilities.js byte for byte.
 */

export const SPEC_VERSION = 8;
export const REGISTER_TYPE = 'fluxappregister';
export const UPDATE_TYPE = 'fluxappupdate';
export const MESSAGE_VERSION = 1;

/** One network month in blocks after the PON fork (30 s blocks). */
export const BLOCKS_PER_MONTH = 88000;
export const PON_FORK_HEIGHT = 2020000;
export const MAX_EXPIRE_BLOCKS = 1056000; // 12 months

const APP_NAME_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const BANNED_PORTS: Array<number | [number, number]> = [
  [16100, 16299],
  [26100, 26299],
  [30000, 30099],
  8384,
  27017,
  22,
  23,
  25,
  3389,
  5900,
  5800,
  161,
  512,
  513,
  5901,
  3388,
  4444,
  123,
  53,
];
const ENTERPRISE_PORTS: Array<number | [number, number]> = [[0, 1023], 8080, 8081, 8443, 6667];

export interface AppComponent {
  name: string;
  description: string;
  repotag: string;
  ports: number[];
  domains: string[];
  environmentParameters: string[];
  commands: string[];
  containerPorts: number[];
  containerData: string;
  cpu: number;
  ram: number;
  hdd: number;
  repoauth: string;
}

export interface AppSpec {
  version: number;
  name: string;
  description: string;
  owner: string;
  compose: AppComponent[];
  instances: number;
  contacts: string[];
  geolocation: string[];
  expire: number;
  nodes: string[];
  staticip: boolean;
  datacenter?: boolean;
  enterprise: string;
}

/**
 * A published (global) specification carries where and when it was accepted.
 * Old apps (version 1-3) have no compose array and may have no expire; use
 * `componentsOf` and `expireOf` rather than the raw fields.
 */
export interface PublishedAppSpec extends Omit<AppSpec, 'compose' | 'expire'> {
  hash: string;
  height: number;
  compose?: AppComponent[] | undefined;
  expire?: number | undefined;
  repotag?: string | undefined;
  ports?: number[] | undefined;
  containerPorts?: number[] | undefined;
  domains?: string[] | undefined;
  environmentParameters?: string[] | undefined;
  commands?: string[] | undefined;
  containerData?: string | undefined;
  cpu?: number | undefined;
  ram?: number | undefined;
  hdd?: number | undefined;
}

/** Components of any spec version, synthesizing one from a legacy single-container spec. */
export function componentsOf(spec: PublishedAppSpec | AppSpec): AppComponent[] {
  if (Array.isArray(spec.compose)) return spec.compose;
  const legacy = spec as PublishedAppSpec;
  return [
    formatComponent({
      name: legacy.name,
      description: legacy.description,
      repotag: legacy.repotag ?? '',
      ports: legacy.ports ?? [],
      domains: legacy.domains ?? [],
      environmentParameters: legacy.environmentParameters ?? [],
      commands: legacy.commands ?? [],
      containerPorts: legacy.containerPorts ?? [],
      containerData: legacy.containerData ?? '',
      cpu: legacy.cpu ?? 0,
      ram: legacy.ram ?? 0,
      hdd: legacy.hdd ?? 0,
    }),
  ];
}

export function expireOf(spec: PublishedAppSpec | AppSpec): number {
  return typeof spec.expire === 'number' ? spec.expire : BLOCKS_PER_MONTH;
}

/** A published spec as a complete v8-shaped object, for updates and summaries. */
export function normalizePublished(
  spec: PublishedAppSpec,
): AppSpec & { hash: string; height: number } {
  return {
    ...formatSpecification({ ...spec, compose: componentsOf(spec), expire: expireOf(spec) }),
    hash: spec.hash,
    height: spec.height,
  };
}

function matches(port: number, list: Array<number | [number, number]>): boolean {
  return list.some((entry) =>
    Array.isArray(entry) ? port >= entry[0] && port <= entry[1] : entry === port,
  );
}

export const isPortBanned = (port: number): boolean => matches(port, BANNED_PORTS);
export const isPortEnterprise = (port: number): boolean => matches(port, ENTERPRISE_PORTS);

export function formatComponent(component: ComponentInput): AppComponent {
  return {
    name: String(component.name ?? ''),
    description: String(component.description ?? ''),
    repotag: String(component.repotag ?? ''),
    ports: (component.ports ?? []).map(Number),
    domains: (component.domains ?? []).map(String),
    environmentParameters: (component.environmentParameters ?? []).map(String),
    commands: (component.commands ?? []).map(String),
    containerPorts: (component.containerPorts ?? []).map(Number),
    containerData: String(component.containerData ?? ''),
    cpu: Number(component.cpu),
    ram: Number(component.ram),
    hdd: Number(component.hdd),
    repoauth: String(component.repoauth ?? ''),
  };
}

/** A specification as a caller may hand it in: any field may be missing. */
export type ComponentInput = { [K in keyof AppComponent]?: AppComponent[K] | undefined };
export type SpecInput = { [K in keyof Omit<AppSpec, 'compose'>]?: AppSpec[K] | undefined } & {
  compose?: ComponentInput[] | undefined;
};

export function formatSpecification(spec: SpecInput & { owner: string }): AppSpec {
  const name = String(spec.name ?? '');
  const compose = spec.compose ?? [];
  const formatted: AppSpec = {
    version: Number(spec.version ?? SPEC_VERSION),
    name,
    description: String(spec.description ?? ''),
    owner: String(spec.owner),
    // A single unnamed component takes the app's name, as Flux Cloud does.
    compose: compose.map((c, i) =>
      formatComponent({ ...c, name: c.name ?? (compose.length === 1 ? name : `${name}${i + 1}`) }),
    ),
    instances: Number(spec.instances ?? 3),
    contacts: (spec.contacts ?? []).map(String),
    geolocation: (spec.geolocation ?? []).map(String),
    expire: Number(spec.expire ?? BLOCKS_PER_MONTH),
    nodes: (spec.nodes ?? []).map(String),
    staticip: Boolean(spec.staticip),
    enterprise: '',
  };
  // `datacenter` is only emitted when explicitly set; FluxOS drops it otherwise.
  if (spec.datacenter !== undefined) formatted.datacenter = Boolean(spec.datacenter);
  // `enterprise` is always emitted last, empty string for a normal app.
  formatted.enterprise = spec.enterprise ? String(spec.enterprise) : '';
  return formatted;
}

/** Local mirror of the node-side sanity checks, so failures surface before anything is paid. */
export function validateSpecification(spec: AppSpec): string[] {
  const errors: string[] = [];
  const push = (m: string) => errors.push(m);

  if (spec.version !== SPEC_VERSION)
    push(`only version ${SPEC_VERSION} specifications are supported`);
  if (!spec.name || spec.name.length > 63) push('name must be 1-63 characters');
  else if (!APP_NAME_REGEX.test(spec.name))
    push('name may only contain a-z A-Z 0-9 and inner hyphens');
  if (/^(zel|flux)/i.test(spec.name)) push('name may not start with "zel" or "flux"');
  if (spec.name.toLowerCase() === 'watchtower') push('name "watchtower" is reserved');
  if (!spec.description || spec.description.length > 256)
    push('description must be 1-256 characters');
  if (!/^1[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(spec.owner))
    push(`owner ${spec.owner} is not a Flux ID (ZelID) address`);

  if (spec.enterprise === '' && spec.compose.length < 1) push('at least one component is required');
  if (spec.compose.length > 10) push('at most 10 components are allowed');

  const seenNames = new Set<string>();
  const seenPorts = new Set<number>();
  spec.compose.forEach((c, i) => {
    const at = `component[${i}] ${c.name || ''}`.trim();
    if (!c.name || c.name.length > 63) push(`${at}: name must be 1-63 characters`);
    else if (!APP_NAME_REGEX.test(c.name))
      push(`${at}: name may only contain a-z A-Z 0-9 and inner hyphens`);
    if (seenNames.has(c.name)) push(`${at}: duplicate component name`);
    seenNames.add(c.name);
    if (!c.description || c.description.length > 256)
      push(`${at}: description must be 1-256 characters`);
    if (!c.repotag || c.repotag.length > 200) push(`${at}: repotag must be 1-200 characters`);
    else if (!c.repotag.includes(':'))
      push(`${at}: repotag must include an explicit tag, e.g. nginx:1.27`);
    if (!c.containerData || c.containerData.length < 2 || c.containerData.length > 200) {
      push(`${at}: containerData must be an absolute path of 2-200 characters`);
    }
    if (c.ports.length !== c.containerPorts.length) {
      push(`${at}: ports and containerPorts must have the same length`);
    }
    if (c.domains.length !== c.ports.length) {
      push(`${at}: domains must have one entry per port (use "" for none)`);
    }
    c.ports.forEach((p) => {
      if (!Number.isInteger(p) || p < 1 || p > 65535) push(`${at}: port ${p} is out of range`);
      else if (isPortBanned(p)) push(`${at}: port ${p} is reserved by the network`);
      if (seenPorts.has(p)) push(`${at}: port ${p} is used twice in this app`);
      seenPorts.add(p);
    });
    c.containerPorts.forEach((p) => {
      if (!Number.isInteger(p) || p < 1 || p > 65535)
        push(`${at}: containerPort ${p} is out of range`);
    });
    if (!(c.cpu >= 0.1) || Math.round(c.cpu * 10) !== c.cpu * 10)
      push(`${at}: cpu must be >= 0.1 in 0.1 steps`);
    if (c.cpu > 15) push(`${at}: cpu must be <= 15`);
    if (!(c.ram >= 100) || c.ram % 100 !== 0) push(`${at}: ram must be >= 100 in 100 MB steps`);
    if (c.ram > 59000) push(`${at}: ram must be <= 59000 MB`);
    if (!(c.hdd >= 1) || !Number.isInteger(c.hdd))
      push(`${at}: hdd must be a whole number of GB >= 1`);
    if (c.hdd > 820) push(`${at}: hdd must be <= 820 GB`);
    if (c.environmentParameters.length > 20) push(`${at}: at most 20 environment parameters`);
    if (c.commands.length > 20) push(`${at}: at most 20 commands`);
    c.environmentParameters.forEach((e) => {
      if (!e.includes('=')) push(`${at}: environment parameter "${e}" must be KEY=value`);
    });
  });

  if (!Number.isInteger(spec.instances) || spec.instances < 1 || spec.instances > 100) {
    push('instances must be an integer between 1 and 100');
  }
  if (!Number.isInteger(spec.expire) || spec.expire < 1)
    push('expire must be a positive number of blocks');
  if (spec.expire > MAX_EXPIRE_BLOCKS)
    push(`expire must be <= ${MAX_EXPIRE_BLOCKS} blocks (12 months)`);
  if (spec.contacts.length > 5) push('at most 5 contacts');
  if (spec.nodes.length > 120) push('at most 120 target nodes');
  if (spec.geolocation.length > 10) push('at most 10 geolocation rules');

  return errors;
}

/**
 * Non-fatal advice. Flux reschedules instances when nodes go away, so state
 * that lives on one node is lost with it unless the mount is replicated.
 */
export function durabilityWarnings(spec: AppSpec): string[] {
  const warnings: string[] = [];
  spec.compose.forEach((component) => {
    const primary = String(component.containerData).split('|')[0] ?? '';
    if (!/^[rgs]+:/.test(primary)) {
      warnings.push(
        `${component.name}: containerData "${primary}" is node-local, so its data is lost when the instance moves. Prefix it with "r:" to replicate across instances, or "g:" for primary/standby.`,
      );
    }
    component.ports.forEach((p) => {
      if (isPortEnterprise(p))
        warnings.push(`${component.name}: port ${p} is an enterprise port and is billed extra.`);
    });
  });
  return warnings;
}

/** The exact byte string that the owner signs. */
export function signablePayload(formatted: AppSpec, timestamp: number, type: string): string {
  return type + MESSAGE_VERSION + JSON.stringify(formatted) + timestamp;
}

// ---------------------------------------------------------------------------
// Builder from simple inputs
// ---------------------------------------------------------------------------

export interface SimplePort {
  /** Port exposed on the public internet. Picked from 31000-39999 when omitted. */
  port?: number | undefined;
  /** Port the container listens on. */
  containerPort: number;
  /** Custom domain to route to this port, if any. */
  domain?: string | undefined;
}

export interface SimpleComponent {
  name?: string | undefined;
  description?: string | undefined;
  image: string;
  ports?: SimplePort[] | undefined;
  env?: Record<string, string> | string[] | undefined;
  commands?: string[] | undefined;
  /** Path inside the container that should persist. */
  dataPath?: string | undefined;
  /** Replicate the data path across instances (Syncthing). Default true. */
  replicateData?: boolean | undefined;
  cpu: number;
  ram: number;
  hdd: number;
  /** "user:token" for a private registry. */
  repoauth?: string | undefined;
}

export interface SimpleApp {
  name: string;
  description?: string | undefined;
  owner: string;
  components: SimpleComponent[];
  instances?: number | undefined;
  months?: number | undefined;
  expireBlocks?: number | undefined;
  contacts?: string[] | undefined;
  geolocation?: string[] | undefined;
  nodes?: string[] | undefined;
  staticip?: boolean | undefined;
}

function hashPort(seed: string, index: number): number {
  let h = 2166136261;
  for (const ch of `${seed}:${index}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return 31000 + (h % 9000);
}

function envList(env: SimpleComponent['env']): string[] {
  if (!env) return [];
  if (Array.isArray(env)) return env;
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

/** Turn a friendly description of an app into a complete, formatted v8 specification. */
export function buildSpecification(input: SimpleApp): AppSpec {
  const usedPorts = new Set<number>();
  let portIndex = 0;
  const components = input.components.map((c, i) => {
    const name = c.name ?? (input.components.length === 1 ? input.name : `${input.name}${i + 1}`);
    const ports: number[] = [];
    const containerPorts: number[] = [];
    const domains: string[] = [];
    for (const p of c.ports ?? []) {
      let publicPort = p.port;
      if (publicPort === undefined) {
        do {
          publicPort = hashPort(input.name, portIndex);
          portIndex += 1;
        } while (usedPorts.has(publicPort) || isPortBanned(publicPort));
      }
      usedPorts.add(publicPort);
      ports.push(publicPort);
      containerPorts.push(p.containerPort);
      domains.push(p.domain ?? '');
    }
    const dataPath = c.dataPath ?? '/data';
    const replicate = c.replicateData ?? true;
    return formatComponent({
      name,
      description: c.description ?? `${name} component of ${input.name}`,
      repotag: c.image,
      ports,
      domains,
      environmentParameters: envList(c.env),
      commands: c.commands ?? [],
      containerPorts,
      containerData: replicate ? `r:${dataPath}` : dataPath,
      cpu: c.cpu,
      ram: c.ram,
      hdd: c.hdd,
      repoauth: c.repoauth ?? '',
    });
  });

  const expire = input.expireBlocks ?? Math.round((input.months ?? 1) * BLOCKS_PER_MONTH);

  return formatSpecification({
    version: SPEC_VERSION,
    name: input.name,
    description: input.description ?? `${input.name} on Flux Cloud`,
    owner: input.owner,
    compose: components,
    instances: input.instances ?? 3,
    contacts: input.contacts ?? [],
    geolocation: input.geolocation ?? [],
    expire,
    nodes: input.nodes ?? [],
    staticip: input.staticip ?? false,
  });
}

export function totalResources(spec: AppSpec): { cpu: number; ram: number; hdd: number } {
  return spec.compose.reduce(
    (acc, c) => ({ cpu: acc.cpu + c.cpu, ram: acc.ram + c.ram, hdd: acc.hdd + c.hdd }),
    { cpu: 0, ram: 0, hdd: 0 },
  );
}

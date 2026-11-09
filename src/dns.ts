import { Resolver, lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { NET_DOMAIN } from '@jumperly/schema';
import { type Aliases, aliasKey } from './aliases';

export interface DnsRecord {
  address: string;
  ttl: number;
}

/** Where the names really get resolved; throws errors with node:dns codes (`ENOTFOUND`, …). */
export interface DnsBackend {
  resolve(name: string, type: 'A' | 'AAAA'): Promise<DnsRecord[]>;
}

export type DnsAnswer =
  | { addrs: string[]; ttl: number; alias?: true }
  | { code: 'nxdomain' | 'servfail' | 'timeout' | 'policy' };

export interface DnsOptions {
  aliases: Aliases;
  /** Defaults to node:dns/promises on `servers` (or the system's servers). */
  backend?: DnsBackend;
  servers?: readonly string[];
  timeoutMs?: number;
  maxEntries?: number;
  /** The longest a positive answer is cached, in seconds. */
  maxTtl?: number;
  now?: () => number;
}

/** The node:dns/promises backend: one try per query, `timeoutMs` each. */
export function systemBackend(
  servers: readonly string[] | undefined,
  timeoutMs: number,
): DnsBackend {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  if (servers?.length) resolver.setServers([...servers]);
  return {
    resolve: (name, type) =>
      type === 'A'
        ? resolver.resolve4(name, { ttl: true })
        : resolver.resolve6(name, { ttl: true }),
  };
}

/** The TTL the helper gives an OS lookup, which tells none (seconds). */
export const LOOKUP_TTL = 30;

/**
 * The OS resolver (getaddrinfo, `dns.lookup`) for the local helper: it knows mDNS
 * `.local` names (Windows 10+, macOS, Linux with nss-mdns) and the router's `.lan` / `.home.arpa`,
 * which `Resolver` (straight to DNS servers) does not. Answers get `LOOKUP_TTL`.
 */
export function lookupBackend(
  hosts: Readonly<Record<string, string>> = {},
  lookup: (
    name: string,
    opts: { all: true; family: 4 | 6 },
  ) => Promise<Array<{ address: string; family: number }>> = (name, opts) => dnsLookup(name, opts),
): DnsBackend {
  return {
    resolve: async (name, type) => {
      const family = type === 'A' ? 4 : 6;
      const fixed = hosts[name];
      if (fixed !== undefined)
        return isIP(fixed) === family ? [{ address: fixed, ttl: LOOKUP_TTL }] : [];
      const found = await lookup(name, { all: true, family });
      return found
        .filter((a) => a.family === family)
        .map((a) => ({ address: a.address, ttl: LOOKUP_TTL }));
    },
  };
}

const LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;

function isDnsName(name: string): boolean {
  return name.length > 0 && name.length <= 253 && name.split('.').every((l) => LABEL.test(l));
}

function errorCode(err: unknown): DnsAnswer {
  const code = (err as { code?: unknown } | null)?.code;
  switch (code) {
    case 'ENOTFOUND':
      return { code: 'nxdomain' };
    case 'ENODATA':
      // NOERROR without records of this type.
      return { addrs: [], ttl: 0 };
    case 'ETIMEOUT':
      return { code: 'timeout' };
    default:
      return { code: 'servfail' };
  }
}

interface Entry {
  addrs: string[];
  expires: number;
}

/**
 * The gateway's DNS: real answers through node:dns, an LRU cache (1024 names, `min(ttl, 300 s)`),
 * a 5 s timeout. Aliases are answered without a query (`alias: true`, no addresses: the client
 * maps them to its own service addresses); other names of the reserved zone do not exist. Private
 * answers are returned as they are: `open` refuses them by policy.
 */
export class DnsResolver {
  private readonly backend: DnsBackend;
  private readonly timeoutMs: number;
  private readonly maxEntries: number;
  private readonly maxTtl: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<DnsAnswer>>();

  constructor(private readonly opts: DnsOptions) {
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.maxEntries = opts.maxEntries ?? 1024;
    this.maxTtl = opts.maxTtl ?? 300;
    this.now = opts.now ?? Date.now;
    this.backend = opts.backend ?? systemBackend(opts.servers, this.timeoutMs);
  }

  async resolve(rawName: string, type: 'A' | 'AAAA'): Promise<DnsAnswer> {
    const name = aliasKey(rawName);
    if (this.opts.aliases.get(name)) return { addrs: [], ttl: this.maxTtl, alias: true };
    if (!isDnsName(name) || name === NET_DOMAIN || name.endsWith(`.${NET_DOMAIN}`))
      return { code: 'nxdomain' };

    const key = `${type} ${name}`;
    const hit = this.cache.get(key);
    if (hit) {
      const left = hit.expires - this.now();
      if (left > 0) {
        // Refresh the LRU position.
        this.cache.delete(key);
        this.cache.set(key, hit);
        return { addrs: [...hit.addrs], ttl: Math.ceil(left / 1000) };
      }
      this.cache.delete(key);
    }

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.query(key, name, type).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    const answer = await pending;
    return 'addrs' in answer ? { ...answer, addrs: [...answer.addrs] } : answer;
  }

  private async query(key: string, name: string, type: 'A' | 'AAAA'): Promise<DnsAnswer> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
    });
    let records: DnsRecord[] | 'timeout';
    try {
      records = await Promise.race([this.backend.resolve(name, type), timeout]);
    } catch (err) {
      return errorCode(err);
    } finally {
      clearTimeout(timer);
    }
    if (records === 'timeout') return { code: 'timeout' };
    if (records.length === 0) return { addrs: [], ttl: 0 };
    const ttl = Math.min(this.maxTtl, ...records.map((r) => Math.max(0, Math.floor(r.ttl))));
    const addrs = records.map((r) => r.address);
    if (ttl > 0) {
      this.cache.set(key, { addrs, expires: this.now() + ttl * 1000 });
      while (this.cache.size > this.maxEntries) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
    }
    return { addrs, ttl };
  }
}

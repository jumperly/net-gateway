import { BlockList, isIPv4, isIPv6 } from 'node:net';
import type { Alias, Aliases } from './aliases';
import type { NetProto, NetRefuseCode } from './protocol';

/**
 * The SSRF policy of `open`. The host must be a canonical IP literal (the server never resolves a
 * name from `open`: no DNS rebinding, no time-of-check/time-of-use gap) or an alias; the address
 * must be outside the forbidden ranges, also through an embedded IPv4; the port must be on the
 * whitelist of its protocol. Aliases bypass all of it.
 */

const FORBIDDEN_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['255.255.255.255', 32],
];

const FORBIDDEN_V6: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
];

/** IPv6 prefixes that carry an IPv4 address; they are judged by that address. */
const EMBEDDING: Array<{ prefix: number[]; at: number }> = [
  // ::ffff:0:0/96 (IPv4-mapped): the last 32 bits.
  { prefix: [0, 0, 0, 0, 0, 0xffff], at: 12 },
  // 64:ff9b::/96 (NAT64): the last 32 bits.
  { prefix: [0x64, 0xff9b, 0, 0, 0, 0], at: 12 },
  // 2002::/16 (6to4): bits 16..47.
  { prefix: [0x2002], at: 2 },
];

function blockList(v4: Array<[string, number]>, v6: Array<[string, number]>): BlockList {
  const list = new BlockList();
  for (const [net, prefix] of v4) list.addSubnet(net, prefix, 'ipv4');
  for (const [net, prefix] of v6) list.addSubnet(net, prefix, 'ipv6');
  return list;
}

const FORBIDDEN = blockList(FORBIDDEN_V4, FORBIDDEN_V6);

/** The 16 bytes of a valid IPv6 literal (no zone). */
function ipv6Bytes(ip: string): Uint8Array {
  const out = new Uint8Array(16);
  let text = ip;
  const tail: number[] = [];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4?.[1]) {
    for (const part of v4[1].split('.')) tail.push(Number(part));
    text = text.slice(0, -v4[1].length);
    if (text.endsWith(':') && !text.endsWith('::')) text = text.slice(0, -1);
  }
  const [head = '', rest] = text.split('::');
  const groups = (s: string) => (s ? s.split(':').map((g) => Number.parseInt(g, 16)) : []);
  const left = groups(head);
  const right = rest === undefined ? [] : groups(rest);
  const words = 8 - tail.length / 2;
  const all = [...left, ...new Array(words - left.length - right.length).fill(0), ...right];
  all.forEach((w, i) => {
    out[i * 2] = w >> 8;
    out[i * 2 + 1] = w & 0xff;
  });
  out.set(tail, 16 - tail.length);
  return out;
}

/** The IPv4 address inside a mapped, NAT64 or 6to4 IPv6 address, if it is one. */
export function embeddedIpv4(ip: string): string | undefined {
  if (!isIPv6(ip)) return undefined;
  const bytes = ipv6Bytes(ip);
  for (const { prefix, at } of EMBEDDING) {
    if (prefix.every((w, i) => ((bytes[i * 2] ?? 0) << 8) + (bytes[i * 2 + 1] ?? 0) === w))
      return Array.from(bytes.subarray(at, at + 4)).join('.');
  }
  return undefined;
}

function listed(list: BlockList, ip: string): boolean {
  if (isIPv4(ip)) return list.check(ip, 'ipv4');
  if (!isIPv6(ip)) return false;
  const v4 = embeddedIpv4(ip);
  if (v4 !== undefined) return list.check(v4, 'ipv4');
  return list.check(ip, 'ipv6');
}

/** True when `ip` (a valid literal) is private, reserved, or embeds such an IPv4 address. */
export function isBlockedIp(ip: string): boolean {
  return listed(FORBIDDEN, ip);
}

/** The RFC 5952 text of an IPv6 literal, as the WHATWG URL parser serializes it. */
function formatIpv6(ip: string): string | null {
  try {
    return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/**
 * The literal when `host` is the canonical text of an IP address: a dotted quad without leading
 * zeros, or a lower-case compressed IPv6 (RFC 5952; an IPv4-mapped address also in its dotted
 * form `::ffff:a.b.c.d`). Null for anything else: names, `127.1`, `0x7f.0.0.1`, `2130706433`,
 * `[::1]`, `0:0:0:0:0:0:0:1`, zones (`fe80::1%eth0`).
 */
export function canonicalIp(host: string): { ip: string; family: 4 | 6 } | null {
  // node:net accepts only four decimal octets without leading zeros: that is the canonical form.
  if (isIPv4(host)) return { ip: host, family: 4 };
  if (!isIPv6(host) || host.includes('%')) return null;
  if (formatIpv6(host) === host) return { ip: host, family: 6 };
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (mapped?.[1] && isIPv4(mapped[1])) return { ip: host, family: 6 };
  return null;
}

export type Target =
  | { kind: 'ip'; ip: string; family: 4 | 6; port: number }
  | { kind: 'alias'; alias: Alias; port: number };

export type Verdict =
  | { ok: true; target: Target }
  | { ok: false; code: NetRefuseCode; reason: string };

export interface PolicyOptions {
  tcpPorts: readonly number[];
  udpPorts: readonly number[];
  aliases: Aliases;
  /** Test only: ranges let through despite the forbidden list. */
  allowCidrs?: readonly string[];
}

function refuse(code: NetRefuseCode, reason: string): Verdict {
  return { ok: false, code, reason };
}

export class Policy implements FlowPolicy {
  private readonly tcpPorts: ReadonlySet<number>;
  private readonly udpPorts: ReadonlySet<number>;
  private readonly allow: BlockList | undefined;

  constructor(private readonly opts: PolicyOptions) {
    this.tcpPorts = new Set(opts.tcpPorts);
    this.udpPorts = new Set(opts.udpPorts);
    if (opts.allowCidrs?.length) {
      this.allow = new BlockList();
      for (const cidr of opts.allowCidrs) {
        const [net = '', bits = ''] = cidr.split('/');
        const family = isIPv4(net) ? 'ipv4' : isIPv6(net) ? 'ipv6' : undefined;
        const prefix = Number(bits);
        if (
          !family ||
          !Number.isInteger(prefix) ||
          prefix < 0 ||
          prefix > (family === 'ipv4' ? 32 : 128)
        )
          throw new Error(`allowCidrs: "${cidr}" is not a CIDR range`);
        this.allow.addSubnet(net, prefix, family);
      }
    }
  }

  /** May a flow `proto` to `host:port` be opened? */
  check(host: string, port: number, proto: NetProto): Verdict {
    const alias = this.opts.aliases.get(host);
    if (alias) {
      if (proto !== 'tcp') return refuse('policy.proto', `${alias.name} accepts TCP only`);
      return { ok: true, target: { kind: 'alias', alias, port } };
    }
    if (proto === 'udp' && this.udpPorts.size === 0)
      return refuse('policy.proto', 'UDP to the internet is off on this gateway');
    const literal = canonicalIp(host);
    if (!literal)
      return refuse(
        'policy.host',
        `"${host}" is not a canonical IP address or a gateway alias; resolve names first`,
      );
    if (!this.remoteAllowed(literal.ip))
      return refuse(
        'policy.private',
        `${literal.ip} is a private or reserved address; only the public internet is reachable (a local helper will reach the LAN later)`,
      );
    const ports = proto === 'tcp' ? this.tcpPorts : this.udpPorts;
    if (!ports.has(port))
      return refuse(
        'policy.port',
        `${proto.toUpperCase()} port ${port} is not allowed; allowed: ${[...ports].join(', ')}`,
      );
    return { ok: true, target: { kind: 'ip', ...literal, port } };
  }

  /** The re-check of the peer address after connect (`socket.remoteAddress`). */
  remoteAllowed(ip: string): boolean {
    if (this.allow && listed(this.allow, ip)) return true;
    if (!isIPv4(ip) && !isIPv6(ip)) return false;
    return !isBlockedIp(ip);
  }
}

/** What a session asks of its flow policy: the server's `Policy` or the helper's `LanPolicy`. */
export interface FlowPolicy {
  check(host: string, port: number, proto: NetProto): Verdict;
  remoteAllowed(ip: string): boolean;
}

/** A CIDR as `[network, prefix, family]`, or an error naming it. */
function parseCidr(cidr: string): [string, number, 'ipv4' | 'ipv6'] {
  const [net = '', bits = ''] = cidr.split('/');
  const family = isIPv4(net) ? 'ipv4' : isIPv6(net) ? 'ipv6' : undefined;
  const prefix = Number(bits);
  if (
    !family ||
    bits === '' ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > (family === 'ipv4' ? 32 : 128)
  )
    throw new Error(`"${cidr}" is not a CIDR range`);
  return [net, prefix, family];
}

/** The network address of `ip` under `prefix` bits (IPv4). */
function ipv4Network(ip: string, prefix: number): string {
  const n = ip.split('.').reduce((v, p) => v * 256 + Number(p), 0);
  const size = 2 ** (32 - prefix);
  const base = Math.floor(n / size) * size;
  return [24, 16, 8, 0].map((s) => Math.floor(base / 2 ** s) % 256).join('.');
}

/** The IPv4 subnets of the machine's interfaces (not loopback) as CIDRs, e.g. `192.168.1.0/24`. */
export function interfaceCidrs(
  interfaces: NodeJS.Dict<
    Array<{ family: string | number; internal: boolean; cidr: string | null; address: string }>
  >,
): string[] {
  const out = new Set<string>();
  for (const list of Object.values(interfaces))
    for (const a of list ?? []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal || !a.cidr) continue;
      const prefix = Number(a.cidr.split('/')[1]);
      // Not a whole internet: a /0../7 "subnet" is a misconfiguration, take the host only.
      out.add(prefix >= 8 ? `${ipv4Network(a.address, prefix)}/${prefix}` : `${a.address}/32`);
    }
  return [...out];
}

/** A test redirect target: `ip` or `ipv4:port`. */
function redirectTarget(to: string): { ip: string; family: 4 | 6; port?: number } | null {
  const m = /^(\d+\.\d+\.\d+\.\d+):(\d{1,5})$/.exec(to);
  const literal = canonicalIp(m ? (m[1] as string) : to);
  if (!literal) return null;
  return m ? { ...literal, port: Number(m[2]) } : literal;
}

export interface LanPolicyOptions {
  /** The LAN: the interfaces' subnets and the configured ranges. */
  cidrs: readonly string[];
  allowLoopback: boolean;
  /** Test only: a LAN address dialled at another one (`ip`, or `ipv4:port` for another port too). */
  redirect?: Readonly<Record<string, string>>;
}

/**
 * The local helper's policy: a flow goes only to the LAN — the subnets of the machine's
 * interfaces and configured ranges, never the machine itself unless allowed — on any port and
 * protocol. Public addresses are the server gateway's; names are resolved first, as on the server.
 */
export class LanPolicy implements FlowPolicy {
  private readonly lan = new BlockList();
  private readonly redirect: ReadonlyMap<string, string>;
  readonly cidrs: readonly string[];

  constructor(opts: LanPolicyOptions) {
    this.cidrs = [...opts.cidrs];
    for (const cidr of opts.cidrs) {
      const [net, prefix, family] = parseCidr(cidr);
      this.lan.addSubnet(net, prefix, family);
    }
    if (opts.allowLoopback) {
      this.lan.addSubnet('127.0.0.0', 8, 'ipv4');
      this.lan.addAddress('::1', 'ipv6');
    }
    this.redirect = new Map(Object.entries(opts.redirect ?? {}));
  }

  check(host: string, port: number, proto: NetProto): Verdict {
    const literal = canonicalIp(host);
    if (!literal)
      return refuse('policy.host', `"${host}" is not a canonical IP address; resolve names first`);
    if (!this.inLan(literal.ip))
      return refuse(
        'policy.host',
        `${literal.ip} is outside this helper's LAN (${this.cidrs.join(', ') || 'no subnet'})`,
      );
    if (port < 1 || port > 65535) return refuse('policy.port', `${proto} port ${port}`);
    const to = this.redirect.get(literal.ip);
    if (!to) return { ok: true, target: { kind: 'ip', ...literal, port } };
    const r = redirectTarget(to);
    if (!r) return refuse('policy.host', `bad redirect of ${literal.ip}`);
    return { ok: true, target: { kind: 'ip', ip: r.ip, family: r.family, port: r.port ?? port } };
  }

  remoteAllowed(ip: string): boolean {
    for (const to of this.redirect.values()) if (redirectTarget(to)?.ip === ip) return true;
    return this.inLan(ip);
  }

  private inLan(ip: string): boolean {
    if (isIPv4(ip)) return this.lan.check(ip, 'ipv4');
    if (!isIPv6(ip)) return false;
    const v4 = embeddedIpv4(ip);
    if (v4 !== undefined) return this.lan.check(v4, 'ipv4');
    return this.lan.check(ip, 'ipv6');
  }
}

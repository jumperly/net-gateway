import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { AliasTarget } from './aliases';

export interface GatewayConfig {
  /**
   * `server`: the public internet gateway. `helper`: the local helper on the user's machine
   * with the LAN only, port forwards and the OS resolver.
   */
  mode: 'server' | 'helper';
  host: string;
  port: number;
  /** Allowed `Origin` of the WebSocket upgrade; `*` allows any. */
  origins: string[];
  tcpPorts: number[];
  /** Empty: UDP to the internet is off. */
  udpPorts: number[];
  limits: {
    maxConns: number;
    connPerMin: number;
    bytesPerSec: number;
    totalBytes: number;
    sessionsPerIp: number;
    framesPerSec: number;
  };
  timeouts: {
    helloMs: number;
    connectMs: number;
    tcpIdleMs: number;
    sessionIdleMs: number;
    /** WebSocket heartbeat: a ping every interval, a client silent for two is dropped. */
    pingMs: number;
  };
  /** DNS servers for name lookups; empty: the system's. */
  dnsServers: string[];
  aliases: Record<string, AliasTarget>;
  /** Test only: ranges let through despite the SSRF policy. */
  allowCidrs: string[];
  /** Non-empty: `hello.token` must be one of these (TokenAuthorizer). */
  tokens: string[];
  /** Take the client IP from X-Forwarded-For (behind a reverse proxy). */
  trustProxy: boolean;
  /** Shared secret of `GET /api/net/internal/stats` (`x-internal-token`); unset: the route is off. */
  internalToken?: string;
  helper: {
    /** LAN ranges beside the subnets of the machine's own interfaces (CIDR). */
    lanCidrs: string[];
    /** Let flows reach the machine itself (127.0.0.0/8, ::1). */
    allowLoopback: boolean;
    /** Where forwarded ports listen. */
    listenHost: string;
    /** The lowest port a forward may take (privileged ports need rights). */
    listenPortMin: number;
    /** Forwards of one session at once. */
    maxListeners: number;
    /** A connection to a forward that the page does not accept in this long is dropped. */
    acceptMs: number;
    /** Test only: an address of the LAN is dialled at another one (`192.0.2.10` → `127.0.0.1`). */
    redirect: Record<string, string>;
    /** Test only: names answered before the OS resolver (`printer.local` → `192.0.2.10`). */
    hosts: Record<string, string>;
  };
  mqtt: {
    /** The MQTT broker `mqtt.jumperly.internal:1883` (one aedes per namespace). */
    enabled: boolean;
    /** Serve sessions without `hello.ns` with one shared broker `default` (development only). */
    shared: boolean;
    /** A TCP port on 127.0.0.1 for external MQTT tools (username = namespace); 0: off. */
    debugPort: number;
    /** A broker nobody uses is unloaded after this long. */
    idleMs: number;
  };
}

const MiB = 1024 * 1024;

/** The defaults: listen on loopback only, the dev origins of the web app. */
export const DEFAULT_CONFIG: GatewayConfig = {
  mode: 'server',
  host: '127.0.0.1',
  port: 3002,
  origins: [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
  ],
  tcpPorts: [80, 443, 1883, 8883, 8080],
  udpPorts: [],
  limits: {
    maxConns: 8,
    connPerMin: 30,
    bytesPerSec: 256 * 1024,
    totalBytes: 64 * MiB,
    sessionsPerIp: 4,
    framesPerSec: 1000,
  },
  timeouts: {
    helloMs: 5_000,
    connectMs: 10_000,
    tcpIdleMs: 5 * 60_000,
    sessionIdleMs: 10 * 60_000,
    pingMs: 20_000,
  },
  dnsServers: [],
  aliases: {},
  allowCidrs: [],
  tokens: [],
  trustProxy: false,
  helper: {
    lanCidrs: [],
    allowLoopback: false,
    listenHost: '0.0.0.0',
    listenPortMin: 1024,
    maxListeners: 8,
    acceptMs: 10_000,
    redirect: {},
    hosts: {},
  },
  mqtt: { enabled: true, shared: false, debugPort: 0, idleMs: 10 * 60_000 },
};

/** What the local helper changes in the defaults: its own port, no MQTT broker. */
export const HELPER_DEFAULTS: ConfigOverrides = {
  mode: 'helper',
  port: 3003,
  // The production app, the dev origins and the second dev server (`vite` picks :5174 when :5173
  // is taken).
  origins: [
    'https://app.jumperly.dev',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5174',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
  ],
  limits: { maxConns: 16 },
  mqtt: { enabled: false },
};

const MIN_INTERNAL_TOKEN = 16;
const port = z.number().int().min(1).max(65535);
const count = z.number().int().nonnegative();
const ms = z.number().int().positive();

const fileSchema = z
  .object({
    mode: z.enum(['server', 'helper']),
    host: z.string().min(1),
    port: port,
    origins: z.array(z.string().min(1)),
    tcpPorts: z.array(port),
    udpPorts: z.array(port),
    limits: z
      .object({
        maxConns: count,
        connPerMin: count,
        bytesPerSec: z.number().int().positive(),
        totalBytes: count,
        sessionsPerIp: count,
        framesPerSec: z.number().int().positive(),
      })
      .strict()
      .partial(),
    timeouts: z
      .object({ helloMs: ms, connectMs: ms, tcpIdleMs: ms, sessionIdleMs: ms, pingMs: ms })
      .strict()
      .partial(),
    dnsServers: z.array(z.string().min(1)),
    aliases: z.record(
      z.discriminatedUnion('kind', [
        z
          .object({ kind: z.literal('tcp'), host: z.string().min(1), port: port.optional() })
          .strict(),
        z.object({ kind: z.literal('mqtt') }).strict(),
      ]),
    ),
    allowCidrs: z.array(z.string().min(1)),
    tokens: z.array(z.string().min(1)),
    trustProxy: z.boolean(),
    internalToken: z.string().min(MIN_INTERNAL_TOKEN),
    helper: z
      .object({
        lanCidrs: z.array(z.string().min(1)),
        allowLoopback: z.boolean(),
        listenHost: z.string().min(1),
        listenPortMin: port,
        maxListeners: count,
        acceptMs: ms,
        redirect: z.record(z.string().min(1)),
        hosts: z.record(z.string().min(1)),
      })
      .strict()
      .partial(),
    mqtt: z
      .object({
        enabled: z.boolean(),
        shared: z.boolean(),
        debugPort: z.number().int().min(0).max(65535),
        idleMs: ms,
      })
      .strict()
      .partial(),
  })
  .strict()
  .partial();

export type ConfigOverrides = z.infer<typeof fileSchema>;

/**
 * The defaults (the helper's in `mode: 'helper'`, HELPER_DEFAULTS) with `overrides` applied
 * (`limits`, `timeouts`, `helper` and `mqtt` field by field).
 */
export function resolveConfig(overrides: ConfigOverrides = {}): GatewayConfig {
  const base = overrides.mode === 'helper' ? mergeOverrides(HELPER_DEFAULTS, overrides) : overrides;
  const { limits, timeouts, mqtt, helper, ...rest } = base;
  const cleaned = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  return {
    ...DEFAULT_CONFIG,
    ...cleaned,
    limits: { ...DEFAULT_CONFIG.limits, ...limits },
    timeouts: { ...DEFAULT_CONFIG.timeouts, ...timeouts },
    helper: { ...DEFAULT_CONFIG.helper, ...helper },
    mqtt: { ...DEFAULT_CONFIG.mqtt, ...mqtt },
  };
}

function mergeOverrides(a: ConfigOverrides, b: ConfigOverrides): ConfigOverrides {
  return {
    ...a,
    ...b,
    limits: { ...a.limits, ...b.limits },
    timeouts: { ...a.timeouts, ...b.timeouts },
    helper: { ...a.helper, ...b.helper },
    mqtt: { ...a.mqtt, ...b.mqtt },
  };
}

function list(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function int(name: string, value: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`${name} must be an integer ${min}..${max}, got "${value}"`);
  return n;
}

function ports(name: string, value: string): number[] {
  return list(value).map((p) => int(name, p, 1, 65535));
}

function bool(name: string, value: string): boolean {
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off|)$/i.test(value)) return false;
  throw new Error(`${name} must be 1/0 or true/false, got "${value}"`);
}

export interface LoadedConfig {
  config: GatewayConfig;
  /** Things the operator must see at startup (allowCidrs, a non-loopback host without tokens). */
  warnings: string[];
}

/**
 * The configuration: the defaults, then the JSON file `NETGW_CONFIG` (aliases and allowCidrs live
 * only there), then the `NETGW_*` variables.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): LoadedConfig {
  let file: ConfigOverrides = {};
  if (env.NETGW_CONFIG) {
    let json: unknown;
    try {
      json = JSON.parse(readFile(env.NETGW_CONFIG));
    } catch (err) {
      throw new Error(`NETGW_CONFIG ${env.NETGW_CONFIG}: ${(err as Error).message}`);
    }
    const parsed = fileSchema.safeParse(json);
    if (!parsed.success)
      throw new Error(
        `NETGW_CONFIG ${env.NETGW_CONFIG}: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || 'config'}: ${i.message}`)
          .join('; ')}`,
      );
    file = parsed.data;
  }

  const limits = { ...file.limits };
  const timeouts = { ...file.timeouts };
  const mqtt = { ...file.mqtt };
  const helper = { ...file.helper };
  const o: ConfigOverrides = { ...file };
  const on = (name: string, apply: (value: string) => void) => {
    const value = env[name]?.trim();
    if (value !== undefined) apply(value);
  };
  on('NETGW_MODE', (s) => {
    if (s !== 'server' && s !== 'helper')
      throw new Error(`NETGW_MODE must be server or helper, got "${s}"`);
    o.mode = s;
  });
  on('NETGW_LAN_CIDRS', (s) => {
    helper.lanCidrs = list(s);
  });
  on('NETGW_ALLOW_LOOPBACK', (s) => {
    helper.allowLoopback = bool('NETGW_ALLOW_LOOPBACK', s);
  });
  on('NETGW_LISTEN_HOST', (s) => {
    if (s) helper.listenHost = s;
  });
  on('NETGW_HOST', (s) => {
    if (s) o.host = s;
  });
  on('NETGW_PORT', (s) => {
    o.port = int('NETGW_PORT', s, 1, 65535);
  });
  on('NETGW_ORIGINS', (s) => {
    o.origins = list(s);
  });
  on('NETGW_TCP_PORTS', (s) => {
    o.tcpPorts = ports('NETGW_TCP_PORTS', s);
  });
  on('NETGW_UDP_PORTS', (s) => {
    o.udpPorts = ports('NETGW_UDP_PORTS', s);
  });
  on('NETGW_MAX_CONNS', (s) => {
    limits.maxConns = int('NETGW_MAX_CONNS', s, 0);
  });
  on('NETGW_CONN_PER_MIN', (s) => {
    limits.connPerMin = int('NETGW_CONN_PER_MIN', s, 0);
  });
  on('NETGW_BYTES_PER_SEC', (s) => {
    limits.bytesPerSec = int('NETGW_BYTES_PER_SEC', s, 1);
  });
  on('NETGW_TOTAL_BYTES', (s) => {
    limits.totalBytes = int('NETGW_TOTAL_BYTES', s, 0);
  });
  on('NETGW_SESSIONS_PER_IP', (s) => {
    limits.sessionsPerIp = int('NETGW_SESSIONS_PER_IP', s, 0);
  });
  on('NETGW_FRAMES_PER_SEC', (s) => {
    limits.framesPerSec = int('NETGW_FRAMES_PER_SEC', s, 1);
  });
  on('NETGW_CONNECT_TIMEOUT_MS', (s) => {
    timeouts.connectMs = int('NETGW_CONNECT_TIMEOUT_MS', s, 1);
  });
  on('NETGW_TCP_IDLE_MS', (s) => {
    timeouts.tcpIdleMs = int('NETGW_TCP_IDLE_MS', s, 1);
  });
  on('NETGW_SESSION_IDLE_MS', (s) => {
    timeouts.sessionIdleMs = int('NETGW_SESSION_IDLE_MS', s, 1);
  });
  on('NETGW_DNS_SERVERS', (s) => {
    o.dnsServers = list(s);
  });
  on('NETGW_TOKENS', (s) => {
    o.tokens = list(s);
  });
  on('NETGW_TRUST_PROXY', (s) => {
    o.trustProxy = bool('NETGW_TRUST_PROXY', s);
  });
  on('INTERNAL_TOKEN', (s) => {
    if (s === '') return;
    if (s.length < MIN_INTERNAL_TOKEN)
      throw new Error(`INTERNAL_TOKEN must be at least ${MIN_INTERNAL_TOKEN} characters`);
    o.internalToken = s;
  });
  on('NETGW_MQTT', (s) => {
    mqtt.enabled = bool('NETGW_MQTT', s);
  });
  on('NETGW_MQTT_SHARED', (s) => {
    mqtt.shared = bool('NETGW_MQTT_SHARED', s);
  });
  on('NETGW_MQTT_DEBUG_PORT', (s) => {
    mqtt.debugPort = s === '' ? 0 : int('NETGW_MQTT_DEBUG_PORT', s, 0, 65535);
  });
  on('NETGW_MQTT_IDLE_MS', (s) => {
    mqtt.idleMs = int('NETGW_MQTT_IDLE_MS', s, 1);
  });
  o.limits = limits;
  o.timeouts = timeouts;
  o.mqtt = mqtt;
  o.helper = helper;

  const config = resolveConfig(o);
  const warnings: string[] = [];
  if (config.allowCidrs.length)
    warnings.push(
      `!!! allowCidrs = ${config.allowCidrs.join(', ')}: the SSRF policy lets these ranges through. TEST ONLY - never in production. !!!`,
    );
  if (!/^(127\.|::1$|localhost$)/.test(config.host) && config.tokens.length === 0)
    warnings.push(
      `listening on ${config.host} without NETGW_TOKENS: an open proxy for anyone who can reach it and fake an allowed Origin`,
    );
  if (config.mqtt.enabled && config.mqtt.shared)
    warnings.push(
      "NETGW_MQTT_SHARED=1: pages without a namespace share one MQTT broker and see each other's topics (development only)",
    );
  if (Object.keys(config.helper.redirect).length)
    warnings.push(
      `!!! helper.redirect = ${JSON.stringify(config.helper.redirect)}: LAN addresses are dialled elsewhere. TEST ONLY. !!!`,
    );
  if (Object.keys(config.helper.hosts).length)
    warnings.push(
      `!!! helper.hosts = ${JSON.stringify(config.helper.hosts)}: names answered before the OS resolver. TEST ONLY. !!!`,
    );
  if (config.mode === 'helper' && config.helper.allowLoopback)
    warnings.push(
      'NETGW_ALLOW_LOOPBACK=1: simulated boards reach the services of this machine (127.0.0.1)',
    );
  if (config.origins.includes('*'))
    warnings.push('NETGW_ORIGINS contains "*": pages of any site may use this gateway');
  return { config, warnings };
}

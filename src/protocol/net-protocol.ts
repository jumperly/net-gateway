import { z } from 'zod';
import type { GattServiceDesc } from './gatt';

/**
 * Gateway protocol v1 between the web hub (or a test client) and a network gateway: our server
 * proxy (the public internet) or the local helper (the user's LAN).
 *
 * One WebSocket per session. A text frame is one JSON message of at most `NET_TEXT_MAX` bytes;
 * a binary frame is `[u8 kind][u32 sid BE][payload ≤ NET_FRAME_MAX]` (kind 1 TCP data, 2 a UDP
 * datagram). A peer closes the socket with 1008 on any malformed frame.
 */
export const NET_PATH = '/net/v1';
export const NET_SUBPROTOCOL = 'jumperly-net.1';
/** The most payload bytes one binary frame carries. */
export const NET_FRAME_MAX = 16384;
/** The default receive window of a flow (`open.window`, `opened.window`). */
export const NET_WINDOW = 65536;
/** The most UTF-8 bytes of one text frame. */
export const NET_TEXT_MAX = 8192;
export const MQTT_HOST = 'mqtt.jumperly.internal';
/** The reserved zone: the MQTT broker, `<boardId>.jumperly.internal` and the gateway aliases. */
export const NET_DOMAIN = 'jumperly.internal';

export type NetProto = 'tcp' | 'udp';
export type NetCap =
  | 'tcp'
  | 'udp'
  | 'dns'
  | 'mqtt'
  | 'listen'
  | 'wifi.scan'
  | 'ble.scan'
  | 'ble.gatt'
  | 'ble.serve';
/** The most devices one `ble.devices` frame carries (64 with advertising data would pass 8 KiB). */
export const BLE_DEVICES_PER_FRAME = 20;
/** A Bluetooth LE device around the helper's machine; `adv` / `rsp`: AD structures in hex. */
export interface NetBleDevice {
  addr: string;
  random: boolean;
  rssi: number;
  name?: string;
  adv: string;
  rsp: string;
  connectable: boolean;
}
/**
 * The helper's Bluetooth: `starting` (the sidecar is being built and started), `ready`, `off` (the
 * radio is switched off), `none` (no adapter), `failed`.
 */
export type NetBleState = 'starting' | 'ready' | 'off' | 'none' | 'failed';
export type NetBleOp = 'read' | 'write' | 'writeNoResponse' | 'notify';
export type NetRefuseCode =
  | 'policy.private'
  | 'policy.port'
  | 'policy.proto'
  | 'policy.host'
  | 'limit.conns'
  | 'limit.rate'
  | 'limit.bytes'
  | 'limit.total'
  | 'limit.sessions'
  | 'net.refused'
  | 'net.unreachable'
  | 'net.timeout'
  | 'net.reset'
  | 'gateway.offline'
  | 'gateway.lost'
  | 'gateway.shutdown'
  | 'lan.nohost'
  /** The hub's own HTTP path without the helper: the fetch failed / the guest's bytes are not HTTP. */
  | 'lan.fetch'
  | 'lan.nothttp'
  | 'unsupported';

export interface NetLimits {
  maxConns: number;
  connPerMin: number;
  bytesPerSec: number;
  totalBytes: number;
  tcpPorts: number[];
  udpPorts: number[];
}

/** Client (web hub) → gateway. */
export type NetClientMsg =
  | { t: 'hello'; v: 1; client: string; caps: NetCap[]; ns?: string; token?: string }
  /** `host`: a canonical IPv4/IPv6 literal or an alias the gateway announced; never a name to resolve. */
  | {
      t: 'open';
      sid: number;
      proto: NetProto;
      host: string;
      port: number;
      window: number;
      board?: string;
    }
  | { t: 'shutdown'; sid: number }
  | { t: 'close'; sid: number; abort?: boolean }
  | { t: 'credit'; sid: number; bytes: number }
  | { t: 'resolve'; qid: number; name: string; type: 'A' | 'AAAA' }
  | { t: 'mqtt.watch'; on: boolean }
  /** `payload`: base64. */
  | { t: 'mqtt.publish'; topic: string; payload: string; qos: 0 | 1; retain: boolean }
  | { t: 'ping'; ts: number }
  // The local helper; the server answers `unsupported`.
  /**
   * Forward the helper machine's `port` (`proto` TCP) into the simulation: `opened` while it
   * listens, `refused` if it cannot; `close { sid }` stops it.
   */
  | { t: 'listen'; sid: number; proto: NetProto; port: number }
  /** The answer to `incoming`: `ok` - the board took it, the flow runs; otherwise it is closed. */
  | { t: 'accept'; sid: number; ok: boolean }
  /** Reserved (real SSIDs as beacon-only access points). */
  | { t: 'wifi.scan' }
  // Bluetooth LE through the helper (Windows): scanning, then GATT connections by address.
  | { t: 'ble.scan'; on: boolean }
  | { t: 'ble.connect'; id: number; addr: string; random: boolean }
  /** `value`: hex (write); `on` (notify). */
  | {
      t: 'ble.op';
      id: number;
      conn: number;
      op: NetBleOp;
      ref: number;
      value?: string;
      on?: boolean;
    }
  | { t: 'ble.disconnect'; conn: number }
  // A board as a peripheral for a real phone (the helper's GATT server): its table by service,
  // then `ble.serve`; the answers to the phone's requests; the board's notifications.
  | { t: 'ble.serveService'; id: number; service: GattServiceDesc }
  | { t: 'ble.serve'; id: number }
  | { t: 'ble.unserve'; id: number }
  | { t: 'ble.serveReply'; req: number; value?: string; error?: string }
  | { t: 'ble.serveNotify'; id: number; ref: number; value: string };

/** Gateway → client. */
export type NetGatewayMsg =
  | {
      t: 'welcome';
      v: 1;
      gateway: 'server' | 'helper';
      scope: 'public' | 'lan';
      session: string;
      caps: NetCap[];
      limits: NetLimits;
      aliases: string[];
      mqtt?: { host: string; port: number };
      /** The helper: the LAN it reaches (CIDRs). */
      lan?: string[];
    }
  | { t: 'opened'; sid: number; remote: string; window: number }
  | { t: 'refused'; sid: number; code: NetRefuseCode; reason: string }
  | { t: 'eof'; sid: number }
  | { t: 'closed'; sid: number; reset: boolean; code?: NetRefuseCode; reason?: string }
  | { t: 'credit'; sid: number; bytes: number }
  | { t: 'resolved'; qid: number; addrs: string[]; ttl: number; alias?: boolean }
  | { t: 'unresolved'; qid: number; code: 'nxdomain' | 'servfail' | 'timeout' | 'policy' }
  /** `payload`: base64 of at most the first 4 KiB (`truncated`); `size`: the full length. */
  | {
      t: 'mqtt.message';
      topic: string;
      payload: string;
      qos: 0 | 1 | 2;
      retain: boolean;
      size: number;
      truncated: boolean;
      from?: string;
      at: number;
    }
  | { t: 'notice'; code: string; msg: string }
  | { t: 'pong'; ts: number }
  /**
   * The helper: a connection came to a forwarded `port` (of the helper machine) from `from`
   * (`ip:port`); `sid` is the helper's own (bit 31 set). Answered by `accept`. From the hub to a
   * worker `port` is the board's port and `board` the board the forward leads to.
   */
  | { t: 'incoming'; sid: number; port: number; from: string; board?: string }
  /** The helper: the Wi-Fi networks around its machine (2.4 GHz), the answer to `wifi.scan`. */
  | {
      t: 'wifi.networks';
      list: Array<{ ssid: string; rssi: number; channel: number; secure: boolean }>;
    }
  /** The helper's Bluetooth: once after `welcome` and on every change. */
  | { t: 'ble.state'; state: NetBleState; reason?: string }
  /** What changed among the devices around since the last frame (in parts of `BLE_DEVICES_PER_FRAME`). */
  | { t: 'ble.devices'; list: NetBleDevice[]; gone: string[] }
  /** One service of the table of `ble.connect` `id`, before its `ble.opened`. */
  | { t: 'ble.service'; id: number; service: GattServiceDesc }
  | { t: 'ble.opened'; id: number; conn: number }
  | { t: 'ble.failed'; id: number; reason: string }
  | { t: 'ble.result'; id: number; value?: string; error?: string }
  | { t: 'ble.notify'; conn: number; ref: number; value: string }
  | { t: 'ble.closed'; conn: number }
  /** The board's services are published (advertised, connectable). */
  | { t: 'ble.served'; id: number }
  | { t: 'ble.serveFailed'; id: number; reason: string }
  /** The phone reads / writes characteristic `ref` (the board's value handle); `ble.serveReply` answers `req`. */
  | { t: 'ble.serveRead'; id: number; req: number; ref: number }
  | { t: 'ble.serveWrite'; id: number; req: number; ref: number; value: string; response: boolean }
  /** Whether any phone is subscribed to characteristic `ref`. */
  | { t: 'ble.serveSubscribe'; id: number; ref: number; on: boolean }
  /** The publication ended on the helper's side (the radio, the sidecar). */
  | { t: 'ble.serveStopped'; id: number; reason: string };

/** Hub ↔ worker over the MessagePort: the same messages plus data and the hub's state. */
export type NetDataMsg = { t: 'data' | 'dgram'; sid: number; bytes: Uint8Array };
export type NetHubMsg = {
  t: 'hub';
  state: 'online' | 'connecting' | 'offline';
  gateways: Array<{ gateway: 'server' | 'helper'; scope: 'public' | 'lan'; caps: NetCap[] }>;
  aliases: string[];
  hint?: string;
  /** The Wi-Fi networks around (the local helper's last scan); absent without one. */
  nearby?: Array<{ ssid: string; rssi: number; channel: number; secure: boolean }>;
};

// --- Binary data frames -------------------------------------------------------------------------

const FRAME_HEADER = 5;
const U32_MAX = 0xffffffff;

function isU32(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= U32_MAX;
}

/** `[u8 kind][u32 sid BE][bytes]`; throws RangeError on a frame the receiver would reject. */
export function encodeDataFrame(kind: 1 | 2, sid: number, bytes: Uint8Array): Uint8Array {
  if (kind !== 1 && kind !== 2) throw new RangeError(`net frame kind ${kind}`);
  if (!isU32(sid)) throw new RangeError(`net frame sid ${sid}`);
  if (bytes.length > NET_FRAME_MAX) throw new RangeError(`net frame of ${bytes.length} bytes`);
  const frame = new Uint8Array(FRAME_HEADER + bytes.length);
  frame[0] = kind;
  new DataView(frame.buffer).setUint32(1, sid, false);
  frame.set(bytes, FRAME_HEADER);
  return frame;
}

/**
 * A binary frame, or null when it is malformed (too short, too long, unknown kind). `bytes` is a
 * view into `buf`, not a copy. A Uint8Array (a Node Buffer) is read at its own offset.
 */
export function decodeDataFrame(
  buf: ArrayBuffer | Uint8Array,
): { kind: 1 | 2; sid: number; bytes: Uint8Array } | null {
  const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (view.length < FRAME_HEADER || view.length > FRAME_HEADER + NET_FRAME_MAX) return null;
  const kind = view[0];
  if (kind !== 1 && kind !== 2) return null;
  const sid = new DataView(view.buffer, view.byteOffset, FRAME_HEADER).getUint32(1, false);
  return { kind, sid, bytes: view.subarray(FRAME_HEADER) };
}

// --- Text messages ------------------------------------------------------------------------------

const encoder = new TextEncoder();

function overTextMax(s: string): boolean {
  // Every UTF-16 unit is 1..3 UTF-8 bytes: skip the encoding when the bounds settle it.
  if (s.length > NET_TEXT_MAX) return true;
  if (s.length * 3 <= NET_TEXT_MAX) return false;
  return encoder.encode(s).length > NET_TEXT_MAX;
}

const u32 = z.number().int().min(0).max(U32_MAX);
const port = z.number().int().min(1).max(65535);
const count = z.number().int().nonnegative();
/** Strict base64 (RFC 4648 §4, padded, no line breaks); empty is an empty payload. */
const base64 = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, 'base64');
const utf8Max = (max: number) =>
  z
    .string()
    .min(1)
    .refine((s) => encoder.encode(s).length <= max, `at most ${max} UTF-8 bytes`);
const str = (max: number) => z.string().max(max);

const proto = z.enum(['tcp', 'udp']);
const cap = z.enum([
  'tcp',
  'udp',
  'dns',
  'mqtt',
  'listen',
  'wifi.scan',
  'ble.scan',
  'ble.gatt',
  'ble.serve',
]);
const caps = z.array(cap).max(16);
const refuseCode = z.enum([
  'policy.private',
  'policy.port',
  'policy.proto',
  'policy.host',
  'limit.conns',
  'limit.rate',
  'limit.bytes',
  'limit.total',
  'limit.sessions',
  'net.refused',
  'net.unreachable',
  'net.timeout',
  'net.reset',
  'gateway.offline',
  'gateway.lost',
  'gateway.shutdown',
  'lan.nohost',
  'lan.fetch',
  'lan.nothttp',
  'unsupported',
]);
/** A DNS name (≤ 253 bytes), an IP literal or an alias. */
const host = utf8Max(253);
const sid = u32;
const bleAddr = z.string().regex(/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/);
const hex = (maxBytes: number) =>
  z
    .string()
    .max(maxBytes * 2)
    .regex(/^(?:[0-9a-f]{2})*$/);
const uuid = z.string().regex(/^[0-9a-f-]{4,36}$/);
const bleDevice = z
  .object({
    addr: bleAddr,
    random: z.boolean(),
    rssi: z.number().int().min(-127).max(20),
    name: str(64).optional(),
    adv: hex(31),
    rsp: hex(31),
    connectable: z.boolean(),
  })
  .strict();
const gattService = z
  .object({
    uuid,
    characteristics: z
      .array(
        z
          .object({
            uuid,
            ref: u32,
            properties: z.number().int().min(0).max(255),
            descriptors: z.array(z.object({ uuid, ref: u32 }).strict()).max(16),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();

const clientSchema = z.discriminatedUnion('t', [
  z
    .object({
      t: z.literal('hello'),
      v: z.literal(1),
      client: z.string().min(1).max(128),
      caps,
      ns: z
        .string()
        .regex(/^[A-Za-z0-9_-]{8,64}$/)
        .optional(),
      token: z.string().min(1).max(1024).optional(),
    })
    .strict(),
  z
    .object({
      t: z.literal('open'),
      sid,
      proto,
      host,
      port,
      window: u32,
      board: z.string().min(1).max(64).optional(),
    })
    .strict(),
  z.object({ t: z.literal('shutdown'), sid }).strict(),
  z.object({ t: z.literal('close'), sid, abort: z.boolean().optional() }).strict(),
  z.object({ t: z.literal('credit'), sid, bytes: u32.min(1) }).strict(),
  z.object({ t: z.literal('resolve'), qid: u32, name: host, type: z.enum(['A', 'AAAA']) }).strict(),
  z.object({ t: z.literal('mqtt.watch'), on: z.boolean() }).strict(),
  z
    .object({
      t: z.literal('mqtt.publish'),
      topic: utf8Max(1024),
      payload: base64,
      qos: z.union([z.literal(0), z.literal(1)]),
      retain: z.boolean(),
    })
    .strict(),
  z.object({ t: z.literal('ping'), ts: z.number().finite() }).strict(),
  z.object({ t: z.literal('listen'), sid, proto, port }).strict(),
  z.object({ t: z.literal('accept'), sid, ok: z.boolean() }).strict(),
  z.object({ t: z.literal('wifi.scan') }).strict(),
  z.object({ t: z.literal('ble.scan'), on: z.boolean() }).strict(),
  z.object({ t: z.literal('ble.connect'), id: u32, addr: bleAddr, random: z.boolean() }).strict(),
  z
    .object({
      t: z.literal('ble.op'),
      id: u32,
      conn: u32,
      op: z.enum(['read', 'write', 'writeNoResponse', 'notify']),
      ref: u32,
      value: hex(512).optional(),
      on: z.boolean().optional(),
    })
    .strict(),
  z.object({ t: z.literal('ble.disconnect'), conn: u32 }).strict(),
  z.object({ t: z.literal('ble.serveService'), id: u32, service: gattService }).strict(),
  z.object({ t: z.literal('ble.serve'), id: u32 }).strict(),
  z.object({ t: z.literal('ble.unserve'), id: u32 }).strict(),
  z
    .object({
      t: z.literal('ble.serveReply'),
      req: u32,
      value: hex(512).optional(),
      error: str(256).optional(),
    })
    .strict(),
  z.object({ t: z.literal('ble.serveNotify'), id: u32, ref: u32, value: hex(512) }).strict(),
]);

const limits = z
  .object({
    maxConns: count,
    connPerMin: count,
    bytesPerSec: count,
    totalBytes: count,
    tcpPorts: z.array(port).max(1024),
    udpPorts: z.array(port).max(1024),
  })
  .strict();

const gatewaySchema = z.discriminatedUnion('t', [
  z
    .object({
      t: z.literal('welcome'),
      v: z.literal(1),
      gateway: z.enum(['server', 'helper']),
      scope: z.enum(['public', 'lan']),
      session: z.string().min(1).max(128),
      caps,
      limits,
      aliases: z.array(host).max(64),
      mqtt: z.object({ host, port }).strict().optional(),
      lan: z.array(str(64)).max(64).optional(),
    })
    .strict(),
  z.object({ t: z.literal('opened'), sid, remote: str(300), window: u32 }).strict(),
  z.object({ t: z.literal('refused'), sid, code: refuseCode, reason: str(1024) }).strict(),
  z.object({ t: z.literal('eof'), sid }).strict(),
  z
    .object({
      t: z.literal('closed'),
      sid,
      reset: z.boolean(),
      code: refuseCode.optional(),
      reason: str(1024).optional(),
    })
    .strict(),
  z.object({ t: z.literal('credit'), sid, bytes: u32.min(1) }).strict(),
  z
    .object({
      t: z.literal('resolved'),
      qid: u32,
      addrs: z.array(str(64)).max(64),
      ttl: u32,
      alias: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      t: z.literal('unresolved'),
      qid: u32,
      code: z.enum(['nxdomain', 'servfail', 'timeout', 'policy']),
    })
    .strict(),
  z
    .object({
      t: z.literal('mqtt.message'),
      topic: utf8Max(1024),
      payload: base64,
      qos: z.union([z.literal(0), z.literal(1), z.literal(2)]),
      retain: z.boolean(),
      size: count,
      truncated: z.boolean(),
      from: str(256).optional(),
      at: z.number().finite(),
    })
    .strict(),
  z.object({ t: z.literal('notice'), code: str(64), msg: str(1024) }).strict(),
  z.object({ t: z.literal('pong'), ts: z.number().finite() }).strict(),
  z
    .object({
      t: z.literal('incoming'),
      sid,
      port,
      from: str(300),
      board: z.string().min(1).max(64).optional(),
    })
    .strict(),
  z
    .object({
      t: z.literal('wifi.networks'),
      list: z
        .array(
          z
            .object({
              ssid: str(32),
              rssi: z.number().int(),
              channel: z.number().int().min(1).max(233),
              secure: z.boolean(),
            })
            .strict(),
        )
        .max(128),
    })
    .strict(),
  z
    .object({
      t: z.literal('ble.state'),
      state: z.enum(['starting', 'ready', 'off', 'none', 'failed']),
      reason: str(1024).optional(),
    })
    .strict(),
  z
    .object({
      t: z.literal('ble.devices'),
      list: z.array(bleDevice).max(BLE_DEVICES_PER_FRAME),
      gone: z.array(bleAddr).max(64),
    })
    .strict(),
  z.object({ t: z.literal('ble.service'), id: u32, service: gattService }).strict(),
  z.object({ t: z.literal('ble.opened'), id: u32, conn: u32 }).strict(),
  z.object({ t: z.literal('ble.failed'), id: u32, reason: str(1024) }).strict(),
  z
    .object({
      t: z.literal('ble.result'),
      id: u32,
      value: hex(512).optional(),
      error: str(256).optional(),
    })
    .strict(),
  z.object({ t: z.literal('ble.notify'), conn: u32, ref: u32, value: hex(512) }).strict(),
  z.object({ t: z.literal('ble.closed'), conn: u32 }).strict(),
  z.object({ t: z.literal('ble.served'), id: u32 }).strict(),
  z.object({ t: z.literal('ble.serveFailed'), id: u32, reason: str(1024) }).strict(),
  z.object({ t: z.literal('ble.serveRead'), id: u32, req: u32, ref: u32 }).strict(),
  z
    .object({
      t: z.literal('ble.serveWrite'),
      id: u32,
      req: u32,
      ref: u32,
      value: hex(512),
      response: z.boolean(),
    })
    .strict(),
  z.object({ t: z.literal('ble.serveSubscribe'), id: u32, ref: u32, on: z.boolean() }).strict(),
  z.object({ t: z.literal('ble.serveStopped'), id: u32, reason: str(1024) }).strict(),
]);

/** Bytes as lower-case hex (`ble.*` messages). */
export const hexOfBytes = (bytes: ArrayLike<number>): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Hex as bytes; an odd last digit is dropped. */
export function bytesOfHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

// The declared types and the schemas must describe the same messages.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameClient: Same<z.infer<typeof clientSchema>, NetClientMsg> = true;
const sameGateway: Same<z.infer<typeof gatewaySchema>, NetGatewayMsg> = true;
void sameClient;
void sameGateway;

function parseText<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, text: string): T | null {
  if (overTextMax(text)) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const r = schema.safeParse(json);
  return r.success ? r.data : null;
}

/** A client → gateway text frame, or null when the gateway must close with 1008. */
export function parseClientMsg(text: string): NetClientMsg | null {
  return parseText(clientSchema, text);
}

/** A gateway → client text frame, or null when the client must close with 1008. */
export function parseGatewayMsg(text: string): NetGatewayMsg | null {
  return parseText(gatewaySchema, text);
}

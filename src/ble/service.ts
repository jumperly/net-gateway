import {
  BLE_DEVICES_PER_FRAME,
  type GattServiceDesc,
  NET_TEXT_MAX,
  type NetBleDevice,
  type NetBleOp,
  type NetBleState,
  type NetGatewayMsg,
  bytesOfHex,
} from '../protocol';
import type { Sidecar, SidecarIn, SidecarOut, SpawnSidecar } from './sidecar';

/** The most devices around the helper keeps (the weakest go). */
export const BLE_DEVICES_MAX = 64;
/** A device not heard for this long is gone. */
export const BLE_DEVICE_TTL_MS = 30_000;
/** How often the scanning sessions hear what changed. */
export const BLE_TICK_MS = 1000;
/** How long a connection may take. */
export const BLE_CONNECT_MS = 15_000;
/** A sidecar that ran this long before it stopped starts its count of stops over. */
export const BLE_STABLE_MS = 60_000;
/** An RSSI change this small (dBm) is not news. */
export const BLE_RSSI_STEP = 3;
/** The longest value (hex) a frame carries: an attribute value is at most 512 bytes. */
const VALUE_HEX_MAX = 1024;

const utf8Length = (msg: NetGatewayMsg) => new TextEncoder().encode(JSON.stringify(msg)).length;

export interface BleClient {
  send(msg: NetGatewayMsg): void;
}

export interface BleLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/** One gateway session's side of the helper's Bluetooth. */
export interface BleSession {
  scan(on: boolean): void;
  connect(id: number, addr: string, random: boolean): void;
  op(msg: {
    id: number;
    conn: number;
    op: NetBleOp;
    ref: number;
    value?: string;
    on?: boolean;
  }): void;
  disconnect(conn: number): void;
  /** A board's table for a phone: its services (`serveService`), then `serve`. */
  serveService(id: number, service: GattServiceDesc): void;
  serve(id: number): void;
  unserve(id: number): void;
  /** The answer to the phone's request `req` (`ble.serveRead` / `ble.serveWrite`). */
  serveReply(req: number, value: string | undefined, error: string | undefined): void;
  serveNotify(id: number, ref: number, value: string): void;
  /** The session ended: its scanning stops, its connections close, its publications end. */
  close(): void;
}

/** The local name in AD structures (hex): 0x09 complete, else 0x08 shortened. */
export function nameOfAd(hex: string): string | undefined {
  const b = bytesOfHex(hex);
  let short: string | undefined;
  for (let i = 0; i + 1 < b.length; ) {
    const len = b[i] ?? 0;
    if (len === 0 || i + 1 + len > b.length) break;
    const type = b[i + 1];
    const text = new TextDecoder().decode(b.subarray(i + 2, i + 1 + len));
    if (type === 0x09) return text;
    if (type === 0x08) short = text;
    i += 1 + len;
  }
  return short;
}

interface Device extends NetBleDevice {
  seenAt: number;
}

interface Peer {
  client: BleClient;
  scanning: boolean;
  /** What this session was last sent of each device. */
  known: Map<string, { rssi: number; adv: string; rsp: string }>;
  conns: Set<number>;
  /** Tables being sent (`serveService`), by the session's id. */
  tables: Map<number, GattServiceDesc[]>;
}

type OpMsg = Parameters<BleSession['op']>[0];

/**
 * The helper's Bluetooth LE (Windows): the sidecar process, the devices around (advertising and
 * scan response merged, at most `BLE_DEVICES_MAX`, gone after `BLE_DEVICE_TTL_MS` of silence), the
 * sessions that scan (the sidecar scans while any does) and their GATT connections. A sidecar that
 * stops is started again once; a second stop leaves Bluetooth `failed`.
 */
export class BleService {
  private state: NetBleState = 'starting';
  private reason: string | undefined;
  private sidecar: Sidecar | undefined;
  private crashes = 0;
  /** When the running sidecar started (for `BLE_STABLE_MS`). */
  private startedAt = 0;
  private closed = false;
  private readonly peers = new Set<Peer>();
  private readonly devices = new Map<string, Device>();
  private tick: ReturnType<typeof setInterval> | undefined;
  private nextId = 1;
  /** Connections asked for, by the sidecar's id. */
  private readonly connects = new Map<
    number,
    { peer: Peer; id: number; timer: ReturnType<typeof setTimeout> }
  >();
  /** Operations waiting for the sidecar, by its id. */
  private readonly ops = new Map<number, { peer: Peer; id: number; conn: number }>();
  /** The session of each open connection. */
  private readonly owners = new Map<number, Peer>();
  /** Publications (a board for a phone), by the sidecar's id; the phone's requests, by its id. */
  private readonly serves = new Map<number, { peer: Peer; id: number }>();
  private readonly requests = new Map<number, Peer>();
  /** The adapter can be a peripheral (the sidecar's `radio.peripheral`; unknown: assumed). */
  private peripheral = true;
  private readonly now: () => number;

  constructor(private readonly opts: { spawn: SpawnSidecar; log: BleLog; now?: () => number }) {
    this.now = opts.now ?? Date.now;
  }

  /** Build and run the sidecar in the background. */
  start(): void {
    void this.launch();
  }

  close(): void {
    this.closed = true;
    this.stopTick();
    this.sidecar?.kill();
    this.sidecar = undefined;
  }

  attach(client: BleClient): BleSession {
    const peer: Peer = {
      client,
      scanning: false,
      known: new Map(),
      conns: new Set(),
      tables: new Map(),
    };
    this.peers.add(peer);
    client.send(this.stateMsg());
    return {
      scan: (on) => this.scan(peer, on),
      connect: (id, addr, random) => this.connect(peer, id, addr, random),
      op: (msg) => this.op(peer, msg),
      disconnect: (conn) => this.disconnect(peer, conn),
      serveService: (id, service) => {
        const table = peer.tables.get(id) ?? [];
        if (table.length < 32) table.push(service);
        peer.tables.set(id, table);
      },
      serve: (id) => this.serve(peer, id),
      unserve: (id) => this.unserve(peer, id),
      serveReply: (req, value, error) => {
        if (this.requests.get(req) !== peer) return;
        this.requests.delete(req);
        this.send({
          op: 'reply',
          req,
          ...(value !== undefined ? { value } : {}),
          ...(error !== undefined ? { error } : {}),
        });
      },
      serveNotify: (id, ref, value) => {
        const sid = this.serveIdOf(peer, id);
        if (sid !== undefined) this.send({ op: 'serveNotify', id: sid, ref, value });
      },
      close: () => this.detach(peer),
    };
  }

  // --- The sidecar --------------------------------------------------------------------------------

  private async launch(): Promise<void> {
    try {
      const s = await this.opts.spawn({
        message: (m) => this.fromSidecar(m),
        exit: (r) => this.exited(r),
      });
      if (this.closed) {
        s.kill();
        return;
      }
      this.sidecar = s;
      this.startedAt = this.now();
      if (this.scanningPeers().length > 0) s.send({ op: 'scan', on: true });
    } catch (e) {
      this.opts.log.warn({ err: String(e) }, 'ble sidecar unavailable');
      this.setState('failed', e instanceof Error ? e.message : String(e));
    }
  }

  private exited(reason: string): void {
    if (this.closed) return;
    this.opts.log.warn({ reason }, 'ble sidecar exited');
    this.sidecar = undefined;
    for (const [sid, c] of this.connects) {
      clearTimeout(c.timer);
      this.connects.delete(sid);
      c.peer.client.send({ t: 'ble.failed', id: c.id, reason: 'the Bluetooth sidecar stopped' });
    }
    for (const conn of [...this.owners.keys()]) this.closedConn(conn);
    for (const [sid, s] of this.serves) {
      this.serves.delete(sid);
      s.peer.client.send({
        t: 'ble.serveStopped',
        id: s.id,
        reason: 'the Bluetooth sidecar stopped',
      });
    }
    this.requests.clear();
    this.devices.clear();
    if (this.now() - this.startedAt >= BLE_STABLE_MS) this.crashes = 0;
    this.crashes++;
    if (this.crashes > 1) {
      this.setState('failed', `the Bluetooth sidecar stopped twice (${reason})`);
      return;
    }
    this.setState('starting');
    void this.launch();
  }

  private send(msg: SidecarIn): void {
    this.sidecar?.send(msg);
  }

  private fromSidecar(m: SidecarOut): void {
    switch (m.ev) {
      case 'radio': {
        if (m.peripheral !== undefined) this.peripheral = m.peripheral;
        const state = m.state === 'on' ? 'ready' : m.state;
        // Off, the sidecar's scan was aborted and the devices are gone; back on, it scans again.
        if (state !== 'ready') this.devices.clear();
        else if ((this.state === 'off' || this.state === 'none') && this.scanningPeers().length > 0)
          this.send({ op: 'scan', on: true });
        this.setState(state);
        break;
      }
      case 'adv':
        this.heard(m);
        break;
      case 'opened': {
        const c = this.connects.get(m.id);
        if (!c) {
          // Given up on (timeout, the session ended): let it go.
          this.send({ op: 'disconnect', conn: m.conn });
          break;
        }
        clearTimeout(c.timer);
        this.connects.delete(m.id);
        this.owners.set(m.conn, c.peer);
        c.peer.conns.add(m.conn);
        for (const service of m.services)
          c.peer.client.send({ t: 'ble.service', id: c.id, service: this.fit(c.id, service) });
        c.peer.client.send({ t: 'ble.opened', id: c.id, conn: m.conn });
        break;
      }
      case 'failed': {
        const c = this.connects.get(m.id);
        if (!c) break;
        clearTimeout(c.timer);
        this.connects.delete(m.id);
        c.peer.client.send({ t: 'ble.failed', id: c.id, reason: m.error.slice(0, 1024) });
        break;
      }
      case 'result': {
        const o = this.ops.get(m.id);
        if (!o) break;
        this.ops.delete(m.id);
        o.peer.client.send({
          t: 'ble.result',
          id: o.id,
          ...(m.value !== undefined ? { value: m.value.slice(0, VALUE_HEX_MAX) } : {}),
          ...(m.error !== undefined ? { error: m.error.slice(0, 256) } : {}),
        });
        break;
      }
      case 'notify':
        this.owners.get(m.conn)?.client.send({
          t: 'ble.notify',
          conn: m.conn,
          ref: m.ref,
          value: m.value.slice(0, VALUE_HEX_MAX),
        });
        break;
      case 'closed':
        this.closedConn(m.conn);
        break;
      case 'served':
      case 'serveFailed':
      case 'serveStopped': {
        const s = this.serves.get(m.id);
        if (!s) break;
        if (m.ev === 'served') s.peer.client.send({ t: 'ble.served', id: s.id });
        else {
          this.serves.delete(m.id);
          s.peer.client.send({
            t: m.ev === 'serveFailed' ? 'ble.serveFailed' : 'ble.serveStopped',
            id: s.id,
            reason: m.error.slice(0, 1024),
          });
        }
        break;
      }
      case 'serveRead':
      case 'serveWrite': {
        const s = this.serves.get(m.id);
        if (!s) {
          this.send({ op: 'reply', req: m.req, error: 'gone' });
          break;
        }
        if (m.ev === 'serveRead') {
          this.requests.set(m.req, s.peer);
          s.peer.client.send({ t: 'ble.serveRead', id: s.id, req: m.req, ref: m.ref });
        } else {
          if (m.response) this.requests.set(m.req, s.peer);
          s.peer.client.send({
            t: 'ble.serveWrite',
            id: s.id,
            req: m.req,
            ref: m.ref,
            value: m.value.slice(0, VALUE_HEX_MAX),
            response: m.response,
          });
        }
        break;
      }
      case 'serveSubscribe': {
        const s = this.serves.get(m.id);
        s?.peer.client.send({ t: 'ble.serveSubscribe', id: s.id, ref: m.ref, on: m.on });
        break;
      }
      case 'log':
        this.opts.log.info({ text: m.text }, 'ble sidecar');
        break;
    }
  }

  private setState(state: NetBleState, reason?: string): void {
    if (this.state === state && this.reason === reason) return;
    this.state = state;
    this.reason = reason;
    for (const p of this.peers) p.client.send(this.stateMsg());
  }

  private stateMsg(): NetGatewayMsg {
    return {
      t: 'ble.state',
      state: this.state,
      ...(this.reason ? { reason: this.reason.slice(0, 1024) } : {}),
    };
  }

  /**
   * A table the protocol cannot carry loses what does not fit (logged): at most 64
   * characteristics of 16 descriptors each, and no more than one text frame.
   */
  private fit(id: number, service: GattServiceDesc): GattServiceDesc {
    const s = {
      ...service,
      characteristics: service.characteristics
        .slice(0, 64)
        .map((c) => ({ ...c, descriptors: c.descriptors.slice(0, 16) })),
    };
    while (
      s.characteristics.length > 0 &&
      utf8Length({ t: 'ble.service', id, service: s }) > NET_TEXT_MAX
    )
      s.characteristics.pop();
    if (
      s.characteristics.length < service.characteristics.length ||
      service.characteristics.some((c) => c.descriptors.length > 16)
    )
      this.opts.log.warn({ uuid: service.uuid }, 'ble service cut to fit a frame');
    return s;
  }

  // --- Devices around -----------------------------------------------------------------------------

  private heard(m: Extract<SidecarOut, { ev: 'adv' }>): void {
    const d = this.devices.get(m.addr) ?? {
      addr: m.addr,
      random: m.random,
      rssi: m.rssi,
      adv: '',
      rsp: '',
      connectable: false,
      seenAt: 0,
    };
    d.random = m.random;
    d.rssi = m.rssi;
    d.seenAt = this.now();
    if (m.kind === 'adv') {
      d.adv = m.data;
      d.connectable = m.connectable;
    } else d.rsp = m.data;
    // The complete name of either packet before a shortened one (0x08 in the advertising, 0x09 in
    // the scan response is common).
    const name = nameOfAd(d.adv + d.rsp);
    if (name) d.name = name.slice(0, 64);
    this.devices.set(m.addr, d);
    if (this.devices.size > BLE_DEVICES_MAX) {
      // The silent ones first; then the weakest, the one heard longest ago of equals.
      this.expire();
      if (this.devices.size > BLE_DEVICES_MAX) {
        let weakest = d;
        for (const x of this.devices.values())
          if (x.rssi < weakest.rssi || (x.rssi === weakest.rssi && x.seenAt < weakest.seenAt))
            weakest = x;
        this.devices.delete(weakest.addr);
      }
    }
  }

  private scanningPeers(): Peer[] {
    return [...this.peers].filter((p) => p.scanning);
  }

  private scan(peer: Peer, on: boolean): void {
    if (peer.scanning === on) return;
    const before = this.scanningPeers().length;
    peer.scanning = on;
    peer.known.clear();
    const after = this.scanningPeers().length;
    if (before === 0 && after > 0) {
      this.send({ op: 'scan', on: true });
      this.tick = setInterval(() => this.flush(), BLE_TICK_MS);
    } else if (before > 0 && after === 0) {
      this.send({ op: 'scan', on: false });
      this.stopTick();
      this.devices.clear();
    }
  }

  private stopTick(): void {
    if (this.tick !== undefined) clearInterval(this.tick);
    this.tick = undefined;
  }

  private expire(): void {
    const now = this.now();
    for (const [addr, d] of this.devices)
      if (now - d.seenAt > BLE_DEVICE_TTL_MS) this.devices.delete(addr);
  }

  /**
   * Drop the silent devices; send each scanning session what changed for it, in frames of at most
   * `BLE_DEVICES_PER_FRAME` devices and `NET_TEXT_MAX` bytes (`gone` in the first).
   */
  private flush(): void {
    this.expire();
    for (const peer of this.scanningPeers()) {
      const list: NetBleDevice[] = [];
      for (const d of this.devices.values()) {
        const k = peer.known.get(d.addr);
        if (k && k.adv === d.adv && k.rsp === d.rsp && Math.abs(k.rssi - d.rssi) <= BLE_RSSI_STEP)
          continue;
        const { seenAt: _, ...dev } = d;
        list.push(dev);
        peer.known.set(d.addr, { rssi: d.rssi, adv: d.adv, rsp: d.rsp });
      }
      const gone = [...peer.known.keys()].filter((a) => !this.devices.has(a));
      for (const a of gone) peer.known.delete(a);
      if (list.length === 0 && gone.length === 0) continue;
      let frame: Extract<NetGatewayMsg, { t: 'ble.devices' }> = {
        t: 'ble.devices',
        list: [],
        gone,
      };
      for (const dev of list) {
        const next = { ...frame, list: [...frame.list, dev] };
        if (frame.list.length >= BLE_DEVICES_PER_FRAME || utf8Length(next) > NET_TEXT_MAX) {
          peer.client.send(frame);
          frame = { t: 'ble.devices', list: [dev], gone: [] };
        } else frame = next;
      }
      peer.client.send(frame);
    }
  }

  // --- GATT ---------------------------------------------------------------------------------------

  private connect(peer: Peer, id: number, addr: string, random: boolean): void {
    if (this.state !== 'ready' || !this.sidecar) {
      peer.client.send({ t: 'ble.failed', id, reason: `Bluetooth is ${this.state}` });
      return;
    }
    const sid = this.nextId++;
    const timer = setTimeout(() => {
      if (!this.connects.delete(sid)) return;
      peer.client.send({ t: 'ble.failed', id, reason: 'timeout' });
    }, BLE_CONNECT_MS);
    this.connects.set(sid, { peer, id, timer });
    this.send({ op: 'connect', id: sid, addr, random });
  }

  private op(peer: Peer, m: OpMsg): void {
    if (!peer.conns.has(m.conn) || !this.sidecar) {
      peer.client.send({ t: 'ble.result', id: m.id, error: 'invalid' });
      return;
    }
    const sid = this.nextId++;
    this.ops.set(sid, { peer, id: m.id, conn: m.conn });
    if (m.op === 'read') this.send({ op: 'read', id: sid, conn: m.conn, ref: m.ref });
    else if (m.op === 'notify')
      this.send({ op: 'notify', id: sid, conn: m.conn, ref: m.ref, on: m.on === true });
    else this.send({ op: m.op, id: sid, conn: m.conn, ref: m.ref, value: m.value ?? '' });
  }

  private disconnect(peer: Peer, conn: number): void {
    if (!peer.conns.delete(conn)) return;
    this.owners.delete(conn);
    this.failOps(conn);
    this.send({ op: 'disconnect', conn });
  }

  /** The device went away (or the sidecar did): its owner hears it, its waiting operations fail. */
  private closedConn(conn: number): void {
    const peer = this.owners.get(conn);
    this.owners.delete(conn);
    this.failOps(conn);
    if (!peer) return;
    peer.conns.delete(conn);
    peer.client.send({ t: 'ble.closed', conn });
  }

  private failOps(conn: number): void {
    for (const [sid, o] of this.ops)
      if (o.conn === conn) {
        this.ops.delete(sid);
        o.peer.client.send({ t: 'ble.result', id: o.id, error: 'unreachable' });
      }
  }

  // --- A board for a phone (the helper's GATT server) --------------------------------------------

  private serveIdOf(peer: Peer, id: number): number | undefined {
    for (const [sid, s] of this.serves) if (s.peer === peer && s.id === id) return sid;
    return undefined;
  }

  private serve(peer: Peer, id: number): void {
    const services = peer.tables.get(id) ?? [];
    peer.tables.delete(id);
    const fail = (reason: string) => peer.client.send({ t: 'ble.serveFailed', id, reason });
    if (this.state !== 'ready' || !this.sidecar) {
      fail(`Bluetooth is ${this.state}`);
      return;
    }
    if (!this.peripheral) {
      fail('this Bluetooth adapter cannot be a peripheral');
      return;
    }
    // Windows has one GATT server: a new publication of this session replaces its last one.
    for (const [sid, s] of this.serves) if (s.peer === peer) this.unserve(peer, s.id, sid);
    const sid = this.nextId++;
    this.serves.set(sid, { peer, id });
    this.send({ op: 'serve', id: sid, services });
  }

  private unserve(peer: Peer, id: number, sid = this.serveIdOf(peer, id)): void {
    if (sid === undefined) return;
    this.serves.delete(sid);
    this.send({ op: 'unserve', id: sid });
  }

  private detach(peer: Peer): void {
    for (const [sid, s] of this.serves) if (s.peer === peer) this.unserve(peer, s.id, sid);
    for (const [req, p] of this.requests) if (p === peer) this.requests.delete(req);
    this.scan(peer, false);
    for (const conn of [...peer.conns]) this.disconnect(peer, conn);
    for (const [sid, c] of this.connects)
      if (c.peer === peer) {
        clearTimeout(c.timer);
        this.connects.delete(sid);
      }
    for (const [sid, o] of this.ops) if (o.peer === peer) this.ops.delete(sid);
    this.peers.delete(peer);
  }
}

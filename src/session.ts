import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import type { FastifyBaseLogger } from 'fastify';
import type WebSocket from 'ws';
import type { Aliases } from './aliases';
import type { Authorizer, ClientInfo, HelloMsg } from './auth';
import type { BleService, BleSession } from './ble/service';
import type { GatewayConfig } from './config';
import type { DnsResolver } from './dns';
import { type Flow, type FlowLine, type FlowSession, hostPort } from './flow';
import { SessionLimits } from './limits';
import { type ListenSession, Listener } from './listen';
import type { MqttHandler, MqttSession } from './mqtt/handler';
import type { FlowPolicy } from './policy';
import {
  NET_WINDOW,
  type NetCap,
  type NetClientMsg,
  type NetGatewayMsg,
  type NetLimits,
  type NetRefuseCode,
  decodeDataFrame,
  encodeDataFrame,
  parseClientMsg,
} from './protocol';
import { StreamFlow, dialTcp } from './tcp';
import { DatagramFlow } from './udp';
import type { WifiScanner } from './wifi-scan';

/** Above this many bytes queued on the WebSocket every flow of the session stops reading. */
export const WS_HIGH_WATER = 1024 * 1024;
/** Lookups of one session in flight at once; more are answered `servfail`. */
const MAX_PENDING_LOOKUPS = 32;
/** The helper's own sids (`incoming`) have bit 31 set: the client's never collide with them. */
const INCOMING_SID_BASE = 0x8000_0000;
/** Connections to the forwards of one session waiting for `accept` at once; more are dropped. */
const MAX_PENDING_INCOMING = 16;

interface PendingIncoming {
  socket: Socket;
  from: string;
  timer: NodeJS.Timeout;
  onClose: () => void;
}

export interface SessionDeps {
  config: GatewayConfig;
  policy: FlowPolicy;
  aliases: Aliases;
  dns: DnsResolver;
  authorizer: Authorizer;
  mqtt?: MqttHandler | undefined;
  log: FastifyBaseLogger;
  /** The helper's LAN, announced in `welcome.lan`. */
  lanCidrs?: readonly string[];
  /** The helper's scans of the Wi-Fi around (`wifi.scan`). */
  wifi?: WifiScanner | undefined;
  /** The helper's Bluetooth LE (Windows): `ble.*`. */
  ble?: BleService | undefined;
}

export interface SessionStats {
  /** Largest data held for one flow while its client window was closed. */
  peakPending: number;
  /** Largest `ws.bufferedAmount` seen after a send. */
  peakBuffered: number;
  flows: number;
  up: number;
  down: number;
}

/**
 * One WebSocket = one session: `hello` within 5 s, `welcome`, then flows
 * (`open` → policy → limits → connect → `remoteAddress` re-check → `opened`), credits both ways,
 * lookups, ping/pong, idle timeouts. Closing the WebSocket closes every flow.
 */
export class Session implements FlowSession, ListenSession {
  readonly id = randomUUID();
  readonly limits: SessionLimits;
  readonly flowIdleMs: number;
  readonly stats: SessionStats = { peakPending: 0, peakBuffered: 0, flows: 0, up: 0, down: 0 };
  private readonly flows = new Map<number, Flow>();
  /** The helper's port forwards by the client's sid (`listen`). */
  private readonly listeners = new Map<number, Listener>();
  /** Connections to a forward the client has not answered yet, by the helper's sid. */
  private readonly incomingWait = new Map<number, PendingIncoming>();
  private nextIncoming = INCOMING_SID_BASE;
  private readonly log: FastifyBaseLogger;
  private state: 'hello' | 'checking' | 'ready' | 'over' = 'hello';
  /**
   * Frames not handled yet: while `hello` is being authenticated, or over `framesPerSec` (the
   * WebSocket is paused meanwhile, so this holds at most what was already read).
   */
  private inbox: Array<[Buffer, boolean]> = [];
  private release: (() => void) | undefined;
  private mqtt: MqttSession | undefined;
  private ble: BleSession | undefined;
  private ns: string | undefined;
  private lookups = 0;
  private congestedNow = false;
  private totalSpentNow = false;
  private alive = true;
  private readonly startedAt = performance.now();
  private helloTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private framesTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly ws: WebSocket,
    private readonly client: ClientInfo,
    private readonly deps: SessionDeps,
    private readonly onEnd: (s: Session) => void,
  ) {
    const { limits, timeouts } = deps.config;
    this.limits = new SessionLimits(limits);
    this.flowIdleMs = timeouts.tcpIdleMs;
    this.log = deps.log.child({ session: this.id });
  }

  /** Admit the session and listen. */
  start(): void {
    const { timeouts } = this.deps.config;
    this.ws.on('close', (code) => this.dispose(code));
    this.ws.on('error', () => {});
    const admission = this.deps.authorizer.admit(this.client);
    if (!admission.ok) {
      this.log.info({ ip: this.client.ip, code: admission.code }, 'session refused');
      this.send({ t: 'notice', code: admission.code, msg: admission.reason });
      this.closeWs(1013, admission.code);
      return;
    }
    this.release = admission.release;
    this.ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (this.state === 'over') return;
      this.inbox.push([data, isBinary]);
      this.drainInbox();
    });
    this.ws.on('pong', () => {
      this.alive = true;
    });
    this.helloTimer = setTimeout(() => this.violation('no hello in time'), timeouts.helloMs);
    this.idleTimer = setTimeout(() => {
      this.send({ t: 'notice', code: 'idle', msg: 'the session was idle too long' });
      this.closeWs(1000, 'idle');
    }, timeouts.sessionIdleMs);
    this.heartbeat = setInterval(() => {
      if (!this.alive) {
        this.log.info('client stopped answering pings');
        this.ws.terminate();
        return;
      }
      this.alive = false;
      this.ws.ping();
    }, timeouts.pingMs);
  }

  // --- FlowSession ------------------------------------------------------------------------------

  control(msg: NetGatewayMsg): void {
    this.send(msg);
  }

  data(kind: 1 | 2, sid: number, bytes: Uint8Array): void {
    if (this.state === 'over') return;
    this.ws.send(encodeDataFrame(kind, sid, bytes), () => this.drained());
    this.noteBuffered();
  }

  congested(): boolean {
    if (this.ws.bufferedAmount > WS_HIGH_WATER) this.congestedNow = true;
    return this.congestedNow;
  }

  activity(): void {
    this.idleTimer?.refresh();
  }

  totalSpent(): void {
    if (this.totalSpentNow) return;
    this.totalSpentNow = true;
    const reason = `the session moved its ${this.deps.config.limits.totalBytes} bytes`;
    for (const f of [...this.flows.values()]) f.kill('limit.total', reason);
    // Later opens are refused by SessionLimits.tryOpen.
  }

  notePending(bytes: number): void {
    if (bytes > this.stats.peakPending) this.stats.peakPending = bytes;
  }

  done(flow: Flow, line: FlowLine): void {
    if (this.flows.get(flow.sid) === flow) this.flows.delete(flow.sid);
    // Every flow object holds a slot from SessionLimits.tryOpen.
    this.limits.release();
    this.stats.up += flow.up;
    this.stats.down += flow.down;
    this.log.info(
      {
        sid: flow.sid,
        board: flow.board,
        proto: flow.proto,
        dst: flow.dst,
        up: flow.up,
        down: flow.down,
        ms: Math.round(performance.now() - flow.startedAt),
        ...line,
      },
      'flow',
    );
  }

  // --- Frames ------------------------------------------------------------------------------------

  /** Handle queued frames at up to `framesPerSec`. */
  private drainInbox(): void {
    while (this.inbox.length && (this.state === 'hello' || this.state === 'ready')) {
      if (!this.limits.frames.take(1)) {
        // Too many frames: stop reading the WebSocket until the bucket refills.
        this.ws.pause();
        this.framesTimer ??= setTimeout(
          () => {
            this.framesTimer = undefined;
            this.drainInbox();
          },
          Math.max(1, this.limits.frames.msUntil(1)),
        );
        return;
      }
      const [data, isBinary] = this.inbox.shift() as [Buffer, boolean];
      this.frame(data, isBinary);
    }
    if (this.inbox.length === 0 && this.state !== 'over' && this.ws.isPaused) this.ws.resume();
  }

  private frame(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      this.binary(data);
      return;
    }
    const msg = parseClientMsg(data.toString('utf8'));
    if (!msg) {
      this.violation('malformed message');
      return;
    }
    if (this.state === 'hello') {
      if (msg.t !== 'hello') {
        this.violation(`${msg.t} before hello`);
        return;
      }
      void this.hello(msg);
      return;
    }
    if (msg.t !== 'ping') this.activity();
    this.message(msg);
  }

  private binary(data: Buffer): void {
    if (this.state !== 'ready') {
      this.violation('data before hello');
      return;
    }
    const f = decodeDataFrame(data);
    if (!f) {
      this.violation('malformed data frame');
      return;
    }
    this.activity();
    const flow = this.flows.get(f.sid);
    // Data for a flow the gateway already ended crossed our `closed`/`refused`: dropped.
    if (!flow) return;
    if (!flow.clientData(f.kind, f.bytes))
      this.violation(`data frame of ${f.bytes.length} bytes outside the window of sid ${f.sid}`);
  }

  private async hello(msg: HelloMsg): Promise<void> {
    clearTimeout(this.helloTimer);
    this.state = 'checking';
    let ok: boolean;
    try {
      ok = await this.deps.authorizer.authenticate(msg, this.client);
    } catch (err) {
      this.log.error({ err }, 'authorizer failed');
      ok = false;
    }
    if (this.state !== 'checking') return;
    if (!ok) {
      this.log.info({ ip: this.client.ip }, 'session not authorized');
      this.send({ t: 'notice', code: 'auth', msg: 'this gateway needs a valid token' });
      this.closeWs(1008, 'not authorized');
      return;
    }
    this.state = 'ready';
    this.ns = msg.ns;
    const { config, mqtt } = this.deps;
    // Undefined when the handler serves no broker to this session (no namespace).
    this.mqtt = mqtt?.attach({
      id: this.id,
      ns: msg.ns,
      send: (m) => this.send(m),
      log: this.log,
    });
    const helper = config.mode === 'helper';
    const caps: NetCap[] = helper ? ['tcp', 'udp', 'dns', 'listen'] : ['tcp', 'dns'];
    if (helper && this.deps.wifi) caps.push('wifi.scan');
    if (helper && this.deps.ble) caps.push('ble.scan', 'ble.gatt', 'ble.serve');
    if (!helper && config.udpPorts.length) caps.splice(1, 0, 'udp');
    if (this.mqtt) caps.push('mqtt');
    const limits: NetLimits = {
      maxConns: config.limits.maxConns,
      connPerMin: config.limits.connPerMin,
      bytesPerSec: config.limits.bytesPerSec,
      totalBytes: config.limits.totalBytes,
      tcpPorts: [...config.tcpPorts],
      udpPorts: [...config.udpPorts],
    };
    this.send({
      t: 'welcome',
      v: 1,
      gateway: helper ? 'helper' : 'server',
      scope: helper ? 'lan' : 'public',
      session: this.id,
      caps,
      limits,
      aliases: this.deps.aliases.names().filter((n) => n !== mqtt?.host),
      ...(mqtt && this.mqtt ? { mqtt: { host: mqtt.host, port: mqtt.port } } : {}),
      ...(helper ? { lan: [...(this.deps.lanCidrs ?? [])] } : {}),
    });
    // Its state follows `welcome` at once (and on every change).
    if (helper && this.deps.ble) this.ble = this.deps.ble.attach({ send: (m) => this.send(m) });
    this.log.info(
      { ip: this.client.ip, origin: this.client.origin, client: msg.client, ns: msg.ns },
      'session',
    );
    this.drainInbox();
  }

  private message(msg: NetClientMsg): void {
    switch (msg.t) {
      case 'hello':
        this.violation('second hello');
        return;
      case 'open':
        this.open(msg);
        return;
      case 'shutdown':
        this.flows.get(msg.sid)?.clientShutdown();
        return;
      case 'close': {
        const listener = this.listeners.get(msg.sid);
        if (listener) {
          listener.close();
          return;
        }
        const waiting = this.incomingWait.get(msg.sid);
        if (waiting) {
          this.dropIncoming(msg.sid, waiting);
          return;
        }
        this.flows.get(msg.sid)?.forget(msg.abort === true);
        return;
      }
      case 'credit':
        this.flows.get(msg.sid)?.clientCredit(msg.bytes);
        return;
      case 'resolve':
        this.resolve(msg);
        return;
      case 'ping':
        this.send({ t: 'pong', ts: msg.ts });
        return;
      case 'mqtt.watch':
      case 'mqtt.publish':
        if (this.mqtt) this.mqtt.message(msg);
        else this.unsupported(`${msg.t}: this gateway has no MQTT broker`);
        return;
      case 'listen':
        if (this.deps.config.mode === 'helper') this.listen(msg);
        else
          this.send({
            t: 'refused',
            sid: msg.sid,
            code: 'unsupported',
            reason: 'listening is for the local helper; the server gateway accepts no connections',
          });
        return;
      case 'accept':
        if (this.deps.config.mode === 'helper') this.accept(msg);
        else this.unsupported('accept is for the local helper');
        return;
      case 'wifi.scan': {
        const wifi = this.deps.config.mode === 'helper' ? this.deps.wifi : undefined;
        if (!wifi) {
          this.unsupported('wifi.scan is for the local helper');
          return;
        }
        void wifi.networks().then((list) => this.send({ t: 'wifi.networks', list }));
        return;
      }
      case 'ble.scan':
      case 'ble.connect':
      case 'ble.op':
      case 'ble.disconnect':
      case 'ble.serveService':
      case 'ble.serve':
      case 'ble.unserve':
      case 'ble.serveReply':
      case 'ble.serveNotify': {
        const ble = this.ble;
        if (!ble) {
          this.unsupported('Bluetooth is for the local helper on Windows');
          return;
        }
        if (msg.t === 'ble.scan') ble.scan(msg.on);
        else if (msg.t === 'ble.connect') ble.connect(msg.id, msg.addr, msg.random);
        else if (msg.t === 'ble.op') ble.op(msg);
        else if (msg.t === 'ble.disconnect') ble.disconnect(msg.conn);
        else if (msg.t === 'ble.serveService') ble.serveService(msg.id, msg.service);
        else if (msg.t === 'ble.serve') ble.serve(msg.id);
        else if (msg.t === 'ble.unserve') ble.unserve(msg.id);
        else if (msg.t === 'ble.serveReply') ble.serveReply(msg.req, msg.value, msg.error);
        else ble.serveNotify(msg.id, msg.ref, msg.value);
        return;
      }
    }
  }

  private unsupported(msg: string): void {
    this.send({ t: 'notice', code: 'unsupported', msg });
  }

  // --- Port forwards (the helper) ------------------------------------------------------------

  private listen(msg: Extract<NetClientMsg, { t: 'listen' }>): void {
    const h = this.deps.config.helper;
    const refuse = (code: NetRefuseCode, reason: string) =>
      this.send({ t: 'refused', sid: msg.sid, code, reason });
    if (this.listeners.has(msg.sid) || this.flows.has(msg.sid)) {
      this.violation(`sid ${msg.sid} is already open`);
      return;
    }
    if (msg.proto !== 'tcp') {
      refuse('policy.proto', 'only TCP ports are forwarded');
      return;
    }
    if (msg.port < h.listenPortMin) {
      refuse('policy.port', `forwarded ports start at ${h.listenPortMin}`);
      return;
    }
    if (this.listeners.size >= h.maxListeners) {
      refuse('limit.conns', `at most ${h.maxListeners} forwarded ports at once`);
      return;
    }
    const listener = new Listener(this, msg.sid, msg.port, h.listenHost);
    this.listeners.set(msg.sid, listener);
    listener.start();
    this.log.info({ sid: msg.sid, port: msg.port }, 'listen');
  }

  incoming(listener: Listener, socket: Socket): void {
    if (this.state !== 'ready' || this.incomingWait.size >= MAX_PENDING_INCOMING) {
      socket.destroy();
      return;
    }
    let sid = this.nextIncoming;
    while (this.flows.has(sid) || this.incomingWait.has(sid))
      sid = sid >= 0xffff_ffff ? INCOMING_SID_BASE : sid + 1;
    this.nextIncoming = sid >= 0xffff_ffff ? INCOMING_SID_BASE : sid + 1;
    const from = hostPort(socket.remoteAddress ?? '0.0.0.0', socket.remotePort ?? 0);
    const timer = setTimeout(() => {
      const waiting = this.incomingWait.get(sid);
      if (!waiting) return;
      this.dropIncoming(sid, waiting);
      this.send({ t: 'closed', sid, reset: true, reason: 'not accepted in time' });
    }, this.deps.config.helper.acceptMs);
    const onClose = () => {
      const waiting = this.incomingWait.get(sid);
      if (waiting?.socket !== socket) return;
      this.dropIncoming(sid, waiting);
      this.send({ t: 'closed', sid, reset: true, reason: 'the peer went away' });
    };
    socket.once('close', onClose);
    this.incomingWait.set(sid, { socket, from, timer, onClose });
    this.send({ t: 'incoming', sid, port: listener.port, from });
  }

  listenerDone(listener: Listener): void {
    if (this.listeners.get(listener.sid) === listener) this.listeners.delete(listener.sid);
  }

  private dropIncoming(sid: number, waiting: PendingIncoming): void {
    clearTimeout(waiting.timer);
    waiting.socket.off('close', waiting.onClose);
    this.incomingWait.delete(sid);
    waiting.socket.destroy();
  }

  private accept(msg: Extract<NetClientMsg, { t: 'accept' }>): void {
    const waiting = this.incomingWait.get(msg.sid);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.incomingWait.delete(msg.sid);
    const { socket, from } = waiting;
    socket.off('close', waiting.onClose);
    if (!msg.ok) {
      socket.resetAndDestroy();
      return;
    }
    const limited = this.limits.tryOpen();
    if (limited) {
      socket.destroy();
      this.send({
        t: 'closed',
        sid: msg.sid,
        reset: true,
        code: limited,
        reason: this.limitReason(limited),
      });
      return;
    }
    this.stats.flows++;
    const info = { sid: msg.sid, proto: 'tcp' as const, board: undefined, dst: from };
    const flow = new StreamFlow(this, info, NET_WINDOW);
    this.flows.set(msg.sid, flow);
    void flow
      .start({
        stream: socket,
        ready: Promise.resolve({
          ok: true as const,
          remote: { address: socket.remoteAddress, port: socket.remotePort },
        }),
      })
      .then(() => socket.resume());
  }

  // --- Flows -------------------------------------------------------------------------------------

  private open(msg: Extract<NetClientMsg, { t: 'open' }>): void {
    if (this.flows.has(msg.sid)) {
      this.violation(`sid ${msg.sid} is already open`);
      return;
    }
    const info = {
      sid: msg.sid,
      proto: msg.proto,
      board: msg.board,
      dst: hostPort(msg.host, msg.port),
    };
    const refuse = (code: NetRefuseCode, reason: string) => {
      this.send({ t: 'refused', sid: msg.sid, code, reason });
      this.log.info(
        {
          sid: msg.sid,
          board: msg.board,
          proto: msg.proto,
          dst: info.dst,
          result: 'refused',
          code,
        },
        'flow',
      );
    };

    const verdict = this.deps.policy.check(msg.host, msg.port, msg.proto);
    if (!verdict.ok) {
      refuse(verdict.code, verdict.reason);
      return;
    }
    const target = verdict.target;
    if (target.kind === 'alias' && target.alias.target.kind === 'mqtt' && !this.mqtt) {
      refuse('unsupported', 'this gateway has no MQTT broker');
      return;
    }
    const limited = this.limits.tryOpen();
    if (limited) {
      refuse(limited, this.limitReason(limited));
      return;
    }
    this.stats.flows++;

    if (msg.proto === 'udp') {
      if (target.kind !== 'ip') return; // the policy refuses UDP to aliases
      const flow = new DatagramFlow(this, info);
      this.flows.set(msg.sid, flow);
      flow.start(target.ip, target.family, target.port, (a) => this.deps.policy.remoteAllowed(a));
      return;
    }

    const flow = new StreamFlow(this, info, msg.window);
    this.flows.set(msg.sid, flow);
    const { connectMs } = this.deps.config.timeouts;
    if (target.kind === 'ip') {
      void flow.start(
        dialTcp(target.ip, target.port, { timeoutMs: connectMs, resolveNames: false }),
        { checkRemote: (a) => a !== undefined && this.deps.policy.remoteAllowed(a) },
      );
      return;
    }
    const aliasTarget = target.alias.target;
    const label = hostPort(target.alias.name, target.port);
    if (aliasTarget.kind === 'mqtt') {
      const stream = (this.mqtt as MqttSession).connect({ sid: msg.sid, board: msg.board });
      void flow.start({ stream, ready: Promise.resolve({ ok: true, remote: {} }) }, { label });
      return;
    }
    void flow.start(
      dialTcp(aliasTarget.host, aliasTarget.port ?? target.port, {
        timeoutMs: connectMs,
        resolveNames: true,
      }),
      { label },
    );
  }

  private limitReason(code: NetRefuseCode): string {
    const l = this.deps.config.limits;
    switch (code) {
      case 'limit.conns':
        return `at most ${l.maxConns} connections at once`;
      case 'limit.rate':
        return `at most ${l.connPerMin} new connections per minute`;
      case 'limit.total':
        return `the session moved its ${l.totalBytes} bytes`;
      default:
        return code;
    }
  }

  private resolve(msg: Extract<NetClientMsg, { t: 'resolve' }>): void {
    if (this.lookups >= MAX_PENDING_LOOKUPS) {
      this.send({ t: 'unresolved', qid: msg.qid, code: 'servfail' });
      return;
    }
    this.lookups++;
    void this.deps.dns
      .resolve(msg.name, msg.type)
      .catch(() => ({ code: 'servfail' as const }))
      .then((answer) => {
        this.lookups--;
        if ('code' in answer) this.send({ t: 'unresolved', qid: msg.qid, code: answer.code });
        else
          this.send({
            t: 'resolved',
            qid: msg.qid,
            addrs: answer.addrs,
            ttl: answer.ttl,
            ...(answer.alias ? { alias: true } : {}),
          });
        this.log.debug(
          {
            qid: msg.qid,
            name: msg.name,
            type: msg.type,
            result: 'code' in answer ? answer.code : 'ok',
          },
          'lookup',
        );
      });
  }

  // --- Plumbing ----------------------------------------------------------------------------------

  private send(msg: NetGatewayMsg): void {
    if (this.state === 'over' || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(msg), () => this.drained());
    this.noteBuffered();
  }

  private noteBuffered(): void {
    const b = this.ws.bufferedAmount;
    if (b > this.stats.peakBuffered) this.stats.peakBuffered = b;
  }

  /** A send completed: when the WebSocket is below the high water again, resume the flows. */
  private drained(): void {
    if (!this.congestedNow || this.ws.bufferedAmount > WS_HIGH_WATER) return;
    this.congestedNow = false;
    for (const f of [...this.flows.values()]) f.pump();
  }

  private violation(reason: string): void {
    if (this.state === 'over') return;
    this.log.info({ ip: this.client.ip, reason }, 'protocol violation');
    this.closeWs(1008, reason.slice(0, 120));
  }

  private closeWs(code: number, reason: string): void {
    if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING)
      this.ws.close(code, reason);
    this.dispose(code);
  }

  /** The gateway is stopping: tell every flow, then close. */
  shutdown(): void {
    if (this.state === 'over') return;
    for (const f of [...this.flows.values()]) f.kill('gateway.shutdown', 'the gateway is stopping');
    this.send({ t: 'notice', code: 'gateway.shutdown', msg: 'the gateway is stopping' });
    this.closeWs(1001, 'gateway shutdown');
  }

  private dispose(code: number): void {
    if (this.state === 'over') return;
    for (const f of [...this.flows.values()]) f.destroy();
    for (const l of [...this.listeners.values()]) l.close();
    for (const [sid, w] of [...this.incomingWait]) this.dropIncoming(sid, w);
    this.state = 'over';
    clearTimeout(this.helloTimer);
    clearTimeout(this.idleTimer);
    clearInterval(this.heartbeat);
    clearTimeout(this.framesTimer);
    this.mqtt?.close();
    this.ble?.close();
    this.ble = undefined;
    this.release?.();
    this.release = undefined;
    this.log.info(
      {
        ip: this.client.ip,
        ns: this.ns,
        code,
        flows: this.stats.flows,
        up: this.stats.up,
        down: this.stats.down,
        ms: Math.round(performance.now() - this.startedAt),
      },
      'session end',
    );
    this.onEnd(this);
  }
}

import { type AddressInfo, type Server, type Socket, createServer } from 'node:net';
import {
  NET_PATH,
  NET_SUBPROTOCOL,
  type NetClientMsg,
  type NetGatewayMsg,
  decodeDataFrame,
  encodeDataFrame,
  parseGatewayMsg,
} from '@jumperly/schema';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import type { BleService } from '../src/ble/service';
import { type ConfigOverrides, resolveConfig } from '../src/config';
import type { DnsResolver } from '../src/dns';
import type { MqttHandler } from '../src/mqtt/handler';
import { buildServer } from '../src/server';
import type { WifiScanner } from '../src/wifi-scan';

export interface TcpServer {
  server: Server;
  port: number;
  /** Server-side sockets and how each ended. */
  conns: Array<{ socket: Socket; error?: string; closed: Promise<void> }>;
  close(): Promise<void>;
}

/** A local TCP server; `onConn` handles each connection (default: echo, FIN after FIN). */
export async function tcpServer(onConn?: (s: Socket) => void): Promise<TcpServer> {
  const conns: TcpServer['conns'] = [];
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    const entry: TcpServer['conns'][number] = {
      socket,
      closed: new Promise((resolve) => socket.on('close', () => resolve())),
    };
    socket.on('error', (err: NodeJS.ErrnoException) => {
      entry.error = err.code ?? err.message;
    });
    conns.push(entry);
    if (onConn) onConn(socket);
    else socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    conns,
    close: () =>
      new Promise((resolve) => {
        for (const c of conns) c.socket.destroy();
        server.close(() => resolve());
      }),
  };
}

export interface Gateway {
  app: FastifyInstance;
  url: string;
  close(): Promise<void>;
}

export async function startGateway(
  overrides: ConfigOverrides = {},
  extra: { dns?: DnsResolver; mqtt?: MqttHandler; wifi?: WifiScanner; ble?: BleService } = {},
): Promise<Gateway> {
  const config = resolveConfig({ ...overrides, port: 1 });
  const app = buildServer({ config, ...extra });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return { app, url: `ws://127.0.0.1:${port}${NET_PATH}`, close: () => app.close() };
}

type Msg = NetGatewayMsg;

/** A test client of the gateway protocol over `ws`. */
export class Client {
  readonly msgs: Msg[] = [];
  /** Received TCP data per sid. */
  readonly data = new Map<number, Buffer[]>();
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: Array<() => void> = [];
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        const f = decodeDataFrame(raw);
        if (!f) throw new Error('bad frame from the gateway');
        const list = this.data.get(f.sid) ?? [];
        list.push(Buffer.from(f.bytes));
        this.data.set(f.sid, list);
        this.onData?.(f.sid, f.bytes.length);
      } else {
        const msg = parseGatewayMsg(raw.toString('utf8'));
        if (!msg) throw new Error(`bad message from the gateway: ${raw}`);
        this.msgs.push(msg);
      }
      for (const w of this.waiters.splice(0)) w();
    });
    this.closed = new Promise((resolve) =>
      ws.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString() });
        for (const w of this.waiters.splice(0)) w();
      }),
    );
  }

  onData?: (sid: number, n: number) => void;

  static async open(
    url: string,
    opts: { origin?: string; protocols?: string[]; hello?: Partial<NetClientMsg> | false } = {},
  ): Promise<Client> {
    const ws = new WebSocket(url, opts.protocols ?? [NET_SUBPROTOCOL], {
      ...(opts.origin ? { origin: opts.origin } : {}),
    });
    // Listen before the handshake ends: a message may come in the same packet as the 101.
    const c = new Client(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) =>
        reject(new Error(`unexpected response ${res.statusCode}`)),
      );
    });
    if (opts.hello !== false) {
      c.send({
        t: 'hello',
        v: 1,
        client: 'test',
        caps: ['tcp', 'dns'],
        ...opts.hello,
      } as NetClientMsg);
    }
    return c;
  }

  send(msg: NetClientMsg | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  sendData(sid: number, bytes: Uint8Array, kind: 1 | 2 = 1): void {
    this.ws.send(encodeDataFrame(kind, sid, bytes));
  }

  /** The first not yet taken message matching `pred` (waits for it). */
  async take<T extends Msg['t']>(
    t: T,
    pred: (m: Extract<Msg, { t: T }>) => boolean = () => true,
    timeoutMs = 5_000,
  ): Promise<Extract<Msg, { t: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.msgs.findIndex((m) => m.t === t && pred(m as Extract<Msg, { t: T }>));
      if (i >= 0) return this.msgs.splice(i, 1)[0] as Extract<Msg, { t: T }>;
      if (this.ws.readyState === WebSocket.CLOSED) throw new Error(`closed while waiting for ${t}`);
      const left = deadline - Date.now();
      if (left <= 0)
        throw new Error(`no ${t} in ${timeoutMs} ms; got ${JSON.stringify(this.msgs)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Bytes received on `sid` so far. */
  received(sid: number): Buffer {
    return Buffer.concat(this.data.get(sid) ?? []);
  }

  /** Wait until `sid` has at least `n` bytes. */
  async waitBytes(sid: number, n: number, timeoutMs = 5_000): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    while (this.received(sid).length < n) {
      if (Date.now() > deadline)
        throw new Error(`sid ${sid}: ${this.received(sid).length} of ${n} bytes`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.received(sid);
  }

  close(): void {
    this.ws.close();
  }
}

/** Resolves after `ms`. */
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

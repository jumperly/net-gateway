import { type AddressInfo, type Server, type Socket, createServer } from 'node:net';
import mqtt, { type Packet } from 'mqtt-packet';
import type { BrokerRegistry } from './brokers';

/** A client must send CONNECT within this time. */
const CONNECT_TIMEOUT_MS = 10_000;
/** A CONNECT packet larger than this is not a debugging tool's. */
const CONNECT_MAX = 64 * 1024;
/** CONNACK "bad user name or password" (3.1.1) / "bad user name or password" (5). */
const BAD_USERNAME = { 4: { returnCode: 4 }, 5: { reasonCode: 0x86 } } as const;

export interface DebugPort {
  server: Server;
  address: string;
  port: number;
  close(): Promise<void>;
}

export interface DebugPortOptions {
  /** 0: any free port. */
  port: number;
  registry: BrokerRegistry;
  log?: { info(obj: object, msg: string): void };
}

/**
 * The optional TCP port for external MQTT tools (MQTT Explorer, mosquitto_sub), bound to
 * `127.0.0.1` only: the CONNECT `username` is the namespace (`hello.ns` of the page); empty means
 * the shared `default` when sharing is on. Anything else gets CONNACK "bad user name" and is
 * closed. The connection then belongs to that namespace's broker (it keeps it loaded).
 */
export async function startDebugPort(opts: DebugPortOptions): Promise<DebugPort> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    accept(socket, opts);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    address: address.address,
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

function accept(socket: Socket, opts: DebugPortOptions): void {
  socket.on('error', () => {});
  const chunks: Buffer[] = [];
  let size = 0;
  let decided = false;
  const parser = mqtt.parser();
  const timer = setTimeout(() => socket.destroy(), CONNECT_TIMEOUT_MS);
  const onData = (chunk: Buffer) => {
    chunks.push(chunk);
    size += chunk.length;
    if (size > CONNECT_MAX) {
      socket.destroy();
      return;
    }
    parser.parse(chunk);
  };
  parser.on('error', () => socket.destroy());
  parser.on('packet', (packet: Packet) => {
    if (decided) return;
    decided = true;
    clearTimeout(timer);
    socket.off('data', onData);
    socket.pause();
    if (packet.cmd !== 'connect') {
      socket.destroy();
      return;
    }
    const ns = opts.registry.namespaceOf(packet.username || undefined);
    if (ns === undefined) {
      const version = packet.protocolVersion === 5 ? 5 : 4;
      socket.end(
        mqtt.generate(
          { cmd: 'connack', sessionPresent: false, ...BAD_USERNAME[version] },
          {
            protocolVersion: version,
          },
        ),
      );
      return;
    }
    let lease: ReturnType<BrokerRegistry['acquire']>;
    try {
      lease = opts.registry.acquire(ns);
    } catch {
      socket.destroy();
      return;
    }
    socket.once('close', () => lease.release());
    // The broker parses the CONNECT (and anything after it) again.
    socket.unshift(Buffer.concat(chunks));
    lease.broker.then(
      (broker) => {
        if (socket.destroyed) return;
        opts.log?.info({ ns, client: packet.clientId }, 'mqtt debug client');
        broker.handle(socket);
      },
      () => socket.destroy(),
    );
  });
  socket.on('data', onData);
}

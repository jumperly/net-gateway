import { type AddressInfo, type Socket, connect } from 'node:net';
import { MQTT_HOST, NET_WINDOW } from '@jumperly/schema';
import mqtt, { type Packet } from 'mqtt-packet';
import { afterEach, describe, expect, it } from 'vitest';
import { BrokerRegistry } from '../src/mqtt/brokers';
import { type DebugPort, startDebugPort } from '../src/mqtt/debug-port';
import { BrokerMqttHandler } from '../src/mqtt/handler';
import { MONITOR_PAYLOAD_MAX, MONITOR_RATE } from '../src/mqtt/monitor';
import { Client, type Gateway, sleep, startGateway } from './helpers';

const NS_A = 'project-aaaa-0001';
const NS_B = 'project-bbbb-0002';

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function setup(opts: { shared?: boolean; idleMs?: number } = {}) {
  const registry = new BrokerRegistry({ shared: opts.shared ?? false, idleMs: opts.idleMs });
  cleanup.push(() => registry.close());
  const gw = await startGateway({}, { mqtt: new BrokerMqttHandler(registry) });
  cleanup.push(() => gw.close());
  return { gw, registry };
}

async function session(gw: Gateway, ns: string | undefined, watch = false) {
  const c = await Client.open(gw.url, { hello: ns === undefined ? {} : { ns } });
  cleanup.push(() => c.close());
  const welcome = await c.take('welcome');
  if (watch) c.send({ t: 'mqtt.watch', on: true });
  return { c, welcome };
}

/** An MQTT client of the guest: raw packets over a gateway flow to the broker alias. */
class Guest {
  readonly packets: Packet[] = [];
  private readonly parser = mqtt.parser({ protocolVersion: 4 });
  private seen = 0;

  private constructor(
    readonly c: Client,
    readonly sid: number,
  ) {
    this.parser.on('packet', (p: Packet) => this.packets.push(p));
  }

  static async open(
    c: Client,
    sid: number,
    clientId: string,
    connect: Partial<mqtt.IConnectPacket> = {},
  ): Promise<Guest> {
    c.send({ t: 'open', sid, proto: 'tcp', host: MQTT_HOST, port: 1883, window: NET_WINDOW });
    const opened = await c.take('opened', (m) => m.sid === sid);
    expect(opened.remote).toBe(`${MQTT_HOST}:1883`);
    const g = new Guest(c, sid);
    g.send({
      cmd: 'connect',
      protocolId: 'MQTT',
      protocolVersion: 4,
      clean: true,
      keepalive: 60,
      clientId,
      ...connect,
    } as mqtt.IConnectPacket);
    const ack = await g.take('connack');
    expect(ack).toMatchObject({ returnCode: 0 });
    return g;
  }

  send(p: Packet): void {
    this.c.sendData(this.sid, mqtt.generate(p));
  }

  async subscribe(topic: string, messageId = 1): Promise<void> {
    this.send({ cmd: 'subscribe', messageId, subscriptions: [{ topic, qos: 0 }] });
    await this.take('suback', (p) => p.messageId === messageId);
  }

  publish(topic: string, payload: string | Buffer, opts: { retain?: boolean } = {}): void {
    this.send({
      cmd: 'publish',
      topic,
      payload,
      qos: 0,
      retain: opts.retain ?? false,
      dup: false,
    });
  }

  private feed(): void {
    const all = this.c.received(this.sid);
    if (all.length > this.seen) {
      this.parser.parse(all.subarray(this.seen));
      this.seen = all.length;
    }
  }

  async take<C extends Packet['cmd']>(
    cmd: C,
    pred: (p: Extract<Packet, { cmd: C }>) => boolean = () => true,
    timeoutMs = 5_000,
  ): Promise<Extract<Packet, { cmd: C }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.feed();
      const i = this.packets.findIndex(
        (p) => p.cmd === cmd && pred(p as Extract<Packet, { cmd: C }>),
      );
      if (i >= 0) return this.packets.splice(i, 1)[0] as Extract<Packet, { cmd: C }>;
      if (Date.now() > deadline)
        throw new Error(`no ${cmd} in ${timeoutMs} ms; got ${this.packets.map((p) => p.cmd)}`);
      await sleep(10);
    }
  }

  /** No packet `cmd` arrives within `ms`. */
  async none(cmd: Packet['cmd'], ms = 300): Promise<void> {
    await sleep(ms);
    this.feed();
    expect(this.packets.filter((p) => p.cmd === cmd)).toEqual([]);
  }
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
const text = (p: Packet) => ((p as mqtt.IPublishPacket).payload as Buffer).toString();

describe('mqtt: the session', () => {
  it('offers the broker with a namespace: cap mqtt, welcome.mqtt, alias not listed', async () => {
    const { gw } = await setup();
    const { welcome } = await session(gw, NS_A);
    expect(welcome.caps).toEqual(['tcp', 'dns', 'mqtt']);
    expect(welcome.mqtt).toEqual({ host: MQTT_HOST, port: 1883 });
    expect(welcome.aliases).not.toContain(MQTT_HOST);
  });

  it('without ns and without NETGW_MQTT_SHARED there is no broker', async () => {
    const { gw, registry } = await setup();
    const { c, welcome } = await session(gw, undefined);
    expect(welcome.caps).toEqual(['tcp', 'dns']);
    expect(welcome.mqtt).toBeUndefined();
    c.send({ t: 'open', sid: 1, proto: 'tcp', host: MQTT_HOST, port: 1883, window: NET_WINDOW });
    expect(await c.take('refused', (m) => m.sid === 1)).toMatchObject({ code: 'unsupported' });
    c.send({ t: 'mqtt.watch', on: true });
    expect(await c.take('notice')).toMatchObject({ code: 'unsupported' });
    expect(registry.size).toBe(0);
  });

  it('without ns and with NETGW_MQTT_SHARED the shared broker `default` serves', async () => {
    const { gw, registry } = await setup({ shared: true });
    const { c, welcome } = await session(gw, undefined, true);
    expect(welcome.caps).toContain('mqtt');
    const g = await Guest.open(c, 1, 'shared-1');
    g.publish('a/b', 'x');
    expect(await c.take('mqtt.message')).toMatchObject({ topic: 'a/b', from: 'shared-1' });
    expect(registry.has('default')).toBe(true);
  });
});

describe('mqtt: guest ↔ broker ↔ monitor', () => {
  it('CONNECT/CONNACK, SUBSCRIBE/SUBACK, PUBLISH comes back; the monitor sees it', async () => {
    const { gw } = await setup();
    const { c } = await session(gw, NS_A, true);
    const g = await Guest.open(c, 1, 'esp32-1');
    await g.subscribe('sensors/#');
    g.publish('sensors/temp', '21.5');
    const back = await g.take('publish');
    expect(back.topic).toBe('sensors/temp');
    expect(text(back)).toBe('21.5');

    const m = await c.take('mqtt.message');
    expect(m).toMatchObject({
      t: 'mqtt.message',
      topic: 'sensors/temp',
      payload: b64('21.5'),
      qos: 0,
      retain: false,
      size: 4,
      truncated: false,
      from: 'esp32-1',
    });
    expect(Math.abs(m.at - Date.now())).toBeLessThan(5_000);
  });

  it('mqtt.publish from the UI reaches the guest; mqtt.watch off stops the monitor', async () => {
    const { gw } = await setup();
    const { c } = await session(gw, NS_A, true);
    const g = await Guest.open(c, 1, 'esp32-1');
    await g.subscribe('led');
    c.send({ t: 'mqtt.publish', topic: 'led', payload: b64('on'), qos: 1, retain: false });
    const p = await g.take('publish');
    expect(p.topic).toBe('led');
    expect(text(p)).toBe('on');
    const m = await c.take('mqtt.message');
    expect(m).toMatchObject({ topic: 'led', payload: b64('on'), qos: 1 });
    expect(m.from).toBeUndefined();

    c.send({ t: 'mqtt.watch', on: false });
    await sleep(50);
    g.publish('led', 'off');
    await g.take('publish', (x) => text(x) === 'off');
    await sleep(200);
    expect(c.msgs.filter((x) => x.t === 'mqtt.message')).toEqual([]);
  });

  it('a fast watch on → off → on subscribes once: no message twice', async () => {
    const { gw } = await setup();
    const { c } = await session(gw, NS_A);
    const g = await Guest.open(c, 1, 'esp32-1');
    g.publish('state', 'ready', { retain: true });
    await sleep(100);
    c.send({ t: 'mqtt.watch', on: true });
    c.send({ t: 'mqtt.watch', on: false });
    c.send({ t: 'mqtt.watch', on: true });
    await sleep(200);
    g.publish('led', 'on');
    await sleep(200);
    const shown = c.msgs.flatMap((m) => (m.t === 'mqtt.message' ? [`${m.topic} ${m.retain}`] : []));
    expect(shown).toEqual(['state true', 'led false']);
  });

  it('mqtt.publish to a wildcard or $ topic is refused with a notice', async () => {
    const { gw } = await setup();
    const { c } = await session(gw, NS_A);
    c.send({ t: 'mqtt.publish', topic: 'a/#', payload: '', qos: 0, retain: false });
    expect(await c.take('notice')).toMatchObject({ code: 'mqtt.topic' });
    c.send({ t: 'mqtt.publish', topic: '$SYS/x', payload: '', qos: 0, retain: false });
    expect(await c.take('notice')).toMatchObject({ code: 'mqtt.topic' });
  });

  it('two namespaces are isolated, sessions with one namespace share a broker', async () => {
    const { gw, registry } = await setup();
    const a = await session(gw, NS_A, true);
    const b = await session(gw, NS_B, true);
    const a2 = await session(gw, NS_A, true);
    const ga = await Guest.open(a.c, 1, 'same-id');
    const gb = await Guest.open(b.c, 1, 'same-id');
    await ga.subscribe('#');
    await gb.subscribe('#');

    gb.publish('t', 'from-b');
    expect(await b.c.take('mqtt.message')).toMatchObject({ payload: b64('from-b') });
    expect(text(await gb.take('publish'))).toBe('from-b');
    await ga.none('publish');
    expect(a.c.msgs.filter((m) => m.t === 'mqtt.message')).toEqual([]);

    ga.publish('t', 'from-a');
    expect(await a2.c.take('mqtt.message')).toMatchObject({ payload: b64('from-a') });
    expect(text(await ga.take('publish'))).toBe('from-a');
    await gb.none('publish');
    expect(registry.size).toBe(2);
  });

  it('a retained message survives the guest reconnecting and the session reconnecting', async () => {
    const { gw } = await setup();
    const s1 = await session(gw, NS_A);
    const g1 = await Guest.open(s1.c, 1, 'esp32-1');
    g1.publish('state', 'ready', { retain: true });
    await sleep(100);
    g1.send({ cmd: 'disconnect' });
    expect(await s1.c.take('closed', (m) => m.sid === 1)).toMatchObject({ reset: false });

    const g2 = await Guest.open(s1.c, 2, 'esp32-1');
    g2.send({ cmd: 'subscribe', messageId: 7, subscriptions: [{ topic: 'state', qos: 0 }] });
    const r = await g2.take('publish');
    expect(r).toMatchObject({ topic: 'state', retain: true });
    expect(text(r)).toBe('ready');
    s1.c.close();
    await s1.c.closed;

    // A new page with the same namespace: the broker is still loaded, the monitor gets the
    // retained message on watch.
    const s2 = await session(gw, NS_A, true);
    expect(await s2.c.take('mqtt.message')).toMatchObject({
      topic: 'state',
      payload: b64('ready'),
      retain: true,
    });
    const g3 = await Guest.open(s2.c, 1, 'esp32-2');
    await g3.subscribe('state');
    expect(text(await g3.take('publish'))).toBe('ready');
  });

  it('a guest FIN ends the MQTT connection: eof, closed without reset', async () => {
    const { gw } = await setup();
    const { c } = await session(gw, NS_A);
    await Guest.open(c, 1, 'esp32-1');
    c.send({ t: 'shutdown', sid: 1 });
    await c.take('eof', (m) => m.sid === 1);
    expect(await c.take('closed', (m) => m.sid === 1)).toMatchObject({ reset: false });
  });

  it('a guest that drops the connection leaves its will', async () => {
    const { gw } = await setup();
    const { c } = await session(gw, NS_A, true);
    await Guest.open(c, 1, 'esp32-1', {
      will: { topic: 'status', payload: Buffer.from('offline'), qos: 0, retain: false },
    });
    c.send({ t: 'close', sid: 1, abort: true });
    expect(await c.take('mqtt.message')).toMatchObject({
      topic: 'status',
      payload: b64('offline'),
    });
  });
});

describe('mqtt: monitor limits', () => {
  it(`truncates payloads over ${MONITOR_PAYLOAD_MAX} bytes, size is the full length`, async () => {
    const { gw } = await setup();
    const { c } = await session(gw, NS_A, true);
    const g = await Guest.open(c, 1, 'esp32-1');
    const big = Buffer.alloc(10_000, 0x61);
    big.write('HEAD', 0);
    g.publish('big', big);
    const m = await c.take('mqtt.message');
    expect(m).toMatchObject({ topic: 'big', size: 10_000, truncated: true });
    const shown = Buffer.from(m.payload, 'base64');
    expect(shown.length).toBe(MONITOR_PAYLOAD_MAX);
    expect(shown.subarray(0, 4).toString()).toBe('HEAD');

    g.publish('small', Buffer.alloc(MONITOR_PAYLOAD_MAX, 0x62));
    expect(await c.take('mqtt.message')).toMatchObject({
      size: MONITOR_PAYLOAD_MAX,
      truncated: false,
    });
  });

  it(`shows at most ${MONITOR_RATE} messages per second and says how many it skipped`, async () => {
    const { gw } = await setup();
    const { c } = await session(gw, NS_A, true);
    const g = await Guest.open(c, 1, 'esp32-1');
    for (let i = 0; i < 200; i++) g.publish('flood', String(i));
    await sleep(400);
    const shown = c.msgs.filter((m) => m.t === 'mqtt.message').length;
    expect(shown).toBeGreaterThanOrEqual(MONITOR_RATE);
    expect(shown).toBeLessThanOrEqual(MONITOR_RATE * 1.5);
    const notice = await c.take('notice', (m) => m.code === 'mqtt.rate', 2_000);
    expect(notice.msg).toMatch(/\d+/);
    // The guests themselves are not limited: the broker delivered all 200.
    await g.subscribe('flood2');
    for (let i = 0; i < 100; i++) g.publish('flood2', String(i));
    for (let i = 0; i < 100; i++) await g.take('publish', (p) => p.topic === 'flood2');
  });
});

describe('mqtt: broker registry', () => {
  it('unloads an idle broker: retained messages go with it', async () => {
    const { gw, registry } = await setup({ idleMs: 200 });
    const s1 = await session(gw, NS_A);
    const g = await Guest.open(s1.c, 1, 'esp32-1');
    g.publish('state', 'ready', { retain: true });
    await sleep(100);
    expect(registry.has(NS_A)).toBe(true);
    s1.c.close();
    await s1.c.closed;
    await sleep(100);
    expect(registry.has(NS_A)).toBe(true);
    await sleep(400);
    expect(registry.has(NS_A)).toBe(false);

    const s2 = await session(gw, NS_A, true);
    const g2 = await Guest.open(s2.c, 1, 'esp32-1');
    await g2.subscribe('state');
    await g2.none('publish');
    expect(s2.c.msgs.filter((m) => m.t === 'mqtt.message')).toEqual([]);
  });

  it('a session coming back before the idle timeout keeps the broker', async () => {
    const { gw, registry } = await setup({ idleMs: 300 });
    const s1 = await session(gw, NS_A);
    await Guest.open(s1.c, 1, 'esp32-1');
    s1.c.close();
    await s1.c.closed;
    await sleep(150);
    await session(gw, NS_A);
    await sleep(400);
    expect(registry.has(NS_A)).toBe(true);
  });

  it('close() unloads every broker', async () => {
    const registry = new BrokerRegistry({ shared: false });
    const lease = registry.acquire(NS_A);
    await lease.broker;
    expect(registry.size).toBe(1);
    await registry.close();
    expect(registry.size).toBe(0);
    expect(() => registry.acquire(NS_B)).toThrow();
  });

  it('namespace of a session: ns itself, `default` only when shared', () => {
    const own = new BrokerRegistry({ shared: false });
    expect(own.namespaceOf(NS_A)).toBe(NS_A);
    expect(own.namespaceOf(undefined)).toBeUndefined();
    const shared = new BrokerRegistry({ shared: true });
    expect(shared.namespaceOf(undefined)).toBe('default');
    expect(shared.namespaceOf(NS_A)).toBe(NS_A);
  });
});

describe('mqtt: the debug port', () => {
  async function debugPort(registry: BrokerRegistry): Promise<DebugPort> {
    const port = await startDebugPort({ port: 0, registry });
    cleanup.push(() => port.close());
    return port;
  }

  /** A raw MQTT client over TCP. */
  async function tcpClient(port: number, username?: string) {
    const socket: Socket = connect({ host: '127.0.0.1', port });
    cleanup.push(() => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const packets: Packet[] = [];
    const parser = mqtt.parser({ protocolVersion: 4 });
    parser.on('packet', (p: Packet) => packets.push(p));
    socket.on('data', (d: Buffer) => parser.parse(d));
    const ended = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.write(
      mqtt.generate({
        cmd: 'connect',
        protocolId: 'MQTT',
        protocolVersion: 4,
        clean: true,
        keepalive: 60,
        clientId: 'mqttx',
        ...(username !== undefined ? { username } : {}),
      }),
    );
    const take = async (cmd: Packet['cmd']) => {
      for (let i = 0; i < 300; i++) {
        const k = packets.findIndex((p) => p.cmd === cmd);
        if (k >= 0) return packets.splice(k, 1)[0] as Packet;
        await sleep(10);
      }
      throw new Error(`no ${cmd}`);
    };
    return { socket, take, ended };
  }

  it('listens on 127.0.0.1; username = ns joins that namespace', async () => {
    const { gw, registry } = await setup();
    const port = await debugPort(registry);
    expect(port.address).toBe('127.0.0.1');
    const { c } = await session(gw, NS_A, true);
    const g = await Guest.open(c, 1, 'esp32-1');
    await g.subscribe('cmd');

    const t = await tcpClient(port.port, NS_A);
    expect(await t.take('connack')).toMatchObject({ returnCode: 0 });
    t.socket.write(
      mqtt.generate({
        cmd: 'publish',
        topic: 'cmd',
        payload: 'blink',
        qos: 0,
        retain: false,
        dup: false,
      }),
    );
    expect(text(await g.take('publish'))).toBe('blink');
    expect(await c.take('mqtt.message')).toMatchObject({ topic: 'cmd', from: 'mqttx' });
  });

  it('refuses a missing or malformed username (CONNACK 4) unless shared', async () => {
    const { registry } = await setup();
    const port = await debugPort(registry);
    for (const username of [undefined, 'short', 'bad name!']) {
      const t = await tcpClient(port.port, username);
      expect(await t.take('connack')).toMatchObject({ returnCode: 4 });
      await t.ended;
    }
    expect(registry.size).toBe(0);

    const shared = new BrokerRegistry({ shared: true });
    cleanup.push(() => shared.close());
    const port2 = await debugPort(shared);
    const t = await tcpClient(port2.port);
    expect(await t.take('connack')).toMatchObject({ returnCode: 0 });
    expect(shared.has('default')).toBe(true);
  });

  it('holds the broker while connected', async () => {
    const registry = new BrokerRegistry({ shared: false, idleMs: 100 });
    cleanup.push(() => registry.close());
    const port = await debugPort(registry);
    const t = await tcpClient(port.port, NS_B);
    await t.take('connack');
    await sleep(300);
    expect(registry.has(NS_B)).toBe(true);
    t.socket.destroy();
    await sleep(400);
    expect(registry.has(NS_B)).toBe(false);
    expect((port.server.address() as AddressInfo).port).toBe(port.port);
  });
});

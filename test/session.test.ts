import { createHash, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { NET_FRAME_MAX, NET_SUBPROTOCOL, NET_WINDOW } from '@jumperly/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { Aliases } from '../src/aliases';
import type { ConfigOverrides } from '../src/config';
import { DnsResolver } from '../src/dns';
import { Client, type Gateway, type TcpServer, sleep, startGateway, tcpServer } from './helpers';

const ECHO = 'echo.jumperly.internal';
const BLOB = 'blob.jumperly.internal';
const CLOSED = 'closed.jumperly.internal';
const MiB = 1024 * 1024;

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function setup(
  overrides: ConfigOverrides = {},
  extra: Parameters<typeof startGateway>[1] = {},
) {
  const echo = await tcpServer();
  cleanup.push(() => echo.close());
  const aliases = {
    [ECHO]: { kind: 'tcp' as const, host: '127.0.0.1', port: echo.port },
    ...overrides.aliases,
  };
  const gw = await startGateway({ ...overrides, aliases }, extra);
  cleanup.push(() => gw.close());
  return { echo, gw };
}

async function client(gw: Gateway, opts: Parameters<typeof Client.open>[1] = {}) {
  const c = await Client.open(gw.url, opts);
  cleanup.push(() => c.close());
  await c.take('welcome');
  return c;
}

/** Open `sid` to the echo alias and wait for `opened`. */
async function openEcho(c: Client, sid: number, window = NET_WINDOW) {
  c.send({ t: 'open', sid, proto: 'tcp', host: ECHO, port: 7, window });
  return c.take('opened', (m) => m.sid === sid);
}

describe('session', () => {
  it('greets with welcome: server, public, limits, aliases, no MQTT', async () => {
    const { gw } = await setup();
    const c = await Client.open(gw.url);
    cleanup.push(() => c.close());
    const w = await c.take('welcome');
    expect(w).toMatchObject({
      v: 1,
      gateway: 'server',
      scope: 'public',
      caps: ['tcp', 'dns'],
      aliases: [ECHO],
      limits: {
        maxConns: 8,
        connPerMin: 30,
        bytesPerSec: 256 * 1024,
        totalBytes: 64 * MiB,
        tcpPorts: [80, 443, 1883, 8883, 8080],
        udpPorts: [],
      },
    });
    expect(w.session).toMatch(/.{8,}/);
    expect(w.mqtt).toBeUndefined();
  });

  it('echoes TCP through an alias, with credits both ways, shutdown → eof → closed', async () => {
    const { gw } = await setup();
    const c = await client(gw);
    const opened = await openEcho(c, 1);
    expect(opened).toEqual({ t: 'opened', sid: 1, remote: `${ECHO}:7`, window: NET_WINDOW });

    c.sendData(1, Buffer.from('hello'));
    expect((await c.waitBytes(1, 5)).toString()).toBe('hello');
    expect(await c.take('credit', (m) => m.sid === 1)).toEqual({ t: 'credit', sid: 1, bytes: 5 });

    c.send({ t: 'shutdown', sid: 1 });
    await c.take('eof', (m) => m.sid === 1);
    expect(await c.take('closed', (m) => m.sid === 1)).toEqual({
      t: 'closed',
      sid: 1,
      reset: false,
    });
  });

  it("sends no more than the client's window and pauses until credit", async () => {
    const { gw } = await setup();
    const c = await client(gw);
    await openEcho(c, 1, 4);
    c.sendData(1, Buffer.from('0123456789'));
    await c.waitBytes(1, 4);
    await sleep(200);
    expect(c.received(1).toString()).toBe('0123');
    c.send({ t: 'credit', sid: 1, bytes: 3 });
    await c.waitBytes(1, 7);
    await sleep(100);
    expect(c.received(1).toString()).toBe('0123456');
    c.send({ t: 'credit', sid: 1, bytes: 100 });
    expect((await c.waitBytes(1, 10)).toString()).toBe('0123456789');
  });

  it('close with abort resets the remote connection; plain close ends it', async () => {
    const { echo, gw } = await setup();
    const c = await client(gw);
    await openEcho(c, 1);
    await openEcho(c, 2);
    c.send({ t: 'close', sid: 1, abort: true });
    c.send({ t: 'close', sid: 2 });
    await Promise.all(echo.conns.map((x) => x.closed));
    expect(echo.conns[0]?.error).toBe('ECONNRESET');
    expect(echo.conns[1]?.error).toBeUndefined();
    // No message follows a client close.
    await sleep(100);
    expect(c.msgs.filter((m) => 'sid' in m && (m.sid === 1 || m.sid === 2))).toEqual([]);
  });

  it('refuses the 9th concurrent flow with limit.conns', async () => {
    const { gw } = await setup();
    const c = await client(gw);
    for (let sid = 1; sid <= 8; sid++) await openEcho(c, sid);
    c.send({ t: 'open', sid: 9, proto: 'tcp', host: ECHO, port: 7, window: NET_WINDOW });
    expect(await c.take('refused', (m) => m.sid === 9)).toMatchObject({ code: 'limit.conns' });
    c.send({ t: 'close', sid: 1 });
    await openEcho(c, 9);
  });

  it('refuses the 31st open in a minute with limit.rate', async () => {
    const { gw } = await setup();
    const c = await client(gw);
    for (let sid = 1; sid <= 30; sid++) {
      await openEcho(c, sid);
      c.send({ t: 'close', sid, abort: true });
    }
    c.send({ t: 'open', sid: 31, proto: 'tcp', host: ECHO, port: 7, window: NET_WINDOW });
    expect(await c.take('refused', (m) => m.sid === 31)).toMatchObject({ code: 'limit.rate' });
  });

  it('closes the flows with limit.total when the session total is spent', async () => {
    const { gw } = await setup({ limits: { totalBytes: 100_000 } });
    const c = await client(gw);
    await openEcho(c, 1);
    const chunk = randomBytes(NET_FRAME_MAX);
    // 64 KiB up (the whole window) and its echo down: over 100 000 on the way back.
    for (let i = 0; i < 4; i++) c.sendData(1, chunk);
    expect(await c.take('closed', (m) => m.sid === 1)).toMatchObject({
      reset: true,
      code: 'limit.total',
    });
    c.send({ t: 'open', sid: 2, proto: 'tcp', host: ECHO, port: 7, window: NET_WINDOW });
    expect(await c.take('refused', (m) => m.sid === 2)).toMatchObject({ code: 'limit.total' });
  });

  it('holds a download to bytesPerSec (±20 % over 2 MiB)', async () => {
    const payload = randomBytes(2 * MiB);
    const blob = await tcpServer((s) => s.end(payload));
    cleanup.push(() => blob.close());
    const { gw } = await setup({
      limits: { bytesPerSec: MiB },
      aliases: { [BLOB]: { kind: 'tcp', host: '127.0.0.1', port: blob.port } },
    });
    const c = await client(gw);
    c.onData = (sid, n) => c.send({ t: 'credit', sid, bytes: n });
    const t0 = performance.now();
    c.send({ t: 'open', sid: 1, proto: 'tcp', host: BLOB, port: 80, window: NET_WINDOW });
    await c.take('opened');
    await c.take('eof', (m) => m.sid === 1, 10_000);
    const seconds = (performance.now() - t0) / 1000;
    expect(c.received(1).equals(payload)).toBe(true);
    expect(seconds).toBeGreaterThan(2 * 0.8);
    expect(seconds).toBeLessThan(2 * 1.2);
  });

  it('carries 10 MiB both ways under backpressure, buffers bounded by the windows', async () => {
    const { gw } = await setup({ limits: { bytesPerSec: 64 * MiB, totalBytes: 64 * MiB } });
    const c = await client(gw);
    const window = 32 * 1024;
    await openEcho(c, 1, window);
    const total = 10 * MiB;
    const payload = randomBytes(total);
    const want = createHash('sha256').update(payload).digest('hex');

    // Upload: never more than the gateway's credit.
    let sent = 0;
    let shut = false;
    let credit = NET_WINDOW;
    let overrun = 0;
    const pump = () => {
      while (sent < total && credit > 0) {
        const n = Math.min(NET_FRAME_MAX, credit, total - sent);
        c.sendData(1, payload.subarray(sent, sent + n));
        sent += n;
        credit -= n;
      }
      if (sent === total && !shut) {
        shut = true;
        c.send({ t: 'shutdown', sid: 1 });
      }
    };
    const origPush = c.msgs.push.bind(c.msgs);
    c.msgs.push = (...items) => {
      for (const m of items)
        if (m.t === 'credit' && m.sid === 1) {
          credit += m.bytes;
          queueMicrotask(pump);
        }
      return origPush(...items);
    };
    // A slow consumer: credit back every 16 KiB after a pause; never more than the window
    // outstanding.
    let got = 0;
    let unacked = 0;
    let outstanding = 0;
    c.onData = (_sid, n) => {
      got += n;
      outstanding += n;
      if (outstanding > window) overrun = Math.max(overrun, outstanding - window);
      unacked += n;
      if (unacked >= 16 * 1024 || got === total) {
        const bytes = unacked;
        unacked = 0;
        setTimeout(() => {
          outstanding -= bytes;
          c.send({ t: 'credit', sid: 1, bytes });
        }, 1);
      }
    };
    pump();
    await c.take('eof', (m) => m.sid === 1, 60_000);
    expect(overrun).toBe(0);
    expect(got).toBe(total);
    expect(createHash('sha256').update(c.received(1)).digest('hex')).toBe(want);
    const stats = [...gw.app.netGateway.sessions][0]?.stats;
    expect(stats?.peakPending).toBeLessThanOrEqual(128 * 1024);
    expect(stats?.peakBuffered).toBeLessThanOrEqual(window + 2 * NET_FRAME_MAX);
  }, 60_000);

  it('pauses every flow while the WebSocket holds over 1 MiB', async () => {
    const payload = randomBytes(16 * MiB);
    const blob = await tcpServer((s) => s.end(payload));
    cleanup.push(() => blob.close());
    const { gw } = await setup({
      limits: { bytesPerSec: 256 * MiB, totalBytes: 64 * MiB },
      aliases: { [BLOB]: { kind: 'tcp', host: '127.0.0.1', port: blob.port } },
    });
    const c = await client(gw);
    // A huge window: only the WebSocket high water can hold the gateway back.
    c.send({ t: 'open', sid: 1, proto: 'tcp', host: BLOB, port: 80, window: 0xffffffff });
    await c.take('opened');
    // Stop reading: the kernel buffers fill, then ws.bufferedAmount grows.
    (c.ws as unknown as { _socket: import('node:net').Socket })._socket.pause();
    await sleep(1_000);
    const stats = [...gw.app.netGateway.sessions][0]?.stats;
    expect(stats?.peakBuffered).toBeGreaterThan(MiB);
    expect(stats?.peakBuffered).toBeLessThanOrEqual(MiB + 2 * NET_FRAME_MAX);
    expect(stats?.peakPending).toBeLessThanOrEqual(128 * 1024);
    (c.ws as unknown as { _socket: import('node:net').Socket })._socket.resume();
    await c.take('eof', (m) => m.sid === 1, 20_000);
    expect(c.received(1).equals(payload)).toBe(true);
  }, 30_000);

  it('slows a flood of frames to framesPerSec', async () => {
    const { gw } = await setup({ limits: { framesPerSec: 200 } });
    const c = await client(gw);
    const t0 = performance.now();
    for (let i = 0; i < 500; i++) c.send({ t: 'ping', ts: i });
    await c.take('pong', (m) => m.ts === 499);
    // 200 at once (the burst), then 300 at 200/s.
    expect(performance.now() - t0).toBeGreaterThan(1_200);
  });

  it('carries UDP datagrams when UDP ports are open', async () => {
    const echo = createSocket('udp4');
    echo.on('message', (msg, rinfo) => echo.send(msg, rinfo.port, rinfo.address));
    await new Promise<void>((resolve) => echo.bind(0, '127.0.0.1', resolve));
    cleanup.push(() => echo.close());
    const port = echo.address().port;
    const { gw } = await setup({ udpPorts: [port], allowCidrs: ['127.0.0.0/8'] });
    const c = await Client.open(gw.url);
    cleanup.push(() => c.close());
    expect((await c.take('welcome')).caps).toEqual(['tcp', 'udp', 'dns']);
    c.send({ t: 'open', sid: 2, proto: 'udp', host: '127.0.0.1', port, window: 0 });
    expect(await c.take('opened')).toEqual({
      t: 'opened',
      sid: 2,
      remote: `127.0.0.1:${port}`,
      window: 0,
    });
    c.sendData(2, Buffer.from('ping'), 2);
    expect((await c.waitBytes(2, 4)).toString()).toBe('ping');
    c.send({ t: 'open', sid: 3, proto: 'udp', host: '127.0.0.1', port: port + 1, window: 0 });
    expect(await c.take('refused')).toMatchObject({ sid: 3, code: 'policy.port' });
  });

  it('refuses a private address even after a DNS answer pointed there (rebinding)', async () => {
    const dns = new DnsResolver({
      aliases: new Aliases(),
      backend: { resolve: async () => [{ address: '127.0.0.1', ttl: 1 }] },
    });
    const { gw } = await setup({}, { dns });
    const c = await client(gw);
    c.send({ t: 'resolve', qid: 1, name: 'rebind.example', type: 'A' });
    expect(await c.take('resolved')).toEqual({
      t: 'resolved',
      qid: 1,
      addrs: ['127.0.0.1'],
      ttl: 1,
    });
    c.send({ t: 'open', sid: 1, proto: 'tcp', host: '127.0.0.1', port: 80, window: NET_WINDOW });
    expect(await c.take('refused')).toMatchObject({ sid: 1, code: 'policy.private' });
  });

  it('answers an alias lookup with alias: true', async () => {
    const { gw } = await setup();
    const c = await client(gw);
    c.send({ t: 'resolve', qid: 7, name: 'Echo.Jumperly.Internal', type: 'A' });
    expect(await c.take('resolved')).toEqual({
      t: 'resolved',
      qid: 7,
      addrs: [],
      ttl: 300,
      alias: true,
    });
  });

  it.each([
    ['example.com', 80, 'policy.host'],
    ['127.1', 80, 'policy.host'],
    ['[::1]', 80, 'policy.host'],
    ['10.0.0.1', 80, 'policy.private'],
    ['93.184.215.14', 22, 'policy.port'],
  ])('refuses open %s:%s with %s', async (host, port, code) => {
    const { gw } = await setup();
    const c = await client(gw);
    c.send({ t: 'open', sid: 5, proto: 'tcp', host, port, window: NET_WINDOW });
    expect(await c.take('refused')).toMatchObject({ sid: 5, code });
  });

  it('refuses UDP while it is off', async () => {
    const { gw } = await setup();
    const c = await client(gw);
    c.send({ t: 'open', sid: 5, proto: 'udp', host: '1.1.1.1', port: 53, window: 0 });
    expect(await c.take('refused')).toMatchObject({ sid: 5, code: 'policy.proto' });
  });

  it('maps a refused connection to net.refused', async () => {
    const dead = await tcpServer();
    const port = dead.port;
    await dead.close();
    const { gw } = await setup({
      aliases: { [CLOSED]: { kind: 'tcp', host: '127.0.0.1', port } },
    });
    const c = await client(gw);
    c.send({ t: 'open', sid: 3, proto: 'tcp', host: CLOSED, port: 80, window: NET_WINDOW });
    expect(await c.take('refused')).toMatchObject({ sid: 3, code: 'net.refused' });
    // The slot is free again.
    for (let sid = 10; sid < 18; sid++) await openEcho(c, sid);
  });

  it('sends eof then closed when the remote host finishes', async () => {
    const hi = await tcpServer((s) => s.end('hi'));
    cleanup.push(() => hi.close());
    const { gw } = await setup({
      aliases: { [BLOB]: { kind: 'tcp', host: '127.0.0.1', port: hi.port } },
    });
    const c = await client(gw);
    c.send({ t: 'open', sid: 1, proto: 'tcp', host: BLOB, port: 80, window: NET_WINDOW });
    await c.take('opened');
    await c.take('eof');
    expect(c.received(1).toString()).toBe('hi');
    c.send({ t: 'shutdown', sid: 1 });
    expect(await c.take('closed')).toEqual({ t: 'closed', sid: 1, reset: false });
  });

  it('closes an idle flow', async () => {
    const { gw } = await setup({ timeouts: { tcpIdleMs: 200 } });
    const c = await client(gw);
    await openEcho(c, 1);
    expect(await c.take('closed')).toMatchObject({ sid: 1, reset: true });
  });

  it('answers ping, and unsupported for the helper-only and MQTT messages', async () => {
    const { gw } = await setup();
    const c = await client(gw);
    c.send({ t: 'ping', ts: 42 });
    expect(await c.take('pong')).toEqual({ t: 'pong', ts: 42 });
    c.send({ t: 'listen', sid: 4, proto: 'tcp', port: 80 });
    expect(await c.take('refused')).toMatchObject({ sid: 4, code: 'unsupported' });
    c.send({ t: 'accept', sid: 4, ok: true });
    c.send({ t: 'wifi.scan' });
    c.send({ t: 'mqtt.watch', on: true });
    for (let i = 0; i < 3; i++) await c.take('notice', (m) => m.code === 'unsupported');
  });
});

describe('admission', () => {
  it('answers 403 to a foreign Origin and admits an allowed one', async () => {
    const { gw } = await setup();
    await expect(Client.open(gw.url, { origin: 'https://evil.example' })).rejects.toThrow(
      /unexpected response 403/,
    );
    const c = await client(gw, { origin: 'http://localhost:5173' });
    c.send({ t: 'ping', ts: 1 });
    await c.take('pong');
  });

  it('answers 400 without the subprotocol', async () => {
    const { gw } = await setup();
    await expect(Client.open(gw.url, { protocols: [] })).rejects.toThrow(/unexpected response 400/);
    await expect(Client.open(gw.url, { protocols: ['other.1'] })).rejects.toThrow(
      /unexpected response 400/,
    );
    const c = await Client.open(gw.url, { protocols: ['other.1', NET_SUBPROTOCOL] });
    cleanup.push(() => c.close());
    expect(c.ws.protocol).toBe(NET_SUBPROTOCOL);
  });

  it.each<[string, (c: Client) => void]>([
    ['not JSON', (c) => c.ws.send('{oops')],
    ['an unknown message', (c) => c.send({ t: 'teleport' })],
    ['an extra field', (c) => c.send({ t: 'ping', ts: 1, x: 1 } as Record<string, unknown>)],
    ['a short binary frame', (c) => c.ws.send(Buffer.from([1, 0, 0]))],
    ['an unknown frame kind', (c) => c.ws.send(Buffer.from([9, 0, 0, 0, 1, 42]))],
    ['an oversized frame', (c) => c.ws.send(Buffer.alloc(5 + NET_FRAME_MAX + 1, 1))],
    ['a JSON array', (c) => c.ws.send('[]')],
    ['a second hello', (c) => c.send({ t: 'hello', v: 1, client: 'x', caps: [] })],
  ])('closes with 1008 on %s', async (_name, bad) => {
    const { gw } = await setup();
    const c = await client(gw);
    bad(c);
    expect((await c.closed).code).toBe(1008);
  });

  it('closes with 1008 on data beyond the granted window', async () => {
    const { gw } = await setup();
    const c = await client(gw);
    await openEcho(c, 1);
    const chunk = Buffer.alloc(NET_FRAME_MAX);
    for (let i = 0; i < 5; i++) c.sendData(1, chunk);
    expect((await c.closed).code).toBe(1008);
  });

  it('closes with 1008 when a message precedes hello', async () => {
    const { gw } = await setup();
    const c = await Client.open(gw.url, { hello: false });
    cleanup.push(() => c.close());
    c.send({ t: 'ping', ts: 1 });
    expect((await c.closed).code).toBe(1008);
  });

  it('closes with 1008 without hello in time', async () => {
    const { gw } = await setup({ timeouts: { helloMs: 150 } });
    const c = await Client.open(gw.url, { hello: false });
    cleanup.push(() => c.close());
    expect((await c.closed).code).toBe(1008);
  });

  it('caps the sessions per client IP with limit.sessions', async () => {
    const { gw } = await setup({ limits: { sessionsPerIp: 2 } });
    await client(gw);
    const second = await client(gw);
    const third = await Client.open(gw.url);
    cleanup.push(() => third.close());
    expect(await third.take('notice')).toMatchObject({ code: 'limit.sessions' });
    expect((await third.closed).code).toBe(1013);
    second.close();
    await second.closed;
    await sleep(50);
    await client(gw);
  });

  it('with tokens, requires a valid hello.token', async () => {
    const { gw } = await setup({ tokens: ['s3cret'] });
    const bad = await Client.open(gw.url, { hello: { token: 'nope' } });
    cleanup.push(() => bad.close());
    expect(await bad.take('notice')).toMatchObject({ code: 'auth' });
    expect((await bad.closed).code).toBe(1008);
    await client(gw, { hello: { token: 's3cret' } });
  });

  it('serves the health check', async () => {
    const { gw } = await setup();
    const res = await gw.app.inject({ method: 'GET', url: '/api/net/health' });
    expect(res.json()).toEqual({ ok: true });
  });

  it('tells the flows gateway.shutdown when the gateway stops', async () => {
    const { gw } = await setup();
    const c = await client(gw);
    await openEcho(c, 1);
    await gw.close();
    expect(await c.take('closed')).toMatchObject({ sid: 1, code: 'gateway.shutdown' });
    expect((await c.closed).code).toBe(1001);
  });
});

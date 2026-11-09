// The local helper: its policy, pairing, DNS and port forwards.
import { type AddressInfo, type Socket, connect, createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BleService } from '../src/ble/service';
import type { SidecarHandlers, SidecarIn } from '../src/ble/sidecar';
import { loadConfig, resolveConfig } from '../src/config';
import { LOOKUP_TTL, lookupBackend } from '../src/dns';
import {
  formatPairingCode,
  loadPairing,
  newPairingCode,
  normalizePairingCode,
} from '../src/pairing';
import { LanPolicy, interfaceCidrs } from '../src/policy';
import { Client, type Gateway, startGateway, tcpServer } from './helpers';

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

describe('LanPolicy', () => {
  const policy = new LanPolicy({ cidrs: ['192.168.1.0/24', 'fd00::/8'], allowLoopback: false });
  const code = (p: LanPolicy, host: string, port = 80, proto: 'tcp' | 'udp' = 'tcp') => {
    const v = p.check(host, port, proto);
    return v.ok ? 'ok' : v.code;
  };

  it('lets the LAN through on any port and protocol, refuses the rest with policy.host', () => {
    expect(code(policy, '192.168.1.20', 8123)).toBe('ok');
    expect(code(policy, '192.168.1.20', 5353, 'udp')).toBe('ok');
    expect(code(policy, 'fd00::5', 1883)).toBe('ok');
    expect(code(policy, '::ffff:192.168.1.7')).toBe('ok');
    expect(code(policy, '192.168.2.20')).toBe('policy.host');
    expect(code(policy, '93.184.215.14', 443)).toBe('policy.host');
    expect(code(policy, 'printer.local')).toBe('policy.host');
    expect(code(policy, '127.0.0.1')).toBe('policy.host');
    expect(policy.remoteAllowed('192.168.1.1')).toBe(true);
    expect(policy.remoteAllowed('10.0.0.1')).toBe(false);
  });

  it('loopback only when allowed; a test redirect dials elsewhere and accepts that peer', () => {
    const loop = new LanPolicy({ cidrs: [], allowLoopback: true });
    expect(code(loop, '127.0.0.1', 8080)).toBe('ok');
    expect(code(loop, '::1', 8080)).toBe('ok');
    const r = new LanPolicy({
      cidrs: ['192.0.2.0/24'],
      allowLoopback: false,
      redirect: { '192.0.2.10': '127.0.0.1' },
    });
    const v = r.check('192.0.2.10', 7000, 'tcp');
    expect(v.ok && v.target).toEqual({ kind: 'ip', ip: '127.0.0.1', family: 4, port: 7000 });
    expect(r.remoteAllowed('127.0.0.1')).toBe(true);
  });

  it('rejects a range that is not a CIDR', () => {
    expect(() => new LanPolicy({ cidrs: ['192.168.1.0'], allowLoopback: false })).toThrow(/CIDR/);
  });
});

describe('interfaceCidrs', () => {
  it('takes the IPv4 subnets of the machine, not loopback, IPv6 or a whole-internet mask', () => {
    expect(
      interfaceCidrs({
        lo: [{ family: 'IPv4', internal: true, cidr: '127.0.0.1/8', address: '127.0.0.1' }],
        eth0: [
          { family: 'IPv4', internal: false, cidr: '192.168.1.37/24', address: '192.168.1.37' },
          { family: 'IPv6', internal: false, cidr: 'fe80::1/64', address: 'fe80::1' },
        ],
        wlan: [
          { family: 4, internal: false, cidr: '10.20.30.40/16', address: '10.20.30.40' },
          { family: 'IPv4', internal: false, cidr: '172.16.0.9/1', address: '172.16.0.9' },
        ],
      }),
    ).toEqual(['192.168.1.0/24', '10.20.0.0/16', '172.16.0.9/32']);
  });
});

describe('pairing', () => {
  it('codes are 8 letters without look-alikes; typed forms normalize; dashes for people', () => {
    const code = newPairingCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(normalizePairingCode(' k7pq-m2xd ')).toBe('K7PQM2XD');
    expect(formatPairingCode('K7PQM2XD')).toBe('K7PQ-M2XD');
  });

  it('is made once and kept; --new-code replaces it', () => {
    const files = new Map<string, string>();
    const file = {
      read: (p: string) => files.get(p) ?? '',
      write: (p: string, t: string) => files.set(p, t),
    };
    const first = loadPairing('/h.json', { file });
    expect(first.created).toBe(true);
    expect(loadPairing('/h.json', { file })).toEqual({ code: first.code, created: false });
    let n = 0;
    const renewed = loadPairing('/h.json', { file, renew: true, random: () => n++ % 32 });
    expect(renewed).toEqual({ code: 'ABCDEFGH', created: true });
    files.set('/h.json', '{"code":"not-ours"}');
    expect(loadPairing('/h.json', { file }).created).toBe(true);
  });
});

describe('lookupBackend', () => {
  it('asks the OS for the family of the record type, with the helper TTL', async () => {
    const asked: Array<[string, number]> = [];
    const backend = lookupBackend({ 'nas.lan': '192.168.1.9' }, async (name, opts) => {
      asked.push([name, opts.family]);
      return [
        { address: '192.168.1.50', family: 4 },
        { address: 'fd00::50', family: 6 },
      ];
    });
    expect(await backend.resolve('printer.local', 'A')).toEqual([
      { address: '192.168.1.50', ttl: LOOKUP_TTL },
    ]);
    expect(await backend.resolve('printer.local', 'AAAA')).toEqual([
      { address: 'fd00::50', ttl: LOOKUP_TTL },
    ]);
    expect(asked).toEqual([
      ['printer.local', 4],
      ['printer.local', 6],
    ]);
    // A test host name is answered without asking the OS.
    expect(await backend.resolve('nas.lan', 'A')).toEqual([
      { address: '192.168.1.9', ttl: LOOKUP_TTL },
    ]);
    expect(await backend.resolve('nas.lan', 'AAAA')).toEqual([]);
    expect(asked).toHaveLength(2);
  });
});

describe('helper configuration', () => {
  it('NETGW_MODE=helper: port 3003, no MQTT broker, more connections; LAN settings by env', () => {
    const { config } = loadConfig({
      NETGW_MODE: 'helper',
      NETGW_LAN_CIDRS: '192.168.50.0/24, 10.8.0.0/16',
      NETGW_ALLOW_LOOPBACK: '1',
      NETGW_LISTEN_HOST: '192.168.50.2',
    });
    expect(config.mode).toBe('helper');
    expect(config.port).toBe(3003);
    expect(config.mqtt.enabled).toBe(false);
    expect(config.limits.maxConns).toBe(16);
    expect(config.helper).toMatchObject({
      lanCidrs: ['192.168.50.0/24', '10.8.0.0/16'],
      allowLoopback: true,
      listenHost: '192.168.50.2',
      listenPortMin: 1024,
    });
    expect(resolveConfig({}).mode).toBe('server');
    expect(() => loadConfig({ NETGW_MODE: 'proxy' })).toThrow(/NETGW_MODE/);
  });
});

/** A port nothing listens on now (for a forward). */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address() as AddressInfo;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

async function helper(
  extra: { acceptMs?: number } = {},
  deps: { ble?: BleService } = {},
): Promise<Gateway> {
  const gw = await startGateway(
    {
      mode: 'helper',
      tokens: ['K7PQM2XD'],
      helper: {
        allowLoopback: true,
        listenHost: '127.0.0.1',
        lanCidrs: ['192.168.77.0/24'],
        ...extra,
      },
    },
    deps,
  );
  cleanup.push(() => gw.close());
  return gw;
}

async function paired(gw: Gateway): Promise<Client> {
  const c = await Client.open(gw.url, { hello: { token: 'K7PQM2XD' } });
  cleanup.push(() => c.close());
  return c;
}

/** A TCP client of a forward on 127.0.0.1:`port`. */
async function dial(
  port: number,
): Promise<{ socket: Socket; got: () => string; ended: Promise<string> }> {
  const socket = connect({ host: '127.0.0.1', port });
  let text = '';
  socket.on('data', (b) => {
    text += b.toString();
  });
  const ended = new Promise<string>((resolve) => {
    socket.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
    socket.on('close', () => resolve('closed'));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  return { socket, got: () => text, ended };
}

describe('the helper session', () => {
  it('Bluetooth (the Windows helper): caps, state, devices, a connection through the sidecar', async () => {
    const sent: SidecarIn[] = [];
    let h: SidecarHandlers | undefined;
    const ble = new BleService({
      spawn: async (handlers) => {
        h = handlers;
        return { send: (m) => sent.push(m), kill: () => undefined };
      },
      log: { info: () => undefined, warn: () => undefined },
    });
    ble.start();
    const c = await paired(await helper({}, { ble }));
    const w = await c.take('welcome');
    expect(w.caps).toEqual(expect.arrayContaining(['ble.scan', 'ble.gatt']));
    expect(await c.take('ble.state')).toEqual({ t: 'ble.state', state: 'starting' });
    h?.message({ ev: 'radio', state: 'on' });
    await c.take('ble.state', (m) => m.state === 'ready');
    c.send({ t: 'ble.scan', on: true });
    await vi.waitFor(() => expect(sent).toContainEqual({ op: 'scan', on: true }));
    h?.message({
      ev: 'adv',
      addr: 'c2:00:00:00:00:01',
      random: true,
      rssi: -40,
      kind: 'adv',
      connectable: true,
      data: '020106',
    });
    expect((await c.take('ble.devices')).list[0]).toMatchObject({ addr: 'c2:00:00:00:00:01' });
    c.send({ t: 'ble.connect', id: 1, addr: 'c2:00:00:00:00:01', random: true });
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ op: 'connect' }));
    h?.message({ ev: 'opened', id: (sent.at(-1) as { id: number }).id, conn: 2, services: [] });
    expect(await c.take('ble.opened')).toEqual({ t: 'ble.opened', id: 1, conn: 2 });
    // A board for a phone: its table, then serve; the phone's read comes back to the session.
    expect(w.caps).toContain('ble.serve');
    const service = {
      uuid: '180f',
      characteristics: [{ uuid: '2a19', ref: 3, properties: 2, descriptors: [] }],
    };
    c.send({ t: 'ble.serveService', id: 5, service });
    c.send({ t: 'ble.serve', id: 5 });
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ op: 'serve', services: [service] }));
    const sid = (sent.at(-1) as { id: number }).id;
    h?.message({ ev: 'served', id: sid });
    expect(await c.take('ble.served')).toEqual({ t: 'ble.served', id: 5 });
    h?.message({ ev: 'serveRead', id: sid, req: 9, ref: 3 });
    expect(await c.take('ble.serveRead')).toEqual({ t: 'ble.serveRead', id: 5, req: 9, ref: 3 });
    c.send({ t: 'ble.serveReply', req: 9, value: '57' });
    await vi.waitFor(() => expect(sent.at(-1)).toEqual({ op: 'reply', req: 9, value: '57' }));
    c.close();
    await vi.waitFor(() => expect(sent).toContainEqual({ op: 'disconnect', conn: 2 }));
    expect(sent).toContainEqual({ op: 'unserve', id: sid });
  });

  it('no Bluetooth without the service: no caps, ble.* is unsupported', async () => {
    const c = await paired(await helper());
    const w = await c.take('welcome');
    expect(w.caps).not.toContain('ble.scan');
    c.send({ t: 'ble.scan', on: true });
    expect(await c.take('notice')).toMatchObject({ code: 'unsupported' });
  });

  it('needs the pairing code; welcomes as the LAN helper with listen', async () => {
    const gw = await helper();
    const stranger = await Client.open(gw.url);
    expect((await stranger.closed).code).toBe(1008);
    const c = await paired(gw);
    const w = await c.take('welcome');
    expect(w).toMatchObject({
      gateway: 'helper',
      scope: 'lan',
      caps: ['tcp', 'udp', 'dns', 'listen', 'wifi.scan'],
    });
    expect(w.mqtt).toBeUndefined();
    expect(w.lan).toEqual(expect.arrayContaining(['192.168.77.0/24']));
  });

  it('opens flows into the LAN (here: loopback, allowed) and refuses public addresses', async () => {
    const echo = await tcpServer();
    cleanup.push(() => echo.close());
    const c = await paired(await helper());
    await c.take('welcome');
    c.send({ t: 'open', sid: 1, proto: 'tcp', host: '127.0.0.1', port: echo.port, window: 65536 });
    await c.take('opened', (m) => m.sid === 1);
    c.sendData(1, new TextEncoder().encode('ping'));
    expect((await c.waitBytes(1, 4)).toString()).toBe('ping');
    c.send({ t: 'open', sid: 2, proto: 'tcp', host: '93.184.215.14', port: 80, window: 65536 });
    expect(await c.take('refused', (m) => m.sid === 2)).toMatchObject({ code: 'policy.host' });
  });

  it('forwards a port: incoming with a high sid, accept, data both ways, EOF; close stops it', async () => {
    const c = await paired(await helper());
    await c.take('welcome');
    const port = await freePort();
    c.send({ t: 'listen', sid: 7, proto: 'tcp', port });
    expect(await c.take('opened', (m) => m.sid === 7)).toMatchObject({
      remote: `127.0.0.1:${port}`,
      window: 0,
    });
    const peer = await dial(port);
    const inc = await c.take('incoming');
    expect(inc.sid).toBeGreaterThanOrEqual(0x8000_0000);
    expect(inc.port).toBe(port);
    expect(inc.from).toMatch(/^127\.0\.0\.1:\d+$/);
    peer.socket.write('GET / HTTP/1.0\r\n\r\n');
    c.send({ t: 'accept', sid: inc.sid, ok: true });
    await c.take('opened', (m) => m.sid === inc.sid);
    expect((await c.waitBytes(inc.sid, 18)).toString()).toBe('GET / HTTP/1.0\r\n\r\n');
    c.sendData(inc.sid, new TextEncoder().encode('HTTP/1.0 200 OK\r\n\r\nhi'));
    c.send({ t: 'shutdown', sid: inc.sid });
    expect(await peer.ended).toBe('closed');
    expect(peer.got()).toBe('HTTP/1.0 200 OK\r\n\r\nhi');
    c.send({ t: 'close', sid: 7 });
    await new Promise((r) => setTimeout(r, 100));
    await expect(dial(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('accept false resets the peer; no answer in time closes it; a taken port is refused', async () => {
    const c = await paired(await helper({ acceptMs: 300 }));
    await c.take('welcome');
    const port = await freePort();
    c.send({ t: 'listen', sid: 1, proto: 'tcp', port });
    await c.take('opened', (m) => m.sid === 1);
    const a = await dial(port);
    const first = await c.take('incoming');
    c.send({ t: 'accept', sid: first.sid, ok: false });
    expect(await a.ended).toMatch(/ECONNRESET|closed/);
    const b = await dial(port);
    const second = await c.take('incoming');
    expect(await c.take('closed', (m) => m.sid === second.sid)).toMatchObject({ reset: true });
    expect(await b.ended).toBe('closed');
    c.send({ t: 'listen', sid: 2, proto: 'tcp', port });
    expect(await c.take('refused', (m) => m.sid === 2)).toMatchObject({ code: 'net.refused' });
    c.send({ t: 'listen', sid: 3, proto: 'tcp', port: 80 });
    expect(await c.take('refused', (m) => m.sid === 3)).toMatchObject({ code: 'policy.port' });
  });

  it('the session ends: its forwards stop', async () => {
    const c = await paired(await helper());
    await c.take('welcome');
    const port = await freePort();
    c.send({ t: 'listen', sid: 1, proto: 'tcp', port });
    await c.take('opened', (m) => m.sid === 1);
    c.close();
    await c.closed;
    await new Promise((r) => setTimeout(r, 100));
    await expect(dial(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('the server gateway refuses listen as unsupported', async () => {
    const gw = await startGateway();
    cleanup.push(() => gw.close());
    const c = await Client.open(gw.url);
    cleanup.push(() => c.close());
    await c.take('welcome');
    c.send({ t: 'listen', sid: 1, proto: 'tcp', port: 40000 });
    expect(await c.take('refused', (m) => m.sid === 1)).toMatchObject({ code: 'unsupported' });
  });
});

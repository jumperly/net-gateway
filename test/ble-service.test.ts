import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BLE_CONNECT_MS,
  BLE_DEVICES_MAX,
  BLE_STABLE_MS,
  BleService,
  nameOfAd,
} from '../src/ble/service';
import type { SidecarHandlers, SidecarIn, SidecarOut } from '../src/ble/sidecar';
import {
  BLE_DEVICES_PER_FRAME,
  NET_TEXT_MAX,
  type NetGatewayMsg,
  parseGatewayMsg,
} from '../src/protocol';

/** A sidecar in the test's hands: what the service sent it, and events to emit. */
function fakeSidecar() {
  const sent: SidecarIn[] = [];
  let h: SidecarHandlers | undefined;
  let spawns = 0;
  const spawn = async (handlers: SidecarHandlers) => {
    h = handlers;
    spawns++;
    return { send: (m: SidecarIn) => sent.push(m), kill: () => undefined };
  };
  return {
    spawn,
    sent,
    emit: (m: SidecarOut) => h?.message(m),
    crash: () => h?.exit('exited 1'),
    spawns: () => spawns,
    last: <O extends SidecarIn['op']>(op: O) =>
      sent.filter((m): m is Extract<SidecarIn, { op: O }> => m.op === op).at(-1),
  };
}

const log = { info: () => undefined, warn: () => undefined };

function client() {
  const got: NetGatewayMsg[] = [];
  return {
    got,
    send: (m: NetGatewayMsg) => got.push(m),
    of: <T extends NetGatewayMsg['t']>(t: T) =>
      got.filter((m): m is Extract<NetGatewayMsg, { t: T }> => m.t === t),
  };
}

const adv = (addr: string, rssi: number, data = '020106', kind: 'adv' | 'rsp' = 'adv') =>
  ({ ev: 'adv', addr, random: true, rssi, kind, connectable: true, data }) as const;

async function ready() {
  const f = fakeSidecar();
  const svc = new BleService({ spawn: f.spawn, log });
  svc.start();
  await vi.advanceTimersByTimeAsync(0);
  f.emit({ ev: 'radio', state: 'on' });
  return { f, svc };
}

describe('BleService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('state: starting until the radio speaks; ready and off reach every session', async () => {
    const f = fakeSidecar();
    const svc = new BleService({ spawn: f.spawn, log });
    const a = client();
    svc.attach(a);
    expect(a.of('ble.state').at(-1)).toEqual({ t: 'ble.state', state: 'starting' });
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    f.emit({ ev: 'radio', state: 'off' });
    expect(a.of('ble.state').at(-1)).toMatchObject({ state: 'off' });
    f.emit({ ev: 'radio', state: 'on' });
    expect(a.of('ble.state').at(-1)).toMatchObject({ state: 'ready' });
    const b = client();
    svc.attach(b);
    expect(b.of('ble.state')).toEqual([{ t: 'ble.state', state: 'ready' }]);
  });

  it('a sidecar that cannot be built: failed with the reason', async () => {
    const svc = new BleService({
      spawn: async () => {
        throw new Error('no csc');
      },
      log,
    });
    const a = client();
    svc.attach(a);
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.of('ble.state').at(-1)).toEqual({ t: 'ble.state', state: 'failed', reason: 'no csc' });
  });

  it('scans while a session wants it; advertising and scan response per device; changes once a second', async () => {
    const { f, svc } = await ready();
    const a = client();
    const b = client();
    const sa = svc.attach(a);
    const sb = svc.attach(b);
    sa.scan(true);
    sb.scan(true);
    expect(f.sent.filter((m) => m.op === 'scan')).toEqual([{ op: 'scan', on: true }]);
    f.emit(adv('c2:00:00:00:00:01', -50));
    f.emit(adv('c2:00:00:00:00:01', -51, '05094a756d70', 'rsp'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.of('ble.devices').at(-1)).toEqual({
      t: 'ble.devices',
      list: [
        {
          addr: 'c2:00:00:00:00:01',
          random: true,
          rssi: -51,
          name: 'Jump',
          adv: '020106',
          rsp: '05094a756d70',
          connectable: true,
        },
      ],
      gone: [],
    });
    // A shortened name in the advertising, the complete one in the scan response: the complete wins.
    f.emit(adv('c2:00:00:00:00:02', -50, '0408536d61'));
    f.emit(adv('c2:00:00:00:00:02', -50, '0609536d617274', 'rsp'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.of('ble.devices').at(-1)?.list[0]).toMatchObject({
      addr: 'c2:00:00:00:00:02',
      name: 'Smart',
    });
    // RSSI within 3 dBm: not sent again; a bigger change: sent.
    f.emit(adv('c2:00:00:00:00:01', -53));
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.of('ble.devices')).toHaveLength(2);
    f.emit(adv('c2:00:00:00:00:01', -60));
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.of('ble.devices').at(-1)?.list[0]?.rssi).toBe(-60);
    // One session stops: scanning goes on for the other; the last one stops it.
    sa.scan(false);
    expect(f.sent.filter((m) => m.op === 'scan')).toHaveLength(1);
    sb.close();
    expect(f.last('scan')).toEqual({ op: 'scan', on: false });
  });

  it('the radio off and on again: the devices go, scanning starts again', async () => {
    const { f, svc } = await ready();
    const a = client();
    svc.attach(a).scan(true);
    f.emit(adv('c2:00:00:00:00:01', -50));
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.of('ble.devices').at(-1)?.list).toHaveLength(1);
    f.emit({ ev: 'radio', state: 'off' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.of('ble.devices').at(-1)?.gone).toEqual(['c2:00:00:00:00:01']);
    const scans = f.sent.filter((m) => m.op === 'scan').length;
    f.emit({ ev: 'radio', state: 'on' });
    expect(f.sent.filter((m) => m.op === 'scan')).toHaveLength(scans + 1);
    expect(f.last('scan')).toEqual({ op: 'scan', on: true });
  });

  it('scanning asked before the sidecar runs starts once it does', async () => {
    const f = fakeSidecar();
    const svc = new BleService({ spawn: f.spawn, log });
    svc.attach(client()).scan(true);
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sent).toEqual([{ op: 'scan', on: true }]);
  });

  it(`silent for 30 s: gone; more than ${BLE_DEVICES_MAX}: the weakest go; frames of ${BLE_DEVICES_PER_FRAME}`, async () => {
    const { f, svc } = await ready();
    const a = client();
    svc.attach(a).scan(true);
    for (let i = 0; i < 70; i++)
      f.emit(adv(`c2:00:00:00:00:${i.toString(16).padStart(2, '0')}`, -30 - i));
    await vi.advanceTimersByTimeAsync(1000);
    const frames = a.of('ble.devices');
    expect(frames.map((m) => m.list.length)).toEqual([20, 20, 20, 4]);
    const addrs = frames.flatMap((m) => m.list.map((d) => d.addr));
    expect(addrs).toHaveLength(BLE_DEVICES_MAX);
    expect(addrs).not.toContain('c2:00:00:00:00:45'); // -99 dBm: evicted
    await vi.advanceTimersByTimeAsync(31_000);
    expect(a.of('ble.devices').flatMap((m) => m.gone)).toHaveLength(BLE_DEVICES_MAX);
  });

  it('connect: the table by service, then opened; operations; notifications; closed; timeout', async () => {
    const { f, svc } = await ready();
    const a = client();
    const s = svc.attach(a);
    s.connect(5, 'c2:00:00:00:00:01', true);
    const c = f.last('connect');
    expect(c).toMatchObject({ addr: 'c2:00:00:00:00:01', random: true });
    const services = [
      {
        uuid: '0000180f-0000-1000-8000-00805f9b34fb',
        characteristics: [
          { uuid: '00002a19-0000-1000-8000-00805f9b34fb', ref: 1, properties: 18, descriptors: [] },
        ],
      },
      { uuid: '4fafc201-1fb5-459e-8fcc-c5c9c331914b', characteristics: [] },
    ];
    f.emit({ ev: 'opened', id: c?.id ?? -1, conn: 3, services });
    expect(a.got.slice(-3).map((m) => m.t)).toEqual(['ble.service', 'ble.service', 'ble.opened']);
    expect(a.of('ble.service')[0]).toEqual({ t: 'ble.service', id: 5, service: services[0] });
    expect(a.of('ble.opened')).toEqual([{ t: 'ble.opened', id: 5, conn: 3 }]);
    s.op({ id: 9, conn: 3, op: 'read', ref: 1 });
    f.emit({ ev: 'result', id: f.last('read')?.id ?? -1, value: '57' });
    expect(a.of('ble.result')).toEqual([{ t: 'ble.result', id: 9, value: '57' }]);
    s.op({ id: 10, conn: 99, op: 'read', ref: 1 });
    expect(a.of('ble.result').at(-1)).toEqual({ t: 'ble.result', id: 10, error: 'invalid' });
    s.op({ id: 12, conn: 3, op: 'write', ref: 1, value: '6869' });
    expect(f.last('write')).toMatchObject({ conn: 3, ref: 1, value: '6869' });
    s.op({ id: 13, conn: 3, op: 'notify', ref: 1, on: true });
    expect(f.last('notify')).toMatchObject({ conn: 3, ref: 1, on: true });
    f.emit({ ev: 'notify', conn: 3, ref: 1, value: '58' });
    expect(a.of('ble.notify')).toEqual([{ t: 'ble.notify', conn: 3, ref: 1, value: '58' }]);
    // An operation still waiting when the device goes away: answered with an error.
    s.op({ id: 11, conn: 3, op: 'read', ref: 1 });
    f.emit({ ev: 'closed', conn: 3 });
    expect(a.of('ble.closed')).toEqual([{ t: 'ble.closed', conn: 3 }]);
    expect(a.of('ble.result').at(-1)).toEqual({ t: 'ble.result', id: 11, error: 'unreachable' });
    // Timeout: failed; an opened that comes later is disconnected at once.
    s.connect(6, 'c2:00:00:00:00:02', true);
    const late = f.last('connect');
    await vi.advanceTimersByTimeAsync(BLE_CONNECT_MS);
    expect(a.of('ble.failed').at(-1)).toEqual({ t: 'ble.failed', id: 6, reason: 'timeout' });
    f.emit({ ev: 'opened', id: late?.id ?? -1, conn: 4, services: [] });
    expect(f.sent.at(-1)).toEqual({ op: 'disconnect', conn: 4 });
    expect(a.of('ble.opened')).toHaveLength(1);
    // A failed connection.
    s.connect(7, 'c2:00:00:00:00:03', false);
    f.emit({ ev: 'failed', id: f.last('connect')?.id ?? -1, error: 'unreachable' });
    expect(a.of('ble.failed').at(-1)).toEqual({ t: 'ble.failed', id: 7, reason: 'unreachable' });
  });

  it('a table too big for one frame loses its last characteristics', async () => {
    const { f, svc } = await ready();
    const a = client();
    svc.attach(a).connect(1, 'c2:00:00:00:00:01', true);
    const characteristics = Array.from({ length: 64 }, (_, i) => ({
      uuid: `beb5483e-36e1-4688-b7f5-ea07361b${i.toString(16).padStart(4, '0')}`,
      ref: i + 1,
      properties: 0x1a,
      descriptors: Array.from({ length: 3 }, (__, j) => ({
        uuid: '00002901-0000-1000-8000-00805f9b34fb',
        ref: 100 + i * 3 + j,
      })),
    }));
    f.emit({
      ev: 'opened',
      id: f.last('connect')?.id ?? -1,
      conn: 2,
      services: [{ uuid: '4fafc201-1fb5-459e-8fcc-c5c9c331914b', characteristics }],
    });
    const sent = a.of('ble.service')[0];
    expect(sent?.service.characteristics.length).toBeLessThan(64);
    expect(JSON.stringify(sent).length).toBeLessThanOrEqual(8192);
  });

  it('every frame the page gets parses: device frames by bytes, long values cut to 512 bytes', async () => {
    const { f, svc } = await ready();
    const a = client();
    const s = svc.attach(a);
    s.scan(true);
    // 64 devices heard, then all gone in the tick that brings 30 new ones with names of control
    // characters (JSON escapes them six bytes each) and full advertising data.
    for (let i = 0; i < 64; i++)
      f.emit(adv(`c2:00:00:00:02:${i.toString(16).padStart(2, '0')}`, -40));
    await vi.advanceTimersByTimeAsync(30_500);
    const name = `1d09${'01'.repeat(29)}`;
    for (let i = 0; i < 30; i++) {
      const addr = `c2:00:00:00:01:${i.toString(16).padStart(2, '0')}`;
      f.emit(adv(addr, -40, `0201ff1aff${'ab'.repeat(25)}`));
      f.emit(adv(addr, -40, name, 'rsp'));
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.of('ble.devices').flatMap((m) => m.gone)).toHaveLength(64);
    s.connect(1, 'c2:00:00:00:01:00', true);
    f.emit({ ev: 'opened', id: f.last('connect')?.id ?? -1, conn: 2, services: [] });
    s.op({ id: 3, conn: 2, op: 'read', ref: 1 });
    f.emit({ ev: 'result', id: f.last('read')?.id ?? -1, value: 'aa'.repeat(600) });
    f.emit({ ev: 'notify', conn: 2, ref: 1, value: 'bb'.repeat(600) });
    for (const m of a.got) {
      const text = JSON.stringify(m);
      expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(NET_TEXT_MAX);
      expect(parseGatewayMsg(text), m.t).not.toBeNull();
    }
    expect(a.of('ble.devices').flatMap((m) => m.list)).toHaveLength(64 + 30);
    expect(a.of('ble.result')[0]?.value).toHaveLength(1024);
    expect(a.of('ble.notify')[0]?.value).toHaveLength(1024);
  });

  it('a table beyond the schema: at most 64 characteristics, 16 descriptors each', async () => {
    const { f, svc } = await ready();
    const a = client();
    svc.attach(a).connect(1, 'c2:00:00:00:00:01', true);
    const characteristics = Array.from({ length: 70 }, (_, i) => ({
      uuid: '2a19',
      ref: i + 1,
      properties: 0x12,
      descriptors: Array.from({ length: i === 0 ? 20 : 0 }, (__, j) => ({
        uuid: '2901',
        ref: 100 + j,
      })),
    }));
    f.emit({
      ev: 'opened',
      id: f.last('connect')?.id ?? -1,
      conn: 2,
      services: [{ uuid: '180f', characteristics }],
    });
    const sent = a.of('ble.service')[0];
    expect(sent?.service.characteristics).toHaveLength(64);
    expect(sent?.service.characteristics[0]?.descriptors).toHaveLength(16);
    expect(parseGatewayMsg(JSON.stringify(sent))).not.toBeNull();
  });

  it('a session that ends disconnects its devices; a crash restarts once, then fails', async () => {
    const { f, svc } = await ready();
    const a = client();
    const s = svc.attach(a);
    s.connect(1, 'c2:00:00:00:00:01', true);
    f.emit({ ev: 'opened', id: f.last('connect')?.id ?? -1, conn: 7, services: [] });
    s.close();
    expect(f.sent.at(-1)).toEqual({ op: 'disconnect', conn: 7 });
    const b = client();
    const sb = svc.attach(b);
    sb.connect(2, 'c2:00:00:00:00:01', true);
    f.emit({ ev: 'opened', id: f.last('connect')?.id ?? -1, conn: 8, services: [] });
    sb.connect(3, 'c2:00:00:00:00:02', true);
    f.crash();
    expect(b.of('ble.closed')).toEqual([{ t: 'ble.closed', conn: 8 }]);
    expect(b.of('ble.failed').at(-1)).toMatchObject({ id: 3 });
    expect(b.of('ble.state').at(-1)).toMatchObject({ state: 'starting' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.spawns()).toBe(2);
    f.crash();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.spawns()).toBe(2);
    expect(b.of('ble.state').at(-1)).toMatchObject({ state: 'failed' });
    sb.connect(4, 'c2:00:00:00:00:01', true);
    expect(b.of('ble.failed').at(-1)).toMatchObject({ id: 4 });
  });

  it("serve: a session publishes a board's table; the phone's requests come back; it ends with the session", async () => {
    const { f, svc } = await ready();
    const a = client();
    const s = svc.attach(a);
    const service = {
      uuid: '4fafc201-1fb5-459e-8fcc-c5c9c331914b',
      characteristics: [
        {
          uuid: 'beb5483e-36e1-4688-b7f5-ea07361b26a8',
          ref: 16,
          properties: 0x1a,
          descriptors: [],
        },
      ],
    };
    s.serveService(7, service);
    s.serve(7);
    const sv = f.last('serve');
    expect(sv).toMatchObject({ services: [service] });
    f.emit({ ev: 'served', id: sv?.id ?? -1 });
    expect(a.of('ble.served')).toEqual([{ t: 'ble.served', id: 7 }]);
    // The phone reads: the session answers, the sidecar gets the reply.
    f.emit({ ev: 'serveRead', id: sv?.id ?? -1, req: 41, ref: 16 });
    expect(a.of('ble.serveRead')).toEqual([{ t: 'ble.serveRead', id: 7, req: 41, ref: 16 }]);
    s.serveReply(41, '6869', undefined);
    expect(f.last('reply')).toEqual({ op: 'reply', req: 41, value: '6869' });
    // A reply to a request this session never got goes nowhere.
    s.serveReply(99, '00', undefined);
    expect(f.last('reply')).toEqual({ op: 'reply', req: 41, value: '6869' });
    f.emit({ ev: 'serveWrite', id: sv?.id ?? -1, req: 42, ref: 16, value: '01', response: true });
    expect(a.of('ble.serveWrite').at(-1)).toEqual({
      t: 'ble.serveWrite',
      id: 7,
      req: 42,
      ref: 16,
      value: '01',
      response: true,
    });
    f.emit({ ev: 'serveSubscribe', id: sv?.id ?? -1, ref: 16, on: true });
    expect(a.of('ble.serveSubscribe').at(-1)).toEqual({
      t: 'ble.serveSubscribe',
      id: 7,
      ref: 16,
      on: true,
    });
    s.serveNotify(7, 16, '6e3d31');
    expect(f.last('serveNotify')).toEqual({
      op: 'serveNotify',
      id: sv?.id,
      ref: 16,
      value: '6e3d31',
    });
    s.close();
    expect(f.last('unserve')).toEqual({ op: 'unserve', id: sv?.id });
  });

  it('serve: refused without the peripheral role; a failure and a stop reach the session', async () => {
    const f = fakeSidecar();
    const svc = new BleService({ spawn: f.spawn, log });
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    f.emit({ ev: 'radio', state: 'on', peripheral: false });
    const a = client();
    const s = svc.attach(a);
    s.serve(1);
    expect(a.of('ble.serveFailed')).toEqual([
      { t: 'ble.serveFailed', id: 1, reason: 'this Bluetooth adapter cannot be a peripheral' },
    ]);
    f.emit({ ev: 'radio', state: 'on', peripheral: true });
    s.serve(2);
    const sv = f.last('serve');
    f.emit({ ev: 'serveFailed', id: sv?.id ?? -1, error: 'provider: RadioNotAvailable' });
    expect(a.of('ble.serveFailed').at(-1)).toEqual({
      t: 'ble.serveFailed',
      id: 2,
      reason: 'provider: RadioNotAvailable',
    });
    s.serve(3);
    const sv3 = f.last('serve');
    f.emit({ ev: 'served', id: sv3?.id ?? -1 });
    f.crash();
    expect(a.of('ble.serveStopped').at(-1)).toMatchObject({ id: 3 });
  });

  it('a sidecar that ran a minute before stopping is restarted again (its count starts over)', async () => {
    const { f } = await ready();
    f.crash();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.spawns()).toBe(2);
    await vi.advanceTimersByTimeAsync(BLE_STABLE_MS);
    f.crash();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.spawns()).toBe(3);
    // Two quick stops in a row: Bluetooth is off for good.
    f.crash();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.spawns()).toBe(3);
  });

  it('nameOfAd: the complete local name, else the shortened one', () => {
    expect(nameOfAd('020106' + '05094a756d70')).toBe('Jump');
    expect(nameOfAd('0408414243')).toBe('ABC');
    expect(nameOfAd('020106')).toBeUndefined();
    expect(nameOfAd('ff09')).toBeUndefined(); // cut short
  });
});

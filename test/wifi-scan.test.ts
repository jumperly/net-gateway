import { afterEach, describe, expect, it } from 'vitest';
import {
  WifiScanner,
  parseNetsh,
  parseNmcli,
  parseSystemProfiler,
  qualityToDbm,
  scanWifi,
} from '../src/wifi-scan';
import { Client, startGateway } from './helpers';

const NETSH_EN = `Interface name : Wi-Fi 2
There are 3 networks currently visible.

SSID 1 : Home
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    BSSID 1                 : aa:bb:cc:dd:ee:01
         Signal             : 100%
         Radio type         : 802.11ac
         Band               : 5 GHz
         Channel            : 52
         Bss Load:
             Connected Stations:         5
    BSSID 2                 : aa:bb:cc:dd:ee:02
         Signal             : 80%
         Radio type         : 802.11n
         Band               : 2.4 GHz
         Channel            : 8
         Bss Load:
             Connected Stations:         2

SSID 2 : Cafe Free
    Network type            : Infrastructure
    Authentication          : Open
    Encryption              : None
    BSSID 1                 : aa:bb:cc:dd:ee:03
         Signal             : 40%
         Radio type         : 802.11n
         Channel            : 1

SSID 3 :
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    BSSID 1                 : aa:bb:cc:dd:ee:04
         Signal             : 90%
         Channel            : 6
`;

// A Russian Windows translates the labels and the values; the parser goes by structure.
// Cyrillic is escaped (the sources are English-only); the labels are only placeholders here.
const RU_OPEN = '\u041e\u0442\u043a\u0440\u044b\u0442\u0430\u044f';
const RU_NONE = '\u041d\u0435\u0442';
const RU_SSID = '\u0414\u0430\u0447\u0430';
const NETSH_RU = `SSID 1 : ${RU_SSID}
    Label A                 : Label value
    Label B                 : ${RU_OPEN}
    Label C                 : ${RU_NONE}
    BSSID 1                 : aa:bb:cc:dd:ee:05
         Label D            : 60%
         Label E            : 802.11n
         Label F            : 11
`;

describe('Wi-Fi scan parsers', () => {
  it('netsh: 2.4 GHz BSSIDs only, signal % as dBm, open by authentication and encryption, hidden left out', () => {
    expect(parseNetsh(NETSH_EN)).toEqual([
      { ssid: 'Home', rssi: -60, channel: 8, secure: true },
      { ssid: 'Cafe Free', rssi: -80, channel: 1, secure: false },
    ]);
    expect(parseNetsh(NETSH_RU)).toEqual([
      { ssid: RU_SSID, rssi: -70, channel: 11, secure: false },
    ]);
    expect(qualityToDbm(100)).toBe(-50);
    expect(qualityToDbm(0)).toBe(-100);
  });

  it('nmcli: escaped colons, open as -- or empty, the strongest of an SSID', () => {
    const text =
      'Home:80:6:WPA2\nHome:30:6:WPA2\nCafe\\:Bar:40:11:\nOpen:20:1:--\nFive:90:36:WPA2\n:70:3:WPA2\n';
    expect(parseNmcli(text)).toEqual([
      { ssid: 'Home', rssi: -60, channel: 6, secure: true },
      { ssid: 'Cafe:Bar', rssi: -80, channel: 11, secure: false },
      { ssid: 'Open', rssi: -90, channel: 1, secure: false },
    ]);
  });

  it('system_profiler: other networks and the current one, dBm as given', () => {
    const json = JSON.stringify({
      SPAirPortDataType: [
        {
          spairport_airport_interfaces: [
            {
              spairport_current_network_information: {
                _name: 'Home',
                spairport_network_channel: '6 (2GHz, 20MHz)',
                spairport_security_mode: 'spairport_security_mode_wpa2_personal',
                spairport_signal_noise: '-48 dBm / -92 dBm',
              },
              spairport_airport_other_local_wireless_networks: [
                {
                  _name: 'Cafe',
                  spairport_network_channel: 11,
                  spairport_security_mode: 'spairport_security_mode_none',
                  spairport_signal_noise: '-71 dBm / -92 dBm',
                },
                {
                  _name: 'Five',
                  spairport_network_channel: '149 (5GHz, 80MHz)',
                  spairport_signal_noise: '-50 dBm / -90 dBm',
                },
              ],
            },
          ],
        },
      ],
    });
    expect(parseSystemProfiler(json)).toEqual([
      { ssid: 'Home', rssi: -48, channel: 6, secure: true },
      { ssid: 'Cafe', rssi: -71, channel: 11, secure: false },
    ]);
    expect(parseSystemProfiler('not json')).toEqual([]);
  });

  it('scanWifi runs the tool of the platform and gives up quietly', async () => {
    const asked: string[] = [];
    const exec = async (cmd: string, args: string[]) => {
      asked.push([cmd, ...args].join(' '));
      if (cmd === 'nmcli') return 'Home:80:6:WPA2\n';
      throw new Error('no such tool');
    };
    expect(await scanWifi('linux', exec)).toEqual([
      { ssid: 'Home', rssi: -60, channel: 6, secure: true },
    ]);
    expect(await scanWifi('win32', exec)).toEqual([]);
    expect(await scanWifi('aix', exec)).toEqual([]);
    expect(asked[1]).toContain('chcp 65001');
  });

  it('WifiScanner scans at most once per TTL', async () => {
    let now = 0;
    let scans = 0;
    const s = new WifiScanner(
      async () => [{ ssid: `n${++scans}`, rssi: -50, channel: 1, secure: false }],
      1000,
      () => now,
    );
    expect((await s.networks())[0]?.ssid).toBe('n1');
    now = 500;
    expect((await s.networks())[0]?.ssid).toBe('n1');
    now = 1500;
    expect((await s.networks())[0]?.ssid).toBe('n2');
  });
});

describe('the helper answers wifi.scan', () => {
  const cleanup: Array<() => Promise<unknown> | unknown> = [];
  afterEach(async () => {
    for (const f of cleanup.splice(0).reverse()) await f();
  });

  it('with the networks around; the server gateway does not scan', async () => {
    const wifi = new WifiScanner(async () => [
      { ssid: 'Home', rssi: -55, channel: 11, secure: true },
    ]);
    const gw = await startGateway({ mode: 'helper', tokens: ['K7PQM2XD'] }, { wifi });
    cleanup.push(() => gw.close());
    const c = await Client.open(gw.url, { hello: { token: 'K7PQM2XD' } });
    cleanup.push(() => c.close());
    expect((await c.take('welcome')).caps).toContain('wifi.scan');
    c.send({ t: 'wifi.scan' });
    expect(await c.take('wifi.networks')).toEqual({
      t: 'wifi.networks',
      list: [{ ssid: 'Home', rssi: -55, channel: 11, secure: true }],
    });
    const server = await startGateway();
    cleanup.push(() => server.close());
    const s = await Client.open(server.url);
    cleanup.push(() => s.close());
    expect((await s.take('welcome')).caps).not.toContain('wifi.scan');
    s.send({ t: 'wifi.scan' });
    expect(await s.take('notice')).toMatchObject({ code: 'unsupported' });
  });
});

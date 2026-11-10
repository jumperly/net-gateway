import { execFile } from 'node:child_process';

/**
 * The Wi-Fi networks around the helper's machine (`wifi.scan`): the board's scans hear
 * them as beacon-only networks. Only 2.4 GHz (channels 1–14, what an ESP32 hears), one entry per
 * SSID (the strongest), hidden networks left out, the strongest first.
 */
export interface WifiNetwork {
  ssid: string;
  /** dBm */
  rssi: number;
  channel: number;
  secure: boolean;
}

/** The most networks a scan answers with. */
export const WIFI_SCAN_MAX = 32;

/** A Windows / NetworkManager signal quality (0–100 %) as dBm: 100 % ≈ −50 dBm, 0 % ≈ −100 dBm. */
export const qualityToDbm = (q: number): number =>
  Math.round(Math.min(100, Math.max(0, q)) / 2 - 100);

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/** The common end of every parser: 2.4 GHz, named, at most 32 bytes, one per SSID, strongest first. */
export function tidy(list: WifiNetwork[]): WifiNetwork[] {
  const best = new Map<string, WifiNetwork>();
  for (const n of list) {
    if (!n.ssid || utf8Bytes(n.ssid) > 32 || n.channel < 1 || n.channel > 14) continue;
    if (!Number.isFinite(n.rssi)) continue;
    const old = best.get(n.ssid);
    if (!old || n.rssi > old.rssi) best.set(n.ssid, { ...n, rssi: Math.round(n.rssi) });
  }
  return [...best.values()].sort((a, b) => b.rssi - a.rssi).slice(0, WIFI_SCAN_MAX);
}

const indent = (line: string) => line.length - line.trimStart().length;
const fieldValue = (line: string) => line.slice(line.indexOf(':') + 1).trim();

/**
 * `netsh wlan show networks mode=bssid` (Windows). The labels are translated in a localized
 * Windows, so the parser goes by structure: an `SSID n : name` block starts with the network type,
 * the authentication and the encryption; each `BSSID n` has its properties one indent deeper - the
 * signal ends with `%`, the channel is a bare number (deeper lines, like the BSS load, are skipped).
 */
export function parseNetsh(text: string): WifiNetwork[] {
  const out: WifiNetwork[] = [];
  const lines = text.split(/\r?\n/);
  let ssid: string | undefined;
  let secure = true;
  let head: string[] = [];
  let bss: { level: number; signal?: number; channel?: number } | undefined;
  const flush = () => {
    if (ssid !== undefined && bss?.signal !== undefined && bss.channel !== undefined)
      out.push({ ssid, rssi: qualityToDbm(bss.signal), channel: bss.channel, secure });
    bss = undefined;
  };
  for (const line of lines) {
    const ssidLine = /^SSID \d+\s*:\s?(.*)$/.exec(line);
    if (ssidLine) {
      flush();
      ssid = (ssidLine[1] ?? '').trimEnd();
      head = [];
      secure = true;
      continue;
    }
    if (ssid === undefined || !line.includes(':')) continue;
    if (/^\s+BSSID \d+\s*:/.test(line)) {
      flush();
      if (head.length >= 3) {
        // [network type, authentication, encryption]
        const auth = head[1] ?? '';
        const enc = head[2] ?? '';
        // A Russian Windows says "otkryt" / "net" (escaped: the sources are English-only).
        secure = !(
          /^(open|\u043e\u0442\u043a\u0440\u044b\u0442)/i.test(auth) &&
          /^(none|\u043d\u0435\u0442)/i.test(enc)
        );
      }
      bss = { level: -1 };
      continue;
    }
    if (!bss) {
      head.push(fieldValue(line));
      continue;
    }
    const level = indent(line);
    if (bss.level < 0) bss.level = level;
    if (level !== bss.level) continue;
    const v = fieldValue(line);
    const pct = /^(\d{1,3})\s*%$/.exec(v);
    if (pct) bss.signal = Number(pct[1]);
    else if (/^\d{1,3}$/.test(v) && bss.channel === undefined) bss.channel = Number(v);
  }
  flush();
  return tidy(out);
}

/** `nmcli -t -f SSID,SIGNAL,CHAN,SECURITY device wifi list` (Linux, NetworkManager): `:`-separated, `\:` escaped. */
export function parseNmcli(text: string): WifiNetwork[] {
  const out: WifiNetwork[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields: string[] = [];
    let cur = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '\\' && i + 1 < line.length) cur += line[++i];
      else if (c === ':') {
        fields.push(cur);
        cur = '';
      } else cur += c;
    }
    fields.push(cur);
    const [ssid = '', signal = '', chan = '', security = ''] = fields;
    out.push({
      ssid,
      rssi: qualityToDbm(Number(signal)),
      channel: Number(chan),
      secure: security.trim() !== '' && security.trim() !== '--',
    });
  }
  return tidy(out);
}

/** `system_profiler SPAirPortDataType -json` (macOS): the other networks of every Wi-Fi interface. */
export function parseSystemProfiler(json: string): WifiNetwork[] {
  const out: WifiNetwork[] = [];
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const ifaces = (
    (data as { SPAirPortDataType?: Array<{ spairport_airport_interfaces?: unknown[] }> })
      .SPAirPortDataType ?? []
  ).flatMap((x) => x.spairport_airport_interfaces ?? []);
  for (const iface of ifaces as Array<Record<string, unknown>>) {
    const nets = [
      ...((iface.spairport_airport_other_local_wireless_networks as unknown[]) ?? []),
      ...(iface.spairport_current_network_information
        ? [iface.spairport_current_network_information]
        : []),
    ] as Array<Record<string, unknown>>;
    for (const n of nets) {
      const channel = Number.parseInt(String(n.spairport_network_channel ?? ''), 10);
      const rssi = Number.parseInt(String(n.spairport_signal_noise ?? ''), 10);
      const security = String(n.spairport_security_mode ?? '');
      out.push({
        ssid: String(n._name ?? ''),
        rssi,
        channel,
        secure: security !== '' && !/none$/i.test(security),
      });
    }
  }
  return tidy(out);
}

export type Run = (cmd: string, args: string[]) => Promise<string>;

const run: Run = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: 15_000, maxBuffer: 4 << 20, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

/** The networks around now, by the OS's own tool; none where it fails or there is no Wi-Fi. */
export async function scanWifi(platform: NodeJS.Platform = process.platform, exec: Run = run) {
  try {
    // netsh writes in the console code page (cp866 on a Russian Windows): UTF-8 first.
    if (platform === 'win32')
      return parseNetsh(
        await exec('cmd', [
          '/d',
          '/s',
          '/c',
          'chcp 65001 >nul && netsh wlan show networks mode=bssid',
        ]),
      );
    if (platform === 'darwin')
      return parseSystemProfiler(await exec('system_profiler', ['SPAirPortDataType', '-json']));
    if (platform === 'linux')
      return parseNmcli(
        await exec('nmcli', ['-t', '-f', 'SSID,SIGNAL,CHAN,SECURITY', 'device', 'wifi', 'list']),
      );
  } catch {
    // no tool, no Wi-Fi interface, no permission
  }
  return [];
}

/** `scanWifi`, at most once per `ttlMs` (a scan takes seconds and the networks change slowly). */
export class WifiScanner {
  private last: { at: number; list: Promise<WifiNetwork[]> } | undefined;
  constructor(
    private readonly scan: () => Promise<WifiNetwork[]> = () => scanWifi(),
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  networks(): Promise<WifiNetwork[]> {
    if (!this.last || this.now() - this.last.at > this.ttlMs)
      this.last = { at: this.now(), list: this.scan().catch(() => []) };
    return this.last.list;
  }
}

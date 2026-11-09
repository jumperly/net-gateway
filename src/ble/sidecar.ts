import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { GattServiceDesc } from '@jumperly/schema';
import { buildSidecar } from './build';

/** The helper → sidecar commands (one JSON object per line). Bytes are lower-case hex. */
export type SidecarIn =
  | { op: 'scan'; on: boolean }
  | { op: 'connect'; id: number; addr: string; random: boolean }
  | { op: 'read'; id: number; conn: number; ref: number }
  | { op: 'write' | 'writeNoResponse'; id: number; conn: number; ref: number; value: string }
  | { op: 'notify'; id: number; conn: number; ref: number; on: boolean }
  | { op: 'disconnect'; conn: number }
  // A board's GATT table published for a phone (the sidecar's GattServiceProvider).
  | { op: 'serve'; id: number; services: GattServiceDesc[] }
  | { op: 'unserve'; id: number }
  | { op: 'reply'; req: number; value?: string; error?: string }
  | { op: 'serveNotify'; id: number; ref: number; value: string };

/** The sidecar → helper events. */
export type SidecarOut =
  /** `peripheral`: the adapter can publish a GATT server (a board for a phone). */
  | { ev: 'radio'; state: 'on' | 'off' | 'none'; peripheral?: boolean }
  | {
      ev: 'adv';
      addr: string;
      random: boolean;
      rssi: number;
      kind: 'adv' | 'rsp';
      connectable: boolean;
      data: string;
    }
  | { ev: 'opened'; id: number; conn: number; services: GattServiceDesc[] }
  | { ev: 'failed'; id: number; error: string }
  | { ev: 'result'; id: number; value?: string; error?: string }
  | { ev: 'notify'; conn: number; ref: number; value: string }
  | { ev: 'closed'; conn: number }
  | { ev: 'served'; id: number }
  | { ev: 'serveFailed'; id: number; error: string }
  | { ev: 'serveRead'; id: number; req: number; ref: number }
  | { ev: 'serveWrite'; id: number; req: number; ref: number; value: string; response: boolean }
  | { ev: 'serveSubscribe'; id: number; ref: number; on: boolean }
  | { ev: 'serveStopped'; id: number; error: string }
  | { ev: 'log'; text: string };

export interface Sidecar {
  send(msg: SidecarIn): void;
  kill(): void;
}

export interface SidecarHandlers {
  message(msg: SidecarOut): void;
  /** The process ended (or could not start): why. */
  exit(reason: string): void;
}

/** Start a sidecar; it may build it first. */
export type SpawnSidecar = (h: SidecarHandlers) => Promise<Sidecar>;

/** The sidecar process: one JSON message per line on stdin and stdout; stderr lines are `log`. */
export function runSidecar(command: string, args: string[], h: SidecarHandlers): Sidecar {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let over = false;
  const end = (reason: string) => {
    if (over) return;
    over = true;
    h.exit(reason);
  };
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg: SidecarOut;
    try {
      msg = JSON.parse(line) as SidecarOut;
    } catch {
      msg = { ev: 'log', text: `unreadable: ${line.slice(0, 200)}` };
    }
    h.message(msg);
  });
  createInterface({ input: child.stderr }).on('line', (text) => h.message({ ev: 'log', text }));
  child.on('error', (e) => end(e.message));
  child.on('exit', (code, signal) => end(`exited ${code ?? signal}`));
  child.stdin.on('error', () => undefined);
  return {
    send: (msg) => {
      if (!over) child.stdin.write(`${JSON.stringify(msg)}\n`);
    },
    kill: () => {
      over = true;
      child.kill();
    },
  };
}

/** Windows: build (once) and run the WinRT sidecar kept in `dir` (`~/.jumperly/ble`). */
export function windowsSidecar(dir: string): SpawnSidecar {
  return async (h) =>
    runSidecar(await buildSidecar({ windir: process.env.windir ?? 'C:\\Windows', dir }), [], h);
}

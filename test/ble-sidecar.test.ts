import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSidecar } from '../src/ble/build';
import { type SidecarOut, runSidecar } from '../src/ble/sidecar';

const FAKE = `
process.stdout.write(JSON.stringify({ ev: 'radio', state: 'on' }) + '\\n');
require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.op === 'scan')
    process.stdout.write(JSON.stringify({ ev: 'adv', addr: 'c2:11:22:33:44:55', random: true, rssi: -50, kind: 'adv', connectable: true, data: '020106' }) + '\\n');
  if (m.op === 'disconnect') process.exit(3);
});
`;

describe('the Bluetooth sidecar', () => {
  it('JSON lines both ways; its exit is reported', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ble-'));
    const script = join(dir, 'fake.cjs');
    writeFileSync(script, FAKE);
    const got: SidecarOut[] = [];
    const exited = await new Promise<string>((resolve) => {
      const s = runSidecar(process.execPath, [script], {
        message: (m) => {
          got.push(m);
          if (m.ev === 'adv') s.send({ op: 'disconnect', conn: 1 });
        },
        exit: resolve,
      });
      s.send({ op: 'scan', on: true });
    });
    expect(exited).toMatch(/3/);
    expect(got.map((m) => m.ev)).toEqual(['radio', 'adv']);
  });

  it('a command that cannot start is an exit, not a throw', async () => {
    const reason = await new Promise<string>((resolve) => {
      runSidecar(join(tmpdir(), 'no-such-sidecar.exe'), [], { message: () => {}, exit: resolve });
    });
    expect(reason).toMatch(/ENOENT/);
  });

  it.runIf(process.platform === 'win32')(
    'builds the real sidecar with csc (once) and hears the radio',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ble-'));
      const windir = process.env.windir ?? 'C:\\Windows';
      const exe = await buildSidecar({ windir, dir });
      expect(await buildSidecar({ windir, dir })).toBe(exe);
      const first = await new Promise<SidecarOut>((resolve, reject) => {
        const s = runSidecar(exe, [], {
          message: (m) => {
            if (m.ev === 'log') return;
            resolve(m);
            s.kill();
          },
          exit: (r) => reject(new Error(r)),
        });
      });
      expect(first).toMatchObject({ ev: 'radio' });
    },
    90_000,
  );

  it.runIf(process.platform === 'win32')(
    'two helpers building at once: both get the same sidecar',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ble-'));
      const windir = process.env.windir ?? 'C:\\Windows';
      const [a, b] = await Promise.all([
        buildSidecar({ windir, dir }),
        buildSidecar({ windir, dir }),
      ]);
      expect(a).toBe(b);
    },
    120_000,
  );
});

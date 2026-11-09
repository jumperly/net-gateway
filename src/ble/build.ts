import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SIDECAR_SOURCE } from './sidecar-source';

const run = promisify(execFile);
/** Builds of this process so far: their own file names, as another helper may build at once. */
let builds = 0;

/** The .NET Framework 4 compiler and the WinRT metadata the sidecar is built against. */
export function sidecarToolchain(windir: string): { csc: string; refs: string[] } {
  const fw = join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const wm = join(windir, 'System32', 'WinMetadata');
  const refs = [
    join(wm, 'Windows.Devices.winmd'),
    join(wm, 'Windows.Foundation.winmd'),
    join(wm, 'Windows.Storage.winmd'),
    join(fw, 'System.Runtime.dll'),
    join(fw, 'System.Runtime.InteropServices.WindowsRuntime.dll'),
    join(fw, 'System.Web.Extensions.dll'),
  ];
  const csc = join(fw, 'csc.exe');
  const missing = [csc, ...refs].find((p) => !existsSync(p));
  if (missing) throw new Error(`no .NET Framework 4 / WinRT for the Bluetooth sidecar: ${missing}`);
  return { csc, refs };
}

/** Build `jumperly-ble-<hash>.exe` in `dir` unless it is there; returns its path. */
export async function buildSidecar(opts: { windir: string; dir: string }): Promise<string> {
  const hash = createHash('sha256').update(SIDECAR_SOURCE).digest('hex').slice(0, 12);
  const exe = join(opts.dir, `jumperly-ble-${hash}.exe`);
  if (existsSync(exe)) return exe;
  const { csc, refs } = sidecarToolchain(opts.windir);
  mkdirSync(opts.dir, { recursive: true });
  const own = `${process.pid}-${++builds}`;
  const source = join(opts.dir, `jumperly-ble-${hash}.${own}.cs`);
  writeFileSync(source, SIDECAR_SOURCE);
  const tmp = join(opts.dir, `jumperly-ble-${hash}.${own}.tmp.exe`);
  try {
    await run(
      csc,
      [
        '/nologo',
        '/optimize+',
        '/target:exe',
        `/out:${tmp}`,
        ...refs.map((r) => `/r:${r}`),
        source,
      ],
      { windowsHide: true, timeout: 60_000 },
    );
  } catch (e) {
    rmSync(source, { force: true });
    const out = String((e as { stdout?: unknown }).stdout ?? '').trim();
    throw new Error(`the Bluetooth sidecar did not build: ${out.slice(0, 800) || String(e)}`);
  }
  rmSync(source, { force: true });
  try {
    renameSync(tmp, exe);
  } catch (e) {
    // Another build got there first (and may run it already): its exe is the same source's.
    rmSync(tmp, { force: true });
    if (!existsSync(exe)) throw e;
  }
  return exe;
}

// The local helper: the simulator's way into the user's own LAN. It runs on the
// user's machine, listens on 127.0.0.1:3003 (`/net/v1`, the gateway protocol with
// `welcome { gateway: 'helper', scope: 'lan' }`) and lets the app's tabs that know its pairing code
// reach the LAN (the subnets of this machine's interfaces), resolve `*.local` / `*.lan` names with
// the OS, and forward ports of this machine to simulated boards.
//
//   npx @jumperly/helper                                    the published package (npm/)
//   pnpm --filter @jumperly/net-gateway helper              start (prints the pairing code)
//   pnpm --filter @jumperly/net-gateway helper --new-code   start with a new code
//   pnpm --filter @jumperly/net-gateway build:helper        one executable for this OS (dist/)
//   pnpm --filter @jumperly/net-gateway build:npm           the npm package (npm/dist/)
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NET_PATH } from '@jumperly/schema';
import { TokenAuthorizer } from './auth';
import { BleService } from './ble/service';
import { windowsSidecar } from './ble/sidecar';
import { loadConfig } from './config';
import { formatPairingCode, loadPairing } from './pairing';
import { buildServer } from './server';

/** Set by the npm build (scripts/build-npm.mjs); absent when run from the sources. */
declare const HELPER_VERSION: string | undefined;

const USAGE = `Usage: jumperly-helper [--new-code]

The local helper of the Jumperly simulator: lets simulated boards into this computer's local
network, shows them the Wi-Fi networks around and, on Windows, Bluetooth LE devices.

  --new-code     start with a new pairing code (paired tabs have to pair again)
  -v, --version  print the version
  -h, --help     print this help

Settings come from NETGW_* environment variables, see the README.`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(typeof HELPER_VERSION === 'string' ? HELPER_VERSION : 'dev');
  process.exit(0);
}

const file = process.env.NETGW_HELPER_FILE ?? join(homedir(), '.jumperly', 'helper.json');
const pairing = loadPairing(file, { renew: process.argv.includes('--new-code') });
const { config, warnings } = loadConfig({ ...process.env, NETGW_MODE: 'helper' });
// Bluetooth LE on Windows: the WinRT sidecar, built in the background (`ble.state` says when).
const ble =
  process.platform === 'win32'
    ? new BleService({
        spawn: windowsSidecar(join(homedir(), '.jumperly', 'ble')),
        log: {
          info: () => undefined,
          warn: (obj, msg) => console.warn(`Jumperly Bluetooth: ${msg}`, JSON.stringify(obj)),
        },
      })
    : undefined;
ble?.start();
const app = buildServer({
  config,
  ...(ble ? { ble } : {}),
  logger: { level: process.env.NETGW_LOG_LEVEL ?? 'warn' },
  authorizer: new TokenAuthorizer({
    origins: config.origins,
    sessionsPerIp: config.limits.sessionsPerIp,
    tokens: [pairing.code],
  }),
});
for (const w of warnings) app.log.warn(w);

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// No top-level await: the single executable (scripts/build-helper.mjs) runs a CommonJS bundle.
app.listen({ host: config.host, port: config.port }).then(printBanner, (err: Error) => {
  console.error(`Jumperly: the helper did not start: ${err.message}`);
  process.exit(1);
});

function printBanner() {
  const lan = app.netGateway.lanCidrs;
  console.log(
    [
      '',
      'Jumperly — local helper',
      `  Address:            ws://${config.host}:${config.port}${NET_PATH}`,
      `  Pairing code:       ${formatPairingCode(pairing.code)}${pairing.created ? '  (new)' : ''}`,
      `  LAN:                ${lan.length ? lan.join(', ') : '— (no network interfaces)'}`,
      `  Forwards listen on: ${config.helper.listenHost}`,
      `  Bluetooth:          ${ble ? 'Windows (WinRT)' : '— (Windows only)'}`,
      '',
      'Enter the code in the simulator\'s "Network" tab. Ctrl+C stops.',
      '',
    ].join('\n'),
  );
}

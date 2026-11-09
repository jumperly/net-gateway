# @jumperly/net-gateway

[![npm](https://img.shields.io/npm/v/@jumperly/helper?label=%40jumperly%2Fhelper)](https://www.npmjs.com/package/@jumperly/helper)
[![license](https://img.shields.io/github/license/jumperly/net-gateway)](LICENSE)

The local helper is published on npm as [`@jumperly/helper`](https://www.npmjs.com/package/@jumperly/helper):

```sh
npx @jumperly/helper
```

The network gateway of [Jumperly](https://jumperly.dev): it lets a sketch running on an ESP32-S3 in
the browser simulator reach the internet. The browser (the `NetHub` of the web app) keeps one
WebSocket, `/net/v1`, and multiplexes the guest's socket operations over it: `open` / data /
`shutdown` / `close` / `resolve`. The gateway checks the policy and the limits, opens real TCP
connections (UDP when configured), answers DNS queries and streams data back with credit-based flow
control.

The same server also runs as the **local helper** on the user's computer: it lets simulated boards
into the real local network (a printer, Home Assistant, another ESP32), shows them the Wi-Fi
networks around, and on Windows bridges Bluetooth LE.

The wire protocol (message types and codec) is in `src/protocol/`: a copy of the Jumperly app's
schema, kept in sync from there. Change the protocol there, not here.

Endpoints: `GET /net/v1` (WebSocket, subprotocol `jumperly-net.1`), `GET /api/net/health` →
`{"ok":true}`.

## Running locally

Node.js 22+ and pnpm 9:

```sh
pnpm install
pnpm dev     # tsx watch, 127.0.0.1:3002
pnpm start   # no watch
curl 127.0.0.1:3002/api/net/health
```

Tests and checks:

```sh
pnpm test
pnpm typecheck
```

The tests never reach the internet: echo servers on `127.0.0.1` are reached through aliases
(`echo.jumperly.internal`) and DNS is stubbed. End-to-end tests with simulated firmware live in the
Jumperly app's repository.

## Local helper

The same server in helper mode, on the user's computer: simulated boards reach the real local
network, find devices by `*.local` names, and LAN devices reach a server on a board through a port
forward on this computer.

```sh
pnpm helper              # 127.0.0.1:3003, prints the pairing code
pnpm helper --new-code   # a new code (the tab has to pair again)
pnpm build:helper        # one executable for this OS
```

The code is entered in the simulator's **Network** tab → **Local network**; port forwards
("computer port → board:port") are set up there too.

**Wi-Fi networks around.** On `wifi.scan` the helper answers with the networks its computer sees
(Windows: `netsh wlan show networks mode=bssid`, macOS: `system_profiler SPAirPortDataType -json`,
Linux: `nmcli`): 2.4 GHz only (channels 1–14), one per SSID (the strongest), hidden networks left
out, at most 32, cached for 30 s. A scan on a simulated board (`WiFi.scanNetworks()`) lists them next
to the simulator's own network with their channel, signal and security; they cannot be joined.

**Bluetooth LE (Windows).** On Windows the helper announces `ble.scan` and `ble.gatt` and listens to
the devices around by itself: real addresses and their type, RSSI, raw advertising and scan response
data (Chrome on Windows cannot do that). A board's sketch connects to them through the helper — to
every service, with no browser chooser. For that the helper builds a sidecar, `jumperly-ble.exe` (C#,
WinRT), in the background on start with the system .NET Framework 4 compiler (`csc.exe`, shipped
with Windows 10 and 11) and keeps it in `~/.jumperly/ble/` (the name carries a hash of the source,
so it is rebuilt only after the helper is updated). While the sidecar builds the state is
`starting`; Bluetooth turned off is `off`; no adapter is `none`; the build or the sidecar failing
twice is `failed` (the reason is in `ble.state` and in the helper's log). On macOS and Linux the
helper does not announce Bluetooth.

The helper can also show a board to a real phone (`ble.serve`, the **Show to a phone** button in the
**Bluetooth** tab): the sidecar publishes the board's services through `GattServiceProvider` and
advertises them; the phone sees the computer under its own name. This needs an adapter with the
peripheral role (`IsPeripheralRoleSupported`).

**Executable.** `build:helper` bundles the helper into one file (esbuild, CommonJS) and turns it into
a Node SEA: `dist/jumperly-helper.exe` (Windows) or `dist/jumperly-helper` (macOS, Linux), ~95 MB —
`node` with the helper embedded. The file targets the OS and CPU of the `node` that runs the build,
so each OS is built on itself (or in CI). It is not signed (ad-hoc on macOS);
`dist/jumperly-helper.cjs` also runs with a plain `node`.

**npm package.** Users run the helper as [`@jumperly/helper`](npm/README.md): `npx @jumperly/helper`
(Node.js 22+). `build:npm` bundles it into `npm/dist/jumperly-helper.cjs` (esbuild, CommonJS, a
shebang, no runtime dependencies) with `npm/dist/THIRD-PARTY-NOTICES.txt`. The version is the one
in `npm/package.json` (`jumperly-helper --version` prints it).

**Releases.** Raising the version in `npm/package.json` on `main` releases it
(`.github/workflows/release.yml`): the tests run, the executables are built on Windows, macOS and
Linux, the package goes to npm (trusted publishing, with provenance) and a GitHub release `vX.Y.Z`
gets the bundle, the executables and the notices; a copy goes to GitHub Packages (it only links
the package to this repository: install from npmjs.com). Other commits release nothing.

| Variable | Default | Meaning |
|----------|---------|---------|
| `NETGW_PORT` | `3003` | Helper port |
| `NETGW_LAN_CIDRS` | — | LAN subnets on top of the subnets of the computer's interfaces |
| `NETGW_ALLOW_LOOPBACK` | `0` | Let boards reach services of the computer itself (`127.0.0.1`) |
| `NETGW_LISTEN_HOST` | `0.0.0.0` | Where port forwards listen |
| `NETGW_ORIGINS` | `https://app.jumperly.dev` and the dev addresses (`localhost` and `127.0.0.1` on ports 5173, 5174, 4173) | App pages allowed to connect |
| `NETGW_HELPER_FILE` | `~/.jumperly/helper.json` | Where the pairing code is stored |
| `NETGW_LOG_LEVEL` | `warn` | Log verbosity |

Security: the helper listens on `127.0.0.1` only; without the pairing code or with a foreign `Origin`
there is no session; boards reach only the subnets of the interfaces (not the internet — that is the
server's job — and not the computer itself); port forwards use ports from 1024, at most 8 per
session, and are removed when the session ends.

## Security

- **The host in `open`** is only the canonical form of an IP literal (`93.184.215.14`,
  `2606:4700:4700::1111`; an IPv4-mapped address may also be written `::ffff:a.b.c.d`) or a
  configured alias. The gateway never resolves names from `open` (no DNS rebinding, no TOCTOU);
  `127.1`, `0x7f.0.0.1`, `2130706433`, `[::1]`, `0:0:0:0:0:0:0:1` and `%` zones → `policy.host`.
- **Blocked ranges** (`policy.private`), a `node:net` `BlockList`. IPv4: `0.0.0.0/8`, `10.0.0.0/8`,
  `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`,
  `192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`,
  `224.0.0.0/4`, `240.0.0.0/4`, `255.255.255.255/32`. IPv6: `::/128`, `::1/128`, `fc00::/7`,
  `fe80::/10`, `fec0::/10`, `ff00::/8`, `100::/64`, `2001::/23`, `2001:db8::/32`; `::ffff:0:0/96`,
  `64:ff9b::/96`, `2002::/16` by the embedded IPv4 address.
- After `connect`, `socket.remoteAddress` is checked again; a connection to a literal never calls
  `lookup`.
- **Ports** are allow-listed (`policy.port`); UDP is off while `udpPorts` is empty (`policy.proto`).
- **Aliases** (trusted configuration) bypass the policy and the port allow-list.
- **Origin.** An upgrade from an `Origin` not on the list → 403; a request without `Origin` (not a
  browser) passes — tokens and binding to `127.0.0.1` protect against non-browser clients. No
  subprotocol → 400.
- **Tokens.** With `NETGW_TOKENS` set, `hello.token` is required (otherwise `notice { code: 'auth' }`
  and close 1008). For your own authorization pass an `authorizer` (the `Authorizer` interface in
  `src/auth.ts`) to `buildServer`.
- **Do not expose it publicly without tokens or an authorizer.** By default the gateway listens on
  `127.0.0.1`; bound to another address without `NETGW_TOKENS` it warns loudly in the log.
- **Logs** (pino, stdout): a `session` / `session end` line per session and a `flow` line per flow —
  board, `ip:port`, bytes both ways, duration, outcome and code; never the payload.

## Session behaviour

| What | How |
| --- | --- |
| `hello` | within 5 s, otherwise 1008; a second `hello`, a message before `hello`, a broken frame, data beyond the granted window — 1008 |
| Sessions per IP | above the limit: `notice { code: 'limit.sessions' }` and close 1013 |
| `welcome` | `gateway: 'server'`, `scope: 'public'`, `caps` (`tcp`, `dns`, `udp` when UDP ports are open, `mqtt` when the session gets a broker, see “MQTT”), `limits`, `aliases` (without the broker name), `mqtt` — only together with `caps: mqtt` |
| Gateway window | `opened.window` = 65536 (0 for UDP); `credit` is granted as data is written to the socket, within the outbound rate limit |
| Client window | `open.window`; with zero credit the remote socket is paused |
| WebSocket backpressure | with `bufferedAmount` > 1 MiB every flow of the session is paused until it drains |
| Rate | `bytesPerSec` in each direction (token bucket, 1/8 s burst); client frames — `framesPerSec`, above that WebSocket reads are paused |
| `totalBytes` | when exhausted every flow gets `closed { reset: true, code: 'limit.total' }`, new `open`s get `refused limit.total` |
| Idle | a TCP/UDP flow — 5 min (`closed { reset: true }`), a session — 10 min without messages (other than `ping`) and data (`notice idle`, close 1000) |
| Liveness | `ping` → `pong`; a WebSocket ping every 20 s, a client that does not answer is dropped |
| `listen` | `refused { code: 'unsupported' }`; `accept`, `wifi.scan`, `mqtt.*` without a broker — `notice { code: 'unsupported' }`, `open` to `mqtt.jumperly.internal` without a broker — `refused unsupported` |
| `resolve` | LRU cache of 1024 names, `min(ttl, 300 s)`, 5 s timeout, at most 32 concurrent queries per session; private addresses in an answer are returned as they are (`open` refuses them); an alias → `resolved { addrs: [], ttl: 300, alias: true }`; other names in the `jumperly.internal` zone → `nxdomain` |
| Shutdown | every flow gets `closed { code: 'gateway.shutdown' }`, then `notice gateway.shutdown`, close 1001 |

A frame over 64 KiB is closed with 1009 by the `ws` library (before parsing); from 16 390 bytes to
64 KiB — 1008, as the protocol requires.

## Configuration

Order: defaults → the JSON file in `NETGW_CONFIG` → `NETGW_*` variables.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NETGW_HOST` | `127.0.0.1` | bind address (`0.0.0.0` in a container) |
| `NETGW_PORT` | `3002` | TCP port |
| `NETGW_ORIGINS` | `http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:4173`, `http://127.0.0.1:4173` | allowed `Origin`s, comma-separated; `*` — any |
| `NETGW_TCP_PORTS` | `80,443,1883,8883,8080` | TCP port allow-list |
| `NETGW_UDP_PORTS` | empty | UDP port allow-list; empty — UDP off |
| `NETGW_MAX_CONNS` | `8` | concurrent flows per session |
| `NETGW_CONN_PER_MIN` | `30` | opens per minute per session |
| `NETGW_BYTES_PER_SEC` | `262144` | bytes/s per session in each direction |
| `NETGW_TOTAL_BYTES` | `67108864` | bytes per session (both directions together) |
| `NETGW_SESSIONS_PER_IP` | `4` | sessions per client IP |
| `NETGW_FRAMES_PER_SEC` | `1000` | client frames per second (against floods of tiny frames) |
| `NETGW_CONNECT_TIMEOUT_MS` | `10000` | connect timeout (`net.timeout`) |
| `NETGW_TCP_IDLE_MS` | `300000` | flow idle time |
| `NETGW_SESSION_IDLE_MS` | `600000` | session idle time |
| `NETGW_DNS_SERVERS` | system | DNS servers, comma-separated |
| `NETGW_TOKENS` | empty | `hello.token` values, comma-separated; empty — anonymous mode |
| `NETGW_TRUST_PROXY` | `0` | take the client IP from `X-Forwarded-For` (behind a reverse proxy) |
| `NETGW_MQTT` | `1` | MQTT broker at `mqtt.jumperly.internal:1883`; `0` — off |
| `NETGW_MQTT_SHARED` | `0` | sessions without `hello.ns` share the `default` broker (development only; warns in the log) |
| `NETGW_MQTT_DEBUG_PORT` | `0` (off) | TCP port of the brokers for external MQTT tools, `127.0.0.1` only |
| `NETGW_MQTT_IDLE_MS` | `600000` | a broker without sessions is unloaded after this time (with its retained messages) |
| `NETGW_CONFIG` | unset | path to a JSON file (below) |

The JSON file (every field is optional, unknown fields fail the start):

```json
{
  "host": "0.0.0.0",
  "port": 3002,
  "origins": ["https://app.jumperly.dev"],
  "tcpPorts": [80, 443, 1883, 8883, 8080],
  "udpPorts": [],
  "limits": { "maxConns": 8, "connPerMin": 30, "bytesPerSec": 262144, "totalBytes": 67108864,
              "sessionsPerIp": 4, "framesPerSec": 1000 },
  "timeouts": { "helloMs": 5000, "connectMs": 10000, "tcpIdleMs": 300000,
                "sessionIdleMs": 600000, "pingMs": 20000 },
  "dnsServers": ["1.1.1.1"],
  "aliases": {
    "httptest.jumperly.internal": { "kind": "tcp", "host": "httptest", "port": 8080 },
    "echo.jumperly.internal": { "kind": "tcp", "host": "127.0.0.1" }
  },
  "allowCidrs": [],
  "tokens": [],
  "trustProxy": false,
  "mqtt": { "enabled": true, "shared": false, "debugPort": 0, "idleMs": 600000 }
}
```

- **Aliases** are set in JSON only. A name is in the `jumperly.internal` zone (case and a trailing
  dot in `open` do not matter). `kind: 'tcp'`: `host` may be a name (it is resolved — the
  configuration is trusted); without `port` the port of the `open` is used. `kind: 'mqtt'` is served
  by the broker; `mqtt.jumperly.internal` is added automatically when MQTT is on.
- **`allowCidrs`** is for tests only: it lets ranges bypass the SSRF policy; a loud warning goes to
  the log on start.

## MQTT

The broker is [aedes](https://github.com/moscajs/aedes) (MIT) in memory, **one instance per
namespace**: `hello.ns` is a random project id from the web app's `localStorage`.

- **The guest** opens an ordinary TCP flow to the alias `mqtt.jumperly.internal:1883`
  (`opened.remote` = `mqtt.jumperly.internal:1883`); the gateway hands it to the broker through a
  pair of in-memory streams (`aedes.handle`) — credits, rate limits and `totalBytes` are the same as
  for any flow. The guest's FIN ends the MQTT connection (`eof`, `closed { reset: false }`);
  `close abort` drops it (the will is published).
- **Without `ns`** a session gets no MQTT: no `caps: mqtt` and no `welcome.mqtt`, `open` to the
  broker is `refused unsupported`, `mqtt.*` is `notice unsupported`. With `NETGW_MQTT_SHARED=1` such
  sessions share the `default` broker (development only: everyone sees everyone's topics).
- **Lifetime.** A broker is created by the first session of its `ns` and lives while there are
  sessions (or debug-port clients); after the last one it is unloaded after `NETGW_MQTT_IDLE_MS`
  (10 min). Retained messages live with the broker: they survive a guest reconnect and a page reload
  within that time, but not a gateway restart.
- **UI monitor.** `mqtt.watch { on: true }` is an internal `#` subscriber: first the retained
  messages, then every message as `mqtt.message` (`from` is the guest's client id; messages from the
  UI have none). The payload is the first 4096 bytes (`truncated`, `size` is the full length); at
  most 50 messages/s per session, the rest are skipped and once a second a
  `notice { code: 'mqtt.rate' }` carries their count. `$…` topics (`$SYS`) are not shown. The monitor
  limit does not apply to guests.
- **Publishing from the UI.** `mqtt.publish` → `aedes.publish` (QoS 0/1, retain). A topic with `+`,
  `#`, a NUL or starting with `$` → `notice { code: 'mqtt.topic' }`.
- **Debug port** `NETGW_MQTT_DEBUG_PORT` (`127.0.0.1` only) — for MQTT Explorer, `mosquitto_sub` and
  the like: the CONNECT `username` is the namespace (empty means `default` with
  `NETGW_MQTT_SHARED=1`), otherwise CONNACK 4 "bad user name" and close. Example:
  `mosquitto_sub -h 127.0.0.1 -p 1884 -u <ns> -t '#' -v`. In a container the port is not reachable
  from the host (it is bound to the container's loopback) — on purpose.

## License

[MIT](LICENSE)

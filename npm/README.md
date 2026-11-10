# @jumperly/helper

The local helper of [Jumperly](https://jumperly.dev), the ESP32 simulator in the browser. Run it on
your computer and the boards you simulate get:

- **your local network**: they reach a printer, Home Assistant or another ESP32, find devices by
  `*.local` names, and LAN devices reach a server on a board through a port forward on this
  computer;
- **the Wi-Fi networks around you** in `WiFi.scanNetworks()` (2.4 GHz, as the computer sees them);
- **Bluetooth LE** (Windows): real devices around with their addresses, RSSI and advertising data,
  every GATT service without the browser's chooser, and a board shown to your phone as a
  peripheral.

Internet access does not need the helper: simulated boards reach the internet through Jumperly's
own gateway.

## Usage

Node.js 22 or newer.

```sh
npx @jumperly/helper
```

The helper prints a pairing code. In the simulator open **Network** → **Local network** and enter
it; port forwards ("computer port → board:port") are set up there too. The code is kept in
`~/.jumperly/helper.json` and stays the same between runs.

```sh
npx @jumperly/helper --new-code   # a new pairing code (paired tabs have to pair again)
npx @jumperly/helper --help
npx @jumperly/helper --version
```

Ctrl+C stops the helper.

## Security

- The helper listens on `127.0.0.1:3003` only.
- Only the Jumperly app (`https://app.jumperly.dev`) with your pairing code gets a session.
- Boards reach only the subnets of your network interfaces: not the internet and not the computer
  itself (unless `NETGW_ALLOW_LOOPBACK=1`).
- Port forwards use ports from 1024, at most 8 per session, and are removed when the session ends.

## Bluetooth LE on Windows

On start the helper builds a small sidecar, `jumperly-ble.exe` (C#, WinRT), in the background with
the .NET Framework 4 compiler that ships with Windows 10 and 11 (`csc.exe`), and keeps it in
`~/.jumperly/ble/`; it is rebuilt only after the helper is updated. Showing a board to a phone needs
an adapter with the peripheral role. On macOS and Linux the helper does not offer Bluetooth: the
simulator uses Web Bluetooth in Chrome and Edge instead (no raw addresses or advertising data).

## Settings

| Variable | Default | Meaning |
|----------|---------|---------|
| `NETGW_PORT` | `3003` | Helper port |
| `NETGW_LAN_CIDRS` | - | LAN subnets on top of the subnets of the computer's interfaces |
| `NETGW_ALLOW_LOOPBACK` | `0` | Let boards reach services of the computer itself (`127.0.0.1`) |
| `NETGW_LISTEN_HOST` | `0.0.0.0` | Where port forwards listen |
| `NETGW_ORIGINS` | `https://app.jumperly.dev` and local dev addresses | App pages allowed to connect |
| `NETGW_HELPER_FILE` | `~/.jumperly/helper.json` | Where the pairing code is stored |
| `NETGW_LOG_LEVEL` | `warn` | Log verbosity |

## Source and license

Source: [github.com/jumperly/net-gateway](https://github.com/jumperly/net-gateway). MIT license;
the licenses of the bundled third-party packages are in `dist/THIRD-PARTY-NOTICES.txt`.

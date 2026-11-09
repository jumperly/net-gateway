import { timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import websocket from '@fastify/websocket';
import { NET_FRAME_MAX, NET_PATH, NET_SUBPROTOCOL } from '@jumperly/schema';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { Aliases } from './aliases';
import { AnonymousAuthorizer, type Authorizer, TokenAuthorizer } from './auth';
import type { BleService } from './ble/service';
import type { GatewayConfig } from './config';
import { DnsResolver, lookupBackend } from './dns';
import type { MqttHandler } from './mqtt/handler';
import { type FlowPolicy, LanPolicy, Policy, interfaceCidrs } from './policy';
import { Session } from './session';
import { WifiScanner } from './wifi-scan';

export interface GatewayDeps {
  config: GatewayConfig;
  /** Defaults to node:dns on `config.dnsServers`. */
  dns?: DnsResolver;
  /** Defaults to TokenAuthorizer with `config.tokens`, else AnonymousAuthorizer. */
  authorizer?: Authorizer;
  /** The MQTT broker; without it the gateway has no `mqtt` capability. */
  mqtt?: MqttHandler;
  logger?: FastifyServerOptions['logger'];
  /** The helper's Wi-Fi scans (default: the OS's tool, `WifiScanner`). */
  wifi?: WifiScanner;
  /** The helper's Bluetooth LE (`helper.ts` makes it on Windows); closed with the server. */
  ble?: BleService;
  /** The helper's view of the machine's interfaces (default `os.networkInterfaces`). */
  interfaces?: () => ReturnType<typeof networkInterfaces>;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** `lanCidrs`: the LAN of the local helper (empty on the server). */
    netGateway: { sessions: Set<Session>; lanCidrs: readonly string[] };
  }
}

/**
 * A binary frame is at most 5 + NET_FRAME_MAX bytes and a text frame NET_TEXT_MAX: a frame over
 * either is closed with 1008 by the session. Beyond this the `ws` library closes with 1009.
 */
const WS_MAX_PAYLOAD = 4 * NET_FRAME_MAX;

/** The gateway: `GET /net/v1` (WebSocket, subprotocol `jumperly-net.1`), `GET /api/net/health`. */
export function buildServer(deps: GatewayDeps): FastifyInstance {
  const { config } = deps;
  const app = Fastify({
    logger: deps.logger ?? false,
    trustProxy: config.trustProxy,
    forceCloseConnections: true,
  });

  let aliases = new Aliases(config.aliases);
  if (deps.mqtt) aliases = aliases.with(deps.mqtt.host, { kind: 'mqtt' });
  const helper = config.mode === 'helper';
  const lanCidrs = helper
    ? [
        ...new Set([
          ...interfaceCidrs((deps.interfaces ?? networkInterfaces)()),
          ...config.helper.lanCidrs,
        ]),
      ]
    : [];
  const policy: FlowPolicy = helper
    ? new LanPolicy({
        cidrs: lanCidrs,
        allowLoopback: config.helper.allowLoopback,
        redirect: config.helper.redirect,
      })
    : new Policy({
        tcpPorts: config.tcpPorts,
        udpPorts: config.udpPorts,
        aliases,
        allowCidrs: config.allowCidrs,
      });
  const dns =
    deps.dns ??
    (helper
      ? new DnsResolver({ aliases, backend: lookupBackend(config.helper.hosts) })
      : new DnsResolver({ aliases, servers: config.dnsServers }));
  const authOptions = { origins: config.origins, sessionsPerIp: config.limits.sessionsPerIp };
  const authorizer =
    deps.authorizer ??
    (config.tokens.length
      ? new TokenAuthorizer({ ...authOptions, tokens: config.tokens })
      : new AnonymousAuthorizer(authOptions));
  const sessions = new Set<Session>();
  app.decorate('netGateway', { sessions, lanCidrs });
  const wifi = helper ? (deps.wifi ?? new WifiScanner()) : undefined;
  const ble = helper ? deps.ble : undefined;
  app.addHook('onClose', async () => ble?.close());

  app.register(websocket, {
    options: {
      maxPayload: WS_MAX_PAYLOAD,
      perMessageDeflate: false,
      handleProtocols: (protocols) => (protocols.has(NET_SUBPROTOCOL) ? NET_SUBPROTOCOL : false),
    },
    preClose(done) {
      for (const s of sessions) s.shutdown();
      this.websocketServer.close();
      done();
    },
  });

  app.get('/api/net/health', { logLevel: 'warn' }, async () => ({ ok: true }));

  // Internal: only the api calls this. Anything but a matching token looks like a missing route.
  app.get('/api/net/internal/stats', { logLevel: 'warn' }, async (req, reply) => {
    const given = req.headers['x-internal-token'];
    const want = config.internalToken;
    if (!want || typeof given !== 'string') return reply.code(404).send({ error: 'not found' });
    const a = Buffer.from(given);
    const b = Buffer.from(want);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      return reply.code(404).send({ error: 'not found' });
    let flows = 0;
    let bytesUp = 0;
    let bytesDown = 0;
    for (const s of sessions) {
      flows += s.stats.flows;
      bytesUp += s.stats.up;
      bytesDown += s.stats.down;
    }
    return { sessions: sessions.size, flows, bytesUp, bytesDown };
  });

  app.register(async (scoped) => {
    scoped.get(
      NET_PATH,
      {
        websocket: true,
        preValidation: async (req, reply) => {
          if (!authorizer.originAllowed(req.headers.origin))
            return reply.code(403).send({ error: 'origin not allowed' });
          const offered = String(req.headers['sec-websocket-protocol'] ?? '')
            .split(',')
            .map((p) => p.trim());
          if (!offered.includes(NET_SUBPROTOCOL))
            return reply
              .code(400)
              .send({ error: `the subprotocol ${NET_SUBPROTOCOL} is required` });
        },
      },
      (socket, req) => {
        const session = new Session(
          socket,
          { ip: req.ip, origin: req.headers.origin },
          {
            config,
            policy,
            aliases,
            dns,
            authorizer,
            mqtt: deps.mqtt,
            log: app.log,
            lanCidrs,
            wifi,
            ble,
          },
          (s) => sessions.delete(s),
        );
        sessions.add(session);
        session.start();
      },
    );
  });

  return app;
}

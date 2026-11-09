import type { Duplex } from 'node:stream';
import { MQTT_HOST, type NetClientMsg, type NetGatewayMsg } from '@jumperly/schema';
import type { FastifyBaseLogger } from 'fastify';
import type { BrokerRegistry } from './brokers';
import { MqttMonitor } from './monitor';
import { duplexPair } from './pair';

/**
 * The seam for the MQTT broker. Without a handler the gateway has no `mqtt` capability: no
 * `welcome.mqtt`, `mqtt.*` messages get `notice { code: 'unsupported' }` and an alias of kind
 * `mqtt` is refused with `unsupported`.
 */
export interface MqttHandler {
  /** Announced in `welcome.mqtt` (`mqtt.jumperly.internal:1883`). */
  readonly host: string;
  readonly port: number;
  /**
   * One per gateway session, at `hello`; `close` is called when the session ends. Undefined: no
   * MQTT for this session (as without a handler).
   */
  attach(session: MqttSessionContext): MqttSession | undefined;
}

export interface MqttSessionContext {
  /** The gateway session id. */
  id: string;
  /** `hello.ns`: the namespace (one broker each); undefined when the client sent none. */
  ns: string | undefined;
  /** Send a control message (`mqtt.message`, `notice`) to the client. */
  send(msg: NetGatewayMsg): void;
  log: FastifyBaseLogger;
}

export interface MqttSession {
  /**
   * A guest TCP flow to the broker: a duplex stream standing in for the remote socket (the
   * gateway writes the guest's bytes into it and sends what it reads back, with the usual credits
   * and limits).
   */
  connect(flow: { sid: number; board: string | undefined }): Duplex;
  /** `mqtt.watch` and `mqtt.publish` from the UI. */
  message(msg: Extract<NetClientMsg, { t: 'mqtt.watch' | 'mqtt.publish' }>): void;
  close(): void;
}

/**
 * The MQTT handler over a BrokerRegistry: a session leases the broker of its namespace (or of
 * `default` when shared), its guest flows are `aedes.handle()` on in-memory stream pairs, the UI
 * talks to it through an MqttMonitor. A session without a namespace gets no MQTT unless shared.
 */
export class BrokerMqttHandler implements MqttHandler {
  readonly host = MQTT_HOST;
  readonly port = 1883;

  constructor(private readonly registry: BrokerRegistry) {}

  attach(ctx: MqttSessionContext): MqttSession | undefined {
    const ns = this.registry.namespaceOf(ctx.ns);
    if (ns === undefined) return undefined;
    const lease = this.registry.acquire(ns);
    const monitor = new MqttMonitor(lease.broker, ctx.send);
    const flows = new Set<Duplex>();
    let closed = false;
    return {
      connect: () => {
        const [gatewaySide, brokerSide] = duplexPair();
        flows.add(brokerSide);
        brokerSide.once('close', () => flows.delete(brokerSide));
        lease.broker.then(
          (broker) => {
            if (!brokerSide.destroyed) broker.handle(brokerSide);
          },
          (err: Error) => brokerSide.destroy(err),
        );
        return gatewaySide;
      },
      message: (msg) => monitor.message(msg),
      close: () => {
        if (closed) return;
        closed = true;
        monitor.close();
        for (const f of flows) f.destroy();
        lease.release();
      },
    };
  }
}

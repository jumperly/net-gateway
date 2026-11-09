import { Aedes, type AedesOptions } from 'aedes';

/** The namespace of the shared broker (`NETGW_MQTT_SHARED=1`); `hello.ns` is 8+ chars, no clash. */
export const SHARED_NS = 'default';

/** `hello.ns` and the debug port's username. */
export const NS_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** How long a broker nobody uses stays loaded. */
export const BROKER_IDLE_MS = 10 * 60_000;

/** The parts of an aedes broker the gateway uses beyond the typings (the retained store). */
export interface Broker extends Aedes {
  persistence: {
    createRetainedStream(pattern: string): AsyncIterable<RetainedPacket>;
  };
}

export interface RetainedPacket {
  topic: string;
  payload: Buffer;
  qos: 0 | 1 | 2;
  retain: boolean;
  clientId?: string;
}

/** A hold on the broker of one namespace; the broker stays loaded while any lease is held. */
export interface BrokerLease {
  readonly ns: string;
  readonly broker: Promise<Broker>;
  /** Idempotent. */
  release(): void;
}

export interface BrokerRegistryOptions {
  /** Serve clients without a namespace with the shared broker `default` (development only). */
  shared: boolean;
  /** Default BROKER_IDLE_MS. */
  idleMs?: number | undefined;
  /** aedes options of every broker. */
  aedes?: AedesOptions;
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

interface Entry {
  ns: string;
  broker: Promise<Broker>;
  refs: number;
  idle: NodeJS.Timeout | undefined;
}

/**
 * The MQTT brokers of the gateway: one aedes in memory per namespace, created on the first
 * lease and unloaded `idleMs` after the last lease is released (retained messages go with it).
 */
export class BrokerRegistry {
  log: BrokerRegistryOptions['log'];
  private readonly entries = new Map<string, Entry>();
  private readonly idleMs: number;
  private closed = false;

  constructor(private readonly opts: BrokerRegistryOptions) {
    this.idleMs = opts.idleMs ?? BROKER_IDLE_MS;
    this.log = opts.log;
  }

  /**
   * The broker namespace of a client: its own `ns`, the shared `default` when there is none and
   * sharing is on, else undefined (no MQTT for that client).
   */
  namespaceOf(ns: string | undefined): string | undefined {
    if (ns !== undefined && NS_PATTERN.test(ns)) return ns;
    if (ns === undefined && this.opts.shared) return SHARED_NS;
    return undefined;
  }

  /** Loaded brokers. */
  get size(): number {
    return this.entries.size;
  }

  has(ns: string): boolean {
    return this.entries.has(ns);
  }

  acquire(ns: string): BrokerLease {
    if (this.closed) throw new Error('the broker registry is closed');
    let entry = this.entries.get(ns);
    if (!entry) {
      const broker = Aedes.createBroker(this.opts.aedes) as Promise<Broker>;
      entry = { ns, broker, refs: 0, idle: undefined };
      this.entries.set(ns, entry);
      const created = entry;
      broker.then(
        () => this.log?.info({ ns }, 'mqtt broker loaded'),
        (err: Error) => {
          this.log?.warn({ ns, err: err.message }, 'mqtt broker failed to start');
          if (this.entries.get(ns) === created) this.entries.delete(ns);
        },
      );
    }
    clearTimeout(entry.idle);
    entry.idle = undefined;
    entry.refs++;
    const held = entry;
    let released = false;
    return {
      ns,
      broker: entry.broker,
      release: () => {
        if (released) return;
        released = true;
        this.release(held);
      },
    };
  }

  private release(entry: Entry): void {
    entry.refs--;
    if (entry.refs > 0 || this.entries.get(entry.ns) !== entry) return;
    entry.idle = setTimeout(() => {
      if (entry.refs > 0 || this.entries.get(entry.ns) !== entry) return;
      this.entries.delete(entry.ns);
      void this.unload(entry).then(() => this.log?.info({ ns: entry.ns }, 'mqtt broker unloaded'));
    }, this.idleMs);
    entry.idle.unref();
  }

  private async unload(entry: Entry): Promise<void> {
    clearTimeout(entry.idle);
    const broker = await entry.broker.catch(() => undefined);
    if (broker) await new Promise<void>((resolve) => broker.close(() => resolve()));
  }

  /** Unload every broker; no lease can be taken afterwards. */
  async close(): Promise<void> {
    this.closed = true;
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(all.map((e) => this.unload(e)));
  }
}

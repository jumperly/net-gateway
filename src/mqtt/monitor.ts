import type { AedesPublishPacket } from 'aedes';
import { TokenBucket } from '../limits';
import { NET_TEXT_MAX, type NetClientMsg, type NetGatewayMsg } from '../protocol';
import type { Broker } from './brokers';

/** `mqtt.message` carries at most this many payload bytes (before base64), else `truncated`. */
export const MONITOR_PAYLOAD_MAX = 4096;
/** `mqtt.message` per second and session; the rest is skipped and counted. */
export const MONITOR_RATE = 50;
/** `mqtt.message.topic` is at most this many UTF-8 bytes (the schema's limit). */
const TOPIC_MAX = 1024;
/** How often the count of skipped messages is reported. */
const SKIPPED_REPORT_MS = 1_000;

interface Delivered {
  topic: string;
  payload: Buffer | string;
  qos: 0 | 1 | 2;
  retain: boolean;
  clientId?: string;
}

/**
 * The UI side of one session's broker: `mqtt.watch` subscribes an internal client to `#` (the
 * retained messages first, as a real subscriber gets them) and forwards each message as
 * `mqtt.message`; `mqtt.publish` publishes on behalf of the UI. Topics starting with `$` are not
 * shown (MQTT 3.1.1 §4.7.2: `#` does not match them).
 */
export class MqttMonitor {
  private watching = false;
  /** `#` is subscribed at the broker (what the last applied `watch` left). */
  private subscribed = false;
  /**
   * Bumped by every `watch` change: only the latest one is applied once the broker is there, so a
   * fast on → off → on subscribes once (not once per `on`) and an older replay stops.
   */
  private generation = 0;
  private readonly bucket: TokenBucket;
  private skipped = 0;
  private skippedTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private readonly deliver = (packet: AedesPublishPacket, cb: () => void) => {
    this.show(packet as unknown as Delivered);
    cb();
  };

  constructor(
    private readonly broker: Promise<Broker>,
    private readonly send: (msg: NetGatewayMsg) => void,
    private readonly opts: { rate?: number; now?: () => number } = {},
  ) {
    const rate = opts.rate ?? MONITOR_RATE;
    this.bucket = new TokenBucket(rate, rate, opts.now);
  }

  message(msg: Extract<NetClientMsg, { t: 'mqtt.watch' | 'mqtt.publish' }>): void {
    if (msg.t === 'mqtt.watch') this.watch(msg.on);
    else this.publish(msg);
  }

  private watch(on: boolean): void {
    if (this.closed || on === this.watching) return;
    this.watching = on;
    const generation = ++this.generation;
    void this.broker.then(
      (broker) => {
        if (this.closed || generation !== this.generation) return;
        if (on) {
          if (!this.subscribed) broker.subscribe('#', this.deliver, () => {});
          this.subscribed = true;
          void this.replayRetained(broker, generation);
        } else if (this.subscribed) {
          broker.unsubscribe('#', this.deliver, () => {});
          this.subscribed = false;
        }
      },
      () => this.notice('mqtt.unavailable', 'the MQTT broker failed to start'),
    );
  }

  private async replayRetained(broker: Broker, generation: number): Promise<void> {
    try {
      for await (const packet of broker.persistence.createRetainedStream('#')) {
        if (this.closed || generation !== this.generation) return;
        this.show({ ...packet, retain: true });
      }
    } catch {
      // The broker was unloaded meanwhile.
    }
  }

  private publish(msg: Extract<NetClientMsg, { t: 'mqtt.publish' }>): void {
    if (/[+#\0]/.test(msg.topic) || msg.topic.startsWith('$')) {
      this.notice('mqtt.topic', `cannot publish to "${msg.topic}": no wildcards, no $ topics`);
      return;
    }
    void this.broker.then(
      (broker) => {
        if (this.closed) return;
        broker.publish(
          {
            cmd: 'publish',
            topic: msg.topic,
            payload: Buffer.from(msg.payload, 'base64'),
            qos: msg.qos,
            retain: msg.retain,
            dup: false,
          },
          (err) => {
            if (err)
              this.notice('mqtt.publish', `publish to "${msg.topic}" failed: ${err.message}`);
          },
        );
      },
      () => this.notice('mqtt.unavailable', 'the MQTT broker failed to start'),
    );
  }

  private show(packet: Delivered): void {
    if (this.closed || !this.watching || packet.topic.startsWith('$')) return;
    if (Buffer.byteLength(packet.topic) > TOPIC_MAX) return;
    if (!this.bucket.take(1)) {
      this.skip();
      return;
    }
    const payload =
      typeof packet.payload === 'string' ? Buffer.from(packet.payload) : packet.payload;
    const truncated = payload.length > MONITOR_PAYLOAD_MAX;
    const msg: NetGatewayMsg = {
      t: 'mqtt.message',
      topic: packet.topic,
      payload: payload.subarray(0, MONITOR_PAYLOAD_MAX).toString('base64'),
      qos: packet.qos,
      retain: packet.retain,
      size: payload.length,
      truncated,
      ...(packet.clientId ? { from: packet.clientId } : {}),
      at: Date.now(),
    };
    // A topic of escaped control characters could push the frame over the text limit.
    if (Buffer.byteLength(JSON.stringify(msg)) > NET_TEXT_MAX) return;
    this.send(msg);
  }

  private skip(): void {
    this.skipped++;
    if (this.skippedTimer) return;
    this.skippedTimer = setTimeout(() => {
      this.skippedTimer = undefined;
      const n = this.skipped;
      this.skipped = 0;
      if (!this.closed && n > 0)
        this.notice(
          'mqtt.rate',
          `${n} MQTT messages not shown: the monitor shows at most ${MONITOR_RATE} per second`,
        );
    }, SKIPPED_REPORT_MS);
  }

  private notice(code: string, msg: string): void {
    if (!this.closed) this.send({ t: 'notice', code, msg });
  }

  close(): void {
    if (this.closed) return;
    const wasSubscribed = this.subscribed;
    this.closed = true;
    this.watching = false;
    this.subscribed = false;
    clearTimeout(this.skippedTimer);
    if (wasSubscribed)
      void this.broker.then(
        (broker) => broker.unsubscribe('#', this.deliver, () => {}),
        () => {},
      );
  }
}

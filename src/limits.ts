import type { NetRefuseCode } from './protocol';
import { NET_FRAME_MAX } from './protocol';

/** A token bucket: `rate` tokens per second up to `capacity`; starts full. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly rate: number,
    readonly capacity: number,
    private readonly now: () => number = performance.now.bind(performance),
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
  }

  /** Whole tokens available now. */
  available(): number {
    this.refill();
    return Math.max(0, Math.floor(this.tokens));
  }

  /** Take `n` tokens if they are all there. */
  take(n: number): boolean {
    this.refill();
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  /** Take `n` tokens unconditionally (the balance may go below zero). */
  consume(n: number): void {
    this.refill();
    this.tokens -= n;
  }

  /** Milliseconds until `n` tokens (at most the capacity) are available. */
  msUntil(n: number): number {
    this.refill();
    const missing = Math.min(n, this.capacity) - this.tokens;
    if (missing <= 0) return 0;
    if (this.rate <= 0) return Number.POSITIVE_INFINITY;
    return Math.ceil((missing / this.rate) * 1000);
  }
}

export interface SessionLimitsConfig {
  maxConns: number;
  connPerMin: number;
  bytesPerSec: number;
  totalBytes: number;
  framesPerSec: number;
}

/**
 * The quotas of one session: concurrent flows, opens per minute, bytes per second in each
 * direction, bytes in total, client frames per second.
 */
export class SessionLimits {
  /** Bytes per second from the client to the remote hosts. */
  readonly up: TokenBucket;
  /** Bytes per second from the remote hosts to the client. */
  readonly down: TokenBucket;
  /** Client frames (text and binary) per second: the defence against floods of tiny frames. */
  readonly frames: TokenBucket;
  private readonly opens: TokenBucket;
  private conns = 0;
  private total = 0;

  constructor(
    private readonly cfg: SessionLimitsConfig,
    now?: () => number,
  ) {
    // A burst of 1/8 s keeps the measured rate close to bytesPerSec over a few seconds.
    const burst = Math.max(2 * NET_FRAME_MAX, Math.floor(cfg.bytesPerSec / 8));
    this.up = new TokenBucket(cfg.bytesPerSec, burst, now);
    this.down = new TokenBucket(cfg.bytesPerSec, burst, now);
    this.frames = new TokenBucket(cfg.framesPerSec, Math.max(1, cfg.framesPerSec), now);
    this.opens = new TokenBucket(cfg.connPerMin / 60, cfg.connPerMin, now);
  }

  get openConns(): number {
    return this.conns;
  }

  get totalBytes(): number {
    return this.total;
  }

  /** May one more flow open? Takes a flow slot and an open token when it may. */
  tryOpen(): NetRefuseCode | null {
    if (this.total >= this.cfg.totalBytes) return 'limit.total';
    if (this.conns >= this.cfg.maxConns) return 'limit.conns';
    if (!this.opens.take(1)) return 'limit.rate';
    this.conns++;
    return null;
  }

  /** A flow ended: its slot is free. */
  release(): void {
    if (this.conns > 0) this.conns--;
  }

  /** Bytes the session may still move before `limit.total`. */
  remainingBytes(): number {
    return Math.max(0, this.cfg.totalBytes - this.total);
  }

  /** Count moved bytes; false once the total quota is exceeded. */
  addBytes(n: number): boolean {
    this.total += n;
    return this.total <= this.cfg.totalBytes;
  }
}

/** Concurrent sessions per client IP. */
export class IpSessions {
  private readonly byIp = new Map<string, number>();

  constructor(private readonly max: number) {}

  /** A slot for `ip` with its release, or null at the cap. */
  acquire(ip: string): (() => void) | null {
    const n = this.byIp.get(ip) ?? 0;
    if (n >= this.max) return null;
    this.byIp.set(ip, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.byIp.get(ip) ?? 1) - 1;
      if (left > 0) this.byIp.set(ip, left);
      else this.byIp.delete(ip);
    };
  }

  count(ip: string): number {
    return this.byIp.get(ip) ?? 0;
  }
}

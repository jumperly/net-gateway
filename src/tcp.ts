import { type Socket, connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { NET_FRAME_MAX, NET_WINDOW, type NetRefuseCode } from '@jumperly/schema';
import { type Flow, type FlowInfo, type FlowLine, type FlowSession, hostPort } from './flow';

/** A connection being made: the stream at once, whether it connected later. */
export interface Dial {
  stream: Duplex;
  ready: Promise<{ ok: true; remote: { address?: string; port?: number } } | DialFailure>;
}

export interface DialFailure {
  ok: false;
  code: NetRefuseCode;
  reason: string;
}

/** The refuse code of a failed connect. */
export function connectErrorCode(err: NodeJS.ErrnoException): NetRefuseCode {
  switch (err.code) {
    case 'ECONNREFUSED':
      return 'net.refused';
    case 'ETIMEDOUT':
      return 'net.timeout';
    case 'ECONNRESET':
      return 'net.reset';
    default:
      // EHOSTUNREACH, ENETUNREACH, EADDRNOTAVAIL, ENOTFOUND (an alias host), …
      return 'net.unreachable';
  }
}

const noLookup = (
  hostname: string,
  _options: unknown,
  callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
) => callback(new Error(`refusing to resolve "${hostname}" for a flow`), '', 0);

/**
 * Connect to `host:port` within `timeoutMs`. `resolveNames` false (a literal from `open`): the
 * socket never looks a name up, whatever `host` is.
 */
export function dialTcp(
  host: string,
  port: number,
  opts: { timeoutMs: number; resolveNames: boolean },
): Dial {
  const socket: Socket = connect({
    host,
    port,
    allowHalfOpen: true,
    noDelay: true,
    ...(opts.resolveNames ? {} : { lookup: noLookup as never }),
  });
  // The flow adds its own listener; this one keeps a late error from crashing the process.
  socket.on('error', () => {});
  const ready = new Promise<Awaited<Dial['ready']>>((resolve) => {
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({
        ok: false,
        code: 'net.timeout',
        reason: `no connection to ${hostPort(host, port)} in ${opts.timeoutMs / 1000} s`,
      });
    }, opts.timeoutMs);
    const onError = (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: connectErrorCode(err),
        reason: `${hostPort(host, port)}: ${err.code ?? err.message}`,
      });
    };
    socket.once('error', onError);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.off('error', onError);
      resolve({ ok: true, remote: { address: socket.remoteAddress, port: socket.remotePort } });
    });
  });
  return { stream: socket, ready };
}

/** How long a forgotten, gracefully closed connection may linger. */
const LINGER_MS = 10_000;

/**
 * A TCP flow over any duplex stream: a socket (internet, aliases) or a broker's in-memory stream
 * (MQTT). Credits both ways: the client's window bounds what is sent to it (the remote stream is
 * paused meanwhile), the gateway's window (`NET_WINDOW`) is granted back as bytes are written and
 * the upload rate allows.
 */
export class StreamFlow implements Flow {
  readonly sid: number;
  readonly proto = 'tcp' as const;
  readonly board: string | undefined;
  readonly dst: string;
  readonly startedAt = performance.now();
  up = 0;
  down = 0;

  private stream: Duplex | undefined;
  private state: 'connecting' | 'open' | 'over' = 'connecting';
  /** Bytes the client still accepts. */
  private credit: number;
  /** Bytes the client may still send. */
  private granted = NET_WINDOW;
  /** Written bytes not yet granted back. */
  private ungranted = 0;
  private grantQueued = false;
  private grantTimer: NodeJS.Timeout | undefined;
  private wakeTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private remoteEnded = false;
  private eofSent = false;
  private shutdownAsked = false;
  /** The stream closed cleanly; `closed` follows once pending data is out. */
  private closing = false;
  private errorCode: string | undefined;

  constructor(
    private readonly session: FlowSession,
    info: FlowInfo,
    clientWindow: number,
  ) {
    this.sid = info.sid;
    this.board = info.board;
    this.dst = info.dst;
    this.credit = clientWindow;
  }

  /**
   * Connect through `dial`. For a literal, `checkRemote` re-checks the peer address once
   * connected and `opened.remote` is that address; an alias keeps its name (`label`).
   */
  async start(
    dial: Dial,
    opts: { checkRemote?: (address: string | undefined) => boolean; label?: string } = {},
  ): Promise<void> {
    const { checkRemote, label } = opts;
    this.stream = dial.stream;
    const r = await dial.ready;
    if (this.state !== 'connecting') {
      // Forgotten or killed meanwhile.
      dial.stream.destroy();
      return;
    }
    if (!r.ok) return this.refuse(r.code, r.reason);
    if (checkRemote && !checkRemote(r.remote.address)) {
      dial.stream.destroy();
      return this.refuse(
        'policy.private',
        `connected to ${r.remote.address ?? 'an unknown address'}, a private or reserved address`,
      );
    }
    this.state = 'open';
    const remote =
      label ??
      (r.remote.address !== undefined && r.remote.port !== undefined
        ? hostPort(r.remote.address, r.remote.port)
        : this.dst);
    this.session.control({ t: 'opened', sid: this.sid, remote, window: NET_WINDOW });
    this.attach(dial.stream);
    if (this.shutdownAsked) dial.stream.end();
  }

  private refuse(code: NetRefuseCode, reason: string): void {
    this.state = 'over';
    this.session.control({ t: 'refused', sid: this.sid, code, reason });
    this.session.done(this, { result: 'refused', code, reason });
  }

  private attach(stream: Duplex): void {
    this.idleTimer = setTimeout(() => {
      this.kill(undefined, `idle for ${Math.round(this.session.flowIdleMs / 1000)} s`);
    }, this.session.flowIdleMs);
    stream.on('data', (chunk: Buffer) => {
      if (this.state !== 'open') return;
      this.pending.push(chunk);
      this.pendingBytes += chunk.length;
      this.session.notePending(this.pendingBytes);
      this.touch();
      this.pump();
    });
    stream.on('end', () => {
      this.remoteEnded = true;
      this.pump();
    });
    stream.on('error', (err: NodeJS.ErrnoException) => {
      this.errorCode = err.code ?? err.message;
    });
    stream.on('close', () => {
      if (this.state !== 'open') return;
      if (this.errorCode !== undefined) {
        this.kill('net.reset', `the remote host reset the connection (${this.errorCode})`);
        return;
      }
      this.closing = true;
      this.pump();
    });
  }

  private touch(): void {
    this.idleTimer?.refresh();
    this.session.activity();
  }

  clientData(kind: 1 | 2, bytes: Uint8Array): boolean {
    if (kind !== 1) return false;
    if (this.state === 'connecting') return false;
    if (this.state === 'over' || this.closing || this.shutdownAsked) return true;
    if (bytes.length > this.granted) return false;
    this.granted -= bytes.length;
    if (!this.session.limits.addBytes(bytes.length)) {
      this.session.totalSpent();
      return true;
    }
    this.up += bytes.length;
    this.touch();
    const n = bytes.length;
    this.stream?.write(bytes, (err) => {
      if (err || this.state !== 'open') return;
      this.ungranted += n;
      if (!this.grantQueued) {
        this.grantQueued = true;
        setImmediate(() => {
          this.grantQueued = false;
          this.grant();
        });
      }
    });
    return true;
  }

  /** Grant written bytes back as credit, at the upload rate. */
  private grant(): void {
    if (this.state !== 'open' || this.grantTimer || this.ungranted === 0) return;
    const up = this.session.limits.up;
    const wait = up.msUntil(Math.min(this.ungranted, up.capacity));
    if (wait > 0) {
      this.grantTimer = setTimeout(() => {
        this.grantTimer = undefined;
        this.grant();
      }, wait);
      return;
    }
    const n = this.ungranted;
    this.ungranted = 0;
    up.consume(n);
    this.granted += n;
    this.session.control({ t: 'credit', sid: this.sid, bytes: n });
  }

  clientCredit(bytes: number): void {
    if (this.state !== 'open') return;
    this.credit += bytes;
    this.pump();
  }

  clientShutdown(): void {
    if (this.shutdownAsked) return;
    this.shutdownAsked = true;
    if (this.state === 'open') this.stream?.end();
  }

  pump(): void {
    if (this.state !== 'open') return;
    const down = this.session.limits.down;
    while (this.pendingBytes > 0 && this.credit > 0) {
      if (this.session.congested()) break;
      const head = this.pending[0] as Buffer;
      const n = Math.min(head.length, this.credit, NET_FRAME_MAX);
      const wait = down.msUntil(Math.min(n, down.capacity));
      if (wait > 0) {
        this.wakeAfter(wait);
        break;
      }
      down.consume(n);
      const slice = head.subarray(0, n);
      if (n === head.length) this.pending.shift();
      else this.pending[0] = head.subarray(n);
      this.pendingBytes -= n;
      this.credit -= n;
      this.down += n;
      this.session.data(1, this.sid, slice);
      if (!this.session.limits.addBytes(n)) {
        this.session.totalSpent();
        return;
      }
    }
    if (this.pendingBytes > 0) {
      this.stream?.pause();
      return;
    }
    if (this.remoteEnded && !this.eofSent) {
      this.eofSent = true;
      this.session.control({ t: 'eof', sid: this.sid });
    }
    if (this.closing) {
      this.finish();
      this.session.control({ t: 'closed', sid: this.sid, reset: false });
      this.session.done(this, { result: 'closed' });
      return;
    }
    this.stream?.resume();
  }

  private wakeAfter(ms: number): void {
    if (this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.pump();
    }, ms);
  }

  private finish(): void {
    this.state = 'over';
    clearTimeout(this.idleTimer);
    clearTimeout(this.grantTimer);
    clearTimeout(this.wakeTimer);
    this.pending = [];
    this.pendingBytes = 0;
  }

  forget(abort: boolean): void {
    if (this.state === 'over') return;
    const stream = this.stream;
    this.finish();
    if (stream) {
      if (abort) {
        const socket = stream as Partial<Socket>;
        if (typeof socket.resetAndDestroy === 'function' && socket.readyState === 'open')
          socket.resetAndDestroy();
        else stream.destroy();
      } else {
        stream.resume();
        stream.end();
        setTimeout(() => stream.destroy(), LINGER_MS).unref();
      }
    }
    this.session.done(this, {
      result: 'forgotten',
      reason: abort ? 'client abort' : 'client close',
    });
  }

  kill(code: NetRefuseCode | undefined, reason: string): void {
    if (this.state === 'over') return;
    const wasConnecting = this.state === 'connecting';
    this.finish();
    this.stream?.destroy();
    if (wasConnecting && code) {
      this.session.control({ t: 'refused', sid: this.sid, code, reason });
      this.session.done(this, { result: 'refused', code, reason });
      return;
    }
    this.session.control({
      t: 'closed',
      sid: this.sid,
      reset: true,
      ...(code ? { code } : {}),
      reason,
    });
    const line: FlowLine = { result: 'reset', reason };
    if (code) line.code = code;
    this.session.done(this, line);
  }

  destroy(): void {
    if (this.state === 'over') return;
    this.finish();
    this.stream?.destroy();
    this.session.done(this, { result: 'closed', reason: 'session closed' });
  }
}

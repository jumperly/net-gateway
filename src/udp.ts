import { type Socket, createSocket } from 'node:dgram';
import { NET_FRAME_MAX, type NetRefuseCode } from '@jumperly/schema';
import type { Flow, FlowInfo, FlowLine, FlowSession } from './flow';
import { hostPort } from './flow';
import { connectErrorCode } from './tcp';

/**
 * A UDP flow (off unless `udpPorts` is set): a connected datagram socket. No credits: a
 * datagram over the rate, over `NET_FRAME_MAX` or while the WebSocket is congested is dropped,
 * as a network would.
 */
export class DatagramFlow implements Flow {
  readonly sid: number;
  readonly proto = 'udp' as const;
  readonly board: string | undefined;
  readonly dst: string;
  readonly startedAt = performance.now();
  up = 0;
  down = 0;
  private socket: Socket | undefined;
  private state: 'connecting' | 'open' | 'over' = 'connecting';
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly session: FlowSession,
    info: FlowInfo,
  ) {
    this.sid = info.sid;
    this.board = info.board;
    this.dst = info.dst;
  }

  start(ip: string, family: 4 | 6, port: number, checkRemote: (address: string) => boolean): void {
    const socket = createSocket(family === 4 ? 'udp4' : 'udp6');
    this.socket = socket;
    socket.on('error', () => {});
    socket.connect(port, ip, () => {
      if (this.state !== 'connecting') return;
      const remote = socket.remoteAddress();
      if (!checkRemote(remote.address)) {
        socket.close();
        return this.refuse('policy.private', `${remote.address} is a private or reserved address`);
      }
      this.state = 'open';
      this.session.control({
        t: 'opened',
        sid: this.sid,
        remote: hostPort(remote.address, remote.port),
        window: 0,
      });
      this.idleTimer = setTimeout(
        () => this.kill(undefined, `idle for ${Math.round(this.session.flowIdleMs / 1000)} s`),
        this.session.flowIdleMs,
      );
      socket.on('message', (msg) => this.remoteData(msg));
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (this.state === 'connecting') {
        socket.close();
        this.refuse(connectErrorCode(err), `${this.dst}: ${err.code ?? err.message}`);
      }
      // Later errors (ICMP port unreachable on a connected socket) are what UDP does: ignored.
    });
  }

  private refuse(code: NetRefuseCode, reason: string): void {
    this.state = 'over';
    this.session.control({ t: 'refused', sid: this.sid, code, reason });
    this.session.done(this, { result: 'refused', code, reason });
  }

  private touch(): void {
    this.idleTimer?.refresh();
    this.session.activity();
  }

  private remoteData(msg: Buffer): void {
    if (this.state !== 'open') return;
    if (msg.length > NET_FRAME_MAX || this.session.congested()) return;
    if (!this.session.limits.down.take(msg.length)) return;
    this.down += msg.length;
    this.touch();
    this.session.data(2, this.sid, msg);
    if (!this.session.limits.addBytes(msg.length)) this.session.totalSpent();
  }

  clientData(kind: 1 | 2, bytes: Uint8Array): boolean {
    if (kind !== 2) return false;
    if (this.state !== 'open') return this.state === 'over';
    if (!this.session.limits.up.take(bytes.length)) return true;
    if (!this.session.limits.addBytes(bytes.length)) {
      this.session.totalSpent();
      return true;
    }
    this.up += bytes.length;
    this.touch();
    this.socket?.send(bytes);
    return true;
  }

  clientCredit(): void {}

  clientShutdown(): void {}

  pump(): void {}

  private finish(): void {
    this.state = 'over';
    clearTimeout(this.idleTimer);
    try {
      this.socket?.close();
    } catch {
      // Already closed.
    }
  }

  forget(abort: boolean): void {
    if (this.state === 'over') return;
    this.finish();
    this.session.done(this, {
      result: 'forgotten',
      reason: abort ? 'client abort' : 'client close',
    });
  }

  kill(code: NetRefuseCode | undefined, reason: string): void {
    if (this.state === 'over') return;
    const wasConnecting = this.state === 'connecting';
    this.finish();
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
    this.session.done(this, { result: 'closed', reason: 'session closed' });
  }
}

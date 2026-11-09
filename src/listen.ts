import { type Server, type Socket, createServer } from 'node:net';
import type { NetGatewayMsg, NetRefuseCode } from '@jumperly/schema';
import { hostPort } from './flow';

/** What a forward needs from its session. */
export interface ListenSession {
  control(msg: NetGatewayMsg): void;
  /** A connection came: the session asks the page (`incoming`) and owns the socket now. */
  incoming(listener: Listener, socket: Socket): void;
  /** The forward is over (closed by the page, failed, or the session ended). */
  listenerDone(listener: Listener): void;
}

/** The refuse code of a failed `listen`. */
function listenErrorCode(err: NodeJS.ErrnoException): NetRefuseCode {
  return err.code === 'EACCES' ? 'policy.port' : 'net.refused';
}

/**
 * A port forward of the local helper: a TCP server on `host:port` of the helper's
 * machine. `opened` once it listens, `refused` when it cannot (taken, no rights); each connection
 * is handed to the session, paused, until the page accepts it.
 */
export class Listener {
  private server: Server | undefined;
  private state: 'starting' | 'listening' | 'over' = 'starting';

  constructor(
    private readonly session: ListenSession,
    readonly sid: number,
    readonly port: number,
    private readonly host: string,
  ) {}

  start(): void {
    const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, (socket) => {
      socket.on('error', () => {});
      if (this.state !== 'listening') {
        socket.destroy();
        return;
      }
      this.session.incoming(this, socket);
    });
    this.server = server;
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (this.state === 'over') return;
      const wasStarting = this.state === 'starting';
      this.finish();
      const reason = `${hostPort(this.host, this.port)}: ${err.code ?? err.message}`;
      if (wasStarting)
        this.session.control({
          t: 'refused',
          sid: this.sid,
          code: listenErrorCode(err),
          reason,
        });
      else this.session.control({ t: 'closed', sid: this.sid, reset: true, reason });
      this.session.listenerDone(this);
    });
    server.listen(this.port, this.host, () => {
      if (this.state !== 'starting') return;
      this.state = 'listening';
      this.session.control({
        t: 'opened',
        sid: this.sid,
        remote: hostPort(this.host, this.port),
        window: 0,
      });
    });
  }

  /** The page stops the forward (`close`): no message about it. */
  close(): void {
    if (this.state === 'over') return;
    this.finish();
    this.session.listenerDone(this);
  }

  private finish(): void {
    this.state = 'over';
    this.server?.close();
  }
}

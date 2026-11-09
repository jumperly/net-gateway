import { Duplex } from 'node:stream';

/**
 * One end of an in-memory connection: what is written here is read at the peer. Backpressure: a
 * write completes once the peer's read buffer takes it.
 */
class PairEnd extends Duplex {
  peer!: PairEnd;
  /** The callback of a write the peer's buffer did not take yet. */
  private blocked: (() => void) | undefined;
  private eof = false;

  constructor() {
    super({ allowHalfOpen: true });
  }

  /** End the readable side once (the peer finished or went away). */
  pushEof(): void {
    if (this.eof) return;
    this.eof = true;
    this.push(null);
  }

  unblock(): void {
    const cb = this.blocked;
    this.blocked = undefined;
    cb?.();
  }

  override _read(): void {
    this.peer.unblock();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, cb: (err?: Error | null) => void) {
    const peer = this.peer;
    if (peer.destroyed || peer.eof) {
      cb(); // the peer is gone: the bytes are dropped, as by a socket the peer closed
      return;
    }
    if (peer.push(chunk)) cb();
    else this.blocked = cb;
  }

  override _final(cb: (err?: Error | null) => void): void {
    this.peer.pushEof();
    cb();
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    this.unblock();
    const peer = this.peer;
    peer.unblock();
    if (!peer.destroyed) {
      if (err) peer.destroy(err);
      else {
        // Like a socket closed by the other side: the peer reads what is left, then EOF, then
        // closes.
        peer.pushEof();
        if (peer.readableEnded) peer.destroy();
        else peer.once('end', () => peer.destroy());
      }
    }
    cb(err);
  }
}

/**
 * Two connected duplex streams: a TCP connection without a socket. `destroy()` of one end ends the
 * other gracefully (EOF, then close); `destroy(err)` destroys it with that error.
 */
export function duplexPair(): [Duplex, Duplex] {
  const a = new PairEnd();
  const b = new PairEnd();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

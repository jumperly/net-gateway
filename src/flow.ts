import type { NetGatewayMsg, NetProto, NetRefuseCode } from '@jumperly/schema';
import type { SessionLimits } from './limits';

/** What a flow needs from its session. */
export interface FlowSession {
  readonly limits: SessionLimits;
  /** The idle timeout of one flow. */
  readonly flowIdleMs: number;
  control(msg: NetGatewayMsg): void;
  data(kind: 1 | 2, sid: number, bytes: Uint8Array): void;
  /** The WebSocket holds more than it should (`bufferedAmount` > 1 MiB): send nothing. */
  congested(): boolean;
  /** Something moved: the session is not idle. */
  activity(): void;
  /** The session total is spent: close every flow with `limit.total`. */
  totalSpent(): void;
  /** A pending peak, for the stats. */
  notePending(bytes: number): void;
  /** The flow is over: free its sid and slot, log its line. */
  done(flow: Flow, line: FlowLine): void;
}

/** The log line of a flow: no payload. */
export interface FlowLine {
  result: 'closed' | 'reset' | 'refused' | 'forgotten';
  code?: NetRefuseCode;
  reason?: string;
}

export interface FlowInfo {
  sid: number;
  proto: NetProto;
  board: string | undefined;
  /** `ip:port` or `alias:port` as asked. */
  dst: string;
}

export interface Flow extends FlowInfo {
  readonly up: number;
  readonly down: number;
  readonly startedAt: number;
  /** A data frame from the client; false is a protocol violation (1008). */
  clientData(kind: 1 | 2, bytes: Uint8Array): boolean;
  clientCredit(bytes: number): void;
  clientShutdown(): void;
  /** The client forgot the flow (`close`): no further message about it. */
  forget(abort: boolean): void;
  /** The gateway ends the flow: `closed { reset: true, code, reason }`. */
  kill(code: NetRefuseCode | undefined, reason: string): void;
  /** The WebSocket drained or a bucket refilled: try to move data again. */
  pump(): void;
  /** The session is gone: drop everything silently. */
  destroy(): void;
}

/** `ip:port`, or `[ip]:port` for IPv6. */
export function hostPort(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

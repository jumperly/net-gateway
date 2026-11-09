import { createHash, timingSafeEqual } from 'node:crypto';
import { IpSessions } from './limits';
import type { NetClientMsg, NetRefuseCode } from './protocol';

export type HelloMsg = Extract<NetClientMsg, { t: 'hello' }>;

export interface ClientInfo {
  ip: string;
  origin: string | undefined;
}

export type Admission =
  | { ok: true; release: () => void }
  | { ok: false; code: NetRefuseCode; reason: string };

/**
 * Who may use the gateway: the hook for real authorization (accounts, quotas). The
 * server calls it at three points of a session.
 */
export interface Authorizer {
  /** At the HTTP upgrade: false answers 403 (a page of another site must not use the gateway). */
  originAllowed(origin: string | undefined): boolean;
  /** When the WebSocket opens: a session slot (the per-IP cap), released when the session ends. */
  admit(client: ClientInfo): Admission;
  /** At `hello`: may this client go on? False closes the session (1008). */
  authenticate(hello: HelloMsg, client: ClientInfo): boolean | Promise<boolean>;
}

export interface AnonymousOptions {
  /** Allowed `Origin` values; `*` allows any. A request without Origin (not a browser) passes. */
  origins: readonly string[];
  sessionsPerIp: number;
}

/** Anyone from an allowed origin, at most `sessionsPerIp` sessions per client IP. */
export class AnonymousAuthorizer implements Authorizer {
  private readonly origins: ReadonlySet<string>;
  private readonly sessions: IpSessions;

  constructor(opts: AnonymousOptions) {
    this.origins = new Set(opts.origins.map((o) => o.toLowerCase()));
    this.sessions = new IpSessions(opts.sessionsPerIp);
  }

  originAllowed(origin: string | undefined): boolean {
    if (origin === undefined) return true;
    return this.origins.has('*') || this.origins.has(origin.toLowerCase());
  }

  admit(client: ClientInfo): Admission {
    const release = this.sessions.acquire(client.ip);
    if (!release)
      return {
        ok: false,
        code: 'limit.sessions',
        reason: `too many sessions from ${client.ip}; close another tab with the simulator`,
      };
    return { ok: true, release };
  }

  authenticate(_hello: HelloMsg, _client: ClientInfo): boolean {
    return true;
  }
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/** As anonymous, and `hello.token` must be one of `tokens` (NETGW_TOKENS). */
export class TokenAuthorizer extends AnonymousAuthorizer {
  private readonly digests: Buffer[];

  constructor(opts: AnonymousOptions & { tokens: readonly string[] }) {
    super(opts);
    if (opts.tokens.length === 0) throw new Error('TokenAuthorizer needs at least one token');
    this.digests = opts.tokens.map(digest);
  }

  override authenticate(hello: HelloMsg): boolean {
    if (hello.token === undefined) return false;
    const d = digest(hello.token);
    // Compare every token in constant time.
    let ok = false;
    for (const t of this.digests) ok = timingSafeEqual(d, t) || ok;
    return ok;
  }
}

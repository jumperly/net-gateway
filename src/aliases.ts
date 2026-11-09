import { NET_DOMAIN } from '@jumperly/schema';

/**
 * Where a gateway alias leads. Aliases come from trusted configuration and bypass the policy (a
 * test server on 127.0.0.1, a compose service by name).
 * - `tcp`: a TCP flow to `host` (a name is resolved here, unlike a host in `open`) and `port`,
 *   or the port the client asked for when `port` is omitted.
 * - `mqtt`: a flow handled by the MQTT broker of the session's namespace, not a socket.
 */
export type AliasTarget = { kind: 'tcp'; host: string; port?: number } | { kind: 'mqtt' };

export interface Alias {
  /** The canonical name: lower case, no trailing dot. */
  name: string;
  target: AliasTarget;
}

/** Lower case without one trailing dot: `ECHO.Jumperly.Internal.` → `echo.jumperly.internal`. */
export function aliasKey(name: string): string {
  const lower = name.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The gateway's aliases, all inside the reserved zone `jumperly.internal`. */
export class Aliases {
  private readonly map = new Map<string, AliasTarget>();

  constructor(entries: Record<string, AliasTarget> = {}) {
    for (const [name, target] of Object.entries(entries)) this.add(name, target);
  }

  /** A copy with one more alias (the MQTT broker's name when MQTT is on). */
  with(name: string, target: AliasTarget): Aliases {
    const copy = new Aliases();
    for (const [n, t] of this.map) copy.map.set(n, t);
    copy.add(name, target);
    return copy;
  }

  get(host: string): Alias | undefined {
    const name = aliasKey(host);
    const target = this.map.get(name);
    return target ? { name, target } : undefined;
  }

  /** The canonical names, in configuration order. */
  names(): string[] {
    return [...this.map.keys()];
  }

  private add(name: string, target: AliasTarget): void {
    const key = aliasKey(name);
    const labels = key.split('.');
    if (!key.endsWith(`.${NET_DOMAIN}`) || !labels.every((l) => LABEL.test(l)) || key.length > 253)
      throw new Error(`alias "${name}" must be a host name in the zone ${NET_DOMAIN}`);
    if (this.map.has(key)) throw new Error(`alias "${name}" is declared twice`);
    this.map.set(key, target);
  }
}

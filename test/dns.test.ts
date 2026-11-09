import { describe, expect, it } from 'vitest';
import { Aliases } from '../src/aliases';
import { type DnsBackend, type DnsRecord, DnsResolver } from '../src/dns';

function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** A backend with a fixed zone; counts the queries. */
function zone(records: Record<string, DnsRecord[] | string>) {
  const calls: string[] = [];
  const backend: DnsBackend = {
    async resolve(name, type) {
      calls.push(`${type} ${name}`);
      const r = records[`${type} ${name}`];
      if (r === undefined) throw dnsError('ENOTFOUND');
      if (typeof r === 'string') throw dnsError(r);
      return r;
    },
  };
  return { backend, calls };
}

const aliases = new Aliases({
  'echo.jumperly.internal': { kind: 'tcp', host: '127.0.0.1', port: 7 },
});

describe('DnsResolver', () => {
  it('answers and caches for min(ttl, 300 s)', async () => {
    let now = 1_000_000;
    const { backend, calls } = zone({
      'A example.com': [
        { address: '93.184.215.14', ttl: 120 },
        { address: '93.184.215.15', ttl: 60 },
      ],
      'A long.example': [{ address: '1.2.3.4', ttl: 86_400 }],
    });
    const dns = new DnsResolver({ backend, aliases, now: () => now });

    expect(await dns.resolve('example.com', 'A')).toEqual({
      addrs: ['93.184.215.14', '93.184.215.15'],
      ttl: 60,
    });
    now += 20_000;
    expect(await dns.resolve('Example.COM.', 'A')).toEqual({
      addrs: ['93.184.215.14', '93.184.215.15'],
      ttl: 40,
    });
    expect(calls).toEqual(['A example.com']);
    now += 41_000;
    await dns.resolve('example.com', 'A');
    expect(calls).toEqual(['A example.com', 'A example.com']);

    expect(await dns.resolve('long.example', 'A')).toEqual({ addrs: ['1.2.3.4'], ttl: 300 });
    now += 299_000;
    expect(await dns.resolve('long.example', 'A')).toEqual({ addrs: ['1.2.3.4'], ttl: 1 });
    now += 1_000;
    await dns.resolve('long.example', 'A');
    expect(calls.filter((c) => c === 'A long.example')).toHaveLength(2);
  });

  it('evicts the least recently used entry past the cache size', async () => {
    const records: Record<string, DnsRecord[]> = {};
    for (const n of ['a', 'b', 'c']) records[`A ${n}.test`] = [{ address: '1.1.1.1', ttl: 100 }];
    const { backend, calls } = zone(records);
    const dns = new DnsResolver({ backend, aliases, maxEntries: 2 });
    await dns.resolve('a.test', 'A');
    await dns.resolve('b.test', 'A');
    await dns.resolve('a.test', 'A'); // a is now the most recent
    await dns.resolve('c.test', 'A'); // evicts b
    await dns.resolve('a.test', 'A');
    await dns.resolve('b.test', 'A');
    expect(calls).toEqual(['A a.test', 'A b.test', 'A c.test', 'A b.test']);
  });

  it('shares one query between concurrent lookups of a name', async () => {
    const { backend, calls } = zone({ 'A x.test': [{ address: '1.1.1.1', ttl: 10 }] });
    const dns = new DnsResolver({ backend, aliases });
    await Promise.all([dns.resolve('x.test', 'A'), dns.resolve('x.test', 'A')]);
    expect(calls).toEqual(['A x.test']);
  });

  it('times out after the timeout as `timeout`', async () => {
    const backend: DnsBackend = { resolve: () => new Promise(() => {}) };
    const dns = new DnsResolver({ backend, aliases, timeoutMs: 50 });
    const t0 = Date.now();
    expect(await dns.resolve('slow.test', 'A')).toEqual({ code: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('maps resolver errors to the protocol codes', async () => {
    const { backend } = zone({
      'A servfail.test': 'ESERVFAIL',
      'A refused.test': 'EREFUSED',
      'A timeout.test': 'ETIMEOUT',
      'A empty.test': 'ENODATA',
    });
    const dns = new DnsResolver({ backend, aliases });
    expect(await dns.resolve('missing.test', 'A')).toEqual({ code: 'nxdomain' });
    expect(await dns.resolve('servfail.test', 'A')).toEqual({ code: 'servfail' });
    expect(await dns.resolve('refused.test', 'A')).toEqual({ code: 'servfail' });
    expect(await dns.resolve('timeout.test', 'A')).toEqual({ code: 'timeout' });
    expect(await dns.resolve('empty.test', 'A')).toEqual({ addrs: [], ttl: 0 });
  });

  it('does not cache failures', async () => {
    const { backend, calls } = zone({});
    const dns = new DnsResolver({ backend, aliases });
    await dns.resolve('missing.test', 'A');
    await dns.resolve('missing.test', 'A');
    expect(calls).toHaveLength(2);
  });

  it('answers an alias itself, without a query', async () => {
    const { backend, calls } = zone({});
    const dns = new DnsResolver({ backend, aliases });
    expect(await dns.resolve('ECHO.jumperly.internal.', 'A')).toEqual({
      addrs: [],
      ttl: 300,
      alias: true,
    });
    expect(await dns.resolve('nope.jumperly.internal', 'A')).toEqual({ code: 'nxdomain' });
    expect(calls).toEqual([]);
  });

  it('returns private answers as they are (the policy refuses them at open)', async () => {
    const { backend } = zone({
      'A rebind.test': [{ address: '127.0.0.1', ttl: 1 }],
      'AAAA rebind.test': [{ address: '::1', ttl: 1 }],
      'A lan.test': [{ address: '192.168.1.10', ttl: 30 }],
    });
    const dns = new DnsResolver({ backend, aliases });
    expect(await dns.resolve('rebind.test', 'A')).toEqual({ addrs: ['127.0.0.1'], ttl: 1 });
    expect(await dns.resolve('rebind.test', 'AAAA')).toEqual({ addrs: ['::1'], ttl: 1 });
    expect(await dns.resolve('lan.test', 'A')).toEqual({ addrs: ['192.168.1.10'], ttl: 30 });
  });

  it('refuses a name that is not a DNS name', async () => {
    const { backend, calls } = zone({});
    const dns = new DnsResolver({ backend, aliases });
    expect(await dns.resolve('bad name', 'A')).toEqual({ code: 'nxdomain' });
    expect(await dns.resolve(`${'a'.repeat(64)}.test`, 'A')).toEqual({ code: 'nxdomain' });
    expect(calls).toEqual([]);
  });
});

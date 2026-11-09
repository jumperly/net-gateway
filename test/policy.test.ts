import { describe, expect, it } from 'vitest';
import { Aliases } from '../src/aliases';
import { Policy, canonicalIp, embeddedIpv4, isBlockedIp } from '../src/policy';

const aliases = new Aliases({
  'echo.jumperly.internal': { kind: 'tcp', host: '127.0.0.1', port: 7 },
});
const policy = new Policy({ tcpPorts: [80, 443, 1883, 8883, 8080], udpPorts: [], aliases });
const udpPolicy = new Policy({ tcpPorts: [80], udpPorts: [53, 123], aliases });

describe('forbidden ranges', () => {
  // One address at each edge of every blocked range, plus the well-known SSRF targets.
  const blocked = [
    '0.0.0.0',
    '0.255.255.255',
    '10.0.0.0',
    '10.255.255.255',
    '100.64.0.0',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '127.255.255.255',
    '169.254.0.0',
    '169.254.169.254',
    '169.254.255.255',
    '172.16.0.0',
    '172.17.0.1',
    '172.31.255.255',
    '192.0.0.0',
    '192.0.0.255',
    '192.0.2.0',
    '192.0.2.255',
    '192.88.99.0',
    '192.88.99.255',
    '192.168.0.0',
    '192.168.65.254',
    '192.168.255.255',
    '198.18.0.0',
    '198.19.255.255',
    '198.51.100.0',
    '198.51.100.255',
    '203.0.113.0',
    '203.0.113.255',
    '224.0.0.0',
    '239.255.255.255',
    '240.0.0.0',
    '255.255.255.254',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::',
    'fd12:3456::1',
    'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    'fe80::',
    'fe80::1',
    'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    'fec0::1',
    'feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    'ff00::',
    'ff02::1',
    '100::',
    '100::ffff:ffff:ffff:ffff',
    '2001::',
    '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2001:db8::',
    '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '64:ff9b::7f00:1',
    '64:ff9b::a00:1',
    '2002:7f00:1::',
    '2002:c0a8:101::1',
  ];
  it.each(blocked)('%s is blocked', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  const allowed = [
    '1.1.1.1',
    '8.8.8.8',
    '9.255.255.255',
    '11.0.0.0',
    '93.184.215.14',
    '100.63.255.255',
    '100.128.0.0',
    '126.255.255.255',
    '128.0.0.0',
    '169.253.255.255',
    '172.15.255.255',
    '172.32.0.0',
    '192.0.1.0',
    '192.0.3.0',
    '192.88.98.255',
    '192.169.0.0',
    '198.17.255.255',
    '198.20.0.0',
    '223.255.255.255',
    '2606:4700:4700::1111',
    '2a00:1450:4001:80b::200e',
    '2001:200::1',
    '2001:db9::1',
    '::ffff:5db8:d70e',
    '64:ff9b::5db8:d70e',
    '2002:5db8:d70e::1',
  ];
  it.each(allowed)('%s is allowed', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it('extracts the embedded IPv4 of the mapped, NAT64 and 6to4 forms', () => {
    expect(embeddedIpv4('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(embeddedIpv4('64:ff9b::7f00:1')).toBe('127.0.0.1');
    expect(embeddedIpv4('2002:7f00:1::')).toBe('127.0.0.1');
    expect(embeddedIpv4('2606:4700:4700::1111')).toBeUndefined();
  });
});

describe('canonical literals', () => {
  it.each([
    ['93.184.215.14', '93.184.215.14'],
    ['::1', '::1'],
    ['2606:4700:4700::1111', '2606:4700:4700::1111'],
    ['::ffff:127.0.0.1', '::ffff:127.0.0.1'],
    ['::ffff:7f00:1', '::ffff:7f00:1'],
  ])('%s is canonical', (host, ip) => {
    expect(canonicalIp(host)?.ip).toBe(ip);
  });

  it.each([
    '127.1',
    '0x7f.0.0.1',
    '2130706433',
    '017700000001',
    '0177.0.0.1',
    '127.000.000.001',
    '[::1]',
    '0:0:0:0:0:0:0:1',
    '::0001',
    '2606:4700:4700:0:0:0:0:1111',
    '2A00:1450::1',
    'fe80::1%eth0',
    '64:ff9b::127.0.0.1',
    ' 1.1.1.1',
    'localhost',
  ])('%s is not canonical', (host) => {
    expect(canonicalIp(host)).toBeNull();
  });
});

describe('checkTarget', () => {
  const code = (p: Policy, host: string, port: number, proto: 'tcp' | 'udp' = 'tcp') => {
    const v = p.check(host, port, proto);
    return v.ok ? 'ok' : v.code;
  };

  it('allows a public address on a whitelisted port', () => {
    const v = policy.check('93.184.215.14', 80, 'tcp');
    expect(v).toEqual({
      ok: true,
      target: { kind: 'ip', ip: '93.184.215.14', family: 4, port: 80 },
    });
    expect(code(policy, '2606:4700:4700::1111', 443)).toBe('ok');
  });

  it.each([
    '169.254.169.254',
    '100.64.0.1',
    '172.17.0.1',
    '192.168.65.254',
    '127.0.0.1',
    '10.0.2.2',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
  ])('%s → policy.private', (host) => {
    expect(code(policy, host, 80)).toBe('policy.private');
  });

  it.each([
    '127.1',
    '0x7f.0.0.1',
    '2130706433',
    '017700000001',
    '[::1]',
    '0:0:0:0:0:0:0:1',
    'fe80::1%eth0',
    'localhost',
    'host.docker.internal',
    'metadata.google.internal',
    'example.com',
    'mqtt.jumperly.internal',
    'other.jumperly.internal',
  ])('%s → policy.host', (host) => {
    expect(code(policy, host, 80)).toBe('policy.host');
  });

  it.each([0, 22, 25, 65536, 8081, -1, 80.5])('port %s → policy.port', (port) => {
    expect(code(policy, '93.184.215.14', port)).toBe('policy.port');
  });

  it('UDP with no UDP ports → policy.proto', () => {
    expect(code(policy, '93.184.215.14', 53, 'udp')).toBe('policy.proto');
  });

  it('UDP ports are their own whitelist', () => {
    expect(code(udpPolicy, '93.184.215.14', 53, 'udp')).toBe('ok');
    expect(code(udpPolicy, '93.184.215.14', 80, 'udp')).toBe('policy.port');
    expect(code(udpPolicy, '93.184.215.14', 53, 'tcp')).toBe('policy.port');
    expect(code(udpPolicy, '127.0.0.1', 53, 'udp')).toBe('policy.private');
  });

  it('aliases bypass the policy, in any case and with a trailing dot', () => {
    for (const host of [
      'echo.jumperly.internal',
      'ECHO.Jumperly.Internal',
      'echo.jumperly.internal.',
    ]) {
      const v = policy.check(host, 22, 'tcp');
      expect(v.ok && v.target.kind === 'alias' && v.target.alias.name).toBe(
        'echo.jumperly.internal',
      );
    }
  });

  it('a TCP alias refuses UDP', () => {
    expect(code(udpPolicy, 'echo.jumperly.internal', 53, 'udp')).toBe('policy.proto');
  });

  it('allowCidrs (test only) opens a forbidden range', () => {
    const p = new Policy({ tcpPorts: [80], udpPorts: [], aliases, allowCidrs: ['127.0.0.0/8'] });
    expect(code(p, '127.0.0.1', 80)).toBe('ok');
    expect(code(p, '10.0.0.1', 80)).toBe('policy.private');
    expect(p.remoteAllowed('127.0.0.1')).toBe(true);
    expect(policy.remoteAllowed('127.0.0.1')).toBe(false);
    expect(policy.remoteAllowed('::ffff:127.0.0.1')).toBe(false);
    expect(policy.remoteAllowed('93.184.215.14')).toBe(true);
  });
});

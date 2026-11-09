import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig } from '../src/config';

const MiB = 1024 * 1024;

describe('loadConfig', () => {
  it('defaults to loopback on 127.0.0.1:3002', () => {
    const { config, warnings } = loadConfig({});
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 3002,
      tcpPorts: [80, 443, 1883, 8883, 8080],
      udpPorts: [],
      limits: {
        maxConns: 8,
        connPerMin: 30,
        bytesPerSec: 256 * 1024,
        totalBytes: 64 * MiB,
        sessionsPerIp: 4,
      },
      timeouts: {
        helloMs: 5_000,
        connectMs: 10_000,
        tcpIdleMs: 300_000,
        sessionIdleMs: 600_000,
        pingMs: 20_000,
      },
      mqtt: { enabled: true, shared: false, debugPort: 0, idleMs: 600_000 },
    });
    expect(warnings).toEqual([]);
  });

  it('reads INTERNAL_TOKEN and rejects a short one', () => {
    expect(loadConfig({}).config.internalToken).toBeUndefined();
    expect(loadConfig({ INTERNAL_TOKEN: '' }).config.internalToken).toBeUndefined();
    expect(loadConfig({ INTERNAL_TOKEN: 'x'.repeat(16) }).config.internalToken).toBe(
      'x'.repeat(16),
    );
    expect(() => loadConfig({ INTERNAL_TOKEN: 'short' })).toThrow(/INTERNAL_TOKEN/);
  });

  it('the helper lets in the production app and the second dev server (:5174); the server gateway does not', () => {
    const helper = loadConfig({ NETGW_MODE: 'helper' }).config;
    expect(helper.origins).toEqual(
      expect.arrayContaining([
        'https://app.jumperly.dev',
        'http://localhost:5174',
        'http://127.0.0.1:5174',
        'http://localhost:5173',
      ]),
    );
    expect(loadConfig({}).config.origins).not.toContain('http://localhost:5174');
    expect(loadConfig({}).config.origins).not.toContain('https://app.jumperly.dev');
  });

  it('reads NETGW_* variables over the JSON file over the defaults', () => {
    const file = JSON.stringify({
      port: 4000,
      limits: { maxConns: 2, connPerMin: 5 },
      aliases: { 'echo.jumperly.internal': { kind: 'tcp', host: 'echo', port: 7 } },
      allowCidrs: ['127.0.0.0/8'],
      mqtt: { idleMs: 1000 },
    });
    const { config, warnings } = loadConfig(
      {
        NETGW_CONFIG: '/etc/netgw.json',
        NETGW_HOST: '0.0.0.0',
        NETGW_ORIGINS: 'https://jumperly.dev, http://localhost:5173',
        NETGW_UDP_PORTS: '53,123',
        NETGW_MAX_CONNS: '3',
        NETGW_TOKENS: 'a,b',
        NETGW_MQTT: '0',
        NETGW_MQTT_DEBUG_PORT: '1884',
      },
      (path) => {
        expect(path).toBe('/etc/netgw.json');
        return file;
      },
    );
    expect(config.port).toBe(4000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.origins).toEqual(['https://jumperly.dev', 'http://localhost:5173']);
    expect(config.udpPorts).toEqual([53, 123]);
    expect(config.limits).toMatchObject({ maxConns: 3, connPerMin: 5, bytesPerSec: 256 * 1024 });
    expect(config.aliases).toEqual({
      'echo.jumperly.internal': { kind: 'tcp', host: 'echo', port: 7 },
    });
    expect(config.tokens).toEqual(['a', 'b']);
    expect(config.mqtt).toEqual({ enabled: false, shared: false, debugPort: 1884, idleMs: 1000 });
    expect(warnings.join('\n')).toMatch(/allowCidrs.*TEST ONLY/);
  });

  it('reads the MQTT variables; the shared broker warns', () => {
    const { config, warnings } = loadConfig({
      NETGW_MQTT_SHARED: '1',
      NETGW_MQTT_IDLE_MS: '5000',
    });
    expect(config.mqtt).toEqual({ enabled: true, shared: true, debugPort: 0, idleMs: 5000 });
    expect(warnings.join('\n')).toMatch(/NETGW_MQTT_SHARED/);
  });

  it('warns about a public host without tokens', () => {
    const { warnings } = loadConfig({ NETGW_HOST: '0.0.0.0' });
    expect(warnings.join('\n')).toMatch(/without NETGW_TOKENS/);
  });

  it.each([
    [{ NETGW_PORT: '70000' }, /NETGW_PORT/],
    [{ NETGW_TCP_PORTS: '80,abc' }, /NETGW_TCP_PORTS/],
    [{ NETGW_BYTES_PER_SEC: '0' }, /NETGW_BYTES_PER_SEC/],
    [{ NETGW_TRUST_PROXY: 'maybe' }, /NETGW_TRUST_PROXY/],
    [{ NETGW_MQTT_DEBUG_PORT: '1884x' }, /NETGW_MQTT_DEBUG_PORT/],
    [{ NETGW_MQTT_IDLE_MS: '0' }, /NETGW_MQTT_IDLE_MS/],
  ])('rejects %o', (env, error) => {
    expect(() => loadConfig(env)).toThrow(error);
  });

  it('rejects an unknown field of the JSON file', () => {
    expect(() => loadConfig({ NETGW_CONFIG: 'x.json' }, () => '{"limits":{"maxConn":1}}')).toThrow(
      /NETGW_CONFIG x\.json: limits/,
    );
    expect(() => loadConfig({ NETGW_CONFIG: 'x.json' }, () => '{oops')).toThrow(/NETGW_CONFIG/);
  });
});

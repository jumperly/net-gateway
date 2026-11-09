import { afterEach, describe, expect, it } from 'vitest';
import { GatewayStatsSchema } from '../src/protocol';
import type { Session } from '../src/session';
import { type Gateway, startGateway } from './helpers';

const token = 'internal-token-0123456789';
let gw: Gateway | undefined;
afterEach(async () => gw?.close());

const get = (g: Gateway, headers?: Record<string, string>) =>
  g.app.inject({ method: 'GET', url: '/api/net/internal/stats', headers });

describe('GET /api/net/internal/stats', () => {
  it('answers 404 without a configured token', async () => {
    gw = await startGateway();
    expect((await get(gw)).statusCode).toBe(404);
    expect((await get(gw, { 'x-internal-token': token })).statusCode).toBe(404);
    expect((await get(gw, { 'x-internal-token': '' })).statusCode).toBe(404);
  });

  it('answers 404 for a missing, wrong or differently long token', async () => {
    gw = await startGateway({ internalToken: token });
    expect((await get(gw)).statusCode).toBe(404);
    expect((await get(gw, { 'x-internal-token': 'x'.repeat(token.length) })).statusCode).toBe(404);
    expect((await get(gw, { 'x-internal-token': `${token}0` })).statusCode).toBe(404);
    expect((await get(gw, { 'x-internal-token': token.slice(1) })).statusCode).toBe(404);
  });

  it('returns zeros with no sessions', async () => {
    gw = await startGateway({ internalToken: token });
    const r = await get(gw, { 'x-internal-token': token });
    expect(r.statusCode).toBe(200);
    expect(GatewayStatsSchema.parse(r.json())).toEqual({
      sessions: 0,
      flows: 0,
      bytesUp: 0,
      bytesDown: 0,
    });
  });

  it('sums the stats of the live sessions', async () => {
    gw = await startGateway({ internalToken: token });
    const fake = (flows: number, up: number, down: number) =>
      ({ stats: { peakPending: 0, peakBuffered: 0, flows, up, down } }) as unknown as Session;
    gw.app.netGateway.sessions.add(fake(2, 100, 400));
    gw.app.netGateway.sessions.add(fake(3, 50, 25));
    const r = await get(gw, { 'x-internal-token': token });
    expect(GatewayStatsSchema.parse(r.json())).toEqual({
      sessions: 2,
      flows: 5,
      bytesUp: 150,
      bytesDown: 425,
    });
    gw.app.netGateway.sessions.clear();
  });

  it('leaves the health route open', async () => {
    gw = await startGateway({ internalToken: token });
    const r = await gw.app.inject({ method: 'GET', url: '/api/net/health' });
    expect(r.json()).toEqual({ ok: true });
  });
});

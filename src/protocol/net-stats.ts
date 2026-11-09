import { z } from 'zod';

/** What a network gateway reports on `GET /api/net/internal/stats` (behind `INTERNAL_TOKEN`). */
export const GatewayStatsSchema = z.object({
  sessions: z.number().int(),
  flows: z.number().int(),
  bytesUp: z.number(),
  bytesDown: z.number(),
});
export type GatewayStats = z.infer<typeof GatewayStatsSchema>;

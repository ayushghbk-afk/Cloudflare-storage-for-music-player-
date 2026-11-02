import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { clientIp, hashIp, readJson } from '../utils/http';
import { enforceRateLimit } from '../utils/ratelimit';
import { resolveUser } from '../auth/middleware';

/**
 * Playback telemetry.
 *
 * Players (web `<audio>` and Android Media3) report failures here; the admin
 * dashboard surfaces the counts and the last messages. Writes are best-effort and
 * rate limited so a broken client cannot flood D1.
 */
export const playbackRoutes = new Hono<AppEnv>();

const errorSchema = z.strictObject({
  trackId: z.string().min(3).max(64).optional(),
  code: z.string().trim().max(64).optional(),
  message: z.string().trim().max(1000).optional(),
  platform: z.enum(['web', 'android', 'ios', 'desktop', 'other']).optional(),
});

playbackRoutes.post('/errors', async (c) => {
  const logger = c.get('logger');
  const ipHash = hashIp(clientIp(c));

  await enforceRateLimit(c.env.DB, { bucket: 'playback:error', subject: `ip:${ipHash}`, limit: 60, windowSeconds: 600 }, logger);

  const body = await readJson(c, errorSchema);
  const user = await resolveUser(c);

  let trackId = body.trackId ?? null;
  let providerId: string | null = null;
  if (trackId) {
    // A player can report a failure for a track that has since been removed
    // (or never existed on this server). Keep the telemetry, but never insert a
    // dangling foreign key — the diagnostic value is in the message, not the id.
    const track = await c.env.DB.prepare('SELECT id FROM tracks WHERE id = ?').bind(trackId).first<{ id: string }>();
    if (track) {
      const row = await c.env.DB.prepare(
        `SELECT o.provider_id
           FROM storage_objects o
          WHERE o.track_id = ? AND o.role = 'audio' AND o.is_primary = 1`
      )
        .bind(trackId)
        .first<{ provider_id: string }>();
      providerId = row?.provider_id ?? null;
    } else {
      trackId = null;
    }
  }

  await c.env.DB.prepare(
    'INSERT INTO playback_errors (track_id, user_id, platform, code, message, provider_id) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(trackId, user?.id ?? null, body.platform ?? null, body.code ?? null, body.message ?? null, providerId)
    .run();

  logger.warn('playback_error_reported', { trackId, reportedTrackId: body.trackId ?? null, code: body.code, platform: body.platform });
  return c.json({ ok: true }, 202);
});

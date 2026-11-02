import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { conflict, notFound } from '../utils/errors';
import { clientIp, hashIp, noStoreHeaders, readJson } from '../utils/http';
import { enforceRateLimit } from '../utils/ratelimit';
import { newId } from '../utils/ids';
import { requireUser } from '../auth/middleware';

/**
 * Public-facing moderation surface: letting listeners report a track.
 * Reviewing those reports is an admin concern (see admin/moderation.ts).
 */
export const reportRoutes = new Hono<AppEnv>();

const reportSchema = z.strictObject({
  reason: z.enum(['copyright', 'explicit', 'spam', 'malware', 'impersonation', 'quality', 'other']),
  details: z.string().trim().max(2000).optional(),
});

/** POST /api/tracks/:id/report */
reportRoutes.post('/:id/report', async (c) => {
  const user = await requireUser(c);
  const logger = c.get('logger');
  const ipHash = hashIp(clientIp(c));

  await enforceRateLimit(c.env.DB, { bucket: 'track:report', subject: `user:${user.id}`, limit: 10, windowSeconds: 3600 }, logger);

  const body = await readJson(c, reportSchema);
  const trackId = c.req.param('id');

  const track = await c.env.DB.prepare('SELECT id FROM tracks WHERE id = ? AND is_deleted = 0')
    .bind(trackId)
    .first<{ id: string }>();
  if (!track) throw notFound('Track not found.');

  const existing = await c.env.DB.prepare(
    "SELECT id FROM moderation_reports WHERE track_id = ? AND reporter_user_id = ? AND status = 'open'"
  )
    .bind(trackId, user.id)
    .first<{ id: string }>();
  if (existing) throw conflict('You have already reported this track. A moderator will review it.');

  const id = newId('rpt');
  await c.env.DB.prepare(
    `INSERT INTO moderation_reports (id, track_id, reporter_user_id, reporter_ip_hash, reason, details)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, trackId, user.id, ipHash, body.reason, body.details ?? null)
    .run();

  logger.info('track_reported', { reportId: id, trackId, reason: body.reason });
  return c.json({ ok: true, reportId: id, status: 'open' }, 201, noStoreHeaders());
});

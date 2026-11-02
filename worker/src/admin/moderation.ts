import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { conflict, notFound } from '../utils/errors';
import { pagination, readJson } from '../utils/http';
import { writeAudit } from '../utils/audit';
import { requireAdmin, requireStaff } from '../auth/middleware';
import { getProviderById, requireAdapter } from '../storage/registry';
import { MODERATED_TRACK_SELECT, serializeModeratedTrack, type TrackRowJoined } from '../catalog/serialize';

/** Moderation queue, review decisions and takedowns. */
export const adminModerationRoutes = new Hono<AppEnv>();

const rejectSchema = z.strictObject({
  reason: z.string().trim().min(5).max(500),
});

const removeSchema = z.strictObject({
  reason: z.string().trim().min(5).max(500),
  /** Explicitly deleting bytes is irreversible; the DB row is always soft-deleted. */
  deleteFiles: z.boolean(),
});

const resolveSchema = z.strictObject({
  status: z.enum(['resolved', 'dismissed']),
  note: z.string().trim().max(2000).optional(),
  /** Optional follow-up action on the reported track. */
  action: z.enum(['none', 'unpublish', 'remove']).optional(),
  deleteFiles: z.boolean().optional(),
});

/** GET /api/admin/tracks?status=pending|approved|rejected|removed */
adminModerationRoutes.get('/tracks', async (c) => {
  await requireStaff(c);
  const { limit, offset } = pagination(c, { limit: 50 });
  const status = c.req.query('status');
  const statuses = ['pending', 'approved', 'rejected', 'removed'];

  const where: string[] = ['t.is_deleted = ?'];
  const bindings: unknown[] = [status === 'removed' ? 1 : 0];
  if (status && statuses.includes(status)) {
    where.push('t.status = ?');
    bindings.push(status);
  }
  if (c.req.query('reported') === '1') {
    where.push("EXISTS (SELECT 1 FROM moderation_reports r WHERE r.track_id = t.id AND r.status = 'open')");
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const rows = await c.env.DB.prepare(
    `${MODERATED_TRACK_SELECT} ${whereSql} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(...bindings, limit, offset)
    .all<TrackRowJoined>();

  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM tracks t ${whereSql}`)
    .bind(...bindings)
    .first<{ count: number }>();

  return c.json({
    tracks: (rows.results ?? []).map(serializeModeratedTrack),
    pagination: { total: total?.count ?? 0, limit, offset },
  });
});

/** POST /api/admin/tracks/:id/approve — publishes a track to the public library. */
adminModerationRoutes.post('/tracks/:id/approve', async (c) => {
  const user = await requireStaff(c);
  const trackId = c.req.param('id');

  const track = await c.env.DB.prepare(
    'SELECT id, title, status, rights_confirmed, is_deleted FROM tracks WHERE id = ?'
  )
    .bind(trackId)
    .first<{ id: string; title: string; status: string; rights_confirmed: number; is_deleted: number }>();
  if (!track) throw notFound('Track not found.');
  if (track.is_deleted === 1) throw conflict('This track has been removed and cannot be approved.');

  if (track.rights_confirmed !== 1) {
    throw conflict(
      'This track has no recorded distribution-rights confirmation and cannot be published. Reject it or ask the uploader to re-upload with rights confirmation.'
    );
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE tracks
        SET status = 'approved', visibility = 'public', published_at = COALESCE(published_at, ?),
            reviewed_by = ?, reviewed_at = ?, rejection_reason = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  )
    .bind(now, user.id, now, track.id)
    .run();

  await c.env.DB.prepare(
    "UPDATE upload_jobs SET status = 'published', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE track_id = ? AND status = 'awaiting_review'"
  )
    .bind(track.id)
    .run();

  await writeAudit(
    c.env.DB,
    {
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'track.approved',
      targetType: 'track',
      targetId: track.id,
      metadata: { title: track.title, previousStatus: track.status },
    },
    c.get('logger')
  );

  const updated = await c.env.DB.prepare(`${MODERATED_TRACK_SELECT} WHERE t.id = ?`)
    .bind(track.id)
    .first<TrackRowJoined>();
  return c.json({ track: updated ? serializeModeratedTrack(updated) : null });
});

/** POST /api/admin/tracks/:id/reject */
adminModerationRoutes.post('/tracks/:id/reject', async (c) => {
  const user = await requireStaff(c);
  const body = await readJson(c, rejectSchema);
  const trackId = c.req.param('id');

  const track = await c.env.DB.prepare('SELECT id, title FROM tracks WHERE id = ? AND is_deleted = 0')
    .bind(trackId)
    .first<{ id: string; title: string }>();
  if (!track) throw notFound('Track not found.');

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE tracks
        SET status = 'rejected', visibility = 'private', rejection_reason = ?, reviewed_by = ?, reviewed_at = ?,
            published_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  )
    .bind(body.reason, user.id, now, track.id)
    .run();

  await c.env.DB.prepare(
    "UPDATE upload_jobs SET status = 'rejected', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE track_id = ? AND status IN ('awaiting_review','published')"
  )
    .bind(track.id)
    .run();

  await writeAudit(
    c.env.DB,
    {
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'track.rejected',
      targetType: 'track',
      targetId: track.id,
      metadata: { title: track.title, reason: body.reason },
    },
    c.get('logger')
  );

  const updated = await c.env.DB.prepare(`${MODERATED_TRACK_SELECT} WHERE t.id = ?`)
    .bind(track.id)
    .first<TrackRowJoined>();
  return c.json({ track: updated ? serializeModeratedTrack(updated) : null });
});

/**
 * POST /api/admin/tracks/:id/remove
 *
 * Takes content out of the library. The database row is always soft-deleted
 * (audit trail, playlists, ownership history); deleting the stored bytes is
 * explicit and irreversible.
 */
adminModerationRoutes.post('/tracks/:id/remove', async (c) => {
  const user = await requireAdmin(c);
  const body = await readJson(c, removeSchema);
  const logger = c.get('logger');
  const trackId = c.req.param('id');

  const track = await c.env.DB.prepare('SELECT id, title FROM tracks WHERE id = ? AND is_deleted = 0')
    .bind(trackId)
    .first<{ id: string; title: string }>();
  if (!track) throw notFound('Track not found.');

  const objects = await c.env.DB.prepare(
    "SELECT id, provider_id, object_key FROM storage_objects WHERE track_id = ? AND status = 'active'"
  )
    .bind(track.id)
    .all<{ id: string; provider_id: string; object_key: string }>();

  const failures: { objectId: string; reason: string }[] = [];
  if (body.deleteFiles) {
    for (const object of objects.results ?? []) {
      try {
        const provider = await getProviderById(c.env.DB, object.provider_id);
        if (!provider) throw new Error('provider row missing');
        await requireAdapter(c.env, provider).delete(object.object_key);
        await c.env.DB.prepare(
          "UPDATE storage_objects SET status = 'deleted', is_primary = 0, last_checked_at = ? WHERE id = ?"
        )
          .bind(new Date().toISOString(), object.id)
          .run();
      } catch (error) {
        failures.push({ objectId: object.id, reason: error instanceof Error ? error.message : String(error) });
        logger.error('takedown_delete_failed', { trackId: track.id, objectId: object.id, error });
      }
    }
  }

  await c.env.DB.prepare(
    `UPDATE tracks
        SET is_deleted = 1, status = 'removed', visibility = 'private', published_at = NULL,
            rejection_reason = ?, reviewed_by = ?, reviewed_at = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  )
    .bind(body.reason, user.id, new Date().toISOString(), track.id)
    .run();

  await c.env.DB.prepare(
    "UPDATE upload_jobs SET status = 'rejected', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE track_id = ?"
  )
    .bind(track.id)
    .run();

  await writeAudit(
    c.env.DB,
    {
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'track.removed',
      targetType: 'track',
      targetId: track.id,
      metadata: { title: track.title, reason: body.reason, deleteFiles: body.deleteFiles, failures: failures.length },
    },
    logger
  );

  return c.json({
    ok: true,
    trackId: track.id,
    filesDeleted: body.deleteFiles,
    deletionFailures: failures,
  });
});

/** GET /api/admin/reports?status=open */
adminModerationRoutes.get('/reports', async (c) => {
  await requireStaff(c);
  const { limit, offset } = pagination(c, { limit: 50 });
  const status = c.req.query('status') ?? 'open';

  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.track_id, r.reason, r.details, r.status, r.created_at, r.resolved_at, r.resolution_note,
            r.reporter_user_id, u.display_name AS reporter_name,
            t.title AS track_title, t.status AS track_status, t.visibility AS track_visibility, t.uploader_id
       FROM moderation_reports r
       LEFT JOIN users u ON u.id = r.reporter_user_id
       LEFT JOIN tracks t ON t.id = r.track_id
      WHERE r.status = ?
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?`
  )
    .bind(status, limit, offset)
    .all<Record<string, unknown>>();

  const total = await c.env.DB.prepare('SELECT COUNT(*) AS count FROM moderation_reports WHERE status = ?')
    .bind(status)
    .first<{ count: number }>();

  return c.json({
    reports: (rows.results ?? []).map((row) => ({
      id: row.id,
      trackId: row.track_id,
      trackTitle: row.track_title,
      trackStatus: row.track_status,
      trackVisibility: row.track_visibility,
      uploaderId: row.uploader_id,
      reason: row.reason,
      details: row.details,
      status: row.status,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      resolutionNote: row.resolution_note,
      reporter: row.reporter_user_id ? { id: row.reporter_user_id, name: row.reporter_name } : null,
    })),
    pagination: { total: total?.count ?? 0, limit, offset },
  });
});

/** POST /api/admin/reports/:id/resolve */
adminModerationRoutes.post('/reports/:id/resolve', async (c) => {
  const user = await requireStaff(c);
  const body = await readJson(c, resolveSchema);
  const reportId = c.req.param('id');

  const report = await c.env.DB.prepare('SELECT id, track_id, status FROM moderation_reports WHERE id = ?')
    .bind(reportId)
    .first<{ id: string; track_id: string; status: string }>();
  if (!report) throw notFound('Report not found.');
  if (report.status !== 'open') throw conflict('This report has already been resolved.');

  if (body.action === 'remove') {
    await requireAdmin(c);
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    'UPDATE moderation_reports SET status = ?, resolution_note = ?, resolved_by = ?, resolved_at = ? WHERE id = ?'
  )
    .bind(body.status, body.note ?? null, user.id, now, report.id)
    .run();

  let trackAction: string | null = null;
  if (body.action === 'unpublish') {
    await c.env.DB.prepare(
      `UPDATE tracks SET status = 'rejected', visibility = 'private', published_at = NULL,
              rejection_reason = ?, reviewed_by = ?, reviewed_at = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    )
      .bind(body.note ?? 'Unpublished after a moderation report.', user.id, now, report.track_id)
      .run();
    trackAction = 'unpublished';
  } else if (body.action === 'remove') {
    await c.env.DB.prepare(
      `UPDATE tracks SET is_deleted = 1, status = 'removed', visibility = 'private', published_at = NULL,
              rejection_reason = ?, reviewed_by = ?, reviewed_at = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    )
      .bind(body.note ?? 'Removed after a moderation report.', user.id, now, report.track_id)
      .run();
    trackAction = 'removed';
  }

  await writeAudit(
    c.env.DB,
    {
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'report.resolved',
      targetType: 'moderation_report',
      targetId: report.id,
      metadata: { status: body.status, action: body.action ?? 'none', trackId: report.track_id },
    },
    c.get('logger')
  );

  return c.json({ ok: true, reportId: report.id, status: body.status, trackAction });
});

export { serializeModeratedTrack };

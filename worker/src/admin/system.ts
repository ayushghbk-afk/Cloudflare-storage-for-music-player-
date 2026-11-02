import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { badRequest, conflict, notFound, validationFailed } from '../utils/errors';
import { pagination, readJson } from '../utils/http';
import { writeAudit } from '../utils/audit';
import { requireAdmin } from '../auth/middleware';
import { likePattern } from '../utils/text';
import { listProviders, listProviderUsage } from '../storage/registry';
import { invalidatePublicConfigCache } from '../cache';
import {
  SETTING_DEFAULTS,
  SETTING_DESCRIPTIONS,
  SETTING_KEYS,
  invalidateSettingsCache,
  loadSettings,
  serialiseSettingValue,
  type Settings,
} from '../settings';

export const adminSystemRoutes = new Hono<AppEnv>();

/* -------------------------------------------------------------------------- */
/* GET /api/admin/stats                                                        */
/* -------------------------------------------------------------------------- */

adminSystemRoutes.get('/stats', async (c) => {
  await requireAdmin(c);

  const counts = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM tracks WHERE is_deleted = 0) AS total_tracks,
       (SELECT COUNT(*) FROM tracks WHERE status = 'approved' AND visibility = 'public' AND is_deleted = 0 AND rights_confirmed = 1) AS public_tracks,
       (SELECT COUNT(*) FROM tracks WHERE status = 'pending' AND is_deleted = 0) AS pending_tracks,
       (SELECT COUNT(*) FROM tracks WHERE status = 'rejected' AND is_deleted = 0) AS rejected_tracks,
       (SELECT COUNT(*) FROM tracks WHERE is_deleted = 1) AS removed_tracks,
       (SELECT COUNT(*) FROM users WHERE status <> 'deleted') AS total_users,
       (SELECT COUNT(*) FROM users WHERE created_at >= datetime('now','-7 days')) AS new_users_7d,
       (SELECT COUNT(*) FROM upload_jobs WHERE status IN ('initiated','processing','uploaded')) AS active_uploads,
       (SELECT COUNT(*) FROM upload_jobs WHERE status = 'awaiting_review') AS pending_uploads,
       (SELECT COUNT(*) FROM upload_jobs WHERE status = 'failed') AS failed_uploads,
       (SELECT COUNT(*) FROM upload_jobs WHERE status = 'failed' AND created_at >= datetime('now','-7 days')) AS failed_uploads_7d,
       (SELECT COUNT(*) FROM moderation_reports WHERE status = 'open') AS open_reports,
       (SELECT COUNT(*) FROM playback_errors WHERE created_at >= datetime('now','-24 hours')) AS playback_errors_24h,
       (SELECT COUNT(*) FROM play_history WHERE played_at >= datetime('now','-24 hours')) AS plays_24h`
  ).first<Record<string, number>>();

  const [providers, usage] = await Promise.all([listProviders(c.env.DB), listProviderUsage(c.env.DB)]);

  const providersWithUsage = providers.map((provider) => {
    const entry = usage.find((row) => row.provider_id === provider.id);
    return {
      id: provider.id,
      name: provider.name,
      bucketName: provider.bucket_name,
      endpoint: provider.endpoint,
      enabled: provider.enabled === 1,
      priority: provider.priority,
      healthStatus: provider.health_status,
      healthCheckedAt: provider.health_checked_at,
      healthMessage: provider.health_message,
      usedBytes: entry?.used_bytes ?? 0,
      objectCount: entry?.object_count ?? 0,
      capacityBytes: provider.capacity_bytes,
    };
  });

  const recentFailures = await c.env.DB.prepare(
    `SELECT id, filename, error_code, error_message, created_at
       FROM upload_jobs WHERE status = 'failed'
      ORDER BY created_at DESC LIMIT 5`
  ).all<Record<string, unknown>>();

  return c.json({
    stats: {
      totalTracks: counts?.total_tracks ?? 0,
      publicTracks: counts?.public_tracks ?? 0,
      pendingTracks: counts?.pending_tracks ?? 0,
      rejectedTracks: counts?.rejected_tracks ?? 0,
      removedTracks: counts?.removed_tracks ?? 0,
      totalUsers: counts?.total_users ?? 0,
      newUsers7d: counts?.new_users_7d ?? 0,
      activeUploads: counts?.active_uploads ?? 0,
      pendingUploads: counts?.pending_uploads ?? 0,
      failedUploads: counts?.failed_uploads ?? 0,
      failedUploads7d: counts?.failed_uploads_7d ?? 0,
      openReports: counts?.open_reports ?? 0,
      playbackErrors24h: counts?.playback_errors_24h ?? 0,
      plays24h: counts?.plays_24h ?? 0,
      storageUsedBytes: usage.reduce((sum, row) => sum + (row.used_bytes ?? 0), 0),
      storageObjectCount: usage.reduce((sum, row) => sum + (row.object_count ?? 0), 0),
    },
    storage: {
      providers: providersWithUsage,
      healthy: providersWithUsage.filter((provider) => provider.healthStatus === 'healthy').length,
      degraded: providersWithUsage.filter((provider) => provider.healthStatus === 'degraded').length,
      errored: providersWithUsage.filter((provider) => provider.healthStatus === 'error').length,
      unconfigured: providersWithUsage.filter((provider) => provider.healthStatus === 'unconfigured').length,
      unknown: providersWithUsage.filter((provider) => provider.healthStatus === 'unknown').length,
    },
    recentFailures: (recentFailures.results ?? []).map((row) => ({
      id: row.id,
      filename: row.filename,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      createdAt: row.created_at,
    })),
  });
});

/* -------------------------------------------------------------------------- */
/* Audit log                                                                   */
/* -------------------------------------------------------------------------- */

adminSystemRoutes.get('/audit', async (c) => {
  await requireAdmin(c);
  const { limit, offset } = pagination(c, { limit: 50, maxLimit: 200 });

  const where: string[] = [];
  const bindings: unknown[] = [];
  const action = c.req.query('action');
  const actorId = c.req.query('actorId');
  if (action) {
    where.push('a.action = ?');
    bindings.push(action);
  }
  if (actorId) {
    where.push('a.actor_user_id = ?');
    bindings.push(actorId);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.actor_user_id, a.actor_email, a.action, a.target_type, a.target_id, a.metadata,
            a.ip_hash, a.user_agent, a.created_at
       FROM audit_logs a ${whereSql}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ? OFFSET ?`
  )
    .bind(...bindings, limit, offset)
    .all<Record<string, unknown>>();

  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM audit_logs a ${whereSql}`)
    .bind(...bindings)
    .first<{ count: number }>();

  return c.json({
    entries: (rows.results ?? []).map((row) => ({
      id: row.id,
      actor: row.actor_user_id ? { id: row.actor_user_id, email: row.actor_email } : null,
      action: row.action,
      target: row.target_id ? { type: row.target_type, id: row.target_id } : null,
      metadata: safeJson(row.metadata),
      ipHash: row.ip_hash,
      userAgent: row.user_agent,
      createdAt: row.created_at,
    })),
    pagination: { total: total?.count ?? 0, limit, offset },
  });
});

function safeJson(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* User administration                                                         */
/* -------------------------------------------------------------------------- */

const updateUserSchema = z.strictObject({
  role: z.enum(['user', 'moderator', 'admin']).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  uploadQuotaBytes: z.number().int().min(0).max(1_099_511_627_776).nullable().optional(),
});

adminSystemRoutes.get('/users', async (c) => {
  await requireAdmin(c);
  const { limit, offset } = pagination(c, { limit: 50 });

  const where: string[] = [];
  const bindings: unknown[] = [];
  const q = c.req.query('q');
  const role = c.req.query('role');
  if (q && q.trim()) {
    where.push("(u.email_normalized LIKE ? ESCAPE '\\' OR LOWER(u.display_name) LIKE ? ESCAPE '\\')");
    bindings.push(likePattern(q), likePattern(q));
  }
  if (role && ['user', 'moderator', 'admin'].includes(role)) {
    where.push('u.role = ?');
    bindings.push(role);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.role, u.status, u.created_at, u.last_login_at, u.upload_quota_bytes,
            (SELECT COUNT(*) FROM tracks t WHERE t.uploader_id = u.id AND t.is_deleted = 0) AS track_count
       FROM users u ${whereSql}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?`
  )
    .bind(...bindings, limit, offset)
    .all<Record<string, unknown>>();

  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM users u ${whereSql}`)
    .bind(...bindings)
    .first<{ count: number }>();

  return c.json({
    users: (rows.results ?? []).map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      status: row.status,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
      uploadQuotaBytes: row.upload_quota_bytes,
      trackCount: row.track_count ?? 0,
    })),
    pagination: { total: total?.count ?? 0, limit, offset },
  });
});

adminSystemRoutes.patch('/users/:id', async (c) => {
  const actor = await requireAdmin(c);
  const body = await readJson(c, updateUserSchema);
  const targetId = c.req.param('id');

  const target = await c.env.DB.prepare('SELECT id, email, role, status FROM users WHERE id = ?')
    .bind(targetId)
    .first<{ id: string; email: string; role: string; status: string }>();
  if (!target) throw notFound('User not found.');

  if (target.id === actor.id && (body.role !== undefined && body.role !== 'admin')) {
    throw conflict('You cannot remove your own administrator role.');
  }
  if (target.role === 'admin' && body.role !== undefined && body.role !== 'admin') {
    const admins = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'")
      .first<{ count: number }>();
    if ((admins?.count ?? 0) <= 1) throw conflict('At least one active administrator must remain.');
  }

  const updates: string[] = [];
  const bindings: unknown[] = [];
  if (body.role !== undefined) {
    updates.push('role = ?');
    bindings.push(body.role);
  }
  if (body.status !== undefined) {
    updates.push('status = ?');
    bindings.push(body.status);
  }
  if (body.uploadQuotaBytes !== undefined) {
    updates.push('upload_quota_bytes = ?');
    bindings.push(body.uploadQuotaBytes);
  }
  if (updates.length === 0) throw badRequest('No supported fields were provided.');

  updates.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  await c.env.DB.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...bindings, target.id)
    .run();

  // A suspension must take effect immediately, not when the JWT expires.
  if (body.status === 'suspended') {
    await c.env.DB.prepare(
      "UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = ? AND revoked_at IS NULL"
    )
      .bind(target.id)
      .run();
  }

  await writeAudit(
    c.env.DB,
    {
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: body.status === 'suspended' ? 'user.suspended' : 'user.role_changed',
      targetType: 'user',
      targetId: target.id,
      metadata: { role: body.role, status: body.status, previousRole: target.role },
    },
    c.get('logger')
  );

  return c.json({ ok: true, userId: target.id, role: body.role ?? target.role, status: body.status ?? target.status });
});

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

const SETTING_BOUNDS: Record<string, { min: number; max: number }> = {
  uploadMaxBytes: { min: 1_048_576, max: 2_147_483_648 },
  uploadDailyUserQuotaBytes: { min: 0, max: 1_099_511_627_776 },
  storageMigrationMaxBytes: { min: 1_048_576, max: 209_715_200 },
  streamUrlTtlSeconds: { min: 30, max: 86_400 },
  maxPlaylistsPerUser: { min: 0, max: 10_000 },
  maxTracksPerPlaylist: { min: 1, max: 10_000 },
};

const booleanKeys = new Set(['uploadRequireRightsConfirmation', 'autoPublishUploads']);

adminSystemRoutes.get('/settings', async (c) => {
  await requireAdmin(c);
  const settings = await loadSettings(c.env.DB);
  return c.json({
    settings,
    schema: SETTING_KEYS.map((key) => ({
      key,
      description: SETTING_DESCRIPTIONS[key],
      default: SETTING_DEFAULTS[key],
      bounds: SETTING_BOUNDS[key] ?? null,
      boolean: booleanKeys.has(key),
      array: key === 'uploadAllowedMimeTypes',
    })),
  });
});

adminSystemRoutes.patch('/settings', async (c) => {
  const actor = await requireAdmin(c);
  const raw = await c.req.json().catch(() => null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest('Body must be an object of setting keys to values.');
  }

  const updates = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(updates).filter((key) => !SETTING_KEYS.includes(key as keyof Settings));
  if (unknownKeys.length > 0) {
    throw validationFailed('Unknown settings keys.', { unknownKeys });
  }

  const statements: { key: keyof Settings; value: string }[] = [];
  for (const [key, value] of Object.entries(updates)) {
    const typedKey = key as keyof Settings;
    if (booleanKeys.has(key)) {
      if (typeof value !== 'boolean') throw validationFailed(`${key} must be a boolean.`);
    } else if (key === 'uploadAllowedMimeTypes') {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.includes('/'))) {
        throw validationFailed('uploadAllowedMimeTypes must be an array of MIME types such as "audio/mpeg".');
      }
    } else {
      const bounds = SETTING_BOUNDS[key];
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw validationFailed(`${key} must be an integer.`);
      }
      if (bounds && (value < bounds.min || value > bounds.max)) {
        throw validationFailed(`${key} must be between ${bounds.min} and ${bounds.max}.`, { bounds });
      }
    }
    statements.push({ key: typedKey, value: serialiseSettingValue(typedKey, value) });
  }

  for (const statement of statements) {
    await c.env.DB.prepare(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    )
      .bind(statement.key, statement.value, actor.id)
      .run();
  }

  await writeAudit(
    c.env.DB,
    {
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: 'settings.updated',
      targetType: 'app_settings',
      targetId: 'global',
      metadata: { changed: Object.keys(updates), values: updates },
    },
    c.get('logger')
  );

  invalidateSettingsCache();
  await invalidatePublicConfigCache(c.env);
  const settings = await loadSettings(c.env.DB);
  return c.json({ settings });
});

/* -------------------------------------------------------------------------- */
/* Upload failures and playback errors                                         */
/* -------------------------------------------------------------------------- */

adminSystemRoutes.get('/uploads', async (c) => {
  await requireAdmin(c);
  const { limit, offset } = pagination(c, { limit: 50 });
  const status = c.req.query('status') ?? 'failed';
  const allowed = ['initiated', 'uploaded', 'processing', 'awaiting_review', 'published', 'rejected', 'duplicate', 'failed', 'expired', 'cancelled'];
  if (!allowed.includes(status)) throw badRequest(`status must be one of: ${allowed.join(', ')}`);

  const rows = await c.env.DB.prepare(
    `SELECT j.id, j.status, j.filename, j.declared_size_bytes, j.uploaded_size_bytes, j.error_code, j.error_message,
            j.created_at, j.completed_at, j.track_id, j.provider_id, u.email AS uploader_email, u.display_name AS uploader_name
       FROM upload_jobs j
       LEFT JOIN users u ON u.id = j.user_id
      WHERE j.status = ?
      ORDER BY j.created_at DESC
      LIMIT ? OFFSET ?`
  )
    .bind(status, limit, offset)
    .all<Record<string, unknown>>();

  const total = await c.env.DB.prepare('SELECT COUNT(*) AS count FROM upload_jobs WHERE status = ?')
    .bind(status)
    .first<{ count: number }>();

  return c.json({
    uploads: (rows.results ?? []).map((row) => ({
      id: row.id,
      status: row.status,
      filename: row.filename,
      declaredSizeBytes: row.declared_size_bytes,
      uploadedSizeBytes: row.uploaded_size_bytes,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      trackId: row.track_id,
      providerId: row.provider_id,
      uploader: row.uploader_email ? { email: row.uploader_email, name: row.uploader_name } : null,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    })),
    pagination: { total: total?.count ?? 0, limit, offset },
  });
});

adminSystemRoutes.get('/playback-errors', async (c) => {
  await requireAdmin(c);
  const { limit, offset } = pagination(c, { limit: 50 });

  const rows = await c.env.DB.prepare(
    `SELECT e.id, e.track_id, e.platform, e.code, e.message, e.created_at, e.provider_id,
            t.title AS track_title
       FROM playback_errors e
       LEFT JOIN tracks t ON t.id = e.track_id
      ORDER BY e.created_at DESC
      LIMIT ? OFFSET ?`
  )
    .bind(limit, offset)
    .all<Record<string, unknown>>();

  const total = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM playback_errors WHERE created_at >= datetime('now','-30 days')"
  ).first<{ count: number }>();

  return c.json({
    errors: (rows.results ?? []).map((row) => ({
      id: row.id,
      trackId: row.track_id,
      trackTitle: row.track_title,
      platform: row.platform,
      code: row.code,
      message: row.message,
      providerId: row.provider_id,
      createdAt: row.created_at,
    })),
    pagination: { total: total?.count ?? 0, limit, offset },
  });
});

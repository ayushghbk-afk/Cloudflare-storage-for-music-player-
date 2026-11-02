import type { D1Database } from '../platform';
import type { Logger } from './logger';

export type AuditAction =
  | 'auth.register'
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.refresh_reuse'
  | 'user.role_changed'
  | 'user.suspended'
  | 'upload.initiated'
  | 'upload.completed'
  | 'upload.failed'
  | 'track.created'
  | 'track.approved'
  | 'track.rejected'
  | 'track.removed'
  | 'track.updated'
  | 'report.resolved'
  | 'storage.provider_created'
  | 'storage.provider_updated'
  | 'storage.provider_deleted'
  | 'storage.health_checked'
  | 'storage.migration_started'
  | 'storage.migration_completed'
  | 'storage.object_verified'
  | 'settings.updated'
  | 'playlist.created'
  | 'playlist.updated'
  | 'playlist.deleted';

export interface AuditEntry {
  actorUserId?: string | null;
  actorEmail?: string | null;
  action: AuditAction;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ipHash?: string | null;
  userAgent?: string | null;
}

/**
 * Append-only audit trail.
 *
 * Audit writes must never break the operation they describe, but they must be
 * visible: failures are logged as errors with the action name.
 */
export async function writeAudit(db: D1Database, entry: AuditEntry, logger?: Logger): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO audit_logs (actor_user_id, actor_email, action, target_type, target_id, metadata, ip_hash, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        entry.actorUserId ?? null,
        entry.actorEmail ?? null,
        entry.action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        entry.ipHash ?? null,
        entry.userAgent ?? null
      )
      .run();
  } catch (error) {
    logger?.error('audit_write_failed', { action: entry.action, targetId: entry.targetId, error });
  }
}

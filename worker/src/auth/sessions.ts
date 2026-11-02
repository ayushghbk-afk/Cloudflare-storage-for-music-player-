import type { D1Database } from '../platform';
import { newId } from '../utils/ids';
import { createRefreshToken, hashRefreshToken } from './tokens';

export interface CreateSessionInput {
  userId: string;
  ttlDays: number;
  userAgent?: string;
  ipHash?: string;
}

export interface CreatedSession {
  sessionId: string;
  refreshToken: string;
  refreshExpiresAt: string;
}

export async function createSession(db: D1Database, input: CreateSessionInput): Promise<CreatedSession> {
  const sessionId = newId('ses');
  const refresh = createRefreshToken();
  const expiresAt = new Date(Date.now() + input.ttlDays * 24 * 60 * 60 * 1000).toISOString();

  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, user_agent, ip_hash, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(sessionId, input.userId, refresh.hash, input.userAgent ?? null, input.ipHash ?? null, expiresAt)
    .run();

  return { sessionId, refreshToken: refresh.token, refreshExpiresAt: expiresAt };
}

export async function revokeSession(db: D1Database, sessionId: string): Promise<void> {
  await db
    .prepare("UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND revoked_at IS NULL")
    .bind(sessionId)
    .run();
}

export async function revokeAllSessions(db: D1Database, userId: string, exceptSessionId?: string): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE sessions
          SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE user_id = ?
          AND revoked_at IS NULL
          AND (? IS NULL OR id <> ?)`
    )
    .bind(userId, exceptSessionId ?? null, exceptSessionId ?? null)
    .run();
  return result.meta?.changes ?? 0;
}

export interface SessionRow {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export async function findSessionByRefreshToken(db: D1Database, token: string): Promise<SessionRow | null> {
  return db
    .prepare('SELECT id, user_id, refresh_token_hash, expires_at, revoked_at, last_used_at FROM sessions WHERE refresh_token_hash = ?')
    .bind(hashRefreshToken(token))
    .first<SessionRow>();
}

/** Housekeeping: drop sessions that expired more than 30 days ago. */
export async function pruneExpiredSessions(db: D1Database): Promise<number> {
  const result = await db
    .prepare("DELETE FROM sessions WHERE expires_at < datetime('now', '-30 days')")
    .run();
  return result.meta?.changes ?? 0;
}

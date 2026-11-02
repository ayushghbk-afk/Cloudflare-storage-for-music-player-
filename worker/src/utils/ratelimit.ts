import type { D1Database } from '../platform';
import { tooManyRequests } from './errors';
import type { Logger } from './logger';

/**
 * Fixed-window rate limiting backed by D1.
 *
 * D1 is the only strongly consistent store guaranteed to be available, so the
 * limiter uses a single atomic UPSERT per request on a primary-key row:
 *
 *   key = "<bucket>:<subject>:<windowIndex>"
 *
 * Rows expire on their own (the key includes the window) and a probabilistic
 * sweep removes stale rows so the table stays small. KV is intentionally not
 * used here: KV is eventually consistent and would let bursts through.
 */
export interface RateLimitOptions {
  bucket: string;
  /** Identity being limited, e.g. `ip:<hash>` or `user:<id>`. */
  subject: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export async function consumeRateLimit(
  db: D1Database,
  options: RateLimitOptions,
  logger?: Logger
): Promise<RateLimitResult> {
  const windowMs = options.windowSeconds * 1000;
  const now = Date.now();
  const windowIndex = Math.floor(now / windowMs);
  const windowStart = windowIndex * windowMs;
  const resetAt = windowStart + windowMs;
  const key = `${options.bucket}:${options.subject}:${windowIndex}`;

  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count, expires_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET count = rate_limits.count + 1
       RETURNING count`
    )
    .bind(key, Math.floor(windowStart / 1000), Math.floor(resetAt / 1000) + 60)
    .first<{ count: number }>();

  const count = row?.count ?? 1;

  // Opportunistic cleanup (~2% of requests) of rows that are past expiry.
  if (Math.random() < 0.02) {
    try {
      await db.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(Math.floor(now / 1000)).run();
    } catch (error) {
      logger?.warn('rate_limit_cleanup_failed', { error: String(error), bucket: options.bucket });
    }
  }

  const allowed = count <= options.limit;
  return {
    allowed,
    remaining: Math.max(0, options.limit - count),
    resetAt,
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
  };
}

/** Consume a quota or throw a 429 with a `Retry-After` hint. */
export async function enforceRateLimit(
  db: D1Database,
  options: RateLimitOptions,
  logger?: Logger
): Promise<RateLimitResult> {
  const result = await consumeRateLimit(db, options, logger);
  if (!result.allowed) {
    throw tooManyRequests(`Too many requests for ${options.bucket}. Try again in ${result.retryAfterSeconds}s.`, result.retryAfterSeconds);
  }
  return result;
}

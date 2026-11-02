import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import type { Bindings } from '../platform';
import type { AppConfig } from '../config';
import { requireJwtSecret } from '../config';
import { badRequest, conflict, forbidden, unauthorized, validationFailed } from '../utils/errors';
import { clientIp, hashIp, noStoreHeaders, readJson, userAgent, type AppContext } from '../utils/http';
import { enforceRateLimit } from '../utils/ratelimit';
import { writeAudit } from '../utils/audit';
import { verifyTurnstile } from '../utils/turnstile';
import { hashPassword, verifyPassword } from './password';
import { parseBearer, signAccessToken, verifyAccessToken } from './tokens';
import { createSession, findSessionByRefreshToken, revokeAllSessions, revokeSession } from './sessions';
import { resolveUser } from './middleware';
import { toAuthUser, type UserRow } from './types';
import { newId } from '../utils/ids';

export const authRoutes = new Hono<AppEnv>();

/**
 * Test/local speed-up only. Production always uses the module default (210k).
 * The stored hash records its own iteration count, so verification stays correct
 * even if this value changes.
 */
function passwordIterations(env: Bindings, config: AppConfig): number | undefined {
  if (config.isProduction) return undefined;
  const raw = Number(env.PASSWORD_HASH_ITERATIONS);
  if (Number.isFinite(raw) && raw >= 50_000 && raw <= 210_000) return Math.trunc(raw);
  return undefined;
}

// A syntactically valid hash used to keep login timing constant for unknown
// accounts (prevents account enumeration through response latency).
const DUMMY_SALT = 'AAAAAAAAAAAAAAAAAAAAAA';
const DUMMY_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const dummyHash = (iterations: number): string => `pbkdf2-sha256$${iterations}$${DUMMY_SALT}$${DUMMY_KEY}`;
const DEFAULT_ITERATIONS_FOR_DUMMY = 210_000;

const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters.')
  .max(200, 'Password must be at most 200 characters.');

const registerSchema = z.strictObject({
  email: z.email('A valid email address is required.').max(254),
  password: passwordSchema,
  displayName: z.string().trim().min(2, 'Display name must be at least 2 characters.').max(60),
  turnstileToken: z.string().max(4096).optional(),
});

const loginSchema = z.strictObject({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(200),
  turnstileToken: z.string().max(4096).optional(),
});

const refreshSchema = z.strictObject({
  refreshToken: z.string().min(20).max(500),
});

const logoutSchema = z.strictObject({
  refreshToken: z.string().min(20).max(500).optional(),
});

function assertPasswordPolicy(password: string, email: string): void {
  const issues: string[] = [];
  if (password.length < 12) issues.push('at least 12 characters');
  if (!/[A-Za-z]/.test(password)) issues.push('at least one letter');
  if (!/[0-9]/.test(password)) issues.push('at least one number');
  const lower = password.toLowerCase();
  if (lower.includes(email.split('@')[0]!.toLowerCase()) && email.split('@')[0]!.length >= 4) {
    issues.push('must not contain your email name');
  }
  if (['password', '123456789012', 'qwertyuiop12', 'letmein12345'].some((weak) => lower.includes(weak))) {
    issues.push('must not contain a common password');
  }
  if (issues.length > 0) {
    throw validationFailed('Password does not meet the security policy.', { requirements: issues });
  }
}

/** Issues an access token + rotating refresh session and shapes the response body. */
async function issueTokens(
  c: AppContext,
  userId: string,
  email: string,
  role: 'user' | 'moderator' | 'admin'
): Promise<Record<string, unknown>> {
  const config = c.get('config');
  const secret = requireJwtSecret(config);
  const session = await createSession(c.env.DB, {
    userId,
    ttlDays: config.refreshTokenTtlDays,
    userAgent: userAgent(c),
    ipHash: hashIp(clientIp(c)),
  });
  const access = await signAccessToken(
    secret,
    { sub: userId, email, role, sid: session.sessionId },
    { ttlSeconds: config.accessTokenTtlSeconds, issuer: config.issuer }
  );
  return {
    sessionId: session.sessionId,
    accessToken: access.token,
    tokenType: 'Bearer',
    expiresIn: config.accessTokenTtlSeconds,
    refreshToken: session.refreshToken,
    refreshExpiresAt: session.refreshExpiresAt,
  };
}

authRoutes.post('/register', async (c) => {
  const config = c.get('config');
  const logger = c.get('logger');
  const ip = clientIp(c);
  const ipHash = hashIp(ip);

  await enforceRateLimit(
    c.env.DB,
    { bucket: 'auth:register', subject: `ip:${ipHash}`, limit: 5, windowSeconds: 3600 },
    logger
  );

  const body = await readJson(c, registerSchema);
  const emailNormalized = body.email.trim().toLowerCase();

  if (config.hasTurnstileSecret) {
    const result = await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY as string, body.turnstileToken, ip, logger);
    if (!result.success) {
      throw badRequest('Human verification failed. Please retry the challenge.', { codes: result.errorCodes });
    }
  }

  assertPasswordPolicy(body.password, emailNormalized);

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email_normalized = ?')
    .bind(emailNormalized)
    .first<{ id: string }>();
  if (existing) throw conflict('An account with this email already exists.');

  // First-ever bootstrap admin. Requires an explicit environment variable and an
  // empty admin set: this can never be replayed to gain privileges later.
  const adminCount = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'")
    .first<{ count: number }>();
  const isBootstrapAdmin =
    Boolean(config.bootstrapAdminEmail) && config.bootstrapAdminEmail === emailNormalized && (adminCount?.count ?? 0) === 0;

  const iterations = passwordIterations(c.env, config);
  const passwordHash = await hashPassword(body.password, iterations);
  const user: UserRow = {
    id: newId('usr'),
    email: body.email.trim(),
    email_normalized: emailNormalized,
    display_name: body.displayName,
    role: isBootstrapAdmin ? 'admin' : 'user',
    status: 'active',
    password_hash: passwordHash,
    created_at: new Date().toISOString(),
  };

  try {
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, email_normalized, display_name, password_hash, role, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`
    )
      .bind(user.id, user.email, user.email_normalized, user.display_name, passwordHash, user.role)
      .run();
  } catch (error) {
    const message = String(error);
    if (message.includes('UNIQUE') || message.includes('unique')) {
      throw conflict('An account with this email already exists.');
    }
    throw error;
  }

  const tokens = await issueTokens(c, user.id, user.email, user.role);

  await writeAudit(
    c.env.DB,
    {
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'auth.register',
      targetType: 'user',
      targetId: user.id,
      metadata: { role: user.role, bootstrapAdmin: isBootstrapAdmin },
      ipHash,
      userAgent: userAgent(c),
    },
    logger
  );
  if (isBootstrapAdmin) logger.warn('bootstrap_admin_created', { userId: user.id });

  return c.json(
    {
      user: toAuthUser(user),
      ...tokens,
    },
    201,
    noStoreHeaders()
  );
});

authRoutes.post('/login', async (c) => {
  const config = c.get('config');
  const logger = c.get('logger');
  const ip = clientIp(c);
  const ipHash = hashIp(ip);

  await enforceRateLimit(c.env.DB, { bucket: 'auth:login', subject: `ip:${ipHash}`, limit: 30, windowSeconds: 300 }, logger);

  const body = await readJson(c, loginSchema);
  const emailNormalized = body.email.trim().toLowerCase();

  await enforceRateLimit(
    c.env.DB,
    { bucket: 'auth:login:email', subject: `email:${emailNormalized}`, limit: 10, windowSeconds: 300 },
    logger
  );

  if (config.hasTurnstileSecret) {
    const result = await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY as string, body.turnstileToken, ip, logger);
    if (!result.success) {
      throw badRequest('Human verification failed. Please retry the challenge.', { codes: result.errorCodes });
    }
  }

  const row = await c.env.DB.prepare(
    'SELECT id, email, email_normalized, display_name, role, status, password_hash FROM users WHERE email_normalized = ?'
  )
    .bind(emailNormalized)
    .first<UserRow>();

  const iterations = passwordIterations(c.env, config);
  if (!row) {
    // Constant-ish time: perform a real derivation against a dummy hash so an
    // unknown email costs the same as a wrong password.
    await verifyPassword(body.password, dummyHash(iterations ?? DEFAULT_ITERATIONS_FOR_DUMMY));
    await writeAudit(
      c.env.DB,
      { action: 'auth.login_failed', targetType: 'email', targetId: emailNormalized, metadata: { reason: 'unknown_user' }, ipHash },
      logger
    );
    throw unauthorized('Invalid email or password.');
  }

  const verification = await verifyPassword(body.password, row.password_hash!);
  if (!verification.valid) {
    await writeAudit(
      c.env.DB,
      {
        actorUserId: row.id,
        actorEmail: row.email,
        action: 'auth.login_failed',
        targetType: 'user',
        targetId: row.id,
        metadata: { reason: 'bad_password' },
        ipHash,
      },
      logger
    );
    throw unauthorized('Invalid email or password.');
  }

  if (row.status !== 'active') {
    throw forbidden('This account is not active. Contact an administrator.');
  }

  if (verification.needsRehash) {
    const upgraded = await hashPassword(body.password, iterations);
    await c.env.DB.prepare("UPDATE users SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .bind(upgraded, row.id)
      .run();
  }

  await c.env.DB.prepare("UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .bind(row.id)
    .run();

  const tokens = await issueTokens(c, row.id, row.email, row.role);

  await writeAudit(
    c.env.DB,
    {
      actorUserId: row.id,
      actorEmail: row.email,
      action: 'auth.login',
      targetType: 'user',
      targetId: row.id,
      ipHash,
      userAgent: userAgent(c),
    },
    logger
  );

  return c.json({ user: toAuthUser(row), ...tokens }, 200, noStoreHeaders());
});

authRoutes.post('/refresh', async (c) => {
  const logger = c.get('logger');
  const ipHash = hashIp(clientIp(c));

  await enforceRateLimit(c.env.DB, { bucket: 'auth:refresh', subject: `ip:${ipHash}`, limit: 120, windowSeconds: 300 }, logger);

  const body = await readJson(c, refreshSchema);
  const session = await findSessionByRefreshToken(c.env.DB, body.refreshToken);
  if (!session) throw unauthorized('Invalid refresh token.');

  if (session.revoked_at) {
    // Token reuse after rotation: assume compromise and kill every session.
    const revoked = await revokeAllSessions(c.env.DB, session.user_id);
    await writeAudit(
      c.env.DB,
      {
        actorUserId: session.user_id,
        action: 'auth.refresh_reuse',
        targetType: 'session',
        targetId: session.id,
        metadata: { revokedSessions: revoked },
        ipHash,
      },
      logger
    );
    logger.warn('refresh_token_reuse_detected', { userId: session.user_id, sessionId: session.id });
    throw unauthorized('Refresh token has already been used. All sessions were revoked.');
  }

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    throw unauthorized('Refresh token expired. Please sign in again.');
  }

  const row = await c.env.DB.prepare(
    'SELECT id, email, email_normalized, display_name, role, status FROM users WHERE id = ?'
  )
    .bind(session.user_id)
    .first<UserRow>();
  if (!row || row.status !== 'active') throw unauthorized('Account is not active.');

  await revokeSession(c.env.DB, session.id);
  await c.env.DB.prepare("UPDATE sessions SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .bind(session.id)
    .run();

  const tokens = await issueTokens(c, row.id, row.email, row.role);
  return c.json({ user: toAuthUser(row), ...tokens }, 200, noStoreHeaders());
});

authRoutes.post('/logout', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = logoutSchema.safeParse(body ?? {});
  const ipHash = hashIp(clientIp(c));

  if (parsed.success && parsed.data.refreshToken) {
    const session = await findSessionByRefreshToken(c.env.DB, parsed.data.refreshToken);
    if (session) await revokeSession(c.env.DB, session.id);
  } else {
    const user = await resolveUser(c);
    if (user) {
      // Revoke the session referenced by the access token when present.
      const bearer = parseBearer(c.req.header('authorization'));
      const secret = c.get('config').jwtSecret;
      if (bearer && secret) {
        const claims = await verifyAccessToken(secret, bearer, c.get('config').issuer);
        if (claims) await revokeSession(c.env.DB, claims.sid);
      }
      await writeAudit(
        c.env.DB,
        { actorUserId: user.id, actorEmail: user.email, action: 'auth.logout', targetType: 'user', targetId: user.id, ipHash },
        c.get('logger')
      );
    }
  }

  return c.json({ ok: true }, 200, noStoreHeaders());
});

authRoutes.get('/me', async (c) => {
  const user = await resolveUser(c);
  if (!user) throw unauthorized();

  const [uploads, favorites, playlists] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) AS count FROM tracks WHERE uploader_id = ? AND is_deleted = 0')
      .bind(user.id)
      .first<{ count: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS count FROM favorites WHERE user_id = ?')
      .bind(user.id)
      .first<{ count: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS count FROM playlists WHERE owner_id = ?')
      .bind(user.id)
      .first<{ count: number }>(),
  ]);

  return c.json(
    {
      user,
      capabilities: {
        canUpload: true,
        canModerate: user.role === 'admin' || user.role === 'moderator',
        canAdminister: user.role === 'admin',
      },
      stats: {
        uploads: uploads?.count ?? 0,
        favorites: favorites?.count ?? 0,
        playlists: playlists?.count ?? 0,
      },
    },
    200,
    noStoreHeaders()
  );
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../support/env';
import { api, DEFAULT_PASSWORD, promote, registerUser, request } from '../support/client';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => {
  ctx.close();
});

describe('POST /api/auth/register', () => {
  it('creates a user and returns a usable access token', async () => {
    const email = `new.user.${Date.now()}@example.test`;
    const response = await api<Record<string, unknown>>(ctx, '/api/auth/register', {
      body: { email, password: DEFAULT_PASSWORD, displayName: 'New Listener' },
    });

    expect(response.status).toBe(201);
    const body = response.body as {
      user: { id: string; email: string; role: string };
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      tokenType: string;
    };
    expect(body.user.email).toBe(email);
    expect(body.user.role).toBe('user');
    expect(body.accessToken.split('.')).toHaveLength(3);
    expect(body.refreshToken).toHaveLength(64);
    expect(body.tokenType).toBe('Bearer');
    expect(body.expiresIn).toBe(900);
    expect(response.headers.get('cache-control')).toContain('no-store');

    // The password is never stored in plain text.
    const row = await ctx.db.prepare('SELECT password_hash FROM users WHERE email_normalized = ?').bind(email).first<{
      password_hash: string;
    }>();
    expect(row?.password_hash).toMatch(/^pbkdf2-sha256\$/);
    expect(row?.password_hash).not.toContain(DEFAULT_PASSWORD);
  });

  it('normalises the email for the uniqueness check', async () => {
    await registerUser(ctx, { email: 'Case.Sensitive@Example.test' });
    const duplicate = await api(ctx, '/api/auth/register', {
      body: { email: 'case.sensitive@example.TEST', password: DEFAULT_PASSWORD, displayName: 'Dupe' },
    });
    expect(duplicate.status).toBe(409);
    expect((duplicate.body as { error: { code: string } }).error.code).toBe('CONFLICT');
  });

  it('enforces the password policy', async () => {
    const weak = await api(ctx, '/api/auth/register', {
      body: { email: 'weak@example.test', password: 'short', displayName: 'Weak' },
    });
    expect(weak.status).toBe(422);

    const noDigit = await api(ctx, '/api/auth/register', {
      body: { email: 'nodigit@example.test', password: 'onlylettershere', displayName: 'No Digit' },
    });
    expect(noDigit.status).toBe(422);
    expect((noDigit.body as { error: { details: { requirements: string[] } } }).error.details.requirements).toContain(
      'at least one number'
    );
  });

  it('rejects invalid emails and unknown fields', async () => {
    const badEmail = await api(ctx, '/api/auth/register', {
      body: { email: 'not-an-email', password: DEFAULT_PASSWORD, displayName: 'Nope' },
    });
    expect(badEmail.status).toBe(422);

    const extraField = await api(ctx, '/api/auth/register', {
      body: { email: 'extra@example.test', password: DEFAULT_PASSWORD, displayName: 'Extra', role: 'admin' },
    });
    // strictObject rejects privilege-escalation attempts through extra fields.
    expect(extraField.status).toBe(422);
  });

  it('rate limits registration attempts from one IP', async () => {
    const ip = '203.0.113.77';
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const response = await api(ctx, '/api/auth/register', {
        ip,
        body: { email: `burst${i}.${Date.now()}@example.test`, password: DEFAULT_PASSWORD, displayName: `Burst ${i}` },
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 5).every((status) => status === 201)).toBe(true);
    expect(statuses[5]).toBe(429);
    expect(statuses[6]).toBe(429);
  });

  it('promotes the configured bootstrap admin exactly once', async () => {
    const second = await createTestContext({ overrides: { BOOTSTRAP_ADMIN_EMAIL: 'owner@example.test' } });
    try {
      const owner = await registerUser(second, { email: 'owner@example.test', displayName: 'Owner' });
      expect(owner.user.role).toBe('admin');

      // The bootstrap variable must not grant admin to anyone else, ever.
      const listener = await registerUser(second, { email: 'listener@example.test', displayName: 'Listener' });
      expect(listener.user.role).toBe('user');
    } finally {
      second.close();
    }
  });
});

describe('POST /api/auth/login', () => {
  it('returns tokens for valid credentials', async () => {
    const user = await registerUser(ctx, { email: 'login@example.test' });
    const response = await api<Record<string, unknown>>(ctx, '/api/auth/login', {
      body: { email: 'LOGIN@example.test', password: DEFAULT_PASSWORD },
    });
    expect(response.status).toBe(200);
    expect((response.body as { user: { id: string } }).user.id).toBe(user.user.id);
  });

  it('rejects wrong passwords and unknown users with the same error', async () => {
    await registerUser(ctx, { email: 'known@example.test' });
    const wrongPassword = await api(ctx, '/api/auth/login', {
      body: { email: 'known@example.test', password: 'Wrong-Harbour-5521' },
    });
    const unknownUser = await api(ctx, '/api/auth/login', {
      body: { email: 'ghost@example.test', password: 'Wrong-Harbour-5521' },
    });
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    // Identical code and message, so the response cannot be used to enumerate accounts.
    const shape = (body: unknown): { code: string; message: string } => {
      const error = (body as { error: { code: string; message: string } }).error;
      return { code: error.code, message: error.message };
    };
    expect(shape(wrongPassword.body)).toEqual(shape(unknownUser.body));
  });

  it('documents failures in the audit log', async () => {
    await registerUser(ctx, { email: 'audited@example.test' });
    await api(ctx, '/api/auth/login', { body: { email: 'audited@example.test', password: 'Nope-Harbour-3312' } });
    const entry = await ctx.db
      .prepare("SELECT action, metadata FROM audit_logs WHERE action = 'auth.login_failed'")
      .first<{ action: string; metadata: string }>();
    expect(entry?.action).toBe('auth.login_failed');
    expect(entry?.metadata).toContain('bad_password');
  });

  it('refuses suspended accounts', async () => {
    const user = await registerUser(ctx, { email: 'suspended@example.test' });
    await ctx.db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").bind(user.user.id).run();
    const response = await api(ctx, '/api/auth/login', {
      body: { email: 'suspended@example.test', password: DEFAULT_PASSWORD },
    });
    expect(response.status).toBe(403);
  });
});

describe('GET /api/auth/me', () => {
  it('returns the caller and their capabilities', async () => {
    const user = await registerUser(ctx);
    const response = await api<Record<string, unknown>>(ctx, '/api/auth/me', { token: user.token });
    expect(response.status).toBe(200);
    const body = response.body as { user: { id: string }; capabilities: Record<string, boolean> };
    expect(body.user.id).toBe(user.user.id);
    expect(body.capabilities.canModerate).toBe(false);
    expect(body.capabilities.canAdminister).toBe(false);
  });

  it('requires a token', async () => {
    const response = await api(ctx, '/api/auth/me');
    expect(response.status).toBe(401);
    expect((response.body as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });

  it('rejects garbage and revoked sessions', async () => {
    const bad = await api(ctx, '/api/auth/me', { token: 'not.a.token' });
    expect(bad.status).toBe(401);

    const user = await registerUser(ctx);
    await ctx.db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").bind(user.user.id).run();
    const suspended = await api(ctx, '/api/auth/me', { token: user.token });
    expect(suspended.status).toBe(401);
  });

  it('reflects a role change immediately (no waiting for JWT expiry)', async () => {
    const user = await registerUser(ctx);
    await promote(ctx, user.user.id, 'admin');
    const response = await api<Record<string, unknown>>(ctx, '/api/auth/me', { token: user.token });
    expect((response.body as { user: { role: string } }).user.role).toBe('admin');
  });
});

describe('refresh token rotation', () => {
  it('issues a new pair and revokes the previous refresh token', async () => {
    const user = await registerUser(ctx);
    const rotated = await api<Record<string, unknown>>(ctx, '/api/auth/refresh', {
      body: { refreshToken: user.refreshToken },
    });
    expect(rotated.status).toBe(200);
    const newRefresh = (rotated.body as { refreshToken: string }).refreshToken;
    expect(newRefresh).not.toBe(user.refreshToken);

    const reused = await api(ctx, '/api/auth/refresh', { body: { refreshToken: user.refreshToken } });
    expect(reused.status).toBe(401);
    expect(reused.text).toMatch(/already been used/i);

    // Reuse revokes everything: even the freshly rotated token stops working.
    const afterReuse = await api(ctx, '/api/auth/refresh', { body: { refreshToken: newRefresh } });
    expect(afterReuse.status).toBe(401);
  });

  it('rejects unknown refresh tokens', async () => {
    const response = await api(ctx, '/api/auth/refresh', { body: { refreshToken: 'a'.repeat(64) } });
    expect(response.status).toBe(401);
  });

  it('logout revokes the session', async () => {
    const user = await registerUser(ctx);
    const logout = await api(ctx, '/api/auth/logout', { token: user.token, body: {} });
    expect(logout.status).toBe(200);

    const me = await api(ctx, '/api/auth/me', { token: user.token });
    // The access token still verifies until it expires, but its session is gone:
    // refresh must fail, which is what ends the client session.
    const refresh = await api(ctx, '/api/auth/refresh', { body: { refreshToken: user.refreshToken } });
    expect(refresh.status).toBe(401);
    expect(me.status).toBe(200);
  });
});

describe('role gates', () => {
  it('forbids non-admins from admin endpoints', async () => {
    const user = await registerUser(ctx);
    for (const path of ['/api/admin/stats', '/api/admin/storage', '/api/admin/audit', '/api/admin/settings']) {
      const response = await api(ctx, path, { token: user.token });
      expect(response.status, path).toBe(403);
    }
  });

  it('allows moderators into the queue but not administration', async () => {
    const moderator = await registerUser(ctx);
    await promote(ctx, moderator.user.id, 'moderator');
    expect((await api(ctx, '/api/admin/tracks?status=pending', { token: moderator.token })).status).toBe(200);
    expect((await api(ctx, '/api/admin/storage', { token: moderator.token })).status).toBe(403);
    expect((await api(ctx, '/api/admin/users', { token: moderator.token })).status).toBe(403);
  });

  it('allows admins into administration', async () => {
    const admin = await registerUser(ctx);
    await promote(ctx, admin.user.id, 'admin');
    const stats = await api(ctx, '/api/admin/stats', { token: admin.token });
    expect(stats.status).toBe(200);
    expect((stats.body as { stats: Record<string, number> }).stats.totalTracks).toBe(0);
  });
});

describe('CORS', () => {
  it('answers preflight for an allowed origin', async () => {
    const response = await request(ctx, '/api/tracks', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('does not echo a disallowed origin', async () => {
    const response = await request(ctx, '/api/tracks', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

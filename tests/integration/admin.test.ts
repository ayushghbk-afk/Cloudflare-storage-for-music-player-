import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../support/env';
import { api, promote, registerAdmin, registerUser, uploadTrack, type AuthResult } from '../support/client';
import { buildMp3 } from '../support/audio';

let ctx: TestContext;
let admin: AuthResult;
let moderator: AuthResult;
let user: AuthResult;

beforeEach(async () => {
  ctx = await createTestContext();
  admin = await registerAdmin(ctx);
  moderator = await registerUser(ctx, { email: 'mod@example.test' });
  await promote(ctx, moderator.user.id, 'moderator');
  user = await registerUser(ctx, { email: 'listener@example.test', displayName: 'Listener' });
});

afterEach(() => {
  ctx.close();
});

describe('GET /api/admin/stats', () => {
  it('summarises catalogue, users, uploads and storage', async () => {
    const pending = await uploadTrack(ctx, user.token, buildMp3({ title: 'Pending' }));
    // A job that fails validation never produces a track row; that is what the
    // dashboard counters must reflect.
    await ctx.db
      .prepare(
        `INSERT INTO upload_jobs
           (id, user_id, status, object_key, filename, declared_mime_type, declared_size_bytes, expires_at, error_code, error_message)
         VALUES ('job_failed_fixture', ?, 'failed', 'audio/fixture.mp3', 'broken.mp3', 'audio/mpeg', 2048,
                 strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'), 'BAD_MIME', 'Declared type does not match the bytes')`
      )
      .bind(user.user.id)
      .run();

    const response = await api<{
      stats: Record<string, number>;
      storage: { providers: { id: string; healthStatus: string }[]; healthy: number };
      recentFailures: { id: string; errorCode: string }[];
    }>(ctx, '/api/admin/stats', { token: admin.token });

    expect(response.status).toBe(200);
    expect(response.body.stats.pendingTracks).toBe(1);
    expect(response.body.stats.activeUploads).toBeGreaterThanOrEqual(0);
    expect(response.body.stats.failedUploads).toBe(1);
    expect(response.body.stats.totalUsers).toBe(3);
    // The completed pending upload is stored, so one object exists.
    expect(response.body.stats.storageObjectCount).toBe(1);
    expect(response.body.storage.providers).toHaveLength(1);
    expect(response.body.storage.providers[0]!.healthStatus).toBe('healthy');
    expect(response.body.storage.healthy).toBe(1);
    expect(response.body.recentFailures).toHaveLength(1);
    expect(response.body.recentFailures[0]!.errorCode).toBe('BAD_MIME');
    expect(pending.trackId).toBeTruthy();
  });

  it('is closed to non-admins', async () => {
    expect((await api(ctx, '/api/admin/stats', { token: moderator.token })).status).toBe(403);
    expect((await api(ctx, '/api/admin/stats')).status).toBe(401);
  });
});

describe('audit log', () => {
  it('records privileged actions and supports filtering', async () => {
    await api(ctx, `/api/admin/users/${user.user.id}`, { token: admin.token, method: 'PATCH', body: { role: 'moderator' } });
    await api(ctx, `/api/admin/users/${user.user.id}`, { token: admin.token, method: 'PATCH', body: { role: 'admin' } });

    const all = await api<{ entries: { action: string; actorEmail: string | null }[]; pagination: { total: number } }>(
      ctx,
      '/api/admin/audit',
      { token: admin.token }
    );
    expect(all.status).toBe(200);
    expect(all.body.pagination.total).toBeGreaterThanOrEqual(2);
    expect(all.body.entries.some((entry) => entry.action === 'user.role_changed')).toBe(true);

    const filtered = await api<{ entries: { action: string }[] }>(ctx, '/api/admin/audit?action=user.role_changed', {
      token: admin.token,
    });
    expect(filtered.body.entries.length).toBeGreaterThanOrEqual(2);
    expect(filtered.body.entries.every((entry) => entry.action === 'user.role_changed')).toBe(true);
  });

  it('caps the page size', async () => {
    const response = await api(ctx, '/api/admin/audit?limit=5000', { token: admin.token });
    expect(response.status).toBe(200);
  });
});

describe('user administration', () => {
  it('lists and searches users', async () => {
    const list = await api<{ users: { email: string; role: string }[]; pagination: { total: number } }>(ctx, '/api/admin/users', {
      token: admin.token,
    });
    expect(list.body.pagination.total).toBe(3);

    const search = await api<{ users: { email: string }[] }>(ctx, '/api/admin/users?q=listener', { token: admin.token });
    expect(search.body.users.map((entry) => entry.email)).toEqual(['listener@example.test']);

    const byRole = await api<{ users: { role: string }[] }>(ctx, '/api/admin/users?role=moderator', { token: admin.token });
    expect(byRole.body.users).toHaveLength(1);
    expect(byRole.body.users[0]!.role).toBe('moderator');
  });

  it('changes a role and applies a per-user upload quota', async () => {
    const response = await api<{ role: string }>(ctx, `/api/admin/users/${user.user.id}`, {
      token: admin.token,
      method: 'PATCH',
      body: { role: 'moderator', uploadQuotaBytes: 10_485_760 },
    });
    expect(response.status).toBe(200);
    expect(response.body.role).toBe('moderator');

    const row = await ctx.db
      .prepare('SELECT role, upload_quota_bytes FROM users WHERE id = ?')
      .bind(user.user.id)
      .first<{ role: string; upload_quota_bytes: number }>();
    expect(row?.role).toBe('moderator');
    expect(row?.upload_quota_bytes).toBe(10_485_760);
  });

  it('refuses to demote the last administrator or the caller themselves', async () => {
    const self = await api<{ error: { message: string } }>(ctx, `/api/admin/users/${admin.user.id}`, {
      token: admin.token,
      method: 'PATCH',
      body: { role: 'user' },
    });
    expect(self.status).toBe(409);
    expect(self.body.error.message).toMatch(/own administrator role/);

    // Someone else cannot demote the only admin either.
    await promote(ctx, moderator.user.id, 'admin');
    const other = await api(ctx, `/api/admin/users/${admin.user.id}`, {
      token: moderator.token,
      method: 'PATCH',
      body: { role: 'admin' },
    });
    expect(other.status).toBe(200);

    await ctx.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(moderator.user.id).run();
    await ctx.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(admin.user.id).run();
    await ctx.db.prepare("UPDATE users SET role = 'user' WHERE id = ?").bind(moderator.user.id).run();

    const lastAdmin = await api(ctx, `/api/admin/users/${admin.user.id}`, {
      token: user.token,
      method: 'PATCH',
      body: { role: 'user' },
    });
    expect(lastAdmin.status).toBe(403);
  });

  it('suspends a user and invalidates their refresh tokens immediately', async () => {
    const before = await api(ctx, '/api/auth/me', { token: user.token });
    expect(before.status).toBe(200);

    const suspend = await api(ctx, `/api/admin/users/${user.user.id}`, {
      token: admin.token,
      method: 'PATCH',
      body: { status: 'suspended' },
    });
    expect(suspend.status).toBe(200);

    // The access token is rejected on the very next request: suspension is not
    // deferred to token expiry.
    const after = await api(ctx, '/api/auth/me', { token: user.token });
    expect(after.status).toBe(401);

    const refresh = await api(ctx, '/api/auth/refresh', { body: { refreshToken: user.refreshToken } });
    expect(refresh.status).toBeGreaterThanOrEqual(400);

    const sessions = await ctx.db
      .prepare('SELECT revoked_at FROM sessions WHERE user_id = ?')
      .bind(user.user.id)
      .all<{ revoked_at: string | null }>();
    expect(sessions.results?.every((row) => row.revoked_at !== null)).toBe(true);
  });

  it('validates the payload and the target', async () => {
    expect(
      (await api(ctx, `/api/admin/users/${user.user.id}`, { token: admin.token, method: 'PATCH', body: { role: 'superuser' } })).status
    ).toBe(422);
    expect(
      (await api(ctx, `/api/admin/users/${user.user.id}`, { token: admin.token, method: 'PATCH', body: {} })).status
    ).toBe(400);
    expect(
      (await api(ctx, '/api/admin/users/usr_missing', { token: admin.token, method: 'PATCH', body: { role: 'user' } })).status
    ).toBe(404);
  });
});

describe('settings', () => {
  it('returns the schema with defaults and bounds', async () => {
    const response = await api<{ settings: Record<string, unknown>; schema: { key: string; default: unknown; bounds: unknown }[] }>(
      ctx,
      '/api/admin/settings',
      { token: admin.token }
    );
    expect(response.status).toBe(200);
    expect(response.body.schema.length).toBeGreaterThan(5);
    const maxBytes = response.body.schema.find((entry) => entry.key === 'uploadMaxBytes');
    expect(maxBytes).toBeDefined();
    expect(response.body.settings.uploadMaxBytes).toBeGreaterThan(0);
  });

  it('updates settings and rejects unknown keys or out-of-bounds values', async () => {
    const unknown = await api<{ error: { details?: { unknownKeys: string[] } } }>(ctx, '/api/admin/settings', {
      token: admin.token,
      method: 'PATCH',
      body: { notARealSetting: 1 },
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.details?.unknownKeys).toEqual(['notARealSetting']);

    const outOfBounds = await api(ctx, '/api/admin/settings', {
      token: admin.token,
      method: 'PATCH',
      body: { uploadMaxBytes: 1 },
    });
    expect(outOfBounds.status).toBe(422);

    const wrongType = await api(ctx, '/api/admin/settings', {
      token: admin.token,
      method: 'PATCH',
      body: { autoPublishUploads: 'yes' },
    });
    expect(wrongType.status).toBe(422);

    const applied = await api<{ settings: { uploadMaxBytes: number; autoPublishUploads: boolean } }>(
      ctx,
      '/api/admin/settings',
      { token: admin.token, method: 'PATCH', body: { uploadMaxBytes: 104_857_600, autoPublishUploads: true } }
    );
    expect(applied.status).toBe(200);
    expect(applied.body.settings.uploadMaxBytes).toBe(104_857_600);
    expect(applied.body.settings.autoPublishUploads).toBe(true);

    // The cached settings used by request handlers are refreshed immediately.
    const config = await api<{ upload: { maxBytes: number } }>(ctx, '/api/config');
    expect(config.body.upload.maxBytes).toBe(104_857_600);
  });

  it('requires an admin', async () => {
    expect((await api(ctx, '/api/admin/settings', { token: moderator.token })).status).toBe(403);
  });
});

describe('upload and playback failure inspection', () => {
  it('lists failed uploads and validates the status filter', async () => {
    const upload = await uploadTrack(ctx, user.token, buildMp3({ title: 'Doomed' }));
    await ctx.db
      .prepare("UPDATE upload_jobs SET status = 'failed', error_code = 'INTEGRITY_MISMATCH', error_message = 'Client hash did not match' WHERE track_id = ?")
      .bind(upload.trackId)
      .run();

    const list = await api<{ uploads: { id: string; errorCode: string; uploader: { email: string } }[] }>(ctx, '/api/admin/uploads?status=failed', {
      token: admin.token,
    });
    expect(list.status).toBe(200);
    expect(list.body.uploads).toHaveLength(1);
    expect(list.body.uploads[0]!.errorCode).toBe('INTEGRITY_MISMATCH');
    expect(list.body.uploads[0]!.uploader.email).toBe('listener@example.test');

    expect((await api(ctx, '/api/admin/uploads?status=nonsense', { token: admin.token })).status).toBe(400);
  });

  it('lists playback errors reported by the Android client', async () => {
    const posted = await api(ctx, '/api/playback/errors', {
      token: user.token,
      body: { trackId: 'trk_unknown', code: 'MEDIA_ERR_DECODE', message: 'Decoder init failed', platform: 'android' },
    });
    expect(posted.status).toBeLessThan(300);

    const list = await api<{ errors: { code: string; platform: string }[] }>(ctx, '/api/admin/playback-errors', { token: admin.token });
    expect(list.status).toBe(200);
    expect(list.body.errors[0]!.code).toBe('MEDIA_ERR_DECODE');
    expect(list.body.errors[0]!.platform).toBe('android');
  });
});

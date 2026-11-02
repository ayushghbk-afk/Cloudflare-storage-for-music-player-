import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestContext, TEST_PROVIDER_ID, type TestContext } from '../support/env';
import { api, publishTrack, registerAdmin, registerUser, type AuthResult } from '../support/client';
import { buildMp3 } from '../support/audio';

let ctx: TestContext;
let admin: AuthResult;
let user: AuthResult;

beforeEach(async () => {
  ctx = await createTestContext();
  admin = await registerAdmin(ctx);
  user = await registerUser(ctx, { email: 'plain@example.test' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  ctx.close();
});

const REMOTE_PROVIDER = {
  name: 'secondary-r2',
  kind: 'r2' as const,
  accountId: 'abcdef0123456789',
  bucketName: 'aether-music-secondary',
  endpoint: 'https://abcdef0123456789.r2.cloudflarestorage.com',
  authMode: 'credentials' as const,
  credentialRef: 'remote',
  priority: 50,
};

describe('authorization', () => {
  it('is admin-only', async () => {
    expect((await api(ctx, '/api/admin/storage')).status).toBe(401);
    expect((await api(ctx, '/api/admin/storage', { token: user.token })).status).toBe(403);
    expect((await api(ctx, '/api/admin/storage/providers', { token: user.token, body: REMOTE_PROVIDER })).status).toBe(403);
    expect((await api(ctx, '/api/admin/storage', { token: admin.token })).status).toBe(200);
  });
});

describe('listing providers', () => {
  it('reports the seeded binding provider without ever exposing secrets', async () => {
    const response = await api<{
      providers: Record<string, unknown>[];
      summary: { providerCount: number; enabledCount: number; totalCapacityBytes: number | null; providersWithRecordedCapacity: number };
    }>(ctx, '/api/admin/storage', { token: admin.token });

    expect(response.status).toBe(200);
    expect(response.body.providers).toHaveLength(1);
    const provider = response.body.providers[0]!;
    expect(provider.id).toBe(TEST_PROVIDER_ID);
    expect(provider.authMode).toBe('binding');
    expect(provider.capacityBytes).toBeNull();
    expect((provider.usage as { utilisation: number | null }).utilisation).toBeNull();
    // Capacity is never invented: without a recorded entitlement the total is null.
    expect(response.body.summary.totalCapacityBytes).toBeNull();
    expect(response.body.summary.providersWithRecordedCapacity).toBe(0);

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toMatch(/accessKeyId|secretAccessKey|ACCESS_KEY/i);
  });

  it('computes utilisation once a real capacity is recorded', async () => {
    await publishTrack(ctx, admin.token, admin.token, buildMp3({ title: 'Counted' }));

    await api(ctx, `/api/admin/storage/providers/${TEST_PROVIDER_ID}`, {
      token: admin.token,
      method: 'PATCH',
      body: { capacityBytes: 10_000_000 },
    });

    const response = await api<{
      providers: { usage: { usedBytes: number; objectCount: number; utilisation: number | null } }[];
      summary: { totalCapacityBytes: number | null; providersWithRecordedCapacity: number };
    }>(ctx, '/api/admin/storage', { token: admin.token });

    const usage = response.body.providers[0]!.usage;
    expect(usage.objectCount).toBe(1);
    expect(usage.usedBytes).toBeGreaterThan(0);
    expect(usage.utilisation).toBeGreaterThan(0);
    expect(usage.utilisation).toBeLessThan(0.01);
    expect(response.body.summary.totalCapacityBytes).toBe(10_000_000);
    expect(response.body.summary.providersWithRecordedCapacity).toBe(1);
  });
});

describe('creating providers', () => {
  it('rejects invalid configuration before touching storage', async () => {
    const badBucket = await api(ctx, '/api/admin/storage/providers', {
      token: admin.token,
      body: { ...REMOTE_PROVIDER, bucketName: 'Bad_Bucket!' },
    });
    expect(badBucket.status).toBe(422);

    const pathEndpoint = await api(ctx, '/api/admin/storage/providers', {
      token: admin.token,
      body: { ...REMOTE_PROVIDER, endpoint: 'https://account.r2.cloudflarestorage.com/aether-music' },
    });
    expect(pathEndpoint.status).toBe(422);
    expect(pathEndpoint.body).toMatchObject({ error: { message: expect.stringMatching(/without a bucket path/) } });

    const missingRef = await api(ctx, '/api/admin/storage/providers', {
      token: admin.token,
      body: { ...REMOTE_PROVIDER, credentialRef: undefined },
    });
    expect(missingRef.status).toBe(422);

    const unknownField = await api(ctx, '/api/admin/storage/providers', {
      token: admin.token,
      body: { ...REMOTE_PROVIDER, secretAccessKey: 'oops' },
    });
    expect(unknownField.status).toBe(422);
  });

  it('rejects a duplicate provider name', async () => {
    const response = await api(ctx, '/api/admin/storage/providers', {
      token: admin.token,
      body: { ...REMOTE_PROVIDER, name: 'primary', authMode: 'binding', credentialRef: undefined },
    });
    expect(response.status).toBe(409);
  });

  it('registers a credentials provider and reports it as unconfigured until secrets exist', async () => {
    const response = await api<{
      provider: { id: string; credentialRef: string; enabled: boolean; credentials: { available: boolean; missingSecrets: string[] } };
      health: { status: string; message: string };
    }>(ctx, '/api/admin/storage/providers', { token: admin.token, body: REMOTE_PROVIDER });

    expect(response.status).toBe(201);
    expect(response.body.provider.credentialRef).toBe('remote');
    expect(response.body.provider.enabled).toBe(true);
    expect(response.body.provider.credentials.available).toBe(false);
    expect(response.body.provider.credentials.missingSecrets).toEqual([
      'R2_REMOTE_ACCESS_KEY_ID',
      'R2_REMOTE_SECRET_ACCESS_KEY',
    ]);
    // Never guessed as healthy.
    expect(response.body.health.status).toBe('unconfigured');
    expect(response.body.health.message).toMatch(/Missing/);

    const row = await ctx.db
      .prepare('SELECT health_status FROM storage_providers WHERE id = ?')
      .bind(response.body.provider.id)
      .first<{ health_status: string }>();
    expect(row?.health_status).toBe('unconfigured');
  });

  it('probes a configured credentials provider over the S3 API', async () => {
    ctx.close();
    ctx = await createTestContext({
      overrides: {
        R2_REMOTE_ACCESS_KEY_ID: 'AKIAEXAMPLEKEY0000001',
        R2_REMOTE_SECRET_ACCESS_KEY: 'example-secret-key-value-0000000000000001',
      },
    });
    admin = await registerAdmin(ctx);

    const fetchMock = vi.fn(async () => new Response(null, { status: 200, headers: { etag: '"abc"' } }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await api<{ health: { status: string; latencyMs: number | null } }>(ctx, '/api/admin/storage/providers', {
      token: admin.token,
      body: REMOTE_PROVIDER,
    });

    expect(response.status).toBe(201);
    expect(response.body.health.status).toBe('healthy');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://abcdef0123456789.r2.cloudflarestorage.com/aether-music-secondary');
    // Header names are lowercase on the wire; HTTP treats them case-insensitively.
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLEKEY0000001\//);
    expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it('refuses a binding provider when the Worker has no R2 binding', async () => {
    ctx.close();
    ctx = await createTestContext({ binding: false, seedProvider: false });
    admin = await registerAdmin(ctx);

    const response = await api(ctx, '/api/admin/storage/providers', {
      token: admin.token,
      body: { ...REMOTE_PROVIDER, name: 'no-binding', authMode: 'binding', credentialRef: undefined },
    });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ error: { message: expect.stringMatching(/MUSIC_BUCKET/) } });
  });
});

describe('updating providers', () => {
  it('applies priority, enabled and capacity changes', async () => {
    const response = await api<{ provider: { priority: number; enabled: boolean; notes: string | null; capacityBytes: number } }>(
      ctx,
      `/api/admin/storage/providers/${TEST_PROVIDER_ID}`,
      { token: admin.token, method: 'PATCH', body: { priority: 5, enabled: false, capacityBytes: 5_000_000, notes: 'Paused for maintenance' } }
    );

    expect(response.status).toBe(200);
    expect(response.body.provider.priority).toBe(5);
    expect(response.body.provider.enabled).toBe(false);
    expect(response.body.provider.capacityBytes).toBe(5_000_000);
    expect(response.body.provider.notes).toBe('Paused for maintenance');
  });

  it('invalidates the health verdict when the endpoint changes', async () => {
    const response = await api<{ provider: { health: { status: string } } }>(ctx, `/api/admin/storage/providers/${TEST_PROVIDER_ID}`, {
      token: admin.token,
      method: 'PATCH',
      body: { bucketName: 'aether-music-renamed' },
    });
    expect(response.body.provider.health.status).toBe('unknown');
  });

  it('rejects an unknown provider and an unknown field', async () => {
    expect(
      (await api(ctx, '/api/admin/storage/providers/prv_missing', { token: admin.token, method: 'PATCH', body: { priority: 1 } })).status
    ).toBe(404);
    expect(
      (await api(ctx, `/api/admin/storage/providers/${TEST_PROVIDER_ID}`, { token: admin.token, method: 'PATCH', body: { colour: 'red' } })).status
    ).toBe(422);
  });
});

describe('health checks', () => {
  it('reports healthy for the bound bucket and persists the verdict', async () => {
    const one = await api<{ health: { status: string; providerId: string } }>(ctx, `/api/admin/storage/health/${TEST_PROVIDER_ID}/check`, {
      token: admin.token,
      method: 'POST',
      body: {},
    });
    expect(one.status).toBe(200);
    expect(one.body.health.status).toBe('healthy');
    expect(one.body.health.providerId).toBe(TEST_PROVIDER_ID);

    const all = await api<{ providers: { status: string }[]; note: string }>(ctx, '/api/admin/storage/health', { token: admin.token });
    expect(all.status).toBe(200);
    expect(all.body.providers).toHaveLength(1);
    expect(all.body.providers[0]!.status).toBe('healthy');
    expect(all.body.note).toMatch(/unconfigured/);

    const row = await ctx.db
      .prepare('SELECT health_status, health_checked_at FROM storage_providers WHERE id = ?')
      .bind(TEST_PROVIDER_ID)
      .first<{ health_status: string; health_checked_at: string }>();
    expect(row?.health_status).toBe('healthy');
    expect(row?.health_checked_at).toBeTruthy();
  });

  it('marks a bucket failure as an error without throwing', async () => {
    ctx.bucket.failure = new Error('R2 unavailable');
    const response = await api<{ health: { status: string; message: string } }>(ctx, `/api/admin/storage/health/${TEST_PROVIDER_ID}/check`, {
      token: admin.token,
      method: 'POST',
      body: {},
    });
    expect(response.status).toBe(200);
    expect(response.body.health.status).toBe('error');
    expect(response.body.health.message).toMatch(/R2 unavailable/);
  });
});

describe('integrity verification', () => {
  it('confirms an intact object and flags a tampered one', async () => {
    const trackId = await publishTrack(ctx, admin.token, admin.token, buildMp3({ title: 'Verify Me' }));
    const object = await ctx.db
      .prepare("SELECT id, object_key FROM storage_objects WHERE track_id = ? AND role = 'audio'")
      .bind(trackId)
      .first<{ id: string; object_key: string }>();

    const ok = await api<{ result: { ok: boolean; expectedSha256: string; actualSha256: string } }>(
      ctx,
      '/api/admin/storage/verify',
      { token: admin.token, method: 'POST', body: { trackId } }
    );
    expect(ok.status).toBe(200);
    expect(ok.body.result.ok).toBe(true);
    expect(ok.body.result.actualSha256).toBe(ok.body.result.expectedSha256);

    const entry = ctx.bucket.objects.get(object!.object_key)!;
    const tampered = entry.bytes.slice();
    const lastIndex = tampered.byteLength - 1;
    tampered[lastIndex] = (tampered[lastIndex] ?? 0) ^ 0xff;
    entry.bytes = tampered;

    const bad = await api<{ result: { ok: boolean; actualSha256: string } }>(ctx, '/api/admin/storage/verify', {
      token: admin.token,
      method: 'POST',
      body: { trackId },
    });
    expect(bad.status).toBe(200);
    expect(bad.body.result.ok).toBe(false);

    const row = await ctx.db
      .prepare('SELECT status FROM storage_objects WHERE id = ?')
      .bind(object!.id)
      .first<{ status: string }>();
    expect(row?.status).toBe('corrupt');

    // A corrupt copy is no longer served to listeners.
    const stream = await api(ctx, `/api/stream/${trackId}`);
    expect(stream.status).toBeGreaterThanOrEqual(500);
  });

  it('reports a missing object as unavailable', async () => {
    const trackId = await publishTrack(ctx, admin.token, admin.token, buildMp3({ title: 'Gone Missing' }));
    const object = await ctx.db
      .prepare("SELECT object_key FROM storage_objects WHERE track_id = ?")
      .bind(trackId)
      .first<{ object_key: string }>();
    ctx.bucket.objects.delete(object!.object_key);

    const response = await api(ctx, '/api/admin/storage/verify', { token: admin.token, method: 'POST', body: { trackId } });
    expect(response.status).toBe(503);
  });

  it('404s for an unknown track', async () => {
    expect(
      (await api(ctx, '/api/admin/storage/verify', { token: admin.token, method: 'POST', body: { trackId: 'trk_missing' } })).status
    ).toBe(404);
  });
});

describe('migrating objects between providers', () => {
  it('flips the primary pointer without changing the track ID and preserves playback', async () => {
    const trackId = await publishTrack(ctx, admin.token, admin.token, buildMp3({ title: 'Movable' }));
    const before = await api(ctx, `/api/stream/${trackId}`, { method: 'HEAD' });
    expect(before.status).toBe(200);

    const created = await api<{ provider: { id: string } }>(ctx, '/api/admin/storage/providers', {
      token: admin.token,
      body: { ...REMOTE_PROVIDER, name: 'bound-secondary', authMode: 'binding', credentialRef: undefined, priority: 60 },
    });
    expect(created.status).toBe(201);
    const targetId = created.body.provider.id;

    const migrated = await api<{
      result: { fromProviderId: string; toProviderId: string; sha256: string; bytes: number; deletedSource: boolean };
    }>(ctx, '/api/admin/storage/migrate', { token: admin.token, method: 'POST', body: { trackId, targetProviderId: targetId, deleteSource: true } });

    expect(migrated.status).toBe(200);
    expect(migrated.body.result.fromProviderId).toBe(TEST_PROVIDER_ID);
    expect(migrated.body.result.toProviderId).toBe(targetId);
    expect(migrated.body.result.bytes).toBeGreaterThan(0);
    expect(migrated.body.result.deletedSource).toBe(true);

    const primary = await ctx.db
      .prepare("SELECT provider_id, is_primary FROM storage_objects WHERE track_id = ? AND role = 'audio' AND is_primary = 1")
      .bind(trackId)
      .first<{ provider_id: string }>();
    expect(primary?.provider_id).toBe(targetId);

    const track = await ctx.db.prepare('SELECT id FROM tracks WHERE id = ?').bind(trackId).first<{ id: string }>();
    expect(track?.id).toBe(trackId);

    const after = await api(ctx, `/api/stream/${trackId}`, { method: 'HEAD' });
    expect(after.status).toBe(200);
  });

  it('refuses to migrate to the provider that already holds the object', async () => {
    const trackId = await publishTrack(ctx, admin.token, admin.token, buildMp3({ title: 'Same Place' }));
    const response = await api(ctx, '/api/admin/storage/migrate', {
      token: admin.token,
      method: 'POST',
      body: { trackId, targetProviderId: TEST_PROVIDER_ID },
    });
    expect(response.status).toBe(409);
  });

  it('refuses a missing or disabled target', async () => {
    const trackId = await publishTrack(ctx, admin.token, admin.token, buildMp3({ title: 'No Target' }));
    expect(
      (await api(ctx, '/api/admin/storage/migrate', { token: admin.token, method: 'POST', body: { trackId, targetProviderId: 'prv_nope' } })).status
    ).toBe(404);

    const created = await api<{ provider: { id: string } }>(ctx, '/api/admin/storage/providers', {
      token: admin.token,
      body: { ...REMOTE_PROVIDER, name: 'disabled-target', authMode: 'binding', credentialRef: undefined, enabled: false },
    });
    const response = await api(ctx, '/api/admin/storage/migrate', {
      token: admin.token,
      method: 'POST',
      body: { trackId, targetProviderId: created.body.provider.id },
    });
    expect(response.status).toBe(409);
  });
});

describe('deleting providers', () => {
  it('refuses to delete a provider that still holds objects', async () => {
    await publishTrack(ctx, admin.token, admin.token, buildMp3({ title: 'Held Hostage' }));
    const response = await api<{ error: { message: string } }>(ctx, `/api/admin/storage/providers/${TEST_PROVIDER_ID}`, {
      token: admin.token,
      method: 'DELETE',
    });
    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/still holds 1 objects/);
  });

  it('deletes an empty provider and writes an audit entry', async () => {
    const created = await api<{ provider: { id: string } }>(ctx, '/api/admin/storage/providers', {
      token: admin.token,
      body: { ...REMOTE_PROVIDER, name: 'spare-capacity', authMode: 'binding', credentialRef: undefined },
    });
    const response = await api<{ ok: boolean }>(ctx, `/api/admin/storage/providers/${created.body.provider.id}`, {
      token: admin.token,
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);

    const audit = await ctx.db
      .prepare("SELECT action FROM audit_logs WHERE action = 'storage.provider_deleted'")
      .first<{ action: string }>();
    expect(audit?.action).toBe('storage.provider_deleted');
  });
});

describe('routing with providers', () => {
  it('refuses new uploads when every provider is disabled', async () => {
    await api(ctx, `/api/admin/storage/providers/${TEST_PROVIDER_ID}`, { token: admin.token, method: 'PATCH', body: { enabled: false } });
    const bytes = buildMp3({ title: 'No Home' });
    const response = await api(ctx, '/api/upload/init', {
      token: user.token,
      body: { filename: 'no-home.mp3', size: bytes.byteLength, mimeType: 'audio/mpeg', rightsConfirmed: true },
    });
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: { message: expect.stringMatching(/No storage provider/) } });
  });
});

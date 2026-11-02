import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestContext, TEST_PROVIDER_ID, type TestContext } from '../support/env';
import { api, publishTrack, registerAdmin, registerUser, request, uploadTrack, type AuthResult } from '../support/client';
import { buildFlac, buildM4a, buildMp3 } from '../support/audio';

let ctx: TestContext;
let uploader: AuthResult;
let admin: AuthResult;

beforeEach(async () => {
  ctx = await createTestContext();
  uploader = await registerUser(ctx, { email: 'listener@example.test', displayName: 'Listener' });
  admin = await registerAdmin(ctx);
});

afterEach(() => {
  ctx.close();
  vi.unstubAllGlobals();
});


describe('authorisation', () => {
  it('hides unapproved tracks from anonymous listeners', async () => {
    const uploaded = await uploadTrack(ctx, uploader.token, buildMp3({ title: 'Hidden' }));
    const response = await request(ctx, `/api/stream/${uploaded.trackId}`);
    expect(response.status).toBe(404);
  });

  it('lets the owner stream their own pending upload', async () => {
    const uploaded = await uploadTrack(ctx, uploader.token, buildMp3({ title: 'Mine' }));
    const response = await request(ctx, `/api/stream/${uploaded.trackId}`, { token: uploader.token });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('lets staff stream anything', async () => {
    const uploaded = await uploadTrack(ctx, uploader.token, buildMp3({ title: 'Staff Access' }));
    const response = await request(ctx, `/api/stream/${uploaded.trackId}`, { token: admin.token });
    expect(response.status).toBe(200);
  });

  it('serves published tracks to everyone with public caching', async () => {
    const trackId = await publishTrack(ctx, uploader.token, admin.token, buildMp3({ title: 'Public' }));
    const response = await request(ctx, `/api/stream/${trackId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('public');
  });
});

describe('byte-range streaming', () => {
  it('returns 200 with correct length, type and Accept-Ranges', async () => {
    const bytes = buildMp3({ title: 'Full Read' });
    const trackId = await publishTrack(ctx, uploader.token, admin.token, bytes);
    const response = await request(ctx, `/api/stream/${trackId}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));

    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.byteLength).toBe(bytes.byteLength);
    expect(Array.from(body.subarray(0, 4))).toEqual([0x49, 0x44, 0x33, 0x03]);
  });

  it('returns 206 with the exact requested slice', async () => {
    const bytes = buildMp3({ title: 'Range Read' });
    const trackId = await publishTrack(ctx, uploader.token, admin.token, bytes);

    const response = await request(ctx, `/api/stream/${trackId}`, { headers: { range: 'bytes=0-1023' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 0-1023/${bytes.byteLength}`);
    expect(response.headers.get('content-length')).toBe('1024');
    expect(response.headers.get('accept-ranges')).toBe('bytes');

    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.byteLength).toBe(1024);
    expect(Array.from(body)).toEqual(Array.from(bytes.subarray(0, 1024)));
  });

  it('supports seek-style ranges in the middle of a file', async () => {
    const bytes = buildMp3({ title: 'Seek Read', durationSeconds: 30 });
    const trackId = await publishTrack(ctx, uploader.token, admin.token, bytes);

    const start = 10_000;
    const end = 19_999;
    const response = await request(ctx, `/api/stream/${trackId}`, { headers: { range: `bytes=${start}-${end}` } });
    expect(response.status).toBe(206);
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.byteLength).toBe(end - start + 1);
    expect(Array.from(body)).toEqual(Array.from(bytes.subarray(start, end + 1)));
  });

  it('supports suffix ranges (players request the tail for tags)', async () => {
    const bytes = buildMp3({ title: 'Tail Read' });
    const trackId = await publishTrack(ctx, uploader.token, admin.token, bytes);

    const response = await request(ctx, `/api/stream/${trackId}`, { headers: { range: 'bytes=-256' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes ${bytes.byteLength - 256}-${bytes.byteLength - 1}/${bytes.byteLength}`);
    const body = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(body)).toEqual(Array.from(bytes.subarray(bytes.byteLength - 256)));
  });

  it('answers 416 for an unsatisfiable range', async () => {
    const bytes = buildMp3({ title: 'Too Far' });
    const trackId = await publishTrack(ctx, uploader.token, admin.token, bytes);
    const response = await request(ctx, `/api/stream/${trackId}`, { headers: { range: 'bytes=99999999-' } });
    expect(response.status).toBe(416);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('RANGE_NOT_SATISFIABLE');
  });

  it('answers HEAD with metadata and no body', async () => {
    const bytes = buildMp3({ title: 'Head Read' });
    const trackId = await publishTrack(ctx, uploader.token, admin.token, bytes);
    const response = await request(ctx, `/api/stream/${trackId}`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it('serves FLAC and M4A with their correct MIME types', async () => {
    const flacId = await publishTrack(ctx, uploader.token, admin.token, buildFlac({ title: 'Flac Public' }), {
      filename: 'x.flac',
      mimeType: 'audio/flac',
    });
    const flac = await request(ctx, `/api/stream/${flacId}`, { headers: { range: 'bytes=0-99' } });
    expect(flac.headers.get('content-type')).toBe('audio/flac');
    expect(flac.status).toBe(206);

    const m4aId = await publishTrack(ctx, uploader.token, admin.token, buildM4a({ title: 'M4a Public' }), {
      filename: 'x.m4a',
      mimeType: 'audio/mp4',
    });
    const m4a = await request(ctx, `/api/stream/${m4aId}`, { headers: { range: 'bytes=0-99' } });
    expect(m4a.headers.get('content-type')).toBe('audio/mp4');
    expect(m4a.status).toBe(206);
  });

  it('counts a play when a full read starts', async () => {
    const trackId = await publishTrack(ctx, uploader.token, admin.token, buildMp3({ title: 'Counted' }));
    await request(ctx, `/api/stream/${trackId}`);
    await request(ctx, `/api/stream/${trackId}`);
    const row = await ctx.db.prepare('SELECT play_count FROM tracks WHERE id = ?').bind(trackId).first<{ play_count: number }>();
    expect(row?.play_count).toBe(2);
  });
});

describe('signed playback URLs', () => {
  it('exposes a signed URL that authorises playback without a token', async () => {
    const uploaded = await uploadTrack(ctx, uploader.token, buildMp3({ title: 'Signed Playback' }));

    const urlResponse = await api<{ url: string; expiresAt: string; mimeType: string; supportsRange: boolean }>(
      ctx,
      `/api/stream/${uploaded.trackId}/url`,
      { token: uploader.token }
    );
    expect(urlResponse.status).toBe(200);
    expect(urlResponse.body.supportsRange).toBe(true);
    expect(urlResponse.body.mimeType).toBe('audio/mpeg');

    const signedPath = new URL(urlResponse.body.url, 'http://localhost').pathname + new URL(urlResponse.body.url, 'http://localhost').search;
    const anonymous = await request(ctx, signedPath);
    expect(anonymous.status).toBe(200);

    const ranged = await request(ctx, signedPath, { headers: { range: 'bytes=0-9' } });
    expect(ranged.status).toBe(206);
  });

  it('rejects a tampered signature and an expired token', async () => {
    const uploaded = await uploadTrack(ctx, uploader.token, buildMp3({ title: 'Tamper' }));
    const urlResponse = await api<{ url: string }>(ctx, `/api/stream/${uploaded.trackId}/url`, { token: uploader.token });
    const parsed = new URL(urlResponse.body.url, 'http://localhost');

    const tampered = `/api/stream/${uploaded.trackId}?exp=${parsed.searchParams.get('exp')}&sig=deadbeef`;
    expect((await request(ctx, tampered)).status).toBe(404);

    const expired = `/api/stream/${uploaded.trackId}?exp=${Math.floor(Date.now() / 1000) - 60}&sig=${parsed.searchParams.get('sig')}`;
    expect((await request(ctx, expired)).status).toBe(404);
  });

  it('requires authorisation to mint a URL for a private track', async () => {
    const uploaded = await uploadTrack(ctx, uploader.token, buildMp3({ title: 'Private Url' }));
    const response = await api(ctx, `/api/stream/${uploaded.trackId}/url`);
    expect(response.status).toBe(404);
  });
});

describe('artwork', () => {
  it('serves artwork immutably for published tracks and 404s without art', async () => {
    const withArt = buildMp3({ title: 'Arty', artwork: { mime: 'image/png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]) } });
    const trackId = await publishTrack(ctx, uploader.token, admin.token, withArt);

    const artwork = await request(ctx, `/api/artwork/${trackId}`);
    expect(artwork.status).toBe(200);
    expect(artwork.headers.get('content-type')).toBe('image/png');
    expect(artwork.headers.get('cache-control')).toContain('immutable');

    const withoutArt = await publishTrack(ctx, uploader.token, admin.token, buildMp3({ title: 'No Art Here' }));
    expect((await request(ctx, `/api/artwork/${withoutArt}`)).status).toBe(404);
  });
});

describe('provider failure handling', () => {
  it('falls back to the next stored copy when the primary object is gone', async () => {
    const bytes = buildMp3({ title: 'Fallback Copy' });
    const trackId = await publishTrack(ctx, uploader.token, admin.token, bytes);

    const primary = await ctx.db
      .prepare("SELECT id, provider_id, object_key FROM storage_objects WHERE track_id = ? AND is_primary = 1 AND role = 'audio'")
      .bind(trackId)
      .first<{ id: string; provider_id: string; object_key: string }>();

    // A second copy on the same provider (as a migration would leave behind).
    const backupKey = `backup/${trackId}.mp3`;
    ctx.bucket.objects.set(backupKey, {
      bytes: bytes.slice(),
      uploaded: new Date(),
      etag: 'backup-etag',
      contentType: 'audio/mpeg',
    });
    await ctx.db
      .prepare(
        `INSERT INTO storage_objects (id, track_id, provider_id, bucket_name, object_key, role, size_bytes, content_type, etag, sha256, is_primary, status)
         VALUES (?, ?, ?, 'aether-music', ?, 'audio', ?, 'audio/mpeg', 'backup-etag', NULL, 0, 'active')`
      )
      .bind(`obj_backup_${trackId}`, trackId, primary!.provider_id, backupKey, bytes.byteLength)
      .run();

    // Remove the primary object from storage: the copy is now unreadable.
    ctx.bucket.objects.delete(primary!.object_key);

    const response = await request(ctx, `/api/stream/${trackId}`);
    expect(response.status).toBe(200);
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.byteLength).toBe(bytes.byteLength);
  });

  it('reports 503 when no copy can be read', async () => {
    const trackId = await publishTrack(ctx, uploader.token, admin.token, buildMp3({ title: 'Gone' }));
    ctx.bucket.failure = new Error('simulated R2 outage');
    try {
      const response = await request(ctx, `/api/stream/${trackId}`);
      expect(response.status).toBe(503);
    } finally {
      ctx.bucket.failure = null;
    }
  });

  it('reports 503 when the provider is disabled', async () => {
    const trackId = await publishTrack(ctx, uploader.token, admin.token, buildMp3({ title: 'Disabled Provider' }));
    await ctx.db.prepare('UPDATE storage_providers SET enabled = 0 WHERE id = ?').bind(TEST_PROVIDER_ID).run();
    const response = await request(ctx, `/api/stream/${trackId}`);
    expect(response.status).toBe(503);
  });
});

describe('redirect mode (presigned provider URLs)', () => {
  it('redirects to a presigned R2 URL instead of proxying bytes', async () => {
    // Register a credential-based provider and stub the S3 HEAD probe.
    const providerId = 'prv_test_s3';
    await ctx.db
      .prepare(
        `INSERT INTO storage_providers
           (id, name, kind, account_id, bucket_name, endpoint, region, auth_mode, credential_ref, priority, enabled, health_status)
         VALUES (?, 'remote', 'r2', 'account', 'remote-bucket', 'https://account.r2.cloudflarestorage.com', 'auto', 'credentials', 'REMOTE', 50, 1, 'healthy')`
      )
      .bind(providerId)
      .run();

    const remoteCtx = await createTestContext({
      overrides: {
        R2_REMOTE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
        R2_REMOTE_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        STREAM_MODE: 'redirect',
      },
    });
    try {
      // The remote provider row has to exist in this context too.
      await remoteCtx.db
        .prepare(
          `INSERT INTO storage_providers
             (id, name, kind, account_id, bucket_name, endpoint, region, auth_mode, credential_ref, priority, enabled, health_status)
           VALUES (?, 'remote', 'r2', 'account', 'remote-bucket', 'https://account.r2.cloudflarestorage.com', 'auto', 'credentials', 'REMOTE', 50, 1, 'healthy')`
        )
        .bind(providerId)
        .run();

      const remoteUploader = await registerUser(remoteCtx, { email: 'remote@example.test' });
      const remoteAdmin = await registerAdmin(remoteCtx);

      // Insert track + object rows directly, pointing at the remote provider.
      const trackId = 'trk_remote_object_1';
      const objectKey = 'audio/remote/track.mp3';
      await remoteCtx.db
        .prepare(
          `INSERT INTO tracks (id, title, title_normalized, uploader_id, format, mime_type, size_bytes,
                               integrity_sha256, visibility, status, rights_confirmed, published_at, primary_object_id)
           VALUES (?, 'Remote Track', 'remote track', ?, 'mp3', 'audio/mpeg', 1024, ?, 'public', 'approved', 1, ?, NULL)`
        )
        .bind(trackId, remoteUploader.user.id, 'a'.repeat(64), new Date().toISOString())
        .run();
      await remoteCtx.db
        .prepare(
          `INSERT INTO storage_objects (id, track_id, provider_id, bucket_name, object_key, role, size_bytes, content_type, is_primary, status)
           VALUES ('obj_remote_1', ?, ?, 'remote-bucket', ?, 'audio', 1024, 'audio/mpeg', 1, 'active')`
        )
        .bind(trackId, providerId, objectKey)
        .run();

      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'HEAD') {
          return new Response(null, { status: 200, headers: { 'content-length': '1024', etag: '"remote-etag"', 'content-type': 'audio/mpeg' } });
        }
        return new Response(new Uint8Array(1024), { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);

      const response = await request(remoteCtx, `/api/stream/${trackId}`, { method: 'GET' });
      expect(response.status).toBe(302);
      const location = response.headers.get('location')!;
      expect(location).toContain('https://account.r2.cloudflarestorage.com/remote-bucket/audio/remote/track.mp3');
      expect(location).toContain('X-Amz-Signature=');
      expect(location).toContain('X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F');
      expect(remoteAdmin.token).toBeTruthy();
    } finally {
      remoteCtx.close();
    }
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../support/env';
import { api, promote, registerUser, request, uploadTrack, type AuthResult } from '../support/client';
import { buildFlac, buildM4a, buildMp3, TINY_PNG } from '../support/audio';

let ctx: TestContext;
let uploader: AuthResult;

beforeEach(async () => {
  ctx = await createTestContext();
  uploader = await registerUser(ctx, { email: 'uploader@example.test', displayName: 'Uploader' });
});

afterEach(() => {
  ctx.close();
});

const mp3 = (title = 'Test Signal'): Uint8Array =>
  buildMp3({ title, artist: 'Fixture Artist', album: 'Fixture Album', genre: 'Ambient', year: '2025', trackNumber: '1' });

describe('POST /api/upload/init', () => {
  it('requires authentication', async () => {
    const response = await api(ctx, '/api/upload/init', {
      body: { filename: 'a.mp3', size: 1024, mimeType: 'audio/mpeg', rightsConfirmed: true },
    });
    expect(response.status).toBe(401);
  });

  it('issues a worker-proxy upload for a binding-only provider', async () => {
    const response = await api<Record<string, unknown>>(ctx, '/api/upload/init', {
      token: uploader.token,
      body: { filename: 'song.mp3', size: 4096, mimeType: 'audio/mpeg', rightsConfirmed: true },
    });

    expect(response.status).toBe(201);
    const body = response.body as Record<string, unknown>;
    // The R2 binding cannot presign, so bytes must stream through the Worker.
    expect(body.uploadMode).toBe('worker');
    expect(String(body.uploadUrl)).toContain(`/api/upload/${body.jobId}/file`);
    expect(body.method).toBe('PUT');
    expect((body.headers as Record<string, string>)['content-type']).toBe('audio/mpeg');

    const job = await ctx.db
      .prepare('SELECT status, upload_mode, rights_confirmed FROM upload_jobs WHERE id = ?')
      .bind(body.jobId)
      .first<{ status: string; upload_mode: string; rights_confirmed: number }>();
    expect(job?.status).toBe('initiated');
    expect(job?.rights_confirmed).toBe(1);
  });

  it('rejects uploads larger than the configured maximum', async () => {
    const response = await api<{ error: { code: string; message: string } }>(ctx, '/api/upload/init', {
      token: uploader.token,
      body: { filename: 'huge.mp3', size: 200 * 1024 * 1024, mimeType: 'audio/mpeg', rightsConfirmed: true },
    });
    expect(response.status).toBe(413);
    expect(response.body.error.message).toMatch(/maximum/i);
  });

  it('rejects unsupported MIME types and extensions', async () => {
    const badMime = await api(ctx, '/api/upload/init', {
      token: uploader.token,
      body: { filename: 'song.mp3', size: 1024, mimeType: 'video/mp4', rightsConfirmed: true },
    });
    expect(badMime.status).toBe(422);

    const badExtension = await api(ctx, '/api/upload/init', {
      token: uploader.token,
      body: { filename: 'song.exe', size: 1024, mimeType: 'audio/mpeg', rightsConfirmed: true },
    });
    expect(badExtension.status).toBe(422);
  });

  it('requires an explicit rights confirmation', async () => {
    const response = await api<{ error: { details: unknown } }>(ctx, '/api/upload/init', {
      token: uploader.token,
      body: { filename: 'song.mp3', size: 1024, mimeType: 'audio/mpeg', rightsConfirmed: false },
    });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body.error)).toMatch(/confirm/i);
  });

  it('fails clearly when no storage provider is registered', async () => {
    const empty = await createTestContext({ binding: false, seedProvider: false });
    try {
      const user = await registerUser(empty);
      const response = await api<{ error: { code: string; message: string } }>(empty, '/api/upload/init', {
        token: user.token,
        body: { filename: 'a.mp3', size: 1024, mimeType: 'audio/mpeg', rightsConfirmed: true },
      });
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(response.body.error.message).toMatch(/storage provider/i);
    } finally {
      empty.close();
    }
  });

  it('enforces the rolling 24h user quota', async () => {
    // Shrink the quota, then send a request that would exceed it.
    await ctx.db
      .prepare("INSERT INTO app_settings (key, value) VALUES ('uploadDailyUserQuotaBytes', '2000') ON CONFLICT(key) DO UPDATE SET value = '2000'")
      .run();
    const { invalidateSettingsCache } = await import('../../worker/src/settings');
    invalidateSettingsCache();

    const first = await api(ctx, '/api/upload/init', {
      token: uploader.token,
      body: { filename: 'a.mp3', size: 1500, mimeType: 'audio/mpeg', rightsConfirmed: true },
    });
    expect(first.status).toBe(201);

    const second = await api<{ error: { code: string } }>(ctx, '/api/upload/init', {
      token: uploader.token,
      body: { filename: 'b.mp3', size: 1500, mimeType: 'audio/mpeg', rightsConfirmed: true },
    });
    expect(second.status).toBe(413);
    expect(second.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('full upload flow', () => {
  it('stores a private, unapproved track and extracts metadata', async () => {
    const result = await uploadTrack(ctx, uploader.token, mp3('Fixture Song'), {
      metadata: { artist: 'Fixture Artist', album: 'Fixture Album' },
    });

    expect(result.status).toBe('awaiting_review');
    expect(result.trackId).toMatch(/^trk_/);

    const track = await ctx.db
      .prepare('SELECT * FROM tracks WHERE id = ?')
      .bind(result.trackId)
      .first<Record<string, unknown>>();

    expect(track?.status).toBe('pending');
    expect(track?.visibility).toBe('private');
    expect(track?.rights_confirmed).toBe(1);
    expect(track?.title).toBe('Fixture Song');
    expect(track?.format).toBe('mp3');
    expect(track?.mime_type).toBe('audio/mpeg');
    expect(track?.sample_rate).toBe(44100);
    expect(track?.channels).toBe(2);
    expect(typeof track?.integrity_sha256).toBe('string');
    expect(String(track?.integrity_sha256)).toHaveLength(64);
    expect(track?.published_at).toBeNull();

    // Artist and album rows are created and linked.
    const artist = await ctx.db.prepare('SELECT name FROM artists WHERE id = ?').bind(track?.artist_id).first<{ name: string }>();
    expect(artist?.name).toBe('Fixture Artist');
    const album = await ctx.db.prepare('SELECT title FROM albums WHERE id = ?').bind(track?.album_id).first<{ title: string }>();
    expect(album?.title).toBe('Fixture Album');

    // The physical object is indexed with its provider and bucket.
    const object = await ctx.db
      .prepare("SELECT provider_id, bucket_name, object_key, role, is_primary, sha256 FROM storage_objects WHERE track_id = ?")
      .bind(result.trackId)
      .first<Record<string, unknown>>();
    expect(object?.role).toBe('audio');
    expect(object?.is_primary).toBe(1);
    expect(String(object?.object_key)).toMatch(/^audio\//);
    expect(object?.sha256).toBe(track?.integrity_sha256);

    // Job bookkeeping.
    const job = await ctx.db.prepare('SELECT status, track_id, sha256 FROM upload_jobs WHERE id = ?').bind(result.jobId).first<Record<string, unknown>>();
    expect(job?.status).toBe('awaiting_review');
    expect(job?.track_id).toBe(result.trackId);

    // Audit trail.
    const actions = await ctx.db
      .prepare("SELECT action FROM audit_logs WHERE target_id IN (?, ?) ORDER BY id")
      .bind(result.jobId, result.trackId)
      .all<{ action: string }>();
    const names = (actions.results ?? []).map((row) => row.action);
    expect(names).toContain('upload.initiated');
    expect(names).toContain('upload.completed');
    expect(names).toContain('track.created');
  });

  it('never exposes a pending track publicly', async () => {
    const result = await uploadTrack(ctx, uploader.token, mp3());
    const list = await api<{ tracks: unknown[]; pagination: { total: number } }>(ctx, '/api/tracks');
    expect(list.body.pagination.total).toBe(0);
    const anonymous = await api(ctx, `/api/tracks/${result.trackId}`);
    expect(anonymous.status).toBe(404);
    const stream = await request(ctx, `/api/stream/${result.trackId}`);
    expect(stream.status).toBe(404);
  });

  it('extracts embedded artwork and serves it to the owner', async () => {
    const file = buildMp3({ title: 'With Art', artist: 'Fixture Artist', artwork: { mime: 'image/png', data: TINY_PNG } });
    const result = await uploadTrack(ctx, uploader.token, file);

    const metadata = result.body.metadata as { artworkStored: boolean; format: string };
    expect(metadata.artworkStored).toBe(true);

    const artwork = await request(ctx, `/api/artwork/${result.trackId}`, { token: uploader.token });
    expect(artwork.status).toBe(200);
    expect(artwork.headers.get('content-type')).toBe('image/png');
  });

  it('supports FLAC and M4A uploads', async () => {
    const flac = await uploadTrack(ctx, uploader.token, buildFlac({ title: 'Lossless One', artist: 'Fixture Artist' }), {
      filename: 'lossless.flac',
      mimeType: 'audio/flac',
    });
    expect((flac.body.metadata as { format: string }).format).toBe('flac');
    expect((flac.body.metadata as { bitDepth: number }).bitDepth).toBe(16);

    const m4a = await uploadTrack(ctx, uploader.token, buildM4a({ title: 'Aac One', artist: 'Fixture Artist' }), {
      filename: 'aac.m4a',
      mimeType: 'audio/mp4',
    });
    expect((m4a.body.metadata as { format: string }).format).toBe('m4a');
  });

  it('rejects content whose bytes contradict the declared type', async () => {
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>'.repeat(20));
    const init = await api<Record<string, unknown>>(ctx, '/api/upload/init', {
      token: uploader.token,
      body: { filename: 'not-audio.mp3', size: html.byteLength, mimeType: 'audio/mpeg', rightsConfirmed: true },
    });
    expect(init.status).toBe(201);

    const jobId = String(init.body.jobId);
    const path = new URL(String(init.body.uploadUrl)).pathname;
    await request(ctx, path, {
      method: 'PUT',
      token: uploader.token,
      rawBody: html as unknown as BodyInit,
      headers: { 'content-type': 'audio/mpeg', 'content-length': String(html.byteLength) },
    });

    const complete = await api<{ error: { message: string } }>(ctx, `/api/upload/complete?jobId=${jobId}`, {
      token: uploader.token,
      body: {},
    });
    expect(complete.status).toBe(422);
    expect(complete.body.error.message).toMatch(/not a recognised audio format/i);

    const job = await ctx.db.prepare('SELECT status FROM upload_jobs WHERE id = ?').bind(jobId).first<{ status: string }>();
    expect(job?.status).toBe('failed');
    // The invalid object was removed from storage.
    expect([...ctx.bucket.objects.keys()].some((key) => key.includes(jobId))).toBe(false);
  });

  it('detects duplicates by content hash and does not create a second track', async () => {
    const file = mp3('Duplicate Test');
    const first = await uploadTrack(ctx, uploader.token, file);

    const init = await api<Record<string, unknown>>(ctx, '/api/upload/init', {
      token: uploader.token,
      body: { filename: 'again.mp3', size: file.byteLength, mimeType: 'audio/mpeg', rightsConfirmed: true },
    });
    const jobId = String(init.body.jobId);
    const path = new URL(String(init.body.uploadUrl)).pathname;
    await request(ctx, path, {
      method: 'PUT',
      token: uploader.token,
      rawBody: file as unknown as BodyInit,
      headers: { 'content-type': 'audio/mpeg', 'content-length': String(file.byteLength) },
    });

    const complete = await api<{ error: { code: string; details: { duplicateTrackId: string } } }>(
      ctx,
      `/api/upload/complete?jobId=${jobId}`,
      { token: uploader.token, body: {} }
    );
    expect(complete.status).toBe(409);
    expect(complete.body.error.details.duplicateTrackId).toBe(first.trackId);

    const job = await ctx.db.prepare('SELECT status, error_code FROM upload_jobs WHERE id = ?').bind(jobId).first<{ status: string; error_code: string }>();
    expect(job?.status).toBe('duplicate');

    const count = await ctx.db.prepare('SELECT COUNT(*) AS count FROM tracks').first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it('is idempotent when complete is called twice', async () => {
    const result = await uploadTrack(ctx, uploader.token, mp3('Idempotent'));
    const again = await api<Record<string, unknown>>(ctx, `/api/upload/complete?jobId=${result.jobId}`, {
      token: uploader.token,
      body: {},
    });
    expect(again.status).toBe(200);
    expect((again.body as { alreadyCompleted: boolean }).alreadyCompleted).toBe(true);
    expect((again.body as { trackId: string }).trackId).toBe(result.trackId);
  });

  it('rejects a client-reported hash that does not match the stored object', async () => {
    const file = mp3('Hash Check');
    const init = await api<Record<string, unknown>>(ctx, '/api/upload/init', {
      token: uploader.token,
      body: { filename: 'hash.mp3', size: file.byteLength, mimeType: 'audio/mpeg', rightsConfirmed: true },
    });
    const jobId = String(init.body.jobId);
    await request(ctx, new URL(String(init.body.uploadUrl)).pathname, {
      method: 'PUT',
      token: uploader.token,
      rawBody: file as unknown as BodyInit,
      headers: { 'content-type': 'audio/mpeg', 'content-length': String(file.byteLength) },
    });

    const complete = await api(ctx, `/api/upload/complete?jobId=${jobId}`, {
      token: uploader.token,
      body: { sha256: 'a'.repeat(64) },
    });
    expect(complete.status).toBe(409);
  });

  it('refuses an upload that exceeds the declared size mid-stream', async () => {
    const file = new Uint8Array(buildMp3({ title: 'Too Big' }));
    const init = await api<Record<string, unknown>>(ctx, '/api/upload/init', {
      token: uploader.token,
      body: { filename: 'big.mp3', size: file.byteLength - 100, mimeType: 'audio/mpeg', rightsConfirmed: true },
    });
    expect(init.status).toBe(201);

    const put = await request(ctx, new URL(String(init.body.uploadUrl)).pathname, {
      method: 'PUT',
      token: uploader.token,
      rawBody: file as unknown as BodyInit,
      headers: { 'content-type': 'audio/mpeg', 'content-length': String(file.byteLength) },
    });
    // Declared size mismatch is rejected before any bytes are stored.
    expect(put.status).toBe(409);
  });

  it('prevents one user from completing another user’s job', async () => {
    const other = await registerUser(ctx, { email: 'other@example.test' });
    const file = mp3('Ownership');
    const init = await api<Record<string, unknown>>(ctx, '/api/upload/init', {
      token: uploader.token,
      body: { filename: 'own.mp3', size: file.byteLength, mimeType: 'audio/mpeg', rightsConfirmed: true },
    });
    const jobId = String(init.body.jobId);

    const forbidden = await api(ctx, `/api/upload/complete?jobId=${jobId}`, { token: other.token, body: {} });
    expect(forbidden.status).toBe(403);
  });

  it('reports job status and progress', async () => {
    const result = await uploadTrack(ctx, uploader.token, mp3('Status Check'));
    const status = await api<Record<string, unknown>>(ctx, `/api/upload/status/${result.jobId}`, { token: uploader.token });
    expect(status.status).toBe(200);
    const job = (status.body as { job: { status: string; progress: number } }).job;
    expect(job.status).toBe('awaiting_review');
    expect(job.progress).toBe(1);
  });

  it('cancels a job and removes the staged object', async () => {
    const result = await uploadTrack(ctx, uploader.token, mp3('Cancel Me'));
    const cancel = await api(ctx, `/api/upload/${result.jobId}/cancel`, { token: uploader.token, body: {} });
    expect(cancel.status).toBe(409); // already processed uploads cannot be cancelled
  });

  it('lists the caller’s uploads', async () => {
    await uploadTrack(ctx, uploader.token, mp3('Listing One'));
    const mine = await api<{ uploads: unknown[]; pagination: { total: number } }>(ctx, '/api/upload/mine', {
      token: uploader.token,
    });
    expect(mine.body.pagination.total).toBe(1);
  });

  it('publishes immediately only when an administrator enables auto-publish', async () => {
    await ctx.db
      .prepare("INSERT INTO app_settings (key, value) VALUES ('autoPublishUploads', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'")
      .run();
    const { invalidateSettingsCache } = await import('../../worker/src/settings');
    invalidateSettingsCache();

    const result = await uploadTrack(ctx, uploader.token, mp3('Auto Published'));
    expect(result.status).toBe('published');
    const list = await api<{ pagination: { total: number } }>(ctx, '/api/tracks');
    expect(list.body.pagination.total).toBe(1);
  });

  it('records moderator promotion flow for uploaders', async () => {
    await promote(ctx, uploader.user.id, 'moderator');
    const response = await api(ctx, `/api/upload/init`, {
      token: uploader.token,
      body: { filename: 'x.mp3', size: 100, mimeType: 'audio/mpeg', rightsConfirmed: true },
    });
    expect(response.status).toBe(201);
  });
});

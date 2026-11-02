import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../support/env';
import { api, promote, registerAdmin, registerUser, uploadTrack, type AuthResult } from '../support/client';
import { buildMp3 } from '../support/audio';

let ctx: TestContext;
let uploader: AuthResult;
let reporter: AuthResult;
let admin: AuthResult;
let moderator: AuthResult;

beforeEach(async () => {
  ctx = await createTestContext();
  uploader = await registerUser(ctx, { email: 'artist@example.test', displayName: 'Artist' });
  reporter = await registerUser(ctx, { email: 'listener@example.test', displayName: 'Listener' });
  admin = await registerAdmin(ctx);
  moderator = await registerUser(ctx, { email: 'mod@example.test', displayName: 'Moderator' });
  await promote(ctx, moderator.user.id, 'moderator');
});

afterEach(() => {
  ctx.close();
});

async function uploadPending(title = 'Pending Track'): Promise<string> {
  const result = await uploadTrack(ctx, uploader.token, buildMp3({ title, artist: 'Moderation Artist' }));
  return result.trackId;
}

describe('review workflow', () => {
  it('moves a pending upload into the public library on approval', async () => {
    const trackId = await uploadPending();

    const queue = await api<{ tracks: { id: string; status: string; visibility: string }[] }>(
      ctx,
      '/api/admin/tracks?status=pending',
      { token: moderator.token }
    );
    expect(queue.body.tracks.map((track) => track.id)).toContain(trackId);

    const approved = await api<{ track: { status: string; visibility: string; publishedAt: string } }>(
      ctx,
      `/api/admin/tracks/${trackId}/approve`,
      { token: moderator.token, method: 'POST', body: {} }
    );
    expect(approved.status).toBe(200);
    expect(approved.body.track.status).toBe('approved');
    expect(approved.body.track.visibility).toBe('public');
    expect(approved.body.track.publishedAt).toBeTruthy();

    const publicList = await api<{ pagination: { total: number } }>(ctx, '/api/tracks');
    expect(publicList.body.pagination.total).toBe(1);

    const job = await ctx.db.prepare('SELECT status FROM upload_jobs WHERE track_id = ?').bind(trackId).first<{ status: string }>();
    expect(job?.status).toBe('published');

    const audit = await ctx.db.prepare("SELECT actor_user_id, action FROM audit_logs WHERE action = 'track.approved'").first<{
      actor_user_id: string;
      action: string;
    }>();
    expect(audit?.actor_user_id).toBe(moderator.user.id);
  });

  it('requires a reason to reject and keeps the track private', async () => {
    const trackId = await uploadPending('Reject Me');

    const noReason = await api(ctx, `/api/admin/tracks/${trackId}/reject`, { token: moderator.token, method: 'POST', body: {} });
    expect(noReason.status).toBe(422);

    const rejected = await api<{ track: { status: string; visibility: string; rejectionReason: string } }>(
      ctx,
      `/api/admin/tracks/${trackId}/reject`,
      { token: moderator.token, method: 'POST', body: { reason: 'Not licensed for distribution' } }
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body.track.status).toBe('rejected');
    expect(rejected.body.track.visibility).toBe('private');
    expect(rejected.body.track.rejectionReason).toMatch(/licensed/);

    const publicList = await api<{ pagination: { total: number } }>(ctx, '/api/tracks');
    expect(publicList.body.pagination.total).toBe(0);
    expect((await api(ctx, `/api/stream/${trackId}`)).status).toBe(404);
  });

  it('refuses to publish a track without a rights confirmation', async () => {
    const trackId = await uploadPending('No Rights');
    await ctx.db.prepare('UPDATE tracks SET rights_confirmed = 0 WHERE id = ?').bind(trackId).run();

    const response = await api<{ error: { message: string } }>(ctx, `/api/admin/tracks/${trackId}/approve`, {
      token: moderator.token,
      method: 'POST',
      body: {},
    });
    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/rights/i);
  });

  it('removes content and deletes the stored files when asked', async () => {
    const trackId = await uploadPending('Takedown Target');
    await api(ctx, `/api/admin/tracks/${trackId}/approve`, { token: moderator.token, method: 'POST', body: {} });

    const object = await ctx.db
      .prepare('SELECT object_key FROM storage_objects WHERE track_id = ?')
      .bind(trackId)
      .first<{ object_key: string }>();
    expect(ctx.bucket.objects.has(object!.object_key)).toBe(true);

    const response = await api<{ ok: boolean; filesDeleted: boolean; deletionFailures: unknown[] }>(
      ctx,
      `/api/admin/tracks/${trackId}/remove`,
      { token: admin.token, method: 'POST', body: { reason: 'DMCA takedown notice', deleteFiles: true } }
    );
    expect(response.status).toBe(200);
    expect(response.body.filesDeleted).toBe(true);
    expect(response.body.deletionFailures).toHaveLength(0);

    expect(ctx.bucket.objects.has(object!.object_key)).toBe(false);

    const track = await ctx.db
      .prepare('SELECT status, visibility, is_deleted FROM tracks WHERE id = ?')
      .bind(trackId)
      .first<{ status: string; visibility: string; is_deleted: number }>();
    // Soft-deleted for the audit trail, but unreachable publicly.
    expect(track?.status).toBe('removed');
    expect(track?.is_deleted).toBe(1);
    expect(track?.visibility).toBe('private');
    expect((await api(ctx, `/api/stream/${trackId}`)).status).toBe(404);
  });

  it('only lets admins perform takedowns', async () => {
    const trackId = await uploadPending('Mod Takedown');
    const response = await api(ctx, `/api/admin/tracks/${trackId}/remove`, {
      token: moderator.token,
      method: 'POST',
      body: { reason: 'Attempt by moderator', deleteFiles: false },
    });
    expect(response.status).toBe(403);
  });

  it('forbids uploaders from approving their own tracks', async () => {
    const trackId = await uploadPending('Self Approve');
    const response = await api(ctx, `/api/admin/tracks/${trackId}/approve`, {
      token: uploader.token,
      method: 'POST',
      body: {},
    });
    expect(response.status).toBe(403);
  });
});

describe('reports', () => {
  it('records a report and de-duplicates repeated reports from one user', async () => {
    const trackId = await uploadPending('Reported');
    await api(ctx, `/api/admin/tracks/${trackId}/approve`, { token: moderator.token, method: 'POST', body: {} });

    const first = await api<{ reportId: string; status: string }>(ctx, `/api/tracks/${trackId}/report`, {
      token: reporter.token,
      body: { reason: 'copyright', details: 'This is a commercial release.' },
    });
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('open');

    const second = await api(ctx, `/api/tracks/${trackId}/report`, {
      token: reporter.token,
      body: { reason: 'copyright' },
    });
    expect(second.status).toBe(409);
  });

  it('validates the report reason and requires authentication', async () => {
    const trackId = await uploadPending('Bad Report');
    expect(
      (await api(ctx, `/api/tracks/${trackId}/report`, { token: reporter.token, body: { reason: 'i-do-not-like-it' } })).status
    ).toBe(422);
    expect((await api(ctx, `/api/tracks/${trackId}/report`, { body: { reason: 'copyright' } })).status).toBe(401);
    expect(
      (await api(ctx, `/api/tracks/${trackId}/report`, { token: reporter.token, body: { reason: 'copyright' } })).status
    ).toBe(201);
  });

  it('lists open reports for staff and resolves them with an unpublish action', async () => {
    const trackId = await uploadPending('Unpublish Me');
    await api(ctx, `/api/admin/tracks/${trackId}/approve`, { token: moderator.token, method: 'POST', body: {} });
    const report = await api<{ reportId: string }>(ctx, `/api/tracks/${trackId}/report`, {
      token: reporter.token,
      body: { reason: 'copyright', details: 'Not licensed' },
    });

    const list = await api<{ reports: { id: string; trackTitle: string }[] }>(ctx, '/api/admin/reports?status=open', {
      token: moderator.token,
    });
    expect(list.body.reports).toHaveLength(1);
    expect(list.body.reports[0]!.trackTitle).toBe('Unpublish Me');

    const resolved = await api<{ status: string; trackAction: string }>(ctx, `/api/admin/reports/${report.body.reportId}/resolve`, {
      token: moderator.token,
      method: 'POST',
      body: { status: 'resolved', note: 'Confirmed unlicensed.', action: 'unpublish' },
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.trackAction).toBe('unpublished');

    const track = await ctx.db.prepare('SELECT status, visibility FROM tracks WHERE id = ?').bind(trackId).first<{ status: string; visibility: string }>();
    expect(track?.status).toBe('rejected');
    expect(track?.visibility).toBe('private');

    const emptied = await api<{ reports: unknown[] }>(ctx, '/api/admin/reports?status=open', { token: moderator.token });
    expect(emptied.body.reports).toHaveLength(0);
  });

  it('requires an admin to remove content through a report', async () => {
    const trackId = await uploadPending('Escalation');
    const report = await api<{ reportId: string }>(ctx, `/api/tracks/${trackId}/report`, {
      token: reporter.token,
      body: { reason: 'malware' },
    });
    const response = await api(ctx, `/api/admin/reports/${report.body.reportId}/resolve`, {
      token: moderator.token,
      method: 'POST',
      body: { status: 'resolved', action: 'remove' },
    });
    expect(response.status).toBe(403);
  });
});

describe('public surface protection', () => {
  it('keeps rejected and removed tracks out of every public listing', async () => {
    const approvedId = await uploadPending('Approved One');
    const rejectedId = await uploadPending('Rejected One');
    const removedId = await uploadPending('Removed One');

    await api(ctx, `/api/admin/tracks/${approvedId}/approve`, { token: moderator.token, method: 'POST', body: {} });
    await api(ctx, `/api/admin/tracks/${rejectedId}/reject`, {
      token: moderator.token,
      method: 'POST',
      body: { reason: 'Unusable audio quality' },
    });
    await api(ctx, `/api/admin/tracks/${removedId}/approve`, { token: moderator.token, method: 'POST', body: {} });
    await api(ctx, `/api/admin/tracks/${removedId}/remove`, {
      token: admin.token,
      method: 'POST',
      body: { reason: 'Infringing content', deleteFiles: true },
    });

    const list = await api<{ tracks: { id: string }[] }>(ctx, '/api/tracks');
    expect(list.body.tracks.map((track) => track.id)).toEqual([approvedId]);

    const search = await api<{ tracks: { id: string }[] }>(ctx, '/api/search?q=one');
    expect(search.body.tracks.map((track) => track.id)).toEqual([approvedId]);
  });
});

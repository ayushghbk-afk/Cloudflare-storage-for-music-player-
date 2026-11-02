import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../support/env';
import { api, publishTrack, registerAdmin, registerUser, uploadTrack, type AuthResult } from '../support/client';
import { buildMp3 } from '../support/audio';

let ctx: TestContext;
let listener: AuthResult;
let admin: AuthResult;
let publicTrackId: string;

beforeEach(async () => {
  ctx = await createTestContext();
  listener = await registerUser(ctx, { email: 'library@example.test', displayName: 'Library Listener' });
  admin = await registerAdmin(ctx);
  publicTrackId = await publishTrack(ctx, admin.token, admin.token, buildMp3({ title: 'Public One', artist: 'Fixture Artist' }));
});

afterEach(() => {
  ctx.close();
});

describe('favourites', () => {
  it('adds, lists and removes a favourite idempotently', async () => {
    const add = await api(ctx, '/api/library/favorites', { token: listener.token, body: { trackId: publicTrackId } });
    expect(add.status).toBe(200);

    const again = await api<{ favorited: boolean }>(ctx, '/api/library/favorites', {
      token: listener.token,
      body: { trackId: publicTrackId },
    });
    expect(again.status).toBe(200);
    expect(again.body.favorited).toBe(true);

    const list = await api<{ tracks: { id: string }[] }>(ctx, '/api/library/favorites', { token: listener.token });
    expect(list.body.tracks.map((track) => track.id)).toEqual([publicTrackId]);

    const remove = await api(ctx, `/api/library/favorites/${publicTrackId}`, { token: listener.token, method: 'DELETE' });
    expect(remove.status).toBe(200);

    const empty = await api<{ tracks: unknown[] }>(ctx, '/api/library/favorites', { token: listener.token });
    expect(empty.body.tracks).toHaveLength(0);
  });

  it('rejects favouriting a track the caller cannot read', async () => {
    const privateUpload = await uploadTrack(ctx, admin.token, buildMp3({ title: 'Still Pending' }));
    const response = await api(ctx, '/api/library/favorites', {
      token: listener.token,
      body: { trackId: privateUpload.trackId },
    });
    expect(response.status).toBe(404);
  });

  it('requires authentication', async () => {
    const response = await api(ctx, '/api/library/favorites', { body: { trackId: publicTrackId } });
    expect(response.status).toBe(401);
  });
});

describe('play history', () => {
  it('records and lists listening history, then clears it', async () => {
    const post = await api(ctx, '/api/library/history', {
      token: listener.token,
      body: { trackId: publicTrackId, positionMs: 1200, completed: false, source: 'library', device: 'web' },
    });
    expect(post.status).toBe(201);

    const history = await api<{ history: { trackId: string; positionMs: number }[] }>(ctx, '/api/library/history', {
      token: listener.token,
    });
    expect(history.body.history).toHaveLength(1);
    expect(history.body.history[0]!.trackId).toBe(publicTrackId);
    expect(history.body.history[0]!.positionMs).toBe(1200);

    const clear = await api<{ deleted: number }>(ctx, '/api/library/history', { token: listener.token, method: 'DELETE' });
    expect(clear.body.deleted).toBe(1);
    const after = await api<{ history: unknown[] }>(ctx, '/api/library/history', { token: listener.token });
    expect(after.body.history).toHaveLength(0);
  });

  it('validates the payload', async () => {
    const badSource = await api(ctx, '/api/library/history', {
      token: listener.token,
      body: { trackId: publicTrackId, source: 'carrier-pigeon' },
    });
    expect(badSource.status).toBe(422);

    const missingTrack = await api(ctx, '/api/library/history', {
      token: listener.token,
      body: { trackId: 'trk_does_not_exist' },
    });
    expect(missingTrack.status).toBe(404);
  });
});

describe('GET /api/library', () => {
  it('aggregates favourites, history, uploads and playlists', async () => {
    await api(ctx, '/api/library/favorites', { token: listener.token, body: { trackId: publicTrackId } });
    await api(ctx, '/api/library/history', { token: listener.token, body: { trackId: publicTrackId } });
    const uploaded = await uploadTrack(ctx, listener.token, buildMp3({ title: 'My Upload' }));

    const library = await api<{
      favorites: unknown[];
      recentlyPlayed: unknown[];
      uploads: { id: string; status: string }[];
      counts: Record<string, number>;
    }>(ctx, '/api/library', { token: listener.token });

    expect(library.status).toBe(200);
    expect(library.body.favorites).toHaveLength(1);
    expect(library.body.recentlyPlayed).toHaveLength(1);
    expect(library.body.uploads).toHaveLength(1);
    expect(library.body.uploads[0]!.id).toBe(uploaded.trackId);
    expect(library.body.uploads[0]!.status).toBe('pending');
    expect(library.body.counts.pendingUploads).toBe(1);
    expect(library.body.counts.favorites).toBe(1);
  });
});

describe('playlists', () => {
  it('creates a private playlist and manages its tracks', async () => {
    const created = await api<{ playlist: { id: string; visibility: string } }>(ctx, '/api/playlists', {
      token: listener.token,
      body: { title: 'Late Night', description: 'Focus set' },
    });
    expect(created.status).toBe(201);
    expect(created.body.playlist.visibility).toBe('private');
    const playlistId = created.body.playlist.id;

    const addTrack = await api(ctx, `/api/playlists/${playlistId}/tracks`, {
      token: listener.token,
      body: { trackId: publicTrackId },
    });
    expect(addTrack.status).toBe(201);

    const duplicate = await api(ctx, `/api/playlists/${playlistId}/tracks`, {
      token: listener.token,
      body: { trackId: publicTrackId },
    });
    expect(duplicate.status).toBe(409);

    const detail = await api<{ playlist: { trackCount: number }; tracks: { id: string }[]; canEdit: boolean }>(
      ctx,
      `/api/playlists/${playlistId}`,
      { token: listener.token }
    );
    expect(detail.body.playlist.trackCount).toBe(1);
    expect(detail.body.tracks[0]!.id).toBe(publicTrackId);
    expect(detail.body.canEdit).toBe(true);

    const remove = await api(ctx, `/api/playlists/${playlistId}/tracks/${publicTrackId}`, {
      token: listener.token,
      method: 'DELETE',
    });
    expect(remove.status).toBe(200);

    const del = await api(ctx, `/api/playlists/${playlistId}`, { token: listener.token, method: 'DELETE' });
    expect(del.status).toBe(200);
  });

  it('hides private playlists from other users', async () => {
    const created = await api<{ playlist: { id: string } }>(ctx, '/api/playlists', {
      token: listener.token,
      body: { title: 'Secret Set' },
    });
    const playlistId = created.body.playlist.id;

    const anonymous = await api(ctx, `/api/playlists/${playlistId}`);
    expect(anonymous.status).toBe(404);

    const other = await registerUser(ctx, { email: 'other.listener@example.test' });
    expect((await api(ctx, `/api/playlists/${playlistId}`, { token: other.token })).status).toBe(404);

    const forbiddenEdit = await api(ctx, `/api/playlists/${playlistId}`, {
      token: other.token,
      method: 'PATCH',
      body: { title: 'Hijacked' },
    });
    expect(forbiddenEdit.status).toBe(404);
  });

  it('lists public playlists anonymously', async () => {
    const created = await api<{ playlist: { id: string } }>(ctx, '/api/playlists', {
      token: listener.token,
      body: { title: 'Public Set', visibility: 'public' },
    });
    const list = await api<{ playlists: { id: string }[] }>(ctx, '/api/playlists');
    expect(list.body.playlists.map((playlist) => playlist.id)).toContain(created.body.playlist.id);
  });

  it('rejects adding a track the user cannot read', async () => {
    const pending = await uploadTrack(ctx, admin.token, buildMp3({ title: 'Not Yours' }));
    const created = await api<{ playlist: { id: string } }>(ctx, '/api/playlists', {
      token: listener.token,
      body: { title: 'Inaccessible' },
    });
    const response = await api(ctx, `/api/playlists/${created.body.playlist.id}/tracks`, {
      token: listener.token,
      body: { trackId: pending.trackId },
    });
    expect(response.status).toBe(404);
  });

  it('enforces the playlist limit setting', async () => {
    await ctx.db
      .prepare("INSERT INTO app_settings (key, value) VALUES ('maxPlaylistsPerUser', '1') ON CONFLICT(key) DO UPDATE SET value = '1'")
      .run();
    const { invalidateSettingsCache } = await import('../../worker/src/settings');
    invalidateSettingsCache();

    expect((await api(ctx, '/api/playlists', { token: listener.token, body: { title: 'First' } })).status).toBe(201);
    expect((await api(ctx, '/api/playlists', { token: listener.token, body: { title: 'Second' } })).status).toBe(409);
  });
});

describe('browsing the public catalogue', () => {
  it('searches titles, artists and albums', async () => {
    await publishTrack(ctx, admin.token, admin.token, buildMp3({ title: 'Neon Rain', artist: 'Aurora Field', album: 'Night Drive' }));

    const byTitle = await api<{ tracks: { title: string }[] }>(ctx, '/api/search?q=neon');
    expect(byTitle.body.tracks.map((track) => track.title)).toContain('Neon Rain');

    const byArtist = await api<{ tracks: unknown[]; artists: { name: string }[] }>(ctx, '/api/search?q=aurora');
    expect(byArtist.body.tracks.length).toBeGreaterThan(0);
    expect(byArtist.body.artists.map((artist) => artist.name)).toContain('Aurora Field');

    const byAlbum = await api<{ albums: { title: string }[] }>(ctx, '/api/search?q=night');
    expect(byAlbum.body.albums.map((album) => album.title)).toContain('Night Drive');
  });

  it('is case and accent insensitive', async () => {
    await publishTrack(ctx, admin.token, admin.token, buildMp3({ title: 'Café Solaire', artist: 'Élodie' }));
    const response = await api<{ tracks: unknown[] }>(ctx, '/api/search?q=cafe solaire');
    expect(response.body.tracks.length).toBe(1);
  });

  it('returns an empty result for a blank query', async () => {
    const response = await api<{ tracks: unknown[]; albums: unknown[]; artists: unknown[] }>(ctx, '/api/search?q=');
    expect(response.body).toEqual({ query: '', tracks: [], albums: [], artists: [] });
  });

  it('lists albums and artists with only public tracks', async () => {
    await publishTrack(ctx, admin.token, admin.token, buildMp3({ title: 'Album Cut', artist: 'Group One', album: 'Record One' }));
    await uploadTrack(ctx, admin.token, buildMp3({ title: 'Pending Cut', artist: 'Group One', album: 'Record One' }));

    const albums = await api<{ albums: { title: string; trackCount: number }[] }>(ctx, '/api/albums');
    const recordOne = albums.body.albums.find((album) => album.title === 'Record One');
    expect(recordOne?.trackCount).toBe(1);

    const artists = await api<{ artists: { name: string; trackCount: number }[] }>(ctx, '/api/artists');
    const groupOne = artists.body.artists.find((artist) => artist.name === 'Group One');
    expect(groupOne?.trackCount).toBe(1);

    const albumId = (await ctx.db.prepare("SELECT id FROM albums WHERE title = 'Record One'").first<{ id: string }>())!.id;
    const detail = await api<{ album: { title: string }; tracks: { title: string }[] }>(ctx, `/api/albums/${albumId}`);
    expect(detail.body.album.title).toBe('Record One');
    expect(detail.body.tracks.map((track) => track.title)).toEqual(['Album Cut']);
  });

  it('filters the track list by artist, album, genre and format', async () => {
    const trackId = await publishTrack(
      ctx,
      admin.token,
      admin.token,
      buildMp3({ title: 'Filterable', artist: 'Filter Artist', album: 'Filter Album', genre: 'Jazz' })
    );
    const track = await ctx.db.prepare('SELECT artist_id, album_id FROM tracks WHERE id = ?').bind(trackId).first<{ artist_id: string; album_id: string }>();

    const byArtist = await api<{ pagination: { total: number } }>(ctx, `/api/tracks?artistId=${track!.artist_id}`);
    expect(byArtist.body.pagination.total).toBe(1);

    const byAlbum = await api<{ pagination: { total: number } }>(ctx, `/api/tracks?albumId=${track!.album_id}`);
    expect(byAlbum.body.pagination.total).toBe(1);

    const byGenre = await api<{ pagination: { total: number } }>(ctx, '/api/tracks?genre=jazz');
    expect(byGenre.body.pagination.total).toBe(1);

    const byFormat = await api<{ pagination: { total: number } }>(ctx, '/api/tracks?format=flac');
    expect(byFormat.body.pagination.total).toBe(0);
  });

  it('shows uploaders their own pending tracks through mine=1', async () => {
    const uploaded = await uploadTrack(ctx, listener.token, buildMp3({ title: 'Pending Mine' }));
    const mine = await api<{ tracks: { id: string; status: string }[] }>(ctx, '/api/tracks?mine=1', { token: listener.token });
    expect(mine.body.tracks.map((track) => track.id)).toContain(uploaded.trackId);
    expect(mine.body.tracks[0]!.status).toBe('pending');

    const anonymously = await api<{ tracks: unknown[] }>(ctx, '/api/tracks?mine=1');
    expect(anonymously.body.tracks).toHaveLength(0);
  });

  it('exposes artist pages with albums and top tracks', async () => {
    await publishTrack(ctx, admin.token, admin.token, buildMp3({ title: 'Artist Page Track', artist: 'Page Artist', album: 'Page Album' }));
    const artistId = (await ctx.db.prepare("SELECT id FROM artists WHERE name = 'Page Artist'").first<{ id: string }>())!.id;
    const page = await api<{ artist: { name: string }; albums: { title: string }[]; tracks: { title: string }[] }>(
      ctx,
      `/api/artists/${artistId}`
    );
    expect(page.body.artist.name).toBe('Page Artist');
    expect(page.body.albums[0]!.title).toBe('Page Album');
    expect(page.body.tracks[0]!.title).toBe('Artist Page Track');
  });
});

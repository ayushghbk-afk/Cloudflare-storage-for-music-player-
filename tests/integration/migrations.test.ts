import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS_DIR, createTestContext, type TestContext } from '../support/env';
import { loadMigrations, migrate, type MigrationDatabase } from '../../scripts/lib/migrations.mjs';
import { SqliteD1 } from '../support/d1';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => {
  ctx.close();
});

async function tables(): Promise<string[]> {
  const rows = await ctx.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all<{ name: string }>();
  return (rows.results ?? []).map((row) => row.name);
}

describe('schema', () => {
  it('creates every table the API depends on', async () => {
    const names = await tables();
    for (const table of [
      'users',
      'sessions',
      'app_settings',
      'rate_limits',
      'audit_logs',
      'artists',
      'albums',
      'tracks',
      'playlists',
      'playlist_tracks',
      'favorites',
      'play_history',
      'storage_providers',
      'storage_objects',
      'upload_jobs',
      'moderation_reports',
      'playback_errors',
      'd1_migrations',
    ]) {
      expect(names, `missing table ${table}`).toContain(table);
    }
  });

  it('creates the reporting views', async () => {
    const rows = await ctx.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name")
      .all<{ name: string }>();
    const views = (rows.results ?? []).map((row) => row.name);
    expect(views).toEqual(expect.arrayContaining(['public_tracks', 'storage_provider_usage']));
  });

  it('records each applied migration exactly once', async () => {
    const rows = await ctx.db
      .prepare('SELECT name FROM d1_migrations ORDER BY name')
      .all<{ name: string }>();
    const applied = (rows.results ?? []).map((row) => row.name);
    expect(applied).toEqual([
      '0001_core_identity.sql',
      '0002_catalog.sql',
      '0003_storage.sql',
      '0004_uploads_moderation.sql',
      '0005_views_and_settings.sql',
    ]);
  });

  it('is idempotent: re-running the migration engine is a no-op', async () => {
    const target: MigrationDatabase = {
      exec: (sql) => ctx.db.execSync(sql),
      query: (sql) => ctx.db.querySync(sql),
      run: (sql, params) => ctx.db.runSync(sql, params),
    };
    const result = await migrate(target, { dir: MIGRATIONS_DIR });
    expect(result.applied).toEqual([]);
    expect(result.total).toBe(5);
    const rows = await ctx.db.prepare('SELECT COUNT(*) AS count FROM d1_migrations').first<{ count: number }>();
    expect(rows?.count).toBe(5);
  });
});

describe('integrity constraints', () => {
  it('enforces foreign keys', async () => {
    await expect(
      ctx.db
        .prepare("INSERT INTO tracks (id, title, title_normalized, uploader_id) VALUES ('trk_orphan', 'Orphan', 'orphan', 'usr_missing')")
        .run()
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it('allows only one primary audio object per track', async () => {
    const trackId = await seedTrack();
    const providerId = 'prv_test_primary';
    await ctx.db
      .prepare(
        `INSERT INTO storage_objects (id, track_id, provider_id, role, object_key, bucket_name, size_bytes, content_type, is_primary)
         VALUES ('obj_one', ?, ?, 'audio', 'audio/one.mp3', 'aether-music', 10, 'audio/mpeg', 1)`
      )
      .bind(trackId, providerId)
      .run();

    await expect(
      ctx.db
        .prepare(
          `INSERT INTO storage_objects (id, track_id, provider_id, role, object_key, bucket_name, size_bytes, content_type, is_primary)
           VALUES ('obj_two', ?, ?, 'audio', 'audio/two.mp3', 'aether-music', 10, 'audio/mpeg', 1)`
        )
        .bind(trackId, providerId)
        .run()
    ).rejects.toThrow(/UNIQUE/);
  });

  it('rejects duplicate content through the primary-object hash index', async () => {
    const first = await seedTrack();
    const second = await seedTrack();
    const sha = 'a'.repeat(64);

    await ctx.db
      .prepare(
        `INSERT INTO storage_objects (id, track_id, provider_id, role, object_key, bucket_name, size_bytes, content_type, sha256, is_primary)
         VALUES ('obj_sha_one', ?, 'prv_test_primary', 'audio', 'audio/sha-one.mp3', 'aether-music', 10, 'audio/mpeg', ?, 1)`
      )
      .bind(first, sha)
      .run();

    await expect(
      ctx.db
        .prepare(
          `INSERT INTO storage_objects (id, track_id, provider_id, role, object_key, bucket_name, size_bytes, content_type, sha256, is_primary)
           VALUES ('obj_sha_two', ?, 'prv_test_primary', 'audio', 'audio/sha-two.mp3', 'aether-music', 10, 'audio/mpeg', ?, 1)`
        )
        .bind(second, sha)
        .run()
    ).rejects.toThrow(/UNIQUE/);
  });

  it('restricts roles, statuses and enum columns', async () => {
    await expect(
      ctx.db
        .prepare(
          `INSERT INTO users (id, email, email_normalized, password_hash, display_name, role)
           VALUES ('usr_badrole', 'bad@example.test', 'bad@example.test', 'x', 'Bad', 'root')`
        )
        .run()
    ).rejects.toThrow(/CHECK/);

    await expect(
      ctx.db
        .prepare(
          `INSERT INTO tracks (id, title, title_normalized, uploader_id, status)
           VALUES ('trk_badstatus', 'Bad', 'bad', 'usr_missing', 'whatever')`
        )
        .run()
    ).rejects.toThrow(/FOREIGN KEY|CHECK/);
  });

  it('deletes dependent rows when a user is hard-deleted', async () => {
    const { registerUser } = await import('../support/client');
    const user = await registerUser(ctx, { email: 'cascade@example.test' });
    const favorites = await ctx.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').bind(user.user.id).first<{ count: number }>();
    expect(favorites?.count).toBe(1);

    await ctx.db.prepare('DELETE FROM users WHERE id = ?').bind(user.user.id).run();
    const remaining = await ctx.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').bind(user.user.id).first<{ count: number }>();
    expect(remaining?.count).toBe(0);
  });
});

describe('public_tracks view', () => {
  it('only exposes approved, public, non-deleted tracks with confirmed rights', async () => {
    const ids = {
      good: await seedTrack({ status: 'approved', visibility: 'public' }),
      private: await seedTrack({ status: 'approved', visibility: 'private' }),
      pending: await seedTrack({ status: 'pending', visibility: 'public' }),
      noRights: await seedTrack({ status: 'approved', visibility: 'public', rights: 0 }),
      deleted: await seedTrack({ status: 'approved', visibility: 'public', isDeleted: 1 }),
    };

    const rows = await ctx.db.prepare('SELECT id FROM public_tracks').all<{ id: string }>();
    expect((rows.results ?? []).map((row) => row.id)).toEqual([ids.good]);
  });
});

describe('settings defaults', () => {
  it('seeds the documented defaults', async () => {
    const { loadSettings, SETTING_KEYS } = await import('../../worker/src/settings');
    const settings = await loadSettings(ctx.db);
    const rows = await ctx.db.prepare('SELECT key FROM app_settings').all<{ key: string }>();
    const keys = (rows.results ?? []).map((row) => row.key);
    for (const key of SETTING_KEYS) {
      expect(keys, `missing seeded setting ${key}`).toContain(key);
      expect(settings[key]).toBeDefined();
    }
  });
});

describe('migration file validation', () => {
  it('rejects misnamed migration files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aether-migrations-'));
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'not-numbered.sql'), 'CREATE TABLE x (id TEXT);\n');
      await expect(loadMigrations(dir)).rejects.toThrow(/Invalid migration filename/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a duplicated migration number', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aether-migrations-'));
    try {
      await writeFile(join(dir, '0001_first.sql'), 'CREATE TABLE a (id TEXT);\n');
      await writeFile(join(dir, '0001_second.sql'), 'CREATE TABLE b (id TEXT);\n');
      await expect(loadMigrations(dir)).rejects.toThrow(/duplicate|0001/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects an empty migration file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aether-migrations-'));
    try {
      await writeFile(join(dir, '0001_empty.sql'), '   \n');
      await expect(loadMigrations(dir)).rejects.toThrow(/empty/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not record a migration that failed to apply', async () => {
    const fresh = new SqliteD1();
    const dir = await mkdtemp(join(tmpdir(), 'aether-migrations-'));
    try {
      await writeFile(join(dir, '0001_broken.sql'), 'CREATE TABLE broken (id TEXT);\nCREATE TABLE broken (id TEXT);\n');
      await expect(
        migrate(
          { exec: (sql) => fresh.execSync(sql), query: (sql) => fresh.querySync(sql), run: (sql, params) => fresh.runSync(sql, params) },
          { dir }
        )
      ).rejects.toThrow(/0001_broken\.sql failed/);

      const recorded = await fresh.prepare('SELECT name FROM d1_migrations WHERE name = ?').bind('0001_broken.sql').first<{ name: string }>();
      expect(recorded).toBeNull();
    } finally {
      fresh.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

let trackCounter = 0;

async function seedTrack(
  options: { status?: string; visibility?: string; rights?: number; isDeleted?: number } = {}
): Promise<string> {
  trackCounter += 1;
  const id = `trk_seed_${trackCounter}`;
  const { registerUser } = await import('../support/client');
  const uploader = await registerUser(ctx, { email: `seed${trackCounter}@example.test` });
  await ctx.db
    .prepare(
      `INSERT INTO tracks (id, title, title_normalized, uploader_id, status, visibility, rights_confirmed, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      `Seed ${trackCounter}`,
      `seed ${trackCounter}`,
      uploader.user.id,
      options.status ?? 'approved',
      options.visibility ?? 'public',
      options.rights ?? 1,
      options.isDeleted ?? 0
    )
    .run();
  return id;
}

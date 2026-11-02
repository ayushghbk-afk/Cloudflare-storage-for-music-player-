#!/usr/bin/env node
/**
 * Validate database migrations without touching Cloudflare.
 *
 * Applies every file in `database/migrations` to a throwaway in-memory SQLite
 * database using the same engine the Worker and the tests use, then asserts:
 *
 *   1. filenames are sequential and well formed,
 *   2. every file applies cleanly,
 *   3. a second run is a no-op (idempotent),
 *   4. the expected tables/views/indexes exist,
 *   5. foreign keys are enforced,
 *   6. every migration is recorded exactly once.
 *
 * Exits non-zero on the first failure so CI blocks a broken migration.
 *
 * Usage: node scripts/validate-migrations.mjs [--dir database/migrations] [--quiet]
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_TABLE_SQL, appliedMigrationNames, loadMigrations, migrate } from './lib/migrations.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const args = process.argv.slice(2);
const dirArg = args.indexOf('--dir');
const migrationsDir = resolve(repoRoot, dirArg >= 0 ? args[dirArg + 1] : 'database/migrations');
const quiet = args.includes('--quiet');

const EXPECTED_TABLES = [
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
];

const EXPECTED_VIEWS = ['public_tracks', 'storage_provider_usage'];

const problems = [];

function fail(message) {
  problems.push(message);
}

function log(message) {
  if (!quiet) console.log(message);
}

function target(db) {
  return {
    exec: (sql) => db.exec(sql),
    query: (sql) => db.prepare(sql).all(),
    run: (sql, params = []) => db.prepare(sql).run(...params),
  };
}

function describe(db, type) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name")
    .all(type)
    .map((row) => String(row.name));
}

async function sums(dir) {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
  const checksums = [];
  for (const file of files) {
    const sql = await readFile(join(dir, file), 'utf8');
    checksums.push({ file, sha256: createHash('sha256').update(sql).digest('hex').slice(0, 16) });
  }
  return checksums;
}

async function main() {
  log(`Validating migrations in ${migrationsDir}\n`);

  const migrations = await loadMigrations(migrationsDir).catch((error) => {
    fail(`Could not load migrations: ${error.message}`);
    return [];
  });
  if (migrations.length === 0) {
    fail('No migration files were found.');
  }

  const checksums = await sums(migrationsDir);
  for (const entry of checksums) {
    log(`  ${entry.file.padEnd(34)} sha256:${entry.sha256}`);
  }
  log('');

  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');

    const first = await migrate(target(db), { dir: migrationsDir }).catch((error) => {
      fail(`Applying migrations failed: ${error.message}`);
      return { applied: [], total: 0 };
    });
    if (first.applied.length !== migrations.length) {
      fail(`Applied ${first.applied.length} of ${migrations.length} migrations.`);
    }

    const recorded = appliedMigrationNames(target(db));
    if (recorded.length !== migrations.length) {
      fail(`d1_migrations holds ${recorded.length} rows, expected ${migrations.length}.`);
    }
    if (new Set(recorded).size !== recorded.length) {
      fail('d1_migrations contains duplicate rows.');
    }

    // Idempotency: replaying must not re-apply or error.
    const second = await migrate(target(db), { dir: migrationsDir }).catch((error) => {
      fail(`Second migration run failed: ${error.message}`);
      return { applied: ['<error>'], total: 0 };
    });
    if (second.applied.length !== 0) {
      fail(`Second run re-applied: ${second.applied.join(', ')}`);
    }

    const tables = describe(db, 'table');
    for (const table of EXPECTED_TABLES) {
      if (!tables.includes(table)) fail(`Missing table: ${table}`);
    }
    const views = describe(db, 'view');
    for (const view of EXPECTED_VIEWS) {
      if (!views.includes(view)) fail(`Missing view: ${view}`);
    }

    const indexes = describe(db, 'index');
    if (indexes.length < 20) {
      fail(`Only ${indexes.length} indexes were created; expected the documented set (>= 20).`);
    }

    const fk = db.prepare('PRAGMA foreign_keys').get();
    if (!fk || Number(fk.foreign_keys) !== 1) {
      fail('Foreign key enforcement is not enabled.');
    }

    // A foreign key must actually reject a bad row.
    try {
      db.prepare("INSERT INTO tracks (id, title, title_normalized, uploader_id) VALUES ('trk_validate', 'X', 'x', 'usr_missing')").run();
      fail('Foreign keys are declared but not enforced: an orphan track insert succeeded.');
    } catch (error) {
      if (!/FOREIGN KEY/.test(String(error.message))) {
        fail(`Unexpected error while testing foreign keys: ${error.message}`);
      }
    }

    const settingCount = db.prepare('SELECT COUNT(*) AS count FROM app_settings').get();
    if (Number(settingCount?.count ?? 0) < 5) {
      fail('The default settings were not seeded by the migrations.');
    }

    // The bootstrap contract: `d1_migrations` must be the table wrangler itself uses.
    if (!MIGRATIONS_TABLE_SQL.includes('d1_migrations')) {
      fail('The migration bookkeeping table is not named d1_migrations.');
    }
  } finally {
    db.close();
  }

  if (problems.length > 0) {
    console.error(`\n✗ Migration validation failed (${problems.length} problem${problems.length === 1 ? '' : 's'}):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  log(`✓ ${migrations.length} migrations validated: schema, views, indexes, foreign keys and idempotency.`);
}

main().catch((error) => {
  console.error('Migration validation crashed:', error);
  process.exit(1);
});

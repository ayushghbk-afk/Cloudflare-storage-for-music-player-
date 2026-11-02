#!/usr/bin/env node
/**
 * List database migrations and, when a local wrangler state database exists,
 * which ones have already been applied.
 *
 * This never touches the network and never needs Cloudflare credentials: the
 * local D1 emulation is a SQLite file under `.wrangler/state` after
 * `npm run db:migrate:local`.
 *
 * Usage: node scripts/list-migrations.mjs [--json]
 */
import { createHash } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const migrationsDir = resolve(repoRoot, 'database/migrations');
const asJson = process.argv.includes('--json');

const LOCAL_DB_CANDIDATES = [
  'worker/.wrangler/state/v3/d1/miniflare-D1DatabaseObject',
  '.wrangler/state/v3/d1/miniflare-D1DatabaseObject',
];

async function findLocalDb() {
  for (const candidate of LOCAL_DB_CANDIDATES) {
    const dirPath = resolve(repoRoot, candidate);
    try {
      await access(dirPath);
      const files = await readdir(dirPath);
      const sqlite = files.filter((file) => file.endsWith('.sqlite')).sort();
      if (sqlite.length > 0) return { path: join(dirPath, sqlite[0]), files: sqlite.length };
    } catch {
      // Not present — the operator has not run the local migration yet.
    }
  }
  return null;
}

function appliedNames(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const hasTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'")
      .get();
    if (!hasTable) return new Set();
    return new Set(db.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map((row) => String(row.name)));
  } finally {
    db.close();
  }
}

async function main() {
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
  if (files.length === 0) {
    console.error(`No migrations found in ${migrationsDir}`);
    process.exit(1);
  }

  const local = await findLocalDb();
  const applied = local ? appliedNames(local.path) : new Set();

  const rows = [];
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    rows.push({
      name: file,
      statements: sql.split(/;\s*(?:\r?\n|$)/).filter((part) => part.trim() && !part.trim().startsWith('--')).length,
      sha256: createHash('sha256').update(sql).digest('hex'),
      applied: local ? applied.has(file) : null,
    });
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          migrationsDir,
          localDatabase: local ? { path: local.path, databaseFiles: local.files } : null,
          migrations: rows,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`Migrations in ${migrationsDir}`);
  console.log(local ? `Local D1 database: ${local.path}` : 'Local D1 database: not found (run `npm run db:migrate:local`)');
  console.log('');
  console.log('  #  Name                               Statements  Applied  sha256');
  rows.forEach((row, index) => {
    const status = row.applied === null ? '   ?   ' : row.applied ? '  yes  ' : '  no   ';
    console.log(`  ${String(index + 1).padStart(2, '0')} ${row.name.padEnd(34)} ${String(row.statements).padStart(10)}  ${status}  ${row.sha256.slice(0, 12)}`);
  });
  console.log('');
  if (local) {
    const pending = rows.filter((row) => row.applied === false);
    console.log(pending.length === 0 ? 'All migrations are applied locally.' : `${pending.length} pending locally: ${pending.map((row) => row.name).join(', ')}`);
  } else {
    console.log('Apply locally with: npm run db:migrate:local');
  }
  console.log('Remote D1 state is only visible with credentials: npx wrangler d1 migrations list DB --remote --config worker/wrangler.toml');
}

main().catch((error) => {
  console.error('Could not list migrations:', error);
  process.exit(1);
});

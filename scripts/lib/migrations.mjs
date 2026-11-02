/**
 * Migration engine shared by the CI validator and the local test harness.
 *
 * It deliberately mirrors `wrangler d1 migrations apply`:
 *   * migrations live in a directory, named `NNNN_description.sql`
 *   * applied migrations are recorded in `d1_migrations(name, applied_at)`
 *   * files are applied in filename order, exactly once
 *
 * Production deployments use wrangler itself; this engine exists so the same
 * migrations can be validated against real SQLite (node:sqlite) in CI without
 * Cloudflare credentials.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

const FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/**
 * @typedef {object} MigrationDatabase
 * @property {(sql: string) => void} exec                  run one or more statements
 * @property {(sql: string) => Record<string, unknown>[]} query  run a query returning rows
 * @property {(sql: string, params: unknown[]) => void} run       run a parameterised statement
 */

/**
 * @param {string} dir
 * @returns {Promise<{name: string, sql: string}[]>}
 */
export async function loadMigrations(dir) {
  const entries = await readdir(dir);
  const files = entries.filter((entry) => entry.endsWith('.sql')).sort();
  /** @type {{name: string, sql: string}[]} */
  const migrations = [];

  for (const file of files) {
    const match = FILENAME_PATTERN.exec(file);
    if (!match) {
      throw new Error(`Invalid migration filename "${file}". Expected NNNN_snake_case.sql`);
    }
    const sql = await readFile(join(dir, file), 'utf8');
    if (sql.trim().length === 0) {
      throw new Error(`Migration "${file}" is empty`);
    }
    migrations.push({ name: file, sql });
  }

  const prefixes = migrations.map((migration) => Number(FILENAME_PATTERN.exec(migration.name)[1]));
  for (let i = 1; i < prefixes.length; i += 1) {
    if (prefixes[i] <= prefixes[i - 1]) {
      throw new Error(
        `Migration numbering must be strictly increasing (${migrations[i - 1].name} -> ${migrations[i].name})`
      );
    }
  }
  if (prefixes.length > 0 && prefixes[0] !== 1) {
    throw new Error(`First migration must be numbered 0001 (found ${prefixes[0]})`);
  }
  return migrations;
}

/**
 * @param {MigrationDatabase} db
 * @returns {string[]}
 */
export function appliedMigrationNames(db) {
  db.exec(MIGRATIONS_TABLE_SQL);
  const rows = db.query('SELECT name FROM d1_migrations ORDER BY id');
  return rows.map((row) => String(row.name));
}

/**
 * Apply already-loaded migrations in order, skipping recorded ones.
 * @param {MigrationDatabase} db
 * @param {{name: string, sql: string}[]} migrations
 * @param {{ onApply?: (name: string) => void }} [options]
 * @returns {{ applied: string[], total: number }}
 */
export function applyMigrations(db, migrations, options = {}) {
  const applied = new Set(appliedMigrationNames(db));
  /** @type {string[]} */
  const executed = [];

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    try {
      db.exec(migration.sql);
    } catch (error) {
      throw new Error(`Migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    db.run('INSERT INTO d1_migrations (name) VALUES (?)', [migration.name]);
    executed.push(migration.name);
    options.onApply?.(migration.name);
  }

  return { applied: executed, total: migrations.length };
}

/**
 * Convenience wrapper: load + apply (async).
 * @param {MigrationDatabase} db
 * @param {{ dir: string, onApply?: (name: string) => void }} options
 */
export async function migrate(db, options) {
  const migrations = await loadMigrations(options.dir);
  return applyMigrations(db, migrations, options);
}

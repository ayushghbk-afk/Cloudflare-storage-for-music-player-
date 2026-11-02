import { DatabaseSync } from 'node:sqlite';
import type { D1Database, D1PreparedStatement, D1Result } from '../../worker/src/platform';

/**
 * A D1-compatible database backed by real SQLite (`node:sqlite`).
 *
 * Tests therefore exercise the actual production SQL — migrations, partial unique
 * indexes, CHECK constraints and FOREIGN KEYs included — instead of a mock that
 * could silently accept invalid statements.
 */
function normaliseParams(values: unknown[]): unknown[] {
  return values.map((value) => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.toISOString();
    return value;
  });
}

class SqliteStatement implements D1PreparedStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = []
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqliteStatement(this.db, this.sql, normaliseParams(values));
  }

  /** node:sqlite binds parameters per call rather than on the statement. */
  private args(): never[] {
    return this.params as never[];
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.args());
    return (row as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const rows = this.db.prepare(this.sql).all(...this.args()) as T[];
    return { results: rows, success: true, meta: { changes: 0 } };
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const info = this.db.prepare(this.sql).run(...this.args());
    return {
      results: [],
      success: true,
      meta: { changes: Number(info.changes ?? 0), last_row_id: Number(info.lastInsertRowid ?? 0) },
    };
  }
}

export class SqliteD1 implements D1Database {
  readonly raw: DatabaseSync;

  constructor(filename = ':memory:') {
    this.raw = new DatabaseSync(filename);
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA journal_mode = MEMORY');
  }

  prepare(query: string): D1PreparedStatement {
    return new SqliteStatement(this.raw, query);
  }

  async batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    // D1 runs a batch inside an implicit transaction.
    this.raw.exec('BEGIN');
    try {
      for (const statement of statements) {
        results.push(await statement.run<T>());
      }
      this.raw.exec('COMMIT');
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
    return results;
  }

  async exec(query: string): Promise<{ count: number }> {
    this.raw.exec(query);
    return { count: 0 };
  }

  /* Migration-runner adapter ------------------------------------------------- */
  execSync(sql: string): void {
    this.raw.exec(sql);
  }

  querySync(sql: string): Record<string, unknown>[] {
    return this.raw.prepare(sql).all() as Record<string, unknown>[];
  }

  runSync(sql: string, params: unknown[]): void {
    this.raw.prepare(sql).run(...(normaliseParams(params) as never[]));
  }

  close(): void {
    this.raw.close();
  }
}

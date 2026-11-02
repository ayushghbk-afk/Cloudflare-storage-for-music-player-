/**
 * Type declarations for the shared migration engine (`migrations.mjs`).
 */
export interface MigrationDatabase {
  /** Run one or more SQL statements. */
  exec(sql: string): void;
  /** Run a query and return rows. */
  query(sql: string): Record<string, unknown>[];
  /** Run a parameterised statement. */
  run(sql: string, params: unknown[]): void;
}

export interface LoadedMigration {
  name: string;
  sql: string;
}

export declare const MIGRATIONS_TABLE_SQL: string;
export declare function loadMigrations(dir: string): Promise<LoadedMigration[]>;
export declare function appliedMigrationNames(db: MigrationDatabase): string[];
export declare function applyMigrations(
  db: MigrationDatabase,
  migrations: LoadedMigration[],
  options?: { onApply?: (name: string) => void }
): { applied: string[]; total: number };
export declare function migrate(
  db: MigrationDatabase,
  options: { dir: string; onApply?: (name: string) => void }
): Promise<{ applied: string[]; total: number }>;

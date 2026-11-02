import { fileURLToPath } from 'node:url';
import { createApp } from '../../worker/src/app';
import { invalidateSettingsCache } from '../../worker/src/settings';
import type { Bindings } from '../../worker/src/platform';
import { SqliteD1 } from './d1';
import { MemoryBucket, MemoryKV } from './storage';
import { migrate } from '../../scripts/lib/migrations.mjs';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../database/migrations', import.meta.url));

export const TEST_SECRET = 'test-only-jwt-secret-value-please-change-1234567890';

export interface TestContext {
  env: Bindings;
  app: ReturnType<typeof createApp>;
  db: SqliteD1;
  bucket: MemoryBucket;
  kv: MemoryKV;
  close: () => void;
}

export interface TestEnvOptions {
  /** Bind the in-memory bucket to MUSIC_BUCKET (default: true). */
  binding?: boolean;
  /**
   * Register the binding as a storage provider row (default: true when bound).
   * In production this row is created by an administrator through
   * POST /api/admin/storage/providers — the API never invents providers.
   */
  seedProvider?: boolean;
  overrides?: Partial<Bindings>;
}

export const TEST_PROVIDER_ID = 'prv_test_primary';

/**
 * Boots a fully migrated API instance backed by in-memory SQLite and an in-memory
 * R2 bucket. No Cloudflare credentials are involved, which is exactly why these
 * tests can run in CI.
 */
export async function createTestContext(options: TestEnvOptions = {}): Promise<TestContext> {
  invalidateSettingsCache();

  const db = new SqliteD1();
  await migrate(
    {
      exec: (sql) => db.execSync(sql),
      query: (sql) => db.querySync(sql),
      run: (sql, params) => db.runSync(sql, params),
    },
    { dir: MIGRATIONS_DIR }
  );

  const bucket = new MemoryBucket();
  const kv = new MemoryKV();

  const env: Bindings = {
    DB: db,
    ...(options.binding === false ? {} : { MUSIC_BUCKET: bucket }),
    MUSIC_CACHE: kv,
    AETHER_ENV: 'test',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    JWT_SECRET: TEST_SECRET,
    JWT_ISSUER: 'aether-api-test',
    ACCESS_TOKEN_TTL_SECONDS: '900',
    REFRESH_TOKEN_TTL_DAYS: '30',
    // PBKDF2 at 50k iterations keeps the suite fast; production uses 210k and the
    // stored hash records its own parameters.
    PASSWORD_HASH_ITERATIONS: '50000',
    ...options.overrides,
  };

  if ((options.seedProvider ?? true) && options.binding !== false) {
    await db
      .prepare(
        `INSERT INTO storage_providers
           (id, name, kind, account_id, bucket_name, endpoint, region, auth_mode, credential_ref,
            priority, enabled, capacity_bytes, health_status, health_checked_at)
         VALUES (?, 'primary', 'r2', 'test-account', 'aether-music', 'https://test-account.r2.cloudflarestorage.com',
                 'auto', 'binding', NULL, 10, 1, NULL, 'healthy', ?)`
      )
      .bind(TEST_PROVIDER_ID, new Date().toISOString())
      .run();
  }

  invalidateSettingsCache();
  const app = createApp();

  return {
    env,
    app,
    db,
    bucket,
    kv,
    close: () => db.close(),
  };
}

/**
 * Platform bindings + minimal structural types for the Cloudflare runtime.
 *
 * We deliberately do not depend on the global `@cloudflare/workers-types`
 * package: the API only needs a small, well-defined slice of the platform, and
 * declaring it here keeps the worker compilable against plain DOM/ES2022 libs
 * and testable with in-memory shims (see `tests/support`).
 */

/* -------------------------------------------------------------------------- */
/* D1                                                                          */
/* -------------------------------------------------------------------------- */

export interface D1Meta {
  duration?: number;
  last_row_id?: number;
  changes?: number;
  served_by?: string;
  internal_stats?: unknown;
  rows_read?: number;
  rows_written?: number;
}

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: D1Meta;
  error?: string;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration?: number }>;
}

/* -------------------------------------------------------------------------- */
/* R2                                                                          */
/* -------------------------------------------------------------------------- */

export interface R2HTTPMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

export interface R2Object {
  key: string;
  size: number;
  etag: string;
  httpEtag?: string;
  uploaded?: Date;
  version?: string;
  checksums?: { md5?: ArrayBuffer; sha1?: ArrayBuffer; sha256?: ArrayBuffer };
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
}

export interface R2ObjectBody extends R2Object {
  body: ReadableStream<Uint8Array>;
  bodyUsed: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  blob(): Promise<unknown>;
}

export interface R2Range {
  offset?: number;
  length?: number;
  suffix?: number;
}

export interface R2GetOptions {
  range?: R2Range;
  onlyIf?: Record<string, unknown>;
}

export interface R2PutOptions {
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
  onlyIf?: Record<string, unknown>;
  md5?: ArrayBuffer;
  sha256?: ArrayBuffer;
}

export interface R2ListOptions {
  limit?: number;
  prefix?: string;
  cursor?: string;
  delimiter?: string;
  include?: ('httpMetadata' | 'customMetadata')[];
}

export interface R2Objects {
  objects: R2Object[];
  truncated: boolean;
  cursor?: string;
  delimitedPrefixes?: string[];
}

export interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null, options?: R2PutOptions): Promise<R2Object>;
  delete(key: string | string[]): Promise<void>;
  list(options?: R2ListOptions): Promise<R2Objects>;
}

/* -------------------------------------------------------------------------- */
/* KV                                                                          */
/* -------------------------------------------------------------------------- */

export interface KVNamespace {
  get(key: string): Promise<string | null>;
  get<T>(key: string, type: 'json'): Promise<T | null>;
  put(key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Worker execution context                                                    */
/* -------------------------------------------------------------------------- */

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/* -------------------------------------------------------------------------- */
/* Environment                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Worker bindings + variables.
 *
 * Everything after the platform bindings is configuration. Secrets are never
 * stored in the database: rows in `storage_providers` reference a *credential
 * reference* (e.g. `PRIMARY`) which resolves to `R2_PRIMARY_ACCESS_KEY_ID` /
 * `R2_PRIMARY_SECRET_ACCESS_KEY` Worker secrets at runtime.
 */
export interface Bindings {
  // Platform bindings
  DB: D1Database;
  MUSIC_CACHE?: KVNamespace;
  MUSIC_BUCKET?: R2Bucket;

  // Non-secret variables (wrangler.toml [vars])
  AETHER_ENV?: string;
  ALLOWED_ORIGINS?: string;
  JWT_ISSUER?: string;
  ACCESS_TOKEN_TTL_SECONDS?: string;
  REFRESH_TOKEN_TTL_DAYS?: string;
  STREAM_MODE?: string;
  PUBLIC_BASE_URL?: string;
  TURNSTILE_SITE_KEY?: string;
  BOOTSTRAP_ADMIN_EMAIL?: string;
  R2_DEFAULT_REGION?: string;
  DEFAULT_PROVIDER_ENDPOINT?: string;

  // Secrets (wrangler secret put / .dev.vars)
  JWT_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
  /**
   * Provider credentials are resolved dynamically:
   *   R2_<CREDENTIAL_REF>_ACCESS_KEY_ID
   *   R2_<CREDENTIAL_REF>_SECRET_ACCESS_KEY
   *   R2_<CREDENTIAL_REF>_SESSION_TOKEN (optional)
   */
  [key: string]: unknown;
}

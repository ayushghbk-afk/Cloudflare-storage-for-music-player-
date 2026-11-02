export type ProviderKind = 'r2' | 's3';
export type ProviderAuthMode = 'credentials' | 'binding';
export type HealthStatus = 'unknown' | 'healthy' | 'degraded' | 'error' | 'unconfigured';

/** A row of `storage_providers`. Contains no secrets. */
export interface StorageProviderRow {
  id: string;
  name: string;
  kind: ProviderKind;
  account_id: string | null;
  bucket_name: string;
  endpoint: string;
  region: string;
  auth_mode: ProviderAuthMode;
  credential_ref: string | null;
  priority: number;
  enabled: number;
  capacity_bytes: number | null;
  health_status: HealthStatus;
  health_checked_at: string | null;
  health_latency_ms: number | null;
  health_message: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ObjectHead {
  key: string;
  size: number;
  etag?: string;
  contentType?: string;
  uploadedAt?: string;
  customMetadata?: Record<string, string>;
}

export interface RangeSpec {
  offset: number;
  length: number;
}

export interface GetObjectResult {
  body: ReadableStream<Uint8Array>;
  /** Total size of the full object (not the ranged slice). */
  size: number;
  /** Size of the returned slice. */
  returnedBytes: number;
  contentType?: string;
  etag?: string;
}

export interface PutObjectOptions {
  contentType?: string;
  cacheControl?: string;
  customMetadata?: Record<string, string>;
  /**
   * Exact byte length of the body. Required when the body is a ReadableStream:
   * the R2 binding cannot store a stream of unknown length, and buffering would
   * defeat the point of streaming the upload through the Worker.
   */
  sizeBytes?: number;
}

export interface PutObjectResult {
  etag?: string;
  size: number;
}

export interface ListedObject {
  key: string;
  size: number;
}

export interface ProbeResult {
  status: HealthStatus;
  latencyMs: number;
  message: string;
}

/**
 * Every storage backend implements this interface. The rest of the application
 * (upload routing, streaming, integrity checks, migration) only ever sees this
 * contract, which is what makes additional providers addable without touching
 * the catalogue or streaming code.
 */
export interface StorageAdapter {
  readonly providerId: string;
  readonly bucketName: string;
  readonly canPresign: boolean;
  readonly canRangeRead: boolean;
  /** True when `put()` can consume a ReadableStream without buffering it. */
  readonly supportsStreamingWrite: boolean;
  head(key: string): Promise<ObjectHead | null>;
  get(key: string, range?: RangeSpec): Promise<GetObjectResult | null>;
  put(key: string, body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string, options?: PutObjectOptions): Promise<PutObjectResult>;
  delete(key: string): Promise<void>;
  list(prefix: string, limit?: number): Promise<{ objects: ListedObject[]; truncated: boolean }>;
  presignGet(key: string, expiresInSeconds: number): Promise<string | null>;
  presignPut(key: string, options: { contentType: string; expiresInSeconds: number }): Promise<string | null>;
  probe(): Promise<ProbeResult>;
}

export interface ResolvedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface CredentialStatus {
  available: boolean;
  mode: 'binding' | 'credentials' | 'missing';
  /** Environment variable names that must be configured, never their values. */
  requiredSecrets: string[];
  missingSecrets: string[];
}

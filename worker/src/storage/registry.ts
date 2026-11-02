import type { Bindings, D1Database } from '../platform';
import type { AppConfig } from '../config';
import { notConfigured } from '../utils/errors';
import type { Logger } from '../utils/logger';
import { BindingStorageAdapter, S3StorageAdapter } from './r2';
import type { CredentialStatus, ResolvedCredentials, StorageAdapter, StorageProviderRow } from './types';

/**
 * Provider credential resolution.
 *
 * Secrets never live in the database or in API responses. A provider row stores
 * only a `credential_ref`; the Worker secrets are named:
 *
 *   R2_<REF>_ACCESS_KEY_ID
 *   R2_<REF>_SECRET_ACCESS_KEY
 *   R2_<REF>_SESSION_TOKEN   (optional, for temporary credentials)
 *
 * Example: credential_ref = "primary"  ->  R2_PRIMARY_ACCESS_KEY_ID
 */
export function normaliseCredentialRef(ref: string): string {
  return ref.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function credentialEnvNames(credentialRef: string): {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
} {
  const ref = normaliseCredentialRef(credentialRef);
  return {
    accessKeyId: `R2_${ref}_ACCESS_KEY_ID`,
    secretAccessKey: `R2_${ref}_SECRET_ACCESS_KEY`,
    sessionToken: `R2_${ref}_SESSION_TOKEN`,
  };
}

function readEnvString(env: Bindings, name: string): string | undefined {
  const value = env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function credentialStatus(env: Bindings, provider: Pick<StorageProviderRow, 'auth_mode' | 'credential_ref'>): CredentialStatus {
  if (provider.auth_mode === 'binding') {
    const available = Boolean(env.MUSIC_BUCKET);
    return {
      available,
      mode: available ? 'binding' : 'missing',
      requiredSecrets: ['MUSIC_BUCKET (binding)'],
      missingSecrets: available ? [] : ['MUSIC_BUCKET (binding)'],
    };
  }

  if (!provider.credential_ref) {
    return { available: false, mode: 'missing', requiredSecrets: ['credential_ref'], missingSecrets: ['credential_ref'] };
  }

  const names = credentialEnvNames(provider.credential_ref);
  const required = [names.accessKeyId, names.secretAccessKey];
  const missing = required.filter((name) => !readEnvString(env, name));
  return {
    available: missing.length === 0,
    mode: missing.length === 0 ? 'credentials' : 'missing',
    requiredSecrets: required,
    missingSecrets: missing,
  };
}

export function resolveCredentials(env: Bindings, provider: Pick<StorageProviderRow, 'credential_ref'>): ResolvedCredentials | null {
  if (!provider.credential_ref) return null;
  const names = credentialEnvNames(provider.credential_ref);
  const accessKeyId = readEnvString(env, names.accessKeyId);
  const secretAccessKey = readEnvString(env, names.secretAccessKey);
  if (!accessKeyId || !secretAccessKey) return null;
  const sessionToken = readEnvString(env, names.sessionToken);
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

/**
 * Build an adapter for a provider, or return null when its credentials are not
 * configured yet (the caller decides whether that is a hard error).
 */
export function createAdapter(env: Bindings, provider: StorageProviderRow): StorageAdapter | null {
  if (provider.auth_mode === 'binding') {
    if (!env.MUSIC_BUCKET) return null;
    return new BindingStorageAdapter(env.MUSIC_BUCKET, provider);
  }
  const credentials = resolveCredentials(env, provider);
  if (!credentials) return null;
  return new S3StorageAdapter(provider, credentials);
}

export function requireAdapter(env: Bindings, provider: StorageProviderRow): StorageAdapter {
  const adapter = createAdapter(env, provider);
  if (adapter) return adapter;
  const status = credentialStatus(env, provider);
  throw notConfigured(
    `Storage provider "${provider.name}" has no usable credentials. Configure: ${status.missingSecrets.join(', ')}.`,
    { providerId: provider.id, missingSecrets: status.missingSecrets }
  );
}

const PROVIDER_COLUMNS = `id, name, kind, account_id, bucket_name, endpoint, region, auth_mode,
  credential_ref, priority, enabled, capacity_bytes, health_status, health_checked_at,
  health_latency_ms, health_message, notes, created_at, updated_at`;

export async function listProviders(db: D1Database): Promise<StorageProviderRow[]> {
  const result = await db.prepare(`SELECT ${PROVIDER_COLUMNS} FROM storage_providers ORDER BY priority ASC, name ASC`).all<StorageProviderRow>();
  return result.results ?? [];
}

export async function getProviderById(db: D1Database, id: string): Promise<StorageProviderRow | null> {
  return db.prepare(`SELECT ${PROVIDER_COLUMNS} FROM storage_providers WHERE id = ?`).bind(id).first<StorageProviderRow>();
}

export async function getProviderByName(db: D1Database, name: string): Promise<StorageProviderRow | null> {
  return db.prepare(`SELECT ${PROVIDER_COLUMNS} FROM storage_providers WHERE name = ?`).bind(name).first<StorageProviderRow>();
}

export interface ProviderUsage {
  provider_id: string;
  name: string;
  enabled: number;
  priority: number;
  capacity_bytes: number | null;
  object_count: number;
  used_bytes: number;
  last_object_at: string | null;
}

export async function listProviderUsage(db: D1Database): Promise<ProviderUsage[]> {
  const result = await db
    .prepare(
      `SELECT provider_id, name, enabled, priority, capacity_bytes, object_count, used_bytes, last_object_at
         FROM storage_provider_usage
        ORDER BY priority ASC, name ASC`
    )
    .all<ProviderUsage>();
  return result.results ?? [];
}

/** Persist the result of a health probe. */
export async function recordHealth(
  db: D1Database,
  providerId: string,
  result: { status: StorageProviderRow['health_status']; latencyMs: number | null; message: string | null },
  logger?: Logger
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE storage_providers
            SET health_status = ?, health_latency_ms = ?, health_message = ?, health_checked_at = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`
      )
      .bind(result.status, result.latencyMs, result.message, new Date().toISOString(), providerId)
      .run();
  } catch (error) {
    logger?.error('storage_health_persist_failed', { providerId, error });
  }
}

export type { AppConfig };

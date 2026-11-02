import type { Bindings, D1Database } from '../platform';
import type { Logger } from '../utils/logger';
import { createAdapter, credentialStatus, listProviders, recordHealth } from './registry';
import type { HealthStatus, StorageProviderRow } from './types';

export interface ProviderHealthReport {
  providerId: string;
  name: string;
  bucket: string;
  endpoint: string;
  enabled: boolean;
  priority: number;
  authMode: string;
  status: HealthStatus;
  latencyMs: number | null;
  message: string;
  checkedAt: string;
  credentials: { available: boolean; mode: string; requiredSecrets: string[]; missingSecrets: string[] };
  usage: { objectCount: number; usedBytes: number; capacityBytes: number | null };
}

/**
 * Probe a single provider and persist the outcome.
 *
 * A provider with missing credentials is reported as `unconfigured` — never as
 * healthy. This is what makes the dashboard honest about a half-finished setup.
 */
export async function probeProvider(
  env: Bindings,
  db: D1Database,
  provider: StorageProviderRow,
  logger?: Logger
): Promise<ProviderHealthReport> {
  const credentials = credentialStatus(env, provider);
  const checkedAt = new Date().toISOString();

  if (!credentials.available) {
    const message = `Not configured. Missing: ${credentials.missingSecrets.join(', ')}`;
    await recordHealth(db, provider.id, { status: 'unconfigured', latencyMs: null, message }, logger);
    return {
      providerId: provider.id,
      name: provider.name,
      bucket: provider.bucket_name,
      endpoint: provider.endpoint,
      enabled: provider.enabled === 1,
      priority: provider.priority,
      authMode: provider.auth_mode,
      status: 'unconfigured',
      latencyMs: null,
      message,
      checkedAt,
      credentials,
      usage: { objectCount: 0, usedBytes: 0, capacityBytes: provider.capacity_bytes },
    };
  }

  const adapter = createAdapter(env, provider);
  if (!adapter) {
    await recordHealth(db, provider.id, { status: 'unconfigured', latencyMs: null, message: 'Adapter unavailable.' }, logger);
    return {
      providerId: provider.id,
      name: provider.name,
      bucket: provider.bucket_name,
      endpoint: provider.endpoint,
      enabled: provider.enabled === 1,
      priority: provider.priority,
      authMode: provider.auth_mode,
      status: 'unconfigured',
      latencyMs: null,
      message: 'Adapter unavailable.',
      checkedAt,
      credentials,
      usage: { objectCount: 0, usedBytes: 0, capacityBytes: provider.capacity_bytes },
    };
  }

  const probe = await adapter.probe();
  await recordHealth(db, provider.id, { status: probe.status, latencyMs: probe.latencyMs, message: probe.message }, logger);
  logger?.info('storage_health_probe', {
    providerId: provider.id,
    status: probe.status,
    latencyMs: probe.latencyMs,
  });

  const usage = await db
    .prepare('SELECT object_count, used_bytes FROM storage_provider_usage WHERE provider_id = ?')
    .bind(provider.id)
    .first<{ object_count: number; used_bytes: number }>();

  return {
    providerId: provider.id,
    name: provider.name,
    bucket: provider.bucket_name,
    endpoint: provider.endpoint,
    enabled: provider.enabled === 1,
    priority: provider.priority,
    authMode: provider.auth_mode,
    status: probe.status,
    latencyMs: probe.latencyMs,
    message: probe.message,
    checkedAt,
    credentials,
    usage: {
      objectCount: usage?.object_count ?? 0,
      usedBytes: usage?.used_bytes ?? 0,
      capacityBytes: provider.capacity_bytes,
    },
  };
}

export async function probeAllProviders(
  env: Bindings,
  db: D1Database,
  logger?: Logger
): Promise<ProviderHealthReport[]> {
  const providers = await listProviders(db);
  const reports: ProviderHealthReport[] = [];
  // Sequential on purpose: parallel probes would hammer a struggling provider and
  // make latency numbers meaningless.
  for (const provider of providers) {
    reports.push(await probeProvider(env, db, provider, logger));
  }
  return reports;
}

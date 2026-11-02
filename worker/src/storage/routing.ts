import type { Bindings, D1Database } from '../platform';
import { unavailable } from '../utils/errors';
import type { Logger } from '../utils/logger';
import { createAdapter, credentialStatus, listProviderUsage } from './registry';
import type { StorageAdapter, StorageProviderRow } from './types';

/**
 * Upload routing.
 *
 * Deterministic and explainable:
 *   1. enabled providers only, ordered by `priority` (lower wins) then least used
 *   2. skip providers whose last health probe failed (`health_status = 'error'`)
 *   3. skip providers with no usable credentials (reported, never silently ignored)
 *   4. skip providers whose *admin-recorded* capacity would be exceeded
 *      (capacity is NULL unless an administrator entered a real figure)
 *
 * No provider is ever invented: with an empty registry the API answers 503 and
 * tells the operator to register one.
 */
export interface RoutingCandidate {
  provider: StorageProviderRow;
  adapter: StorageAdapter;
  usedBytes: number;
  objectCount: number;
  capacityBytes: number | null;
}

export interface SkippedProvider {
  providerId: string;
  name: string;
  reason: string;
}

export type RoutingDecision =
  | { ok: true; selected: RoutingCandidate; skipped: SkippedProvider[] }
  | { ok: false; skipped: SkippedProvider[] };

export interface RoutingOptions {
  /** Bytes the incoming object is expected to need. */
  estimatedBytes: number;
  /** Prefer providers that can presign (direct browser upload). */
  preferPresign?: boolean;
}

export async function selectUploadProvider(
  env: Bindings,
  db: D1Database,
  options: RoutingOptions
): Promise<RoutingDecision> {
  const usage = await listProviderUsage(db);
  const skipped: SkippedProvider[] = [];

  if (usage.length === 0) {
    return { ok: false, skipped };
  }

  const providers = await db
    .prepare(
      `SELECT id, name, kind, account_id, bucket_name, endpoint, region, auth_mode, credential_ref,
              priority, enabled, capacity_bytes, health_status, health_checked_at, health_latency_ms,
              health_message, notes, created_at, updated_at
         FROM storage_providers
        WHERE enabled = 1
        ORDER BY priority ASC, name ASC`
    )
    .all<StorageProviderRow>();

  const candidates: RoutingCandidate[] = [];

  for (const provider of providers.results ?? []) {
    const providerUsage = usage.find((entry) => entry.provider_id === provider.id);
    const usedBytes = providerUsage?.used_bytes ?? 0;
    const objectCount = providerUsage?.object_count ?? 0;

    if (provider.health_status === 'error') {
      skipped.push({ providerId: provider.id, name: provider.name, reason: 'last health check failed' });
      continue;
    }

    const credentials = credentialStatus(env, provider);
    if (!credentials.available) {
      skipped.push({
        providerId: provider.id,
        name: provider.name,
        reason: `credentials not configured (${credentials.missingSecrets.join(', ')})`,
      });
      continue;
    }

    const capacityBytes = provider.capacity_bytes;
    if (capacityBytes !== null && usedBytes + options.estimatedBytes > capacityBytes) {
      skipped.push({
        providerId: provider.id,
        name: provider.name,
        reason: `capacity would be exceeded (${usedBytes} + ${options.estimatedBytes} > ${capacityBytes})`,
      });
      continue;
    }

    const adapter = createAdapter(env, provider);
    if (!adapter) {
      skipped.push({ providerId: provider.id, name: provider.name, reason: 'adapter could not be created' });
      continue;
    }

    candidates.push({ provider, adapter, usedBytes, objectCount, capacityBytes });
  }

  if (candidates.length === 0) return { ok: false, skipped };

  if (options.preferPresign) {
    candidates.sort((a, b) => {
      if (a.adapter.canPresign !== b.adapter.canPresign) return a.adapter.canPresign ? -1 : 1;
      if (a.provider.priority !== b.provider.priority) return a.provider.priority - b.provider.priority;
      return a.usedBytes - b.usedBytes;
    });
  } else {
    candidates.sort((a, b) => {
      if (a.provider.priority !== b.provider.priority) return a.provider.priority - b.provider.priority;
      return a.usedBytes - b.usedBytes;
    });
  }

  // Disabled/failed providers are reported for logging, not exposed to end users.
  return { ok: true, selected: candidates[0]!, skipped };
}

export function assertRouting(decision: RoutingDecision, logger?: Logger): RoutingCandidate {
  if (decision.ok) return decision.selected;
  logger?.warn('storage_routing_failed', { skipped: decision.skipped });
  throw unavailable(
    'No storage provider is available to accept uploads. An administrator must register and configure an R2 bucket.',
    { skipped: decision.skipped }
  );
}

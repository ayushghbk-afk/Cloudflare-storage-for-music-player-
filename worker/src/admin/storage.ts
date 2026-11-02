import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { conflict, notFound, validationFailed } from '../utils/errors';
import { readJson } from '../utils/http';
import { writeAudit } from '../utils/audit';
import { invalidatePublicConfigCache } from '../cache';
import { newId } from '../utils/ids';
import { requireAdmin } from '../auth/middleware';
import { credentialStatus, getProviderById, listProviderUsage, listProviders, recordHealth } from '../storage/registry';
import { probeAllProviders, probeProvider } from '../storage/health';
import { migrateTrackObject } from '../storage/migration';
import { verifyObjectIntegrity } from '../storage/integrity';

/**
 * Storage administration.
 *
 * Credentials never appear in a request or response body: a provider references a
 * Worker secret namespace (`credentialRef`), and the API only reports *which*
 * secret names are missing.
 */
export const adminStorageRoutes = new Hono<AppEnv>();

const nameSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{2,39}$/, 'Use 3-40 lowercase letters, digits, - or _');
const bucketSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, 'R2 bucket names are 3-63 lowercase letters, digits or hyphens');
const credentialRefSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{2,40}$/, 'Credential references are 2-40 letters, digits, - or _');

const createProviderSchema = z.strictObject({
  name: nameSchema,
  kind: z.enum(['r2', 's3']).default('r2'),
  accountId: z.string().trim().max(64).optional(),
  bucketName: bucketSchema,
  endpoint: z.url('Endpoint must be a valid URL'),
  region: z.string().trim().max(40).optional(),
  authMode: z.enum(['credentials', 'binding']).default('credentials'),
  credentialRef: credentialRefSchema.optional(),
  priority: z.number().int().min(0).max(10_000).default(100),
  enabled: z.boolean().default(true),
  capacityBytes: z.number().int().min(0).max(1_099_511_627_776).nullable().optional(),
  notes: z.string().trim().max(1000).optional(),
});

const updateProviderSchema = z.strictObject({
  name: nameSchema.optional(),
  bucketName: bucketSchema.optional(),
  endpoint: z.url().optional(),
  region: z.string().trim().max(40).optional(),
  authMode: z.enum(['credentials', 'binding']).optional(),
  credentialRef: credentialRefSchema.nullable().optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  enabled: z.boolean().optional(),
  capacityBytes: z.number().int().min(0).max(1_099_511_627_776).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

const verifySchema = z.strictObject({
  trackId: z.string().min(3).max(64),
  objectId: z.string().min(3).max(64).optional(),
});

const migrateSchema = z.strictObject({
  trackId: z.string().min(3).max(64),
  targetProviderId: z.string().min(3).max(64),
  deleteSource: z.boolean().optional(),
});

function assertHttpsEndpoint(endpoint: string, isProduction: boolean): void {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' && !(url.hostname === 'localhost' || url.hostname === '127.0.0.1') && isProduction) {
    throw validationFailed('Provider endpoints must use HTTPS in production.');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw validationFailed('Endpoint must be the account/API root without a bucket path (e.g. https://<account>.r2.cloudflarestorage.com).');
  }
}

function providerResponse(
  provider: Awaited<ReturnType<typeof listProviders>>[number],
  env: AppEnv['Bindings'],
  usage?: { usedBytes: number; objectCount: number }
): Record<string, unknown> {
  const credentials = credentialStatus(env, provider);
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    accountId: provider.account_id,
    bucketName: provider.bucket_name,
    endpoint: provider.endpoint,
    region: provider.region,
    authMode: provider.auth_mode,
    credentialRef: provider.credential_ref,
    priority: provider.priority,
    enabled: provider.enabled === 1,
    capacityBytes: provider.capacity_bytes,
    notes: provider.notes,
    health: {
      status: provider.health_status,
      checkedAt: provider.health_checked_at,
      latencyMs: provider.health_latency_ms,
      message: provider.health_message,
    },
    credentials,
    usage: {
      usedBytes: usage?.usedBytes ?? 0,
      objectCount: usage?.objectCount ?? 0,
      capacityBytes: provider.capacity_bytes,
      // Null means "not reported", never a fabricated figure.
      utilisation: provider.capacity_bytes && provider.capacity_bytes > 0
        ? Number(((usage?.usedBytes ?? 0) / provider.capacity_bytes).toFixed(4))
        : null,
    },
    createdAt: provider.created_at,
    updatedAt: provider.updated_at,
  };
}

/** GET /api/admin/storage */
adminStorageRoutes.get('/', async (c) => {
  await requireAdmin(c);
  const providers = await listProviders(c.env.DB);
  const usage = await listProviderUsage(c.env.DB);

  const mapped = providers.map((provider) => {
    const entry = usage.find((row) => row.provider_id === provider.id);
    return providerResponse(provider, c.env, {
      usedBytes: entry?.used_bytes ?? 0,
      objectCount: entry?.object_count ?? 0,
    });
  });

  const totalUsedBytes = usage.reduce((sum, row) => sum + (row.used_bytes ?? 0), 0);
  const capacities = providers.map((provider) => provider.capacity_bytes).filter((value): value is number => value !== null);

  return c.json({
    providers: mapped,
    summary: {
      providerCount: providers.length,
      enabledCount: providers.filter((provider) => provider.enabled === 1).length,
      totalUsedBytes,
      objectCount: usage.reduce((sum, row) => sum + (row.object_count ?? 0), 0),
      /** Only present when every provider has an administrator-recorded capacity. */
      totalCapacityBytes: capacities.length === providers.length && capacities.length > 0 ? capacities.reduce((a, b) => a + b, 0) : null,
      providersWithRecordedCapacity: capacities.length,
    },
    note: 'Capacity is only shown when an administrator records the real provider entitlement. Aether does not infer or pool free tiers.',
  });
});

/** POST /api/admin/storage/providers */
adminStorageRoutes.post('/providers', async (c) => {
  const user = await requireAdmin(c);
  const logger = c.get('logger');
  const body = await readJson(c, createProviderSchema);

  const existing = await c.env.DB.prepare('SELECT id FROM storage_providers WHERE name = ?').bind(body.name).first<{ id: string }>();
  if (existing) throw conflict('A storage provider with that name already exists.');

  assertHttpsEndpoint(body.endpoint, c.get('config').isProduction);

  if (body.authMode === 'credentials' && !body.credentialRef) {
    throw validationFailed('credentialRef is required for credential-based providers (it names the Worker secrets to use).');
  }
  if (body.authMode === 'binding' && !c.env.MUSIC_BUCKET) {
    throw validationFailed(
      'No R2 binding (MUSIC_BUCKET) is configured on this Worker, so a binding provider cannot be used. Register it with authMode "credentials" instead.'
    );
  }

  const id = newId('prv');
  await c.env.DB.prepare(
    `INSERT INTO storage_providers
       (id, name, kind, account_id, bucket_name, endpoint, region, auth_mode, credential_ref, priority, enabled, capacity_bytes, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      body.name,
      body.kind,
      body.accountId ?? null,
      body.bucketName,
      body.endpoint,
      body.region ?? c.get('config').r2DefaultRegion,
      body.authMode,
      body.authMode === 'credentials' ? (body.credentialRef ?? null) : null,
      body.priority,
      body.enabled ? 1 : 0,
      body.capacityBytes ?? null,
      body.notes ?? null,
      user.id
    )
    .run();

  const created = await getProviderById(c.env.DB, id);
  if (!created) throw notFound('Provider could not be read back after creation.');

  await writeAudit(
    c.env.DB,
    {
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'storage.provider_created',
      targetType: 'storage_provider',
      targetId: id,
      metadata: {
        name: created.name,
        bucket: created.bucket_name,
        endpoint: created.endpoint,
        authMode: created.auth_mode,
        credentialRef: created.credential_ref,
      },
    },
    logger
  );

  // Probe immediately so the operator sees the real connection state, not a guess.
  const health = await probeProvider(c.env, c.env.DB, created, logger);
  await invalidatePublicConfigCache(c.env);
  const refreshed = (await getProviderById(c.env.DB, id)) ?? created;

  return c.json({ provider: providerResponse(refreshed, c.env), health }, 201);
});

/** PATCH /api/admin/storage/providers/:id */
adminStorageRoutes.patch('/providers/:id', async (c) => {
  const user = await requireAdmin(c);
  const logger = c.get('logger');
  const provider = await getProviderById(c.env.DB, c.req.param('id'));
  if (!provider) throw notFound('Storage provider not found.');

  const body = await readJson(c, updateProviderSchema);
  if (body.endpoint) assertHttpsEndpoint(body.endpoint, c.get('config').isProduction);

  const nextAuthMode = body.authMode ?? provider.auth_mode;
  const nextCredentialRef = body.credentialRef === undefined ? provider.credential_ref : body.credentialRef;
  if (nextAuthMode === 'credentials' && !nextCredentialRef) {
    throw validationFailed('credentialRef is required for credential-based providers.');
  }
  if (nextAuthMode === 'binding' && !c.env.MUSIC_BUCKET) {
    throw validationFailed('No R2 binding (MUSIC_BUCKET) is configured on this Worker.');
  }

  const updates: string[] = [];
  const bindings: unknown[] = [];
  const push = (column: string, value: unknown): void => {
    updates.push(`${column} = ?`);
    bindings.push(value);
  };

  if (body.name !== undefined && body.name !== provider.name) {
    const clash = await c.env.DB.prepare('SELECT id FROM storage_providers WHERE name = ? AND id <> ?')
      .bind(body.name, provider.id)
      .first<{ id: string }>();
    if (clash) throw conflict('Another storage provider already uses that name.');
    push('name', body.name);
  }
  if (body.bucketName !== undefined) push('bucket_name', body.bucketName);
  if (body.endpoint !== undefined) push('endpoint', body.endpoint);
  if (body.region !== undefined) push('region', body.region);
  if (body.authMode !== undefined) push('auth_mode', body.authMode);
  if (body.credentialRef !== undefined) push('credential_ref', body.credentialRef);
  if (body.priority !== undefined) push('priority', body.priority);
  if (body.enabled !== undefined) push('enabled', body.enabled ? 1 : 0);
  if (body.capacityBytes !== undefined) push('capacity_bytes', body.capacityBytes);
  if (body.notes !== undefined) push('notes', body.notes);

  if (updates.length === 0) {
    return c.json({ provider: providerResponse(provider, c.env) });
  }

  updates.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  await c.env.DB.prepare(`UPDATE storage_providers SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...bindings, provider.id)
    .run();

  // Any change invalidates the previous health verdict until re-probed.
  if (body.endpoint !== undefined || body.bucketName !== undefined || body.credentialRef !== undefined || body.authMode !== undefined) {
    await recordHealth(c.env.DB, provider.id, { status: 'unknown', latencyMs: null, message: 'Configuration changed; re-check required.' }, logger);
  }

  await writeAudit(
    c.env.DB,
    {
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'storage.provider_updated',
      targetType: 'storage_provider',
      targetId: provider.id,
      metadata: {
        changed: Object.keys(body),
        // Record the action, never the secret value.
        credentialRef: body.credentialRef,
        enabled: body.enabled,
        priority: body.priority,
      },
    },
    logger
  );

  await invalidatePublicConfigCache(c.env);
  const updated = await getProviderById(c.env.DB, provider.id);
  return c.json({ provider: providerResponse(updated!, c.env) });
});

/** DELETE /api/admin/storage/providers/:id — refuses while objects still reference it. */
adminStorageRoutes.delete('/providers/:id', async (c) => {
  const user = await requireAdmin(c);
  const provider = await getProviderById(c.env.DB, c.req.param('id'));
  if (!provider) throw notFound('Storage provider not found.');

  const objects = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM storage_objects WHERE provider_id = ? AND status = 'active'"
  )
    .bind(provider.id)
    .first<{ count: number }>();

  if ((objects?.count ?? 0) > 0) {
    throw conflict(
      `This provider still holds ${objects?.count} objects. Disable it (enabled=false) or migrate the tracks first; deleting the row would orphan stored audio.`
    );
  }

  await c.env.DB.prepare('DELETE FROM storage_providers WHERE id = ?').bind(provider.id).run();

  await writeAudit(
    c.env.DB,
    {
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'storage.provider_deleted',
      targetType: 'storage_provider',
      targetId: provider.id,
      metadata: { name: provider.name, bucket: provider.bucket_name },
    },
    c.get('logger')
  );

  await invalidatePublicConfigCache(c.env);
  return c.json({ ok: true, providerId: provider.id });
});

/** GET /api/admin/storage/health — probes every provider. */
adminStorageRoutes.get('/health', async (c) => {
  await requireAdmin(c);
  const reports = await probeAllProviders(c.env, c.env.DB, c.get('logger'));
  await invalidatePublicConfigCache(c.env);
  return c.json({
    providers: reports,
    checkedAt: new Date().toISOString(),
    note: 'A provider with missing credentials is reported as "unconfigured", never as healthy.',
  });
});

/** POST /api/admin/storage/health/:id/check */
adminStorageRoutes.post('/health/:id/check', async (c) => {
  const user = await requireAdmin(c);
  const provider = await getProviderById(c.env.DB, c.req.param('id'));
  if (!provider) throw notFound('Storage provider not found.');

  const report = await probeProvider(c.env, c.env.DB, provider, c.get('logger'));
  await writeAudit(
    c.env.DB,
    {
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'storage.health_checked',
      targetType: 'storage_provider',
      targetId: provider.id,
      metadata: { status: report.status, latencyMs: report.latencyMs },
    },
    c.get('logger')
  );
  await invalidatePublicConfigCache(c.env);
  return c.json({ health: report });
});

/** POST /api/admin/storage/verify — recomputes a stored object's SHA-256. */
adminStorageRoutes.post('/verify', async (c) => {
  const user = await requireAdmin(c);
  const body = await readJson(c, verifySchema);

  const result = await verifyObjectIntegrity(c.env, c.env.DB, {
    trackId: body.trackId,
    ...(body.objectId ? { objectId: body.objectId } : {}),
    logger: c.get('logger'),
  });

  await writeAudit(
    c.env.DB,
    {
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'storage.object_verified',
      targetType: 'track',
      targetId: body.trackId,
      metadata: { ok: result.ok, objectId: result.objectId, providerId: result.providerId },
    },
    c.get('logger')
  );

  return c.json({ result });
});

/** POST /api/admin/storage/migrate — moves a track's primary object. */
adminStorageRoutes.post('/migrate', async (c) => {
  const user = await requireAdmin(c);
  const logger = c.get('logger');
  const body = await readJson(c, migrateSchema);
  const settings = c.get('settings');

  const result = await migrateTrackObject(c.env, c.env.DB, {
    trackId: body.trackId,
    targetProviderId: body.targetProviderId,
    deleteSource: body.deleteSource ?? false,
    maxBytes: settings.storageMigrationMaxBytes,
    logger,
  });

  await writeAudit(
    c.env.DB,
    {
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'storage.migration_completed',
      targetType: 'track',
      targetId: body.trackId,
      metadata: {
        fromProviderId: result.fromProviderId,
        toProviderId: result.toProviderId,
        bytes: result.bytes,
        deletedSource: result.deletedSource,
      },
    },
    logger
  );

  return c.json({ result });
});

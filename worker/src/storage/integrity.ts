import type { Bindings, D1Database } from '../platform';
import { notFound, unavailable } from '../utils/errors';
import { sha256StreamHex } from '../utils/hash';
import type { Logger } from '../utils/logger';
import { getProviderById } from './registry';
import { requireAdapter } from './registry';

export interface IntegrityResult {
  trackId: string;
  objectId: string;
  providerId: string;
  objectKey: string;
  expectedSha256: string | null;
  actualSha256: string;
  sizeBytes: number;
  ok: boolean;
  checkedAt: string;
}

interface ObjectRow {
  id: string;
  track_id: string;
  provider_id: string;
  object_key: string;
  size_bytes: number;
  sha256: string | null;
}

/**
 * Recompute the SHA-256 of an object by streaming it through the Worker and
 * compare it with the hash recorded at upload time.
 *
 * This is an explicit administrative action (not a background sweep) because it
 * costs one full object read per track.
 */
export async function verifyObjectIntegrity(
  env: Bindings,
  db: D1Database,
  options: { trackId: string; objectId?: string; logger?: Logger }
): Promise<IntegrityResult> {
  const object = options.objectId
    ? await db
        .prepare(
          'SELECT id, track_id, provider_id, object_key, size_bytes, sha256 FROM storage_objects WHERE id = ? AND track_id = ?'
        )
        .bind(options.objectId, options.trackId)
        .first<ObjectRow>()
    : await db
        .prepare(
          `SELECT id, track_id, provider_id, object_key, size_bytes, sha256
             FROM storage_objects
            WHERE track_id = ? AND role = 'audio' AND is_primary = 1`
        )
        .bind(options.trackId)
        .first<ObjectRow>();

  if (!object) throw notFound('No stored object found for this track.');

  const provider = await getProviderById(db, object.provider_id);
  if (!provider) throw notFound('Storage provider for this object no longer exists.');

  const adapter = requireAdapter(env, provider);
  const stored = await adapter.get(object.object_key);
  if (!stored) {
    await db
      .prepare(
        `UPDATE storage_objects
            SET status = 'missing', last_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`
      )
      .bind(object.id)
      .run();
    throw unavailable('The object is missing from its storage provider.', {
      objectId: object.id,
      providerId: provider.id,
      objectKey: object.object_key,
    });
  }

  const { sha256, bytes } = await sha256StreamHex(stored.body);
  const expected = object.sha256;
  const ok = expected === null || expected.toLowerCase() === sha256;

  await db
    .prepare(
      `UPDATE storage_objects
          SET sha256 = COALESCE(sha256, ?), verified_at = ?, last_checked_at = ?, status = ?
        WHERE id = ?`
    )
    .bind(sha256, new Date().toISOString(), new Date().toISOString(), ok ? 'active' : 'corrupt', object.id)
    .run();

  options.logger?.info('storage_integrity_checked', {
    trackId: options.trackId,
    objectId: object.id,
    ok,
    sizeMismatch: bytes !== object.size_bytes,
  });

  return {
    trackId: options.trackId,
    objectId: object.id,
    providerId: provider.id,
    objectKey: object.object_key,
    expectedSha256: expected,
    actualSha256: sha256,
    sizeBytes: bytes,
    ok,
    checkedAt: new Date().toISOString(),
  };
}

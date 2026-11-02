import type { Bindings, D1Database } from '../platform';
import { conflict, notFound, payloadTooLarge } from '../utils/errors';
import { sha256Hex, sha256StreamHex } from '../utils/hash';
import { newId } from '../utils/ids';
import type { Logger } from '../utils/logger';
import { getProviderById, requireAdapter } from './registry';

export interface MigrateTrackOptions {
  trackId: string;
  targetProviderId: string;
  /** Remove the source copy after a verified copy exists at the target. */
  deleteSource?: boolean;
  maxBytes: number;
  logger?: Logger;
}

export interface MigrateTrackResult {
  trackId: string;
  objectId: string;
  fromProviderId: string;
  toProviderId: string;
  bytes: number;
  sha256: string;
  deletedSource: boolean;
}

interface TrackRow {
  id: string;
  title: string;
  size_bytes: number;
  integrity_sha256: string | null;
  primary_object_id: string | null;
}

interface ObjectRow {
  id: string;
  provider_id: string;
  object_key: string;
  size_bytes: number;
  content_type: string | null;
  sha256: string | null;
}

/**
 * Copy a track's primary audio object to another provider and atomically flip the
 * primary pointer. The track ID never changes, so playlists, favourites, play
 * history and Android Media3 caches stay valid.
 *
 * Limits (documented in docs/STORAGE.md):
 *  * Targets that can stream (the R2 binding) are streamed without buffering.
 *  * Targets that need a signed single PUT (S3 API) are buffered, so the object
 *    must be <= `maxBytes` (default 25 MiB). Larger objects are copied with
 *    scripts/storage-copy.mjs (rclone/wrangler) instead.
 */
export async function migrateTrackObject(
  env: Bindings,
  db: D1Database,
  options: MigrateTrackOptions
): Promise<MigrateTrackResult> {
  const logger = options.logger;
  const track = await db
    .prepare('SELECT id, title, size_bytes, integrity_sha256, primary_object_id FROM tracks WHERE id = ? AND is_deleted = 0')
    .bind(options.trackId)
    .first<TrackRow>();
  if (!track) throw notFound('Track not found.');

  const source = await db
    .prepare(
      `SELECT id, provider_id, object_key, size_bytes, content_type, sha256
         FROM storage_objects
        WHERE track_id = ? AND role = 'audio' AND is_primary = 1`
    )
    .bind(track.id)
    .first<ObjectRow>();
  if (!source) throw notFound('Track has no primary audio object to migrate.');

  if (source.provider_id === options.targetProviderId) {
    throw conflict('Track is already stored on the requested provider.');
  }

  const [sourceProvider, targetProvider] = await Promise.all([
    getProviderById(db, source.provider_id),
    getProviderById(db, options.targetProviderId),
  ]);
  if (!sourceProvider) throw notFound('Source storage provider not found.');
  if (!targetProvider) throw notFound('Target storage provider not found.');
  if (targetProvider.enabled !== 1) throw conflict('Target storage provider is disabled.');

  const sourceAdapter = requireAdapter(env, sourceProvider);
  const targetAdapter = requireAdapter(env, targetProvider);

  if (source.size_bytes > options.maxBytes && !targetAdapter.supportsStreamingWrite) {
    throw payloadTooLarge(
      `Object is ${source.size_bytes} bytes; this provider requires buffered copies limited to ${options.maxBytes} bytes. Use scripts/storage-copy.mjs for larger files.`
    );
  }

  const fetched = await sourceAdapter.get(source.object_key);
  if (!fetched) throw notFound('Source object is missing from its provider.');

  let sha256: string;
  let bytes: number;

  if (targetAdapter.supportsStreamingWrite) {
    // One pass: hash a tee branch while the other branch streams to the target.
    const [forUpload, forHash] = fetched.body.tee();
    const [putResult, hashResult] = await Promise.all([
      targetAdapter.put(source.object_key, forUpload, {
        ...(source.content_type ? { contentType: source.content_type } : {}),
        customMetadata: { migratedFrom: sourceProvider.id, trackId: track.id },
        // R2 needs the length of a streamed write; the source row knows it.
        sizeBytes: source.size_bytes,
      }),
      sha256StreamHex(forHash),
    ]);
    sha256 = hashResult.sha256;
    bytes = putResult.size;
  } else {
    if (source.size_bytes > options.maxBytes) {
      throw payloadTooLarge(`Object is ${source.size_bytes} bytes; limit is ${options.maxBytes} bytes.`);
    }
    const buffer = new Uint8Array(await new Response(fetched.body).arrayBuffer());
    const putResult = await targetAdapter.put(source.object_key, buffer, {
      ...(source.content_type ? { contentType: source.content_type } : {}),
      customMetadata: { migratedFrom: sourceProvider.id, trackId: track.id },
    });
    sha256 = sha256Hex(buffer);
    bytes = putResult.size;
  }

  const expectedSha = source.sha256 ?? track.integrity_sha256;
  if (expectedSha && expectedSha.toLowerCase() !== sha256.toLowerCase()) {
    throw conflict('Integrity check failed: the copied object does not match the recorded hash. Migration aborted.');
  }

  const newObjectId = newId('obj');
  const now = new Date().toISOString();

  // Statements run in one batch: demote the old primary first so the partial
  // unique index (one primary audio object per track) is never violated.
  await db.batch([
    db
      .prepare("UPDATE storage_objects SET is_primary = 0, status = 'active' WHERE id = ?")
      .bind(source.id),
    db
      .prepare(
        `INSERT INTO storage_objects
           (id, track_id, provider_id, bucket_name, object_key, role, size_bytes, content_type, etag, sha256,
            is_primary, status, verified_at)
         VALUES (?, ?, ?, ?, ?, 'audio', ?, ?, NULL, ?, 1, 'active', ?)`
      )
      .bind(
        newObjectId,
        track.id,
        targetProvider.id,
        targetProvider.bucket_name,
        source.object_key,
        bytes,
        source.content_type,
        sha256,
        now
      ),
    db.prepare('UPDATE tracks SET primary_object_id = ?, updated_at = ? WHERE id = ?').bind(newObjectId, now, track.id),
  ]);

  let deletedSource = false;
  if (options.deleteSource) {
    try {
      await sourceAdapter.delete(source.object_key);
      await db
        .prepare("UPDATE storage_objects SET status = 'deleted' WHERE id = ?")
        .bind(source.id)
        .run();
      deletedSource = true;
    } catch (error) {
      // Non-fatal: the new copy is primary and verified. Surface for cleanup.
      logger?.error('storage_migration_source_delete_failed', {
        trackId: track.id,
        objectId: source.id,
        error,
      });
    }
  }

  logger?.info('storage_migration_completed', {
    trackId: track.id,
    fromProviderId: sourceProvider.id,
    toProviderId: targetProvider.id,
    bytes,
  });

  return {
    trackId: track.id,
    objectId: newObjectId,
    fromProviderId: sourceProvider.id,
    toProviderId: targetProvider.id,
    bytes,
    sha256,
    deletedSource,
  };
}

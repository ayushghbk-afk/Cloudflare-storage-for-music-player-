import type { D1Database } from '../platform';
import { notFound, unavailable } from '../utils/errors';
import type { Logger } from '../utils/logger';
import { getProviderById, requireAdapter } from '../storage/registry';
import type { StorageAdapter } from '../storage/types';

export interface TrackRow {
  id: string;
  title: string;
  uploader_id: string;
  status: string;
  visibility: string;
  is_deleted: number;
  rights_confirmed: number;
  mime_type: string;
  size_bytes: number;
  format: string;
  artwork_key: string | null;
  artwork_mime: string | null;
  primary_object_id: string | null;
}

export interface ObjectCandidate {
  id: string;
  object_key: string;
  provider_id: string;
  size_bytes: number;
  content_type: string | null;
  etag: string | null;
  is_primary: number;
  role: string;
}

export async function loadStreamableTrack(db: D1Database, trackId: string): Promise<TrackRow | null> {
  return db
    .prepare(
      `SELECT id, title, uploader_id, status, visibility, is_deleted, rights_confirmed,
              mime_type, size_bytes, format, artwork_key, artwork_mime, primary_object_id
         FROM tracks
        WHERE id = ?`
    )
    .bind(trackId)
    .first<TrackRow>();
}

/**
 * All usable copies of a track, primary first. Provider fallback relies on this
 * ordering: if the primary provider fails, the next healthy copy is served.
 */
export async function loadObjectCandidates(
  db: D1Database,
  trackId: string,
  role: 'audio' | 'artwork' = 'audio'
): Promise<ObjectCandidate[]> {
  const result = await db
    .prepare(
      `SELECT o.id, o.object_key, o.provider_id, o.size_bytes, o.content_type, o.etag, o.is_primary, o.role
         FROM storage_objects o
         JOIN storage_providers p ON p.id = o.provider_id
        WHERE o.track_id = ?
          AND o.role = ?
          AND o.status = 'active'
          AND p.enabled = 1
        ORDER BY o.is_primary DESC, p.priority ASC, o.created_at ASC`
    )
    .bind(trackId, role)
    .all<ObjectCandidate>();
  return result.results ?? [];
}

export interface ResolvedCopy {
  candidate: ObjectCandidate;
  adapter: StorageAdapter;
}

/**
 * Resolve every candidate copy with a working adapter, skipping providers whose
 * credentials are missing. Returns the failures so the caller can report them.
 */
export async function resolveCopies(
  env: Parameters<typeof requireAdapter>[0],
  db: D1Database,
  candidates: ObjectCandidate[],
  logger?: Logger
): Promise<{ copies: ResolvedCopy[]; failures: { providerId: string; reason: string }[] }> {
  const copies: ResolvedCopy[] = [];
  const failures: { providerId: string; reason: string }[] = [];

  for (const candidate of candidates) {
    const provider = await getProviderById(db, candidate.provider_id);
    if (!provider) {
      failures.push({ providerId: candidate.provider_id, reason: 'provider row missing' });
      continue;
    }
    try {
      const adapter = requireAdapter(env, provider);
      copies.push({ candidate, adapter });
    } catch (error) {
      failures.push({ providerId: provider.id, reason: error instanceof Error ? error.message : String(error) });
      logger?.warn('stream_provider_unavailable', { providerId: provider.id, trackId: candidate.id });
    }
  }

  return { copies, failures };
}

export function contentTypeFor(candidate: ObjectCandidate, track: TrackRow): string {
  const declared = candidate.content_type ?? track.mime_type;
  if (declared && declared.includes('/')) return declared;
  return 'application/octet-stream';
}

export function assertCopiesExist(copies: ResolvedCopy[], failures: { providerId: string; reason: string }[]): void {
  if (copies.length === 0) {
    throw unavailable('No storage provider is currently able to serve this track.', { failures });
  }
}

export { notFound };

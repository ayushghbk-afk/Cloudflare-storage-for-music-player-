import type { D1Database } from '../platform';
import { conflict, validationFailed } from '../utils/errors';
import { sha256Hex, sha256StreamHex } from '../utils/hash';
import { newId } from '../utils/ids';
import type { Logger } from '../utils/logger';
import { normalizeText } from '../utils/text';
import { extractMetadata, verifyDeclaredFormat, FORMAT_EXTENSION, type AudioMetadata } from '../metadata';
import type { StorageAdapter } from '../storage/types';
import type { Settings } from '../settings';
import { artworkObjectKey, isSupportedArtworkMime } from './validation';

/** Only these windows are read from storage — never the whole file. */
export const HEAD_WINDOW_BYTES = 512 * 1024;
export const TAIL_WINDOW_BYTES = 256 * 1024;
const MAX_STORED_ARTWORK_BYTES = 5 * 1024 * 1024;

export interface UploadJobRow {
  id: string;
  user_id: string;
  provider_id: string | null;
  storage_object_id: string | null;
  track_id: string | null;
  status: string;
  upload_mode: 'direct' | 'worker';
  object_key: string;
  bucket_name: string | null;
  filename: string;
  declared_mime_type: string;
  declared_size_bytes: number;
  uploaded_size_bytes: number | null;
  sha256: string | null;
  metadata: string | null;
  rights_confirmed: number;
  turnstile_verified: number;
  error_code: string | null;
  error_message: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface UploaderMetadataInput {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  genre?: string;
  year?: number;
  trackNumber?: number;
  discNumber?: number;
}

export interface StoredWindows {
  head: Uint8Array;
  tail: Uint8Array;
  size: number;
}

/** Read the leading and trailing windows of a stored object. */
export async function readObjectWindows(adapter: StorageAdapter, key: string, size: number): Promise<StoredWindows> {
  const headLength = Math.min(HEAD_WINDOW_BYTES, size);
  const headResult = await adapter.get(key, { offset: 0, length: headLength });
  if (!headResult) throw conflict('The uploaded object could not be read back from storage.');
  const head = new Uint8Array(await new Response(headResult.body).arrayBuffer());

  let tail = new Uint8Array(0);
  if (size > headLength) {
    const tailLength = Math.min(TAIL_WINDOW_BYTES, size);
    const tailResult = await adapter.get(key, { offset: size - tailLength, length: tailLength });
    if (tailResult) tail = new Uint8Array(await new Response(tailResult.body).arrayBuffer());
  } else {
    tail = head;
  }

  return { head, tail, size };
}

async function findOrCreateArtist(db: D1Database, name: string): Promise<string | null> {
  const trimmed = name.trim().slice(0, 200);
  const normalized = normalizeText(trimmed);
  if (!normalized) return null;

  const existing = await db.prepare('SELECT id FROM artists WHERE name_normalized = ?').bind(normalized).first<{ id: string }>();
  if (existing) return existing.id;

  const id = newId('art');
  try {
    await db.prepare('INSERT INTO artists (id, name, name_normalized) VALUES (?, ?, ?)').bind(id, trimmed, normalized).run();
    return id;
  } catch {
    // Concurrent insert won the race; use the winner.
    const raced = await db.prepare('SELECT id FROM artists WHERE name_normalized = ?').bind(normalized).first<{ id: string }>();
    return raced?.id ?? null;
  }
}

async function findOrCreateAlbum(
  db: D1Database,
  title: string,
  artistId: string | null,
  year: number | undefined
): Promise<string | null> {
  const trimmed = title.trim().slice(0, 200);
  const normalized = normalizeText(trimmed);
  if (!normalized) return null;

  if (artistId) {
    const existing = await db
      .prepare('SELECT id FROM albums WHERE title_normalized = ? AND artist_id = ?')
      .bind(normalized, artistId)
      .first<{ id: string }>();
    if (existing) return existing.id;
  } else {
    const existing = await db
      .prepare('SELECT id FROM albums WHERE title_normalized = ? AND artist_id IS NULL')
      .bind(normalized)
      .first<{ id: string }>();
    if (existing) return existing.id;
  }

  const id = newId('alb');
  try {
    await db
      .prepare('INSERT INTO albums (id, title, title_normalized, artist_id, release_year) VALUES (?, ?, ?, ?, ?)')
      .bind(id, trimmed, normalized, artistId, year ?? null)
      .run();
    return id;
  } catch {
    const raced = await db
      .prepare('SELECT id FROM albums WHERE title_normalized = ? AND artist_id IS ?')
      .bind(normalized, artistId)
      .first<{ id: string }>();
    return raced?.id ?? null;
  }
}

export interface ProcessUploadResult {
  trackId: string;
  status: 'awaiting_review' | 'published';
  metadata: AudioMetadata;
  sha256: string;
  bytes: number;
  artworkStored: boolean;
}

export interface ProcessUploadOptions {
  db: D1Database;
  adapter: StorageAdapter;
  providerId: string;
  bucketName: string;
  job: UploadJobRow;
  settings: Settings;
  uploaderMetadata: UploaderMetadataInput;
  logger?: Logger;
  /** Optional hash computed while the bytes were streamed through the Worker. */
  streamedHash?: string;
}

/**
 * Turn a completed upload into a private, moderated track.
 *
 * The order matters:
 *   verify content -> hash -> deduplicate -> extract metadata -> persist row
 * Nothing here publishes anything: `status` starts at `pending` (or `approved`
 * only when an administrator explicitly enabled auto-publish).
 */
export async function processCompletedUpload(options: ProcessUploadOptions): Promise<ProcessUploadResult> {
  const { db, adapter, job, settings, uploaderMetadata, logger } = options;
  const key = job.object_key;

  const head = await adapter.head(key);
  if (!head) throw conflict('No uploaded file was found in storage for this job.');

  if (head.size <= 0) throw validationFailed('The uploaded file is empty.');
  if (head.size > settings.uploadMaxBytes) {
    await adapter.delete(key).catch(() => undefined);
    throw validationFailed(`Uploaded file exceeds the configured maximum of ${settings.uploadMaxBytes} bytes.`);
  }

  const windows = await readObjectWindows(adapter, key, head.size);

  const formatError = verifyDeclaredFormat(windows.head, job.declared_mime_type, job.filename);
  if (formatError) {
    await adapter.delete(key).catch(() => undefined);
    throw validationFailed(formatError);
  }

  // Authoritative hash computed from the stored bytes (not from client input).
  const stored = await adapter.get(key);
  if (!stored) throw conflict('The uploaded object disappeared while being processed.');
  const hashed = await sha256StreamHex(stored.body);
  if (hashed.bytes !== head.size) {
    throw conflict(`Uploaded object size mismatch (${hashed.bytes} bytes read, ${head.size} expected).`);
  }
  if (options.streamedHash && options.streamedHash.toLowerCase() !== hashed.sha256.toLowerCase()) {
    throw conflict('Upload integrity check failed: the streamed hash does not match the stored object.');
  }

  // Duplicate detection is global across providers: identical audio is stored once.
  const duplicate = await db
    .prepare(
      `SELECT o.track_id, t.title, t.status
         FROM storage_objects o
         JOIN tracks t ON t.id = o.track_id
        WHERE o.sha256 = ? AND o.role = 'audio' AND o.is_primary = 1
        LIMIT 1`
    )
    .bind(hashed.sha256)
    .first<{ track_id: string; title: string; status: string }>();

  if (duplicate) {
    await adapter.delete(key).catch(() => undefined);
    logger?.info('upload_duplicate_detected', { jobId: job.id, existingTrackId: duplicate.track_id });
    throw conflict('This recording already exists in the library.', {
      duplicateTrackId: duplicate.track_id,
      existingTitle: duplicate.title,
      existingStatus: duplicate.status,
    });
  }

  const metadata = extractMetadata({
    head: windows.head,
    tail: windows.tail,
    fileSize: head.size,
    filename: job.filename,
  });

  const pickText = (...values: (string | undefined)[]): string | undefined => {
    for (const value of values) {
      if (value && value.trim().length > 0) return value.trim().slice(0, 300);
    }
    return undefined;
  };

  const fallbackTitle = job.filename.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
  const title = pickText(uploaderMetadata.title, metadata.tags.title, fallbackTitle) ?? 'Untitled';
  const artistName = pickText(uploaderMetadata.artist, metadata.tags.artist);
  const albumTitle = pickText(uploaderMetadata.album, metadata.tags.album);
  const genre = pickText(uploaderMetadata.genre, metadata.tags.genre);
  const year = uploaderMetadata.year ?? metadata.tags.year;
  const trackNumber = uploaderMetadata.trackNumber ?? metadata.tags.trackNumber;
  const discNumber = uploaderMetadata.discNumber ?? metadata.tags.discNumber;

  const artistId = artistName ? await findOrCreateArtist(db, artistName) : null;
  const albumId = albumTitle ? await findOrCreateAlbum(db, albumTitle, artistId, year) : null;

  const trackId = newId('trk');
  const objectId = newId('obj');
  const now = new Date().toISOString();
  const publishImmediately = settings.autoPublishUploads && job.rights_confirmed === 1;
  const status = publishImmediately ? 'approved' : 'pending';
  const visibility = publishImmediately ? 'public' : 'private';

  try {
    await db
      .prepare(
        `INSERT INTO tracks (
           id, title, title_normalized, artist_id, album_id, uploader_id, track_number, disc_number, genre,
           release_year, duration_ms, format, mime_type, size_bytes, sample_rate, channels, bit_depth,
           bitrate_kbps, integrity_sha256, visibility, status, rights_confirmed, rights_statement,
           published_at, primary_object_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        trackId,
        title,
        normalizeText(title),
        artistId,
        albumId,
        job.user_id,
        trackNumber ?? null,
        discNumber ?? null,
        genre ?? null,
        year ?? null,
        metadata.durationMs ?? null,
        metadata.format,
        metadata.mimeType,
        head.size,
        metadata.sampleRate ?? null,
        metadata.channels ?? null,
        metadata.bitDepth ?? null,
        metadata.bitrateKbps ?? null,
        hashed.sha256,
        visibility,
        status,
        job.rights_confirmed,
        'Uploader confirmed ownership or distribution rights at upload time.',
        publishImmediately ? now : null,
        null
      )
      .run();

    await db
      .prepare(
        `INSERT INTO storage_objects
           (id, track_id, provider_id, bucket_name, object_key, role, size_bytes, content_type, etag, sha256, is_primary, status)
         VALUES (?, ?, ?, ?, ?, 'audio', ?, ?, ?, ?, 1, 'active')`
      )
      .bind(
        objectId,
        trackId,
        options.providerId,
        options.bucketName,
        key,
        head.size,
        metadata.mimeType,
        head.etag ?? null,
        hashed.sha256
      )
      .run();

    await db.prepare('UPDATE tracks SET primary_object_id = ? WHERE id = ?').bind(objectId, trackId).run();
  } catch (error) {
    // Roll back the stored object so a failed insert cannot leak orphaned audio.
    await adapter.delete(key).catch(() => undefined);
    throw error;
  }

  let artworkStored = false;
  if (metadata.artwork && isSupportedArtworkMime(metadata.artwork.mime) && metadata.artwork.data.byteLength <= MAX_STORED_ARTWORK_BYTES) {
    const artworkKey = artworkObjectKey(trackId, metadata.artwork.mime);
    try {
      const put = await adapter.put(artworkKey, metadata.artwork.data, {
        contentType: metadata.artwork.mime,
        cacheControl: 'public, max-age=31536000, immutable',
      });
      const artworkObjectId = newId('obj');
      await db
        .prepare(
          `INSERT INTO storage_objects
             (id, track_id, provider_id, bucket_name, object_key, role, size_bytes, content_type, etag, sha256, is_primary, status)
           VALUES (?, ?, ?, ?, ?, 'artwork', ?, ?, ?, ?, 0, 'active')`
        )
        .bind(
          artworkObjectId,
          trackId,
          options.providerId,
          options.bucketName,
          artworkKey,
          put.size,
          metadata.artwork.mime,
          put.etag ?? null,
          sha256Hex(metadata.artwork.data)
        )
        .run();
      await db
        .prepare('UPDATE tracks SET artwork_key = ?, artwork_mime = ? WHERE id = ?')
        .bind(artworkKey, metadata.artwork.mime, trackId)
        .run();
      artworkStored = true;
    } catch (error) {
      // Artwork is optional: never fail an upload because of cover art.
      logger?.warn('artwork_store_failed', { trackId, error });
    }
  }

  logger?.info('upload_processed', {
    jobId: job.id,
    trackId,
    format: metadata.format,
    durationMs: metadata.durationMs,
    status,
    warnings: metadata.warnings.length,
  });

  return {
    trackId,
    status: publishImmediately ? 'published' : 'awaiting_review',
    metadata,
    sha256: hashed.sha256,
    bytes: head.size,
    artworkStored,
  };
}

export { FORMAT_EXTENSION };

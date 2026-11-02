import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import type { D1Database } from '../platform';
import { badRequest, conflict, forbidden, notFound, payloadTooLarge, unavailable } from '../utils/errors';
import { absoluteUrl, clientIp, hashIp, noStoreHeaders, pagination, readJson, userAgent } from '../utils/http';
import { enforceRateLimit } from '../utils/ratelimit';
import { writeAudit } from '../utils/audit';
import { verifyTurnstile } from '../utils/turnstile';
import { sha256StreamHex } from '../utils/hash';
import { newId } from '../utils/ids';
import { requireUser } from '../auth/middleware';
import { getProviderById, requireAdapter } from '../storage/registry';
import { assertRouting, selectUploadProvider } from '../storage/routing';
import { isAppError } from '../utils/errors';
import { MODERATED_TRACK_SELECT, serializeModeratedTrack, type TrackRowJoined } from '../catalog/serialize';
import { processCompletedUpload, type UploadJobRow } from './service';
import { uploadObjectKey, validateUploadInit } from './validation';

export const uploadRoutes = new Hono<AppEnv>();

const metadataSchema = {
  title: z.string().trim().max(300).optional(),
  artist: z.string().trim().max(200).optional(),
  album: z.string().trim().max(200).optional(),
  albumArtist: z.string().trim().max(200).optional(),
  genre: z.string().trim().max(100).optional(),
  year: z.number().int().min(1900).max(2200).optional(),
  trackNumber: z.number().int().min(0).max(999).optional(),
  discNumber: z.number().int().min(0).max(99).optional(),
};

const initSchema = z.strictObject({
  filename: z.string().min(3).max(255),
  size: z.number().int().positive(),
  mimeType: z.string().min(3).max(120),
  rightsConfirmed: z.boolean(),
  turnstileToken: z.string().max(4096).optional(),
  preferredMode: z.enum(['auto', 'direct', 'worker']).optional(),
  ...metadataSchema,
});

const completeSchema = z.strictObject({
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i, 'sha256 must be 64 hexadecimal characters')
    .optional(),
  size: z.number().int().positive().optional(),
});

const UPLOAD_URL_TTL_SECONDS = 3600;

/** Wrap a request body so it fails as soon as it exceeds the limit. */
function limitStream(body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(new Error(`Upload exceeded the maximum of ${maxBytes} bytes.`));
          return;
        }
        controller.enqueue(chunk);
      },
    })
  );
}

async function loadJob(db: D1Database, id: string): Promise<UploadJobRow | null> {
  return db.prepare('SELECT * FROM upload_jobs WHERE id = ?').bind(id).first<UploadJobRow>();
}

function assertJobOwner(job: UploadJobRow, userId: string, role: string): void {
  if (job.user_id !== userId && role !== 'admin' && role !== 'moderator') {
    throw forbidden('This upload belongs to another user.');
  }
}

/* -------------------------------------------------------------------------- */
/* POST /api/upload/init                                                       */
/* -------------------------------------------------------------------------- */

uploadRoutes.post('/init', async (c) => {
  const user = await requireUser(c);
  const settings = c.get('settings');
  const logger = c.get('logger');
  const ip = clientIp(c);
  const ipHash = hashIp(ip);

  await enforceRateLimit(c.env.DB, { bucket: 'upload:init', subject: `user:${user.id}`, limit: 40, windowSeconds: 3600 }, logger);

  const body = await readJson(c, initSchema);

  if (c.get('config').hasTurnstileSecret) {
    const result = await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY as string, body.turnstileToken, ip, logger);
    if (!result.success) throw badRequest('Human verification failed. Please retry the challenge.', { codes: result.errorCodes });
  }

  validateUploadInit(
    { filename: body.filename, size: body.size, mimeType: body.mimeType, rightsConfirmed: body.rightsConfirmed },
    settings
  );

  // Rolling 24h quota (per-user override wins over the global setting).
  const quota = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(declared_size_bytes), 0) AS used
       FROM upload_jobs
      WHERE user_id = ?
        AND created_at >= datetime('now', '-1 day')
        AND status NOT IN ('failed', 'expired', 'cancelled', 'duplicate')`
  )
    .bind(user.id)
    .first<{ used: number }>();

  const userRow = await c.env.DB.prepare('SELECT upload_quota_bytes FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ upload_quota_bytes: number | null }>();
  const limit = userRow?.upload_quota_bytes ?? settings.uploadDailyUserQuotaBytes;
  if (limit > 0 && (quota?.used ?? 0) + body.size > limit) {
    throw payloadTooLarge(
      `Daily upload quota exceeded. Used ${quota?.used ?? 0} of ${limit} bytes in the last 24 hours.`
    );
  }

  const decision = await selectUploadProvider(c.env, c.env.DB, {
    estimatedBytes: body.size,
    preferPresign: body.preferredMode !== 'worker',
  });
  const selected = assertRouting(decision, logger);

  const direct = selected.adapter.canPresign && body.preferredMode !== 'worker';
  if (!direct && !selected.adapter.supportsStreamingWrite) {
    throw unavailable(
      `Provider "${selected.provider.name}" cannot accept uploads: it supports neither presigned uploads nor streamed writes.`
    );
  }

  const jobId = newId('upl');
  const objectKey = uploadObjectKey(user.id, jobId, body.filename);
  const expiresAt = new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString();
  const normalizedMime = body.mimeType.toLowerCase().split(';')[0]!.trim();

  const metadata = {
    title: body.title,
    artist: body.artist,
    album: body.album,
    albumArtist: body.albumArtist,
    genre: body.genre,
    year: body.year,
    trackNumber: body.trackNumber,
    discNumber: body.discNumber,
  };

  await c.env.DB.prepare(
    `INSERT INTO upload_jobs
       (id, user_id, provider_id, status, upload_mode, object_key, bucket_name, filename, declared_mime_type,
        declared_size_bytes, metadata, rights_confirmed, turnstile_verified, expires_at)
     VALUES (?, ?, ?, 'initiated', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      jobId,
      user.id,
      selected.provider.id,
      direct ? 'direct' : 'worker',
      objectKey,
      selected.provider.bucket_name,
      body.filename.slice(0, 255),
      normalizedMime,
      body.size,
      JSON.stringify(metadata),
      body.rightsConfirmed ? 1 : 0,
      c.get('config').hasTurnstileSecret ? 1 : 0,
      expiresAt
    )
    .run();

  let uploadUrl: string;
  const headers: Record<string, string> = { 'content-type': normalizedMime };

  if (direct) {
    const presigned = await selected.adapter.presignPut(objectKey, {
      contentType: normalizedMime,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    });
    if (!presigned) {
      throw unavailable('Provider advertises presigned uploads but returned no URL.');
    }
    uploadUrl = presigned;
  } else {
    uploadUrl = absoluteUrl(c, `/api/upload/${jobId}/file`);
    headers.authorization = `Bearer ${c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''}`;
  }

  await writeAudit(
    c.env.DB,
    {
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'upload.initiated',
      targetType: 'upload_job',
      targetId: jobId,
      metadata: { size: body.size, mimeType: normalizedMime, providerId: selected.provider.id, mode: direct ? 'direct' : 'worker' },
      ipHash,
      userAgent: userAgent(c),
    },
    logger
  );

  return c.json(
    {
      jobId,
      uploadMode: direct ? 'direct' : 'worker',
      method: 'PUT',
      uploadUrl,
      headers,
      expiresAt,
      maxBytes: settings.uploadMaxBytes,
      provider: { id: selected.provider.id, name: selected.provider.name },
      next: 'Upload the bytes to uploadUrl, then POST /api/upload/complete.',
    },
    201,
    noStoreHeaders()
  );
});

/* -------------------------------------------------------------------------- */
/* PUT /api/upload/:id/file — Worker-proxied upload (binding providers)        */
/* -------------------------------------------------------------------------- */

uploadRoutes.put('/:id/file', async (c) => {
  const user = await requireUser(c);
  const settings = c.get('settings');
  const logger = c.get('logger');
  const jobId = c.req.param('id');

  const job = await loadJob(c.env.DB, jobId);
  if (!job) throw notFound('Upload job not found.');
  assertJobOwner(job, user.id, user.role);
  if (job.upload_mode !== 'worker') throw conflict('This upload must be sent directly to the provider using the presigned URL.');
  if (job.status !== 'initiated' && job.status !== 'uploaded') {
    throw conflict(`Upload job is "${job.status}" and can no longer accept bytes.`);
  }
  if (new Date(job.expires_at).getTime() < Date.now()) {
    throw conflict('This upload URL has expired. Start a new upload.');
  }

  const provider = job.provider_id ? await getProviderById(c.env.DB, job.provider_id) : null;
  if (!provider) throw notFound('Storage provider for this upload no longer exists.');
  const adapter = requireAdapter(c.env, provider);

  const contentLength = Number(c.req.header('content-length') ?? '0');
  if (contentLength > settings.uploadMaxBytes) {
    throw payloadTooLarge(`Upload exceeds the maximum of ${settings.uploadMaxBytes} bytes.`);
  }
  if (contentLength > 0 && contentLength !== job.declared_size_bytes) {
    throw conflict(`Content-Length (${contentLength}) does not match the declared size (${job.declared_size_bytes}).`);
  }

  const body = c.req.raw.body;
  if (!body) throw badRequest('A request body with the audio bytes is required.');

  const limited = limitStream(body, Math.min(settings.uploadMaxBytes, job.declared_size_bytes));
  const [forUpload, forHash] = limited.tee();

  let putResult: { size: number; etag?: string };
  let hashResult: { sha256: string; bytes: number };
  try {
    [putResult, hashResult] = await Promise.all([
      adapter.put(job.object_key, forUpload, {
        contentType: job.declared_mime_type,
        sizeBytes: job.declared_size_bytes,
      }),
      sha256StreamHex(forHash),
    ]);
  } catch (error) {
    await adapter.delete(job.object_key).catch(() => undefined);
    await c.env.DB.prepare(
      "UPDATE upload_jobs SET status = 'failed', error_code = 'STREAM_FAILED', error_message = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    )
      .bind(error instanceof Error ? error.message : String(error), job.id)
      .run();
    logger.error('upload_stream_failed', { jobId: job.id, error });
    throw badRequest('The upload could not be stored. Please retry.');
  }

  await c.env.DB.prepare(
    `UPDATE upload_jobs
        SET status = 'uploaded', uploaded_size_bytes = ?, sha256 = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  )
    .bind(hashResult.bytes, hashResult.sha256, job.id)
    .run();

  return c.json(
    { jobId: job.id, bytes: putResult.size, sha256: hashResult.sha256, next: 'POST /api/upload/complete' },
    200,
    noStoreHeaders()
  );
});

/* -------------------------------------------------------------------------- */
/* POST /api/upload/complete                                                   */
/* -------------------------------------------------------------------------- */

uploadRoutes.post('/complete', async (c) => {
  const user = await requireUser(c);
  const jobId = c.req.query('jobId');
  if (!jobId) throw badRequest('jobId query parameter is required.');

  const body = await c.req.json().catch(() => ({}));
  const parsed = completeSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw badRequest('Invalid completion payload.', parsed.error.issues.map((issue) => issue.message));
  }

  const logger = c.get('logger');
  const settings = c.get('settings');
  const ipHash = hashIp(clientIp(c));

  const job = await loadJob(c.env.DB, jobId);
  if (!job) throw notFound('Upload job not found.');
  assertJobOwner(job, user.id, user.role);

  // Idempotency: a completed job returns its result instead of processing twice.
  if (['awaiting_review', 'published'].includes(job.status) && job.track_id) {
    const track = await c.env.DB.prepare(`${MODERATED_TRACK_SELECT} WHERE t.id = ?`)
      .bind(job.track_id)
      .first<TrackRowJoined>();
    return c.json(
      {
        jobId: job.id,
        trackId: job.track_id,
        status: job.status,
        track: track ? serializeModeratedTrack(track) : null,
        moderation: { required: job.status === 'awaiting_review' },
        alreadyCompleted: true,
      },
      200,
      noStoreHeaders()
    );
  }
  if (job.status === 'duplicate') {
    throw conflict('This recording already exists in the library.', { jobId: job.id });
  }
  if (job.status === 'processing') {
    throw conflict('This upload is already being processed.', { jobId: job.id });
  }
  if (['failed', 'cancelled', 'expired', 'rejected'].includes(job.status)) {
    throw conflict(`Upload job is "${job.status}" and cannot be completed.`, {
      reason: job.error_message ?? job.status,
    });
  }
  if (new Date(job.expires_at).getTime() < Date.now() && job.status === 'initiated') {
    await c.env.DB.prepare("UPDATE upload_jobs SET status = 'expired' WHERE id = ?").bind(job.id).run();
    throw conflict('This upload expired before any bytes were received. Start a new upload.');
  }

  // Claim the job atomically so two concurrent completes cannot both process it.
  const claim = await c.env.DB.prepare(
    "UPDATE upload_jobs SET status = 'processing', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status IN ('initiated','uploaded')"
  )
    .bind(job.id)
    .run();
  if ((claim.meta?.changes ?? 0) === 0) {
    throw conflict('This upload is already being processed.', { jobId: job.id });
  }

  const provider = job.provider_id ? await getProviderById(c.env.DB, job.provider_id) : null;
  if (!provider) {
    await c.env.DB.prepare("UPDATE upload_jobs SET status = 'failed', error_code = 'PROVIDER_MISSING' WHERE id = ?")
      .bind(job.id)
      .run();
    throw notFound('Storage provider for this upload no longer exists.');
  }
  const adapter = requireAdapter(c.env, provider);

  const uploaderMetadata = ((): Record<string, unknown> => {
    if (!job.metadata) return {};
    try {
      const parsed = JSON.parse(job.metadata) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  })();

  try {
    const result = await processCompletedUpload({
      db: c.env.DB,
      adapter,
      providerId: provider.id,
      bucketName: provider.bucket_name,
      job,
      settings,
      uploaderMetadata,
      logger,
      ...(job.sha256 ? { streamedHash: job.sha256 } : {}),
    });

    if (parsed.data.sha256 && parsed.data.sha256.toLowerCase() !== result.sha256.toLowerCase()) {
      throw conflict('Upload integrity check failed: the client reported hash does not match the stored object.', {
        expected: parsed.data.sha256,
        actual: result.sha256,
      });
    }

    await c.env.DB.prepare(
      `UPDATE upload_jobs
          SET status = ?, track_id = ?, sha256 = ?, uploaded_size_bytes = ?, completed_at = ?, updated_at = ?
        WHERE id = ?`
    )
      .bind(result.status, result.trackId, result.sha256, result.bytes, new Date().toISOString(), new Date().toISOString(), job.id)
      .run();

    await writeAudit(
      c.env.DB,
      {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'upload.completed',
        targetType: 'upload_job',
        targetId: job.id,
        metadata: { trackId: result.trackId, bytes: result.bytes, status: result.status },
        ipHash,
      },
      logger
    );
    await writeAudit(
      c.env.DB,
      {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'track.created',
        targetType: 'track',
        targetId: result.trackId,
        metadata: { format: result.metadata.format, autoPublished: result.status === 'published' },
        ipHash,
      },
      logger
    );

    const track = await c.env.DB.prepare(`${MODERATED_TRACK_SELECT} WHERE t.id = ?`)
      .bind(result.trackId)
      .first<TrackRowJoined>();

    return c.json(
      {
        jobId: job.id,
        trackId: result.trackId,
        status: result.status,
        track: track ? serializeModeratedTrack(track) : null,
        metadata: {
          format: result.metadata.format,
          mimeType: result.metadata.mimeType,
          durationMs: result.metadata.durationMs ?? null,
          sampleRate: result.metadata.sampleRate ?? null,
          channels: result.metadata.channels ?? null,
          bitDepth: result.metadata.bitDepth ?? null,
          bitrateKbps: result.metadata.bitrateKbps ?? null,
          artworkStored: result.artworkStored,
          warnings: result.metadata.warnings,
        },
        moderation: { required: result.status === 'awaiting_review' },
      },
      201,
      noStoreHeaders()
    );
  } catch (error) {
    const duplicate =
      isAppError(error) &&
      error.status === 409 &&
      typeof error.details === 'object' &&
      error.details !== null &&
      'duplicateTrackId' in (error.details as Record<string, unknown>);

    await c.env.DB.prepare(
      `UPDATE upload_jobs
          SET status = ?, error_code = ?, error_message = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    )
      .bind(
        duplicate ? 'duplicate' : 'failed',
        isAppError(error) ? error.code : 'INTERNAL_ERROR',
        error instanceof Error ? error.message.slice(0, 500) : 'Unknown error',
        job.id
      )
      .run();

    await writeAudit(
      c.env.DB,
      {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'upload.failed',
        targetType: 'upload_job',
        targetId: job.id,
        metadata: { code: isAppError(error) ? error.code : 'INTERNAL_ERROR' },
        ipHash,
      },
      logger
    );

    throw error;
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/upload/status/:id, GET /api/upload/mine, POST /api/upload/:id/cancel */
/* -------------------------------------------------------------------------- */

uploadRoutes.get('/status/:id', async (c) => {
  const user = await requireUser(c);
  const job = await loadJob(c.env.DB, c.req.param('id'));
  if (!job) throw notFound('Upload job not found.');
  assertJobOwner(job, user.id, user.role);

  const track = job.track_id
    ? await c.env.DB.prepare(`${MODERATED_TRACK_SELECT} WHERE t.id = ?`).bind(job.track_id).first<TrackRowJoined>()
    : null;

  return c.json(
    {
      job: {
        id: job.id,
        status: job.status,
        filename: job.filename,
        uploadMode: job.upload_mode,
        declaredSizeBytes: job.declared_size_bytes,
        uploadedSizeBytes: job.uploaded_size_bytes,
        progress:
          job.uploaded_size_bytes && job.declared_size_bytes > 0
            ? Math.min(1, job.uploaded_size_bytes / job.declared_size_bytes)
            : job.status === 'initiated'
              ? 0
              : 1,
        errorCode: job.error_code,
        errorMessage: job.error_message,
        createdAt: job.created_at,
        expiresAt: job.expires_at,
        completedAt: job.completed_at,
      },
      track: track ? serializeModeratedTrack(track) : null,
      moderation: { required: job.status === 'awaiting_review' },
    },
    200,
    noStoreHeaders()
  );
});

uploadRoutes.get('/mine', async (c) => {
  const user = await requireUser(c);
  const { limit, offset } = pagination(c);

  const rows = await c.env.DB.prepare(
    `SELECT id, status, filename, uploaded_size_bytes, declared_size_bytes, error_code, error_message,
            created_at, completed_at, track_id
       FROM upload_jobs
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?`
  )
    .bind(user.id, limit, offset)
    .all<Record<string, unknown>>();

  const total = await c.env.DB.prepare('SELECT COUNT(*) AS count FROM upload_jobs WHERE user_id = ?')
    .bind(user.id)
    .first<{ count: number }>();

  return c.json(
    {
      uploads: (rows.results ?? []).map((row) => ({
        id: row.id,
        status: row.status,
        filename: row.filename,
        uploadedSizeBytes: row.uploaded_size_bytes,
        declaredSizeBytes: row.declared_size_bytes,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        trackId: row.track_id,
        createdAt: row.created_at,
        completedAt: row.completed_at,
      })),
      pagination: { total: total?.count ?? 0, limit, offset },
    },
    200,
    noStoreHeaders()
  );
});

uploadRoutes.post('/:id/cancel', async (c) => {
  const user = await requireUser(c);
  const logger = c.get('logger');
  const job = await loadJob(c.env.DB, c.req.param('id'));
  if (!job) throw notFound('Upload job not found.');
  assertJobOwner(job, user.id, user.role);

  if (!['initiated', 'uploaded', 'failed'].includes(job.status)) {
    throw conflict(`Upload job is "${job.status}" and cannot be cancelled.`);
  }

  await c.env.DB.prepare(
    "UPDATE upload_jobs SET status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  )
    .bind(job.id)
    .run();

  if (job.provider_id) {
    const provider = await getProviderById(c.env.DB, job.provider_id);
    if (provider) {
      try {
        await requireAdapter(c.env, provider).delete(job.object_key);
      } catch (error) {
        logger.warn('upload_cancel_cleanup_failed', { jobId: job.id, error });
      }
    }
  }

  return c.json({ ok: true, jobId: job.id, status: 'cancelled' }, 200, noStoreHeaders());
});

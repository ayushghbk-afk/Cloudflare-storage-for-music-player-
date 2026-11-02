import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { isAppError, notFound, rangeNotSatisfiable, unavailable } from '../utils/errors';
import { absoluteUrl, noStoreHeaders } from '../utils/http';
import { background } from '../utils/background';
import { parseRange, contentRangeHeader } from '../utils/range';
import { requireJwtSecret } from '../config';
import { createStreamToken } from './signed';
import { authorizeMedia, cacheControlFor } from './authz';
import { serveTrackArtwork } from './artwork';
import { assertCopiesExist, contentTypeFor, loadObjectCandidates, loadStreamableTrack, resolveCopies, type ResolvedCopy } from './serve';

export const streamRoutes = new Hono<AppEnv>();
export const artworkRoutes = new Hono<AppEnv>();

function mediaHeaders(cacheControl: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'accept-ranges': 'bytes',
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff',
    ...extra,
  };
}

/**
 * GET /api/stream/:id
 *
 * Behaviour:
 *  * Range request  -> Worker proxies a 206 Partial Content response (works for
 *    every player, including those that cannot follow a cross-origin redirect).
 *  * Plain GET      -> 302 redirect to a presigned provider URL when the provider
 *    supports it (no audio bytes flow through the Worker, no egress cost), or a
 *    streamed 200 response when it does not.
 *  * Provider failure on the primary copy transparently falls back to the next
 *    stored copy of the same track.
 */
streamRoutes.get('/:id', async (c) => {
  const trackId = c.req.param('id');
  const logger = c.get('logger');
  const config = c.get('config');
  const settings = c.get('settings');

  const track = await loadStreamableTrack(c.env.DB, trackId);
  if (!track) throw notFound('Track not found.');
  await authorizeMedia(c, track);

  const candidates = await loadObjectCandidates(c.env.DB, track.id, 'audio');
  const { copies, failures } = await resolveCopies(c.env, c.env.DB, candidates, logger);
  assertCopiesExist(copies, failures);

  const isHead = c.req.method === 'HEAD';
  const rangeHeader = c.req.header('range');
  const cacheControl = cacheControlFor(track);

  for (const copy of copies) {
    try {
      const size = copy.candidate.size_bytes || track.size_bytes;

      // Direct-to-provider redirect (cheapest path, no Worker bandwidth).
      const canRedirect = config.streamMode !== 'proxy' && !rangeHeader && copy.adapter.canPresign && !isHead;
      if (canRedirect) {
        const exists = await copy.adapter.head(copy.candidate.object_key);
        if (!exists) {
          logger.warn('stream_object_missing', { trackId: track.id, providerId: copy.candidate.provider_id });
          continue;
        }
        const presigned = await copy.adapter.presignGet(copy.candidate.object_key, settings.streamUrlTtlSeconds);
        if (presigned) {
          return new Response(null, {
            status: 302,
            headers: { location: presigned, 'cache-control': 'no-store', ...mediaHeaders('no-store') },
          });
        }
      }

      const parsed = parseRange(rangeHeader, size);
      if (parsed.kind === 'unsatisfiable') {
        throw rangeNotSatisfiable();
      }

      const contentType = contentTypeFor(copy.candidate, track);

      if (isHead) {
        return new Response(null, {
          status: 200,
          headers: mediaHeaders(cacheControl, {
            'content-type': contentType,
            'content-length': String(size),
          }),
        });
      }

      if (parsed.kind === 'single') {
        const object = await copy.adapter.get(copy.candidate.object_key, {
          offset: parsed.start,
          length: parsed.length,
        });
        if (!object) continue;
        return new Response(object.body, {
          status: 206,
          headers: mediaHeaders(cacheControl, {
            'content-type': contentType,
            'content-length': String(object.returnedBytes),
            'content-range': contentRangeHeader(parsed.start, parsed.end, size),
            ...(copy.candidate.etag ? { etag: `"${copy.candidate.etag}"` } : {}),
          }),
        });
      }

      const object = await copy.adapter.get(copy.candidate.object_key);
      if (!object) continue;

      // Count a play only when a full read starts from the beginning.
      if (!rangeHeader) {
        background(
          c,
          c.env.DB.prepare('UPDATE tracks SET play_count = play_count + 1 WHERE id = ?').bind(track.id).run()
        );
      }

      return new Response(object.body, {
        status: 200,
        headers: mediaHeaders(cacheControl, {
          'content-type': contentType,
          'content-length': String(object.size),
          ...(copy.candidate.etag ? { etag: `"${copy.candidate.etag}"` } : {}),
        }),
      });
    } catch (error) {
      if (isAppError(error)) throw error;
      logger.error('stream_provider_failed', {
        trackId: track.id,
        providerId: copy.candidate.provider_id,
        error,
      });
    }
  }

  throw unavailable('The track could not be read from any storage provider.', {
    trackId: track.id,
    failures,
  });
});

/**
 * GET /api/stream/:id/url — metadata for players.
 *
 * `url` always points at this API (signed, range-capable) so it works in a
 * browser `<audio>` element without bucket CORS configuration. `directUrl` is a
 * presigned provider URL for clients that can talk to R2 directly (Android
 * Media3), avoiding Worker bandwidth entirely.
 */
streamRoutes.get('/:id/url', async (c) => {
  const trackId = c.req.param('id');
  const logger = c.get('logger');
  const config = c.get('config');
  const settings = c.get('settings');

  const track = await loadStreamableTrack(c.env.DB, trackId);
  if (!track) throw notFound('Track not found.');
  await authorizeMedia(c, track);

  const candidates = await loadObjectCandidates(c.env.DB, track.id, 'audio');
  const { copies, failures } = await resolveCopies(c.env, c.env.DB, candidates, logger);
  assertCopiesExist(copies, failures);

  const primary = copies[0]!;
  const secret = requireJwtSecret(config);
  const { expiresAt, token } = await createStreamToken(secret, track.id, settings.streamUrlTtlSeconds);
  const proxyUrl = absoluteUrl(c, `/api/stream/${encodeURIComponent(track.id)}?exp=${expiresAt}&sig=${encodeURIComponent(token)}`);

  let directUrl: string | null = null;
  if (primary.adapter.canPresign) {
    directUrl = await primary.adapter.presignGet(primary.candidate.object_key, settings.streamUrlTtlSeconds);
  }

  const size = primary.candidate.size_bytes || track.size_bytes;

  return c.json(
    {
      trackId: track.id,
      url: proxyUrl,
      directUrl,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      expiresIn: settings.streamUrlTtlSeconds,
      mimeType: contentTypeFor(primary.candidate, track),
      format: track.format,
      sizeBytes: size,
      supportsRange: true,
      // Hints for Media3 / <audio>: always prefer the API URL for cross-origin use.
      headers: { accept: contentTypeFor(primary.candidate, track) },
    },
    200,
    noStoreHeaders()
  );
});

/**
 * GET /api/artwork/:id — cover art proxied from storage.
 */
artworkRoutes.get('/:id', (c) => serveTrackArtwork(c, c.req.param('id')));

export type { ResolvedCopy };

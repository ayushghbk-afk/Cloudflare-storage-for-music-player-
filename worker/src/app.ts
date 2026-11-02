import { Hono } from 'hono';
import type { AppEnv } from './types';
import { PUBLIC_CONFIG_CACHE_KEY, PUBLIC_CONFIG_CACHE_TTL_SECONDS } from './cache';
import { loadConfig } from './config';
import { loadSettingsCached } from './settings';
import { isAppError, AppError, internal } from './utils/errors';
import { clientIp } from './utils/http';
import { createLogger } from './utils/logger';
import { sha256Hex } from './utils/hash';
import { authRoutes } from './auth/routes';
import { resolveUser } from './auth/middleware';
import { trackRoutes } from './catalog/tracks';
import { browseRoutes } from './catalog/browse';
import { playlistRoutes } from './catalog/playlists';
import { libraryRoutes } from './library/routes';
import { uploadRoutes } from './uploads/routes';
import { streamRoutes, artworkRoutes } from './streaming/routes';
import { reportRoutes } from './moderation/routes';
import { playbackRoutes } from './playback/routes';
import { adminModerationRoutes } from './admin/moderation';
import { adminStorageRoutes } from './admin/storage';
import { adminSystemRoutes } from './admin/system';
import { credentialStatus, listProviders } from './storage/registry';

export const API_VERSION = '0.4.0';

/**
 * Build the API application.
 *
 * Kept as a factory (rather than a module-level singleton) so tests can create an
 * isolated app instance per environment.
 */
export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /* ---------------------------------------------------------------------- */
  /* Cross-cutting middleware                                               */
  /* ---------------------------------------------------------------------- */

  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID();
    const config = loadConfig(c.env);
    c.set('requestId', requestId);
    c.set('config', config);
    c.set('ip', clientIp(c));
    c.set(
      'logger',
      createLogger(
        {
          requestId,
          method: c.req.method,
          path: new URL(c.req.url).pathname,
          environment: config.environment,
        },
        'info'
      )
    );
    c.header('x-request-id', requestId);
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    await next();
  });

  /**
   * CORS.
   *
   * Bearer tokens (not cookies) are used for auth, so credentials mode stays off.
   * `ALLOWED_ORIGINS` is a comma separated allowlist; when it is unset the API
   * answers `*` for public reads and logs a warning — a deployment checklist item,
   * not a silent default.
   */
  app.use('*', async (c, next) => {
    const config = c.get('config');
    const origin = c.req.header('origin');
    const allowAll = config.allowedOrigins.length === 0;
    const allowed = allowAll || (origin ? config.allowedOrigins.includes(origin) : false);

    if (allowAll && config.isProduction) {
      c.get('logger').warn('cors_wildcard', { note: 'ALLOWED_ORIGINS is not set; answering with *' });
    }

    if (c.req.method === 'OPTIONS') {
      const headers: Record<string, string> = {
        'access-control-allow-methods': 'GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS',
        'access-control-allow-headers': 'authorization,content-type,if-none-match,range',
        'access-control-max-age': '86400',
        vary: 'origin',
      };
      if (allowed) headers['access-control-allow-origin'] = allowAll ? '*' : (origin ?? '*');
      return new Response(null, { status: 204, headers });
    }

    await next();

    if (allowed) {
      c.res.headers.set('access-control-allow-origin', allowAll ? '*' : (origin ?? '*'));
      c.res.headers.append('vary', 'origin');
    }
    // Media players and fetch() need these to work cross-origin.
    c.res.headers.set('access-control-expose-headers', 'content-length,content-range,accept-ranges,etag,x-request-id');
  });

  // Load admin-configurable settings once per request.
  app.use('/api/*', async (c, next) => {
    c.set('settings', await loadSettingsCached(c.env.DB));
    await next();
  });

  // Resolve the caller once per request (never throws; endpoints enforce auth).
  app.use('/api/*', async (c, next) => {
    try {
      const user = await resolveUser(c);
      if (user) c.set('user', user);
    } catch (error) {
      c.get('logger').warn('user_resolution_failed', { error });
    }
    await next();
  });

  /* ---------------------------------------------------------------------- */
  /* Operational endpoints                                                  */
  /* ---------------------------------------------------------------------- */

  app.get('/', (c) =>
    c.json({
      service: 'aether-public-music-cloud',
      version: API_VERSION,
      docs: 'https://github.com/ayushghbk-afk/Cloudflare-storage-for-music-player-/tree/main/docs',
      health: '/api/health',
    })
  );

  /**
   * GET /api/health — unauthenticated readiness report.
   *
   * Reports *whether configuration exists*, never the values, so an operator can
   * see exactly which step of docs/SETUP.md is still pending.
   */
  app.get('/api/health', async (c) => {
    const config = c.get('config');
    const checks: Record<string, boolean> = {};

    let databaseOk = false;
    let migrationsApplied = false;
    let databaseError: string | null = null;
    try {
      await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
      databaseOk = true;
      const table = await c.env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tracks'"
      ).first<{ name: string }>();
      migrationsApplied = Boolean(table);
    } catch (error) {
      databaseError = error instanceof Error ? error.message : String(error);
    }

    let providerSummary = { total: 0, enabled: 0, healthy: 0 };
    if (databaseOk && migrationsApplied) {
      try {
        const providers = await listProviders(c.env.DB);
        providerSummary = {
          total: providers.length,
          enabled: providers.filter((provider) => provider.enabled === 1).length,
          healthy: providers.filter((provider) => provider.health_status === 'healthy').length,
        };
      } catch {
        providerSummary = { total: 0, enabled: 0, healthy: 0 };
      }
    }

    checks.database = databaseOk;
    checks.migrations = migrationsApplied;
    checks.jwtSecret = Boolean(config.jwtSecret);
    checks.turnstile = config.hasTurnstileSecret;
    checks.r2Binding = Boolean(c.env.MUSIC_BUCKET);
    checks.kvCache = Boolean(c.env.MUSIC_CACHE);
    checks.storageProvider = providerSummary.enabled > 0;

    const ok = databaseOk && migrationsApplied;
    return c.json(
      {
        ok,
        version: API_VERSION,
        environment: config.environment,
        time: new Date().toISOString(),
        checks,
        storage: providerSummary,
        ...(databaseError ? { databaseError } : {}),
        pendingConfiguration: Object.entries(checks)
          .filter(([, value]) => !value)
          .map(([key]) => key),
      },
      ok ? 200 : 503
    );
  });

  /** GET /api/config — public client bootstrap (no secrets). */
  app.get('/api/config', async (c) => {
    const config = c.get('config');
    const kv = c.env.MUSIC_CACHE;

    if (kv) {
      try {
        const cached = await kv.get(PUBLIC_CONFIG_CACHE_KEY);
        if (cached) {
          c.header('x-aether-cache', 'hit');
          return c.body(cached, 200, { 'content-type': 'application/json; charset=utf-8' });
        }
      } catch {
        // Fall through to a fresh build; KV is an optimisation, never a dependency.
      }
    }

    const settings = c.get('settings');
    const providersConfigured = await listProviders(c.env.DB)
      .then((providers) => providers.filter((provider) => provider.enabled === 1 && provider.health_status !== 'error').length)
      .catch(() => 0);

    const payload = JSON.stringify({
      apiVersion: API_VERSION,
      environment: config.environment,
      turnstile: {
        enabled: Boolean(config.turnstileSiteKey),
        siteKey: config.turnstileSiteKey ?? null,
      },
      upload: {
        maxBytes: settings.uploadMaxBytes,
        allowedMimeTypes: settings.uploadAllowedMimeTypes,
        requireRightsConfirmation: settings.uploadRequireRightsConfirmation,
        dailyQuotaBytes: settings.uploadDailyUserQuotaBytes,
        enabled: providersConfigured > 0,
      },
      streaming: {
        urlTtlSeconds: settings.streamUrlTtlSeconds,
        mode: config.streamMode,
      },
    });

    if (kv) {
      try {
        await kv.put(PUBLIC_CONFIG_CACHE_KEY, payload, { expirationTtl: PUBLIC_CONFIG_CACHE_TTL_SECONDS });
        c.header('x-aether-cache', 'miss');
      } catch {
        // Ignore cache write failures.
      }
    }

    return c.body(payload, 200, { 'content-type': 'application/json; charset=utf-8' });
  });

  /* ---------------------------------------------------------------------- */
  /* Routes                                                                 */
  /* ---------------------------------------------------------------------- */

  app.route('/api/auth', authRoutes);
  app.route('/api/tracks', trackRoutes);
  app.route('/api/tracks', reportRoutes);
  app.route('/api', browseRoutes);
  app.route('/api/playlists', playlistRoutes);
  app.route('/api/library', libraryRoutes);
  app.route('/api/upload', uploadRoutes);
  app.route('/api/stream', streamRoutes);
  app.route('/api/artwork', artworkRoutes);
  app.route('/api/playback', playbackRoutes);
  app.route('/api/admin/storage', adminStorageRoutes);
  app.route('/api/admin', adminSystemRoutes);
  app.route('/api/admin', adminModerationRoutes);

  /* ---------------------------------------------------------------------- */
  /* Error handling                                                         */
  /* ---------------------------------------------------------------------- */

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}`,
          requestId: c.get('requestId'),
        },
      },
      404
    )
  );

  app.onError((error, c) => {
    const logger = c.get('logger') ?? createLogger({});
    const requestId = c.get('requestId');

    if (isAppError(error)) {
      const appError = error as AppError;
      if (appError.status >= 500) {
        logger.error('request_failed', { code: appError.code, status: appError.status, error: appError.cause ?? appError });
      } else {
        logger.warn('request_rejected', { code: appError.code, status: appError.status });
      }
      return c.json(
        {
          error: {
            code: appError.code,
            message: appError.expose ? appError.message : 'Internal error.',
            ...(appError.details !== undefined ? { details: appError.details } : {}),
            requestId,
          },
        },
        appError.status as 400,
        appError.status === 429 ? { 'retry-after': String((appError.details as { retryAfterSeconds?: number })?.retryAfterSeconds ?? 60) } : {}
      );
    }

    // Never leak internals, but keep enough to correlate with logs.
    const fingerprint = sha256Hex(String(error instanceof Error ? error.stack ?? error.message : error)).slice(0, 12);
    logger.error('unhandled_error', { error, fingerprint });
    const wrapped = internal('Internal error.', error);
    return c.json(
      { error: { code: wrapped.code, message: 'Internal error.', requestId, fingerprint } },
      500
    );
  });

  return app;
}

/** Runtime entrypoint for the Worker. */
export type { AppEnv };
export { credentialStatus };

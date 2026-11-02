import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../support/env';
import { api } from '../support/client';
import { request } from '../support/client';

let ctx: TestContext | null = null;

afterEach(() => {
  ctx?.close();
  ctx = null;
});

describe('GET /api/health', () => {
  it('reports readiness without leaking configuration values', async () => {
    ctx = await createTestContext();
    const response = await api<{
      ok: boolean;
      version: string;
      environment: string;
      checks: Record<string, boolean>;
      storage: { total: number; enabled: number; healthy: number };
      pendingConfiguration: string[];
    }>(ctx, '/api/health');

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.environment).toBe('test');
    expect(response.body.checks.database).toBe(true);
    expect(response.body.checks.migrations).toBe(true);
    expect(response.body.checks.jwtSecret).toBe(true);
    expect(response.body.checks.r2Binding).toBe(true);
    expect(response.body.checks.kvCache).toBe(true);
    expect(response.body.checks.storageProvider).toBe(true);
    expect(response.body.storage).toEqual({ total: 1, enabled: 1, healthy: 1 });
    // No values, only presence flags.
    expect(response.body.pendingConfiguration).toEqual(expect.arrayContaining(['turnstile']));
    expect(JSON.stringify(response.body)).not.toContain('test-only-jwt-secret');
  });

  it('lists pending configuration and still reports 200 while the database is usable', async () => {
    ctx = await createTestContext({ overrides: { JWT_SECRET: '' }, seedProvider: false });
    const response = await api<{ ok: boolean; checks: Record<string, boolean>; pendingConfiguration: string[] }>(ctx, '/api/health');
    expect(response.status).toBe(200);
    expect(response.body.checks.jwtSecret).toBe(false);
    expect(response.body.checks.storageProvider).toBe(false);
    expect(response.body.pendingConfiguration).toEqual(expect.arrayContaining(['jwtSecret', 'storageProvider']));
  });

  it('fails with 503 when the database is unreachable', async () => {
    ctx = await createTestContext();
    const broken = {
      ...ctx.env,
      DB: {
        prepare() {
          throw new Error('D1 unavailable');
        },
        batch() {
          throw new Error('D1 unavailable');
        },
        exec() {
          throw new Error('D1 unavailable');
        },
      },
    };
    ctx.env = broken as typeof ctx.env;

    const response = await api<{ ok: boolean; checks: Record<string, boolean>; databaseError: string }>(ctx, '/api/health');
    expect(response.status).toBe(503);
    expect(response.body.ok).toBe(false);
    expect(response.body.checks.database).toBe(false);
    expect(response.body.databaseError).toMatch(/D1 unavailable/);
  });
});

describe('GET /api/config', () => {
  it('returns client bootstrap data without secrets', async () => {
    ctx = await createTestContext({ overrides: { TURNSTILE_SITE_KEY: '1x00000000000000000000AA' } });
    const response = await api<{
      apiVersion: string;
      environment: string;
      turnstile: { enabled: boolean; siteKey: string | null };
      upload: { maxBytes: number; allowedMimeTypes: string[]; enabled: boolean; requireRightsConfirmation: boolean };
      streaming: { urlTtlSeconds: number; mode: string };
    }>(ctx, '/api/config');

    expect(response.status).toBe(200);
    expect(response.body.turnstile).toEqual({ enabled: true, siteKey: '1x00000000000000000000AA' });
    expect(response.body.upload.enabled).toBe(true);
    expect(response.body.upload.maxBytes).toBeGreaterThan(0);
    expect(response.body.upload.allowedMimeTypes).toContain('audio/mpeg');
    expect(response.body.upload.requireRightsConfirmation).toBe(true);
    expect(response.body.streaming.mode).toBe('auto');
    expect(response.body.streaming.urlTtlSeconds).toBeGreaterThan(0);
    expect(JSON.stringify(response.body)).not.toMatch(/TURNSTILE_SECRET|JWT_SECRET/);
  });

  it('serves the bootstrap payload from KV and refreshes it after a settings change', async () => {
    ctx = await createTestContext();
    const first = await request(ctx, '/api/config');
    expect(first.headers.get('x-aether-cache')).toBe('miss');
    const firstBody = await first.clone().json();

    const second = await request(ctx, '/api/config');
    expect(second.headers.get('x-aether-cache')).toBe('hit');
    expect(await second.json()).toEqual(firstBody);

    const { registerAdmin } = await import('../support/client');
    const admin = await registerAdmin(ctx);
    const patched = await api(ctx, '/api/admin/settings', { token: admin.token, method: 'PATCH', body: { uploadMaxBytes: 33_554_432 } });
    expect(patched.status).toBe(200);

    const third = await request(ctx, '/api/config');
    expect(third.headers.get('x-aether-cache')).toBe('miss');
    expect(((await third.json()) as { upload: { maxBytes: number } }).upload.maxBytes).toBe(33_554_432);
  });

  it('works without a KV binding at all', async () => {
    ctx = await createTestContext({ overrides: { MUSIC_CACHE: undefined } });
    const response = await request(ctx, '/api/config');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-aether-cache')).toBeNull();
    expect(((await response.json()) as { upload: { enabled: boolean } }).upload.enabled).toBe(true);
  });

  it('reports uploads as disabled when no provider is enabled', async () => {
    ctx = await createTestContext({ seedProvider: false });
    const response = await api<{ upload: { enabled: boolean } }>(ctx, '/api/config');
    expect(response.body.upload.enabled).toBe(false);
  });
});

describe('service root', () => {
  it('advertises the service and a health endpoint', async () => {
    ctx = await createTestContext();
    const response = await api<{ service: string; version: string; health: string; docs: string }>(ctx, '/');
    expect(response.status).toBe(200);
    expect(response.body.service).toBe('aether-public-music-cloud');
    expect(response.body.health).toBe('/api/health');
    expect(response.body.docs).toMatch(/^https:\/\/github\.com\//);
  });
});

describe('error envelope', () => {
  it('returns a structured 404 with a request id', async () => {
    ctx = await createTestContext();
    const response = await api<{ error: { code: string; message: string; requestId: string } }>(ctx, '/api/nope');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.message).toMatch(/No route for GET \/api\/nope/);
    expect(response.body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects malformed JSON with 400 and echoes the request id header', async () => {
    ctx = await createTestContext();
    const response = await request(ctx, '/api/auth/login', {
      method: 'POST',
      rawBody: '{not-json',
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(400);
    const body = (await response.clone().json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.requestId).toBe(response.headers.get('x-request-id'));
  });

  it('rejects unknown fields on a strict schema', async () => {
    ctx = await createTestContext();
    const response = await api(ctx, '/api/auth/login', {
      body: { email: 'a@b.test', password: 'whatever-1234567', admin: true },
    });
    expect(response.status).toBe(422);
  });

  it('sets baseline security headers on every response', async () => {
    ctx = await createTestContext();
    const response = await request(ctx, '/api/health');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('CORS', () => {
  it('answers preflight requests for an allowlisted origin', async () => {
    ctx = await createTestContext();
    const response = await request(ctx, '/api/tracks', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(response.headers.get('access-control-allow-methods')).toContain('GET');
    expect(response.headers.get('access-control-allow-headers')).toContain('range');

    // Expose-headers belongs on the actual (non-preflight) response.
    const actual = await request(ctx, '/api/tracks', { headers: { origin: 'http://localhost:5173' } });
    expect(actual.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(actual.headers.get('access-control-expose-headers')).toContain('content-range');
  });

  it('does not echo an origin outside the allowlist', async () => {
    ctx = await createTestContext();
    const response = await request(ctx, '/api/tracks', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('falls back to * only when ALLOWED_ORIGINS is unset', async () => {
    ctx = await createTestContext({ overrides: { ALLOWED_ORIGINS: '' } });
    const response = await request(ctx, '/api/tracks', { headers: { origin: 'https://anywhere.example' } });
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});

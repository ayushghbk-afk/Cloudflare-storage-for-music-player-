import type { Bindings } from './platform';
import { notConfigured } from './utils/errors';

export type StreamMode = 'auto' | 'proxy' | 'redirect';

/**
 * Runtime configuration derived from Worker variables/secrets.
 *
 * Nothing here is read from the database and nothing here is ever returned to a
 * client except the explicitly public fields used by `/api/config`.
 */
export interface AppConfig {
  environment: string;
  isProduction: boolean;
  allowedOrigins: string[];
  issuer: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  streamMode: StreamMode;
  publicBaseUrl?: string;
  turnstileSiteKey?: string;
  /** Never expose this value; it is only used to verify Turnstile responses. */
  hasTurnstileSecret: boolean;
  jwtSecret?: string;
  bootstrapAdminEmail?: string;
  defaultProviderEndpoint?: string;
  r2DefaultRegion: string;
}

const clampInt = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
};

const asString = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.endsWith('/') ? entry.slice(0, -1) : entry));
}

export function loadConfig(env: Bindings): AppConfig {
  const environment = asString(env.AETHER_ENV) ?? 'development';
  const streamModeRaw = (asString(env.STREAM_MODE) ?? 'auto').toLowerCase();
  const streamMode: StreamMode = streamModeRaw === 'proxy' || streamModeRaw === 'redirect' ? streamModeRaw : 'auto';

  return {
    environment,
    isProduction: environment === 'production',
    allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS),
    issuer: asString(env.JWT_ISSUER) ?? 'aether-api',
    accessTokenTtlSeconds: clampInt(env.ACCESS_TOKEN_TTL_SECONDS, 900, 60, 86_400),
    refreshTokenTtlDays: clampInt(env.REFRESH_TOKEN_TTL_DAYS, 30, 1, 365),
    streamMode,
    ...(asString(env.PUBLIC_BASE_URL) ? { publicBaseUrl: asString(env.PUBLIC_BASE_URL)! } : {}),
    ...(asString(env.TURNSTILE_SITE_KEY) ? { turnstileSiteKey: asString(env.TURNSTILE_SITE_KEY)! } : {}),
    hasTurnstileSecret: Boolean(asString(env.TURNSTILE_SECRET_KEY)),
    ...(asString(env.JWT_SECRET) ? { jwtSecret: asString(env.JWT_SECRET)! } : {}),
    ...(asString(env.BOOTSTRAP_ADMIN_EMAIL) ? { bootstrapAdminEmail: asString(env.BOOTSTRAP_ADMIN_EMAIL)!.toLowerCase() } : {}),
    ...(asString(env.DEFAULT_PROVIDER_ENDPOINT) ? { defaultProviderEndpoint: asString(env.DEFAULT_PROVIDER_ENDPOINT)! } : {}),
    r2DefaultRegion: asString(env.R2_DEFAULT_REGION) ?? 'auto',
  };
}

/**
 * JWT signing secret accessor.
 *
 * A missing secret is a hard configuration error rather than an ephemeral
 * fallback: silently generating one would invalidate every token on the next
 * isolate and hide a broken deployment.
 */
export function requireJwtSecret(config: AppConfig): string {
  if (!config.jwtSecret || config.jwtSecret.length < 32) {
    throw notConfigured(
      'JWT_SECRET is not configured. Run `wrangler secret put JWT_SECRET` (32+ random characters) before using authentication.',
      { missing: ['JWT_SECRET'] }
    );
  }
  return config.jwtSecret;
}

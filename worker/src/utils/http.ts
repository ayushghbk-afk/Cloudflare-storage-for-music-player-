import type { Context } from 'hono';
import type { z } from 'zod';
import type { AppEnv } from '../types';
import { badRequest, validationFailed } from './errors';
import { sha256Hex } from './hash';

export type AppContext = Context<AppEnv>;

/** Parse and validate a JSON body, converting failures into 400/422 responses. */
export async function readJson<S extends z.ZodType>(
  c: AppContext,
  schema: S
): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('Request body must be valid JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw validationFailed('Request validation failed.', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      })),
    });
  }
  return parsed.data;
}

export function parseIntParam(raw: string | undefined | null, field: string): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw badRequest(`${field} must be an integer.`);
  }
  return value;
}

export function parseBoolParam(raw: string | undefined | null): boolean | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = raw.toLowerCase();
  if (['1', 'true', 'yes'].includes(value)) return true;
  if (['0', 'false', 'no'].includes(value)) return false;
  return undefined;
}

export interface Pagination {
  limit: number;
  offset: number;
  page: number;
}

export function pagination(c: AppContext, defaults: { limit?: number; maxLimit?: number } = {}): Pagination {
  const defaultLimit = defaults.limit ?? 25;
  const maxLimit = defaults.maxLimit ?? 100;
  const limit = Math.min(maxLimit, Math.max(1, parseIntParam(c.req.query('limit'), 'limit') ?? defaultLimit));
  const page = Math.max(1, parseIntParam(c.req.query('page'), 'page') ?? 1);
  const explicitOffset = parseIntParam(c.req.query('offset'), 'offset');
  const offset = explicitOffset !== undefined ? Math.max(0, Math.min(100_000, explicitOffset)) : (page - 1) * limit;
  return { limit, offset, page };
}

/**
 * Client IP extraction behind the Cloudflare edge.
 *
 * `CF-Connecting-IP` is authoritative at the edge. We never trust
 * `X-Forwarded-For` unless the request lacks the Cloudflare header, and the value
 * is only ever persisted as a salted hash.
 */
export function clientIp(c: AppContext): string {
  const header =
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-real-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  return header && header.length > 0 ? header : 'unknown';
}

export function hashIp(ip: string): string {
  return sha256Hex(`aether-ip-v1:${ip}`).slice(0, 32);
}

/** Standard no-store headers for authenticated JSON responses. */
export function noStoreHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'cache-control': 'no-store',
    vary: 'authorization, origin',
    ...extra,
  };
}

export function absoluteUrl(c: AppContext, path: string): string {
  const config = c.get('config');
  const base = config.publicBaseUrl ?? new URL(c.req.url).origin;
  return `${base.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

export function userAgent(c: AppContext): string {
  return (c.req.header('user-agent') ?? '').slice(0, 300);
}

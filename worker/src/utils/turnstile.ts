import type { Logger } from './logger';

/**
 * Cloudflare Turnstile verification.
 *
 * When `TURNSTILE_SECRET_KEY` is not configured the check is *skipped* and the
 * caller is told so (see `skipped: true`), which is logged as a warning. Deploy
 * docs mark this as a required production secret; the API never pretends a
 * challenge passed.
 */
export interface TurnstileResult {
  success: boolean;
  skipped: boolean;
  errorCodes: string[];
}

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(
  secret: string | undefined,
  token: string | undefined,
  remoteIp: string | undefined,
  logger?: Logger
): Promise<TurnstileResult> {
  if (!secret) {
    logger?.warn('turnstile_not_configured', {
      note: 'TURNSTILE_SECRET_KEY absent; abuse protection relies on rate limits and auth only.',
    });
    return { success: true, skipped: true, errorCodes: [] };
  }
  if (!token) {
    return { success: false, skipped: false, errorCodes: ['missing-input-response'] };
  }

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp && remoteIp !== 'unknown') body.set('remoteip', remoteIp);

  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) {
      logger?.error('turnstile_siteverify_http_error', { status: response.status });
      return { success: false, skipped: false, errorCodes: ['siteverify-http-error'] };
    }
    const payload = (await response.json()) as { success?: boolean; 'error-codes'?: string[] };
    return {
      success: Boolean(payload.success),
      skipped: false,
      errorCodes: payload['error-codes'] ?? [],
    };
  } catch (error) {
    logger?.error('turnstile_siteverify_failed', { error });
    return { success: false, skipped: false, errorCodes: ['siteverify-unreachable'] };
  }
}

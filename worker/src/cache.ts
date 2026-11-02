import type { Bindings } from './platform';

/**
 * The single place where the API uses Workers KV.
 *
 * Why only here:
 *  * `GET /api/config` is fetched by every client on start-up and is identical
 *    for all callers, so caching it removes repeated D1 reads from the hot path.
 *  * Audio bytes never pass through KV. Streaming goes R2 → client (or through
 *    the Worker with HTTP byte ranges); KV is not a CDN and would add latency.
 *  * Anything requiring strong consistency (auth, uploads, moderation, quotas,
 *    rate limits) reads and writes D1 directly.
 *
 * Staleness is bounded by the TTL *and* proactively cleared on every mutation
 * that can change the payload (settings, providers, provider health).
 */
export const PUBLIC_CONFIG_CACHE_KEY = 'aether:public-config:v1';

/** Short on purpose: the payload is small and correctness beats micro-optimisation. */
export const PUBLIC_CONFIG_CACHE_TTL_SECONDS = 30;

/**
 * Drop the cached bootstrap payload.
 *
 * KV deletes are eventually consistent across colos, which is acceptable here:
 * the cached payload only advertises limits and feature flags, never permissions.
 * Every enforcement path re-reads D1.
 */
export async function invalidatePublicConfigCache(env: Bindings): Promise<void> {
  if (!env.MUSIC_CACHE) return;
  try {
    await env.MUSIC_CACHE.delete(PUBLIC_CONFIG_CACHE_KEY);
  } catch {
    // A cache miss is always correct; a failed delete is therefore harmless.
  }
}

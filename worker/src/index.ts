import { createApp } from './app';
import type { Bindings, ExecutionContext } from './platform';

const app = createApp();

/**
 * Cloudflare Worker entrypoint.
 *
 * Everything is bound to `0.0.0.0`-agnostic fetch events; there is no state in the
 * isolate beyond short-lived caches.
 */
export default {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> | Response {
    return app.fetch(request, env, ctx as unknown as Parameters<typeof app.fetch>[2]);
  },
};

export { createApp };

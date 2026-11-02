import type { AppContext } from './http';

/**
 * Run work after the response is sent.
 *
 * Uses `ctx.waitUntil` when the runtime provides an execution context (real
 * Workers) and degrades to a floating promise in tests. Errors are logged, never
 * propagated: background work must not break the response that already started.
 */
export function background(c: AppContext, task: Promise<unknown>): void {
  const safe = task.catch((error: unknown) => {
    c.get('logger').error('background_task_failed', { error });
  });

  let executionCtx: { waitUntil: (promise: Promise<unknown>) => void } | undefined;
  try {
    executionCtx = (c as unknown as { executionCtx?: { waitUntil: (promise: Promise<unknown>) => void } }).executionCtx;
  } catch {
    executionCtx = undefined;
  }

  if (executionCtx && typeof executionCtx.waitUntil === 'function') executionCtx.waitUntil(safe);
  else void safe;
}

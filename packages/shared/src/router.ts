/**
 * Router status values Nelle can send a request to.
 *
 * `sleeping` counts: llama.cpp keeps the weights and wakes the model on the next
 * request. This module holds no zod so the web bundle can import it.
 */
export const RUNNABLE_ROUTER_STATUSES = ['loaded', 'sleeping'] as const;

export function isRunnableRouterStatus(status: string | null | undefined): boolean {
  return RUNNABLE_ROUTER_STATUSES.includes(status as (typeof RUNNABLE_ROUTER_STATUSES)[number]);
}

/** How long a run waits for a model to finish loading before giving up. */
export const MODEL_LOAD_TIMEOUT_MS = 30_000;
export const MODEL_LOAD_POLL_MS = 500;

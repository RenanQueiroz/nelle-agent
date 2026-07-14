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

/**
 * How long a requested load has to leave `unloaded` before a nonzero exit code is believed.
 *
 * The router never marks a child that died at startup as `failed`: it answers `{success: true}`
 * to the load, leaves the model `unloaded`, and records the exit code. So `unloaded` plus a
 * nonzero exit code is the *only* signal that a load failed instantly -- but the exit code is
 * also still sitting there from any previous failure, so it cannot be trusted the instant a load
 * is requested. A healthy load reaches `loading` within a second; this is the window it gets.
 */
export const MODEL_LOAD_START_GRACE_MS = 3_000;

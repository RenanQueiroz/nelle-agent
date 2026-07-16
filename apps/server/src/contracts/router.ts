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

/**
 * How long a load may go without any sign of progress before the run gives up.
 *
 * This is a **stall** window, not a wall clock: a first load downloads the weights (measured:
 * 6.7 GB ≈ 2 min on a fast connection, arbitrarily long on a slow one), and the old fixed 30s
 * deadline failed every such load while it was working -- reproduced live, `model_load_failed`
 * at 30.0s with the model ready at 33s. Progress -- the repo directory growing, an SSE frame
 * arriving, the router status moving -- resets the window, so a slow download runs to completion
 * while a genuinely wedged load still fails in about a minute.
 */
export const MODEL_LOAD_STALL_MS = 60_000;
/**
 * The backstop for a pathological load that never stops "progressing" -- e.g. a download whose
 * bytes trickle forever. Nothing legitimate takes this long without also stalling somewhere.
 */
export const MODEL_LOAD_ABSOLUTE_MAX_MS = 30 * 60_000;
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

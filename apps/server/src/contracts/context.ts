/**
 * Context-window thresholds, shared so every client colours the same bar at the
 * same fill. Zod-free on purpose: the web bundle imports this module directly.
 */

/** Below this fill the bar is plain; at or above it the user should compact. */
export const CONTEXT_WARNING_RATIO = 0.8;

/** llama.cpp refuses the prompt at or above this fill. */
export const CONTEXT_OVERFLOW_RATIO = 1;

export type ContextUsageStatus = 'ok' | 'warning' | 'overflow';

/** Just the fields the thresholds read, so this module needs no zod schema. */
export type ContextTokenCounts = {
  usedTokens?: number;
  totalTokens?: number;
};

export function contextUsageRatio(context: ContextTokenCounts): number | null {
  const usedTokens = positiveTokenCount(context.usedTokens);
  const totalTokens = positiveTokenCount(context.totalTokens);
  if (usedTokens == null || totalTokens == null) {
    return null;
  }
  return usedTokens / totalTokens;
}

/**
 * An unknown fill is `ok`: a conversation whose model has never reported a
 * context window should not open under a warning banner.
 */
export function contextUsageStatus(context: ContextTokenCounts): ContextUsageStatus {
  const ratio = contextUsageRatio(context);
  if (ratio == null || ratio < CONTEXT_WARNING_RATIO) {
    return 'ok';
  }
  return ratio >= CONTEXT_OVERFLOW_RATIO ? 'overflow' : 'warning';
}

/** Stamps the derived status onto a usage payload before it leaves the server. */
export function withContextStatus<T extends ContextTokenCounts>(
  context: T,
): T & {status: ContextUsageStatus} {
  return {...context, status: contextUsageStatus(context)};
}

export function positiveTokenCount(value: number | undefined): number | undefined {
  return value != null && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

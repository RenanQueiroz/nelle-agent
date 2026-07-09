/**
 * Pi clamps every request's `max_tokens` with (see `pi-ai/src/api/simple-options.ts`):
 *
 *   available = model.contextWindow - estimateContextTokens(context) - CONTEXT_SAFETY_TOKENS
 *   max_tokens = min(model.maxTokens, max(MIN_MAX_TOKENS, available))
 *
 * `MIN_MAX_TOKENS` is 1, so once the prompt plus the safety reserve fills the
 * context window, Pi silently asks llama.cpp for a single token and the reply
 * comes back after one word with `finish_reason: "length"`. Pi's agent system
 * prompt alone is around 4k tokens, so an 8k context window can never produce a
 * usable answer.
 */
export const PI_CONTEXT_SAFETY_TOKENS = 4096;

/** Pi's floor when the context is exhausted. A reply this short is always a bug. */
export const PI_MIN_MAX_TOKENS = 1;

/** Below this many reply tokens the model cannot finish a sentence, let alone a turn. */
export const MIN_USABLE_REPLY_TOKENS = 256;

/** Upper bound we advertise to Pi. Pi clamps it down to whatever the context allows. */
const MAX_REPLY_TOKENS = 8192;

/**
 * The reply budget we advertise to Pi as `model.maxTokens`. Pi clamps this
 * against the live context, so we can be generous: a quarter of the window,
 * never below 1024 and never above `MAX_REPLY_TOKENS`.
 */
export function replyTokenBudget(contextSize: number): number {
  if (!Number.isFinite(contextSize) || contextSize <= 0) {
    return 1024;
  }
  return Math.max(1024, Math.min(MAX_REPLY_TOKENS, Math.floor(contextSize / 4)));
}

/**
 * How many reply tokens Pi will actually allow once `promptTokens` of context
 * are in use. Mirrors `clampMaxTokensToContext`.
 */
export function availableReplyTokens(contextSize: number, promptTokens: number): number {
  if (!Number.isFinite(contextSize) || contextSize <= 0) {
    return replyTokenBudget(contextSize);
  }
  const available = contextSize - promptTokens - PI_CONTEXT_SAFETY_TOKENS;
  return Math.min(replyTokenBudget(contextSize), Math.max(PI_MIN_MAX_TOKENS, available));
}

/**
 * The smallest context window that still leaves `MIN_USABLE_REPLY_TOKENS` of
 * reply budget for a prompt of `promptTokens`.
 */
export function minimumUsableContextSize(promptTokens: number): number {
  return promptTokens + PI_CONTEXT_SAFETY_TOKENS + MIN_USABLE_REPLY_TOKENS;
}

/**
 * True when a prompt of `promptTokens` leaves Pi so little room that the reply
 * will be truncated to a word or two.
 */
export function isReplyBudgetExhausted(contextSize: number, promptTokens: number): boolean {
  return availableReplyTokens(contextSize, promptTokens) < MIN_USABLE_REPLY_TOKENS;
}

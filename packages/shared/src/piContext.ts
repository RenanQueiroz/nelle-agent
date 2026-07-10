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

/**
 * Pi counts every image as a flat 4,800 characters, then divides by four
 * (`ESTIMATED_IMAGE_CHARS` in `pi-ai/src/core/compaction/compaction.ts`). So an
 * image costs Pi 1,200 tokens of its estimate regardless of the picture, while
 * llama.cpp charges around 120 for the ones Nelle renders -- a tenfold
 * overestimate that Pi then subtracts from the reply budget.
 *
 * Pi's agent system prompt measures around 9,400 tokens with host tools off, and
 * it reserves another 4,096. On the default 16,384-token window that leaves room
 * for two images; the third drives `max_tokens` to `PI_MIN_MAX_TOKENS`, llama.cpp
 * returns one token, and the turn ends with no answer.
 */
export const PI_ESTIMATED_IMAGE_TOKENS = 1200;

/**
 * What Pi's agent system prompt costs its own estimate, measured off the wire
 * with host tools disabled: `max_tokens` of 1,649 for a single image on a
 * 16,384-token window puts the rest of the estimate at 9,439.
 *
 * Pi estimates characters divided by four, so this does not move with the
 * tokenizer. It *does* grow when host tools are enabled and their schemas join
 * the prompt, which is why it is only ever used to refuse a message that could
 * not fit even an empty conversation.
 */
export const PI_AGENT_PROMPT_TOKENS = 9439;

/** Below this many reply tokens the model cannot finish a sentence, let alone a turn. */
export const MIN_USABLE_REPLY_TOKENS = 256;

/**
 * The smallest context window in which Pi can hold a conversation, rounded up to
 * a power of two: 9,439 (agent prompt) + 4,096 (Pi's reserve) + 256 (a usable
 * reply) is 13,791, and the rest is room for what the user actually typed.
 *
 * This is a **floor for llama.cpp's `--fit`**, never a cap. llama.cpp adjusts an
 * unset context to the memory it finds, between `--fit-ctx` and the model's
 * trained window, and its own default floor of 4,096 is a window in which Pi's
 * system prompt alone does not fit -- every answer comes back one token long.
 * Told this floor instead, llama.cpp gives a model as much context as the
 * machine allows, and fails to load rather than running uselessly.
 */
export const PI_MINIMUM_CONTEXT_TOKENS = 16_384;

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

/**
 * The smallest context window that leaves a usable reply budget once Pi has
 * charged `imageCount` images against it, given the tokens the rest of the
 * conversation already occupies.
 */
export function minimumContextSizeForImages(imageCount: number, basePromptTokens: number): number {
  return minimumUsableContextSize(basePromptTokens + imageCount * PI_ESTIMATED_IMAGE_TOKENS);
}

/**
 * True when Pi asked llama.cpp for a reply so short it cannot be an answer. The
 * value is read off the wire in Nelle's llama.cpp proxy, so it holds whatever the
 * cause was: a long history, a big attachment, or a context window set too small.
 */
export function isClampedReplyBudget(maxTokens: number | undefined): boolean {
  return maxTokens != null && maxTokens <= PI_MIN_MAX_TOKENS;
}

/**
 * How many images Pi's reply budget can carry on this context window.
 *
 * `basePromptTokens` deliberately excludes the conversation's history, and Pi's
 * system prompt is not a fixed size -- measured at 9,439 tokens, observed 350
 * higher. Both make this an underestimate on purpose: it can only ever let a
 * message through that then reports `reply_budget_exhausted`, where an
 * overestimate would refuse a message that would have worked.
 */
export function maxAffordableImages(
  contextSize: number,
  basePromptTokens: number = PI_AGENT_PROMPT_TOKENS,
): number {
  const room = contextSize - basePromptTokens - PI_CONTEXT_SAFETY_TOKENS - MIN_USABLE_REPLY_TOKENS;
  if (!Number.isFinite(room) || room <= 0) {
    return 0;
  }
  return Math.floor(room / PI_ESTIMATED_IMAGE_TOKENS);
}

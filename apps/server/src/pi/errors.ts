/**
 * Why a Pi run refused, or ended with nothing to show for itself.
 *
 * Each of these carries a `NelleError` code, because a bare 500 with a sentence in it is a thing
 * no second client can render. They are pure: an input, a message, a code -- no repository, no
 * session, no llama.cpp -- which is what let them leave the harness.
 */

import {NELLE_ERROR_CODES} from '../contracts/contracts.ts';
import {
  isClampedReplyBudget,
  MIN_USABLE_REPLY_TOKENS,
  PI_CONTEXT_SAFETY_TOKENS,
  PI_ESTIMATED_IMAGE_TOKENS,
} from '../contracts/piContext.ts';

export class SessionUnavailableError extends Error {
  readonly detail?: string;

  constructor(reason?: string, piSessionPath?: string) {
    super(
      reason
        ? `${reason} Restore the Pi session file, rebuild the conversation from its stored messages, or delete it.`
        : 'The conversation session is unavailable. Restore or import the Pi session file, or delete the conversation.',
    );
    this.name = 'SessionUnavailableError';
    this.detail = piSessionPath;
  }
}

export class ToolsDisabledError extends Error {
  readonly code = 'tools_disabled';
  readonly retryable = false;

  constructor() {
    super(
      'Host tools are disabled, but the model tried to call one. The run was stopped. Enable host tools in Settings > Tools to allow it.',
    );
    this.name = 'ToolsDisabledError';
  }
}

export class ConversationNotFoundError extends Error {
  readonly code = 'conversation_not_found';

  constructor() {
    super('Conversation not found.');
    this.name = 'ConversationNotFoundError';
  }
}

export function isSessionUnavailableError(error: unknown): boolean {
  return error instanceof SessionUnavailableError;
}

export function isConversationNotFoundError(error: unknown): boolean {
  return error instanceof ConversationNotFoundError;
}

/** A fork/clone the client asked for that cannot exist. A 4xx, never a 500. */
export function notBranchableError(message: string): Error {
  const error = new Error(message);
  Object.assign(error, {code: NELLE_ERROR_CODES.conversationNotBranchable, retryable: false});
  return error;
}

/** A variant-switch target that is not an activatable assistant variant. A 4xx, never a 500. */
export function variantNotActivatableError(message: string): Error {
  const error = new Error(message);
  Object.assign(error, {code: NELLE_ERROR_CODES.variantNotActivatable, retryable: false});
  return error;
}

/**
 * A reply budget too small to finish a sentence, but not small enough to end the
 * turn empty. The answer will stop mid-thought, so say why before it does.
 * `null` when the budget is healthy, unknown, or clamped outright -- a clamp is
 * `emptyAnswerError`'s to explain, and warning about it as well would say the
 * same thing twice.
 */
export function squeezedReplyBudgetWarning(maxTokens: number | undefined): string | null {
  if (
    maxTokens == null ||
    isClampedReplyBudget(maxTokens) ||
    maxTokens >= MIN_USABLE_REPLY_TOKENS
  ) {
    return null;
  }
  return (
    `This prompt leaves only ${maxTokens.toLocaleString()} tokens for a reply. ` +
    'Attach fewer files, run /compact, or raise the context size in Settings > Models.'
  );
}

/**
 * Explains a turn that ended with no assistant text.
 *
 * The old message -- "check the llama.cpp model id and logs" -- was true of
 * nothing the user could act on. The common cause is Pi clamping `max_tokens` to
 * one because its context estimate charges 1,200 tokens for every image, so a
 * third image on the default 16,384-token window leaves no reply budget at all.
 */
export function emptyAnswerError(input: {
  providerError?: string;
  maxTokens?: number;
  /** `null` when llama.cpp has never reported a window and none is configured. */
  contextSize: number | null;
  imageCount: number;
}): Error {
  if (input.providerError) {
    return new Error(input.providerError);
  }
  if (!isClampedReplyBudget(input.maxTokens)) {
    return new Error(
      'The Pi harness completed without assistant text. Check the llama.cpp model id and logs.',
    );
  }

  // Pi clamped the reply, so it knew a window even where Nelle does not. Say
  // what happened without naming a number nobody measured.
  const window =
    input.contextSize == null
      ? "this model's context window"
      : `this model's ${input.contextSize.toLocaleString()} token context window`;
  const message =
    input.imageCount > 0
      ? `The ${input.imageCount === 1 ? 'image' : `${input.imageCount} images`} left no room for a ` +
        `reply: Pi charges about ${PI_ESTIMATED_IMAGE_TOKENS.toLocaleString()} tokens per image ` +
        `against ${window}, and reserves ${PI_CONTEXT_SAFETY_TOKENS.toLocaleString()} more. ` +
        'Attach fewer images, or raise the context size in Settings > Models.'
      : `The prompt left no room for a reply inside ${window}. Run /compact, or raise the ` +
        'context size in Settings > Models.';

  const error = new Error(message);
  Object.assign(error, {code: NELLE_ERROR_CODES.replyBudgetExhausted, retryable: false});
  return error;
}

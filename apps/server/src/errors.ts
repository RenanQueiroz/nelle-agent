import type {NelleError} from './contracts/contracts.ts';
import {NELLE_ERROR_CODES} from './contracts/contracts.ts';
import type {ChatStreamEvent} from './types';

type ErrorLike = {
  code?: unknown;
  message?: unknown;
  detail?: unknown;
  retryable?: unknown;
  logRef?: unknown;
  name?: unknown;
};

export function normalizeNelleError(
  error: unknown,
  options: {fallbackCode?: string; retryable?: boolean} = {},
): NelleError {
  const source = isObject(error) ? (error as ErrorLike) : {};
  const rawMessage =
    typeof source.message === 'string' ? source.message : String(error ?? 'Unknown error');
  const explicitCode = typeof source.code === 'string' && source.code ? source.code : null;
  const mapped = mapKnownError(rawMessage, source.name);
  return {
    code: explicitCode ?? mapped?.code ?? options.fallbackCode ?? 'internal_error',
    message: mapped?.message ?? rawMessage,
    detail: typeof source.detail === 'string' ? source.detail : undefined,
    retryable:
      typeof source.retryable === 'boolean'
        ? source.retryable
        : (mapped?.retryable ?? options.retryable),
    logRef: typeof source.logRef === 'string' ? source.logRef : undefined,
  };
}

export function createErrorEvent(
  error: unknown,
  options: {fallbackCode?: string; retryable?: boolean} = {},
): Extract<ChatStreamEvent, {type: 'error'}> {
  return {
    type: 'error',
    ...normalizeNelleError(error, options),
  };
}

function mapKnownError(
  message: string,
  name?: unknown,
): {code: string; message?: string; detail?: string; retryable?: boolean} | null {
  if (message === 'conversation_busy') {
    return {
      code: NELLE_ERROR_CODES.conversationBusy,
      message: 'This conversation already has an active run.',
      retryable: true,
    };
  }
  if (message.startsWith('Invalid conversation status transition:')) {
    return {
      code: NELLE_ERROR_CODES.invalidConversationTransition,
      retryable: false,
    };
  }
  if (name === 'SessionUnavailableError') {
    return {
      code: NELLE_ERROR_CODES.sessionUnavailable,
      retryable: false,
    };
  }
  return mapContextOverflow(message);
}

/**
 * Recognises llama.cpp's context-overflow error wherever it surfaces.
 *
 * llama.cpp answers 400 with
 * `{"error":{"type":"exceed_context_size_error","n_prompt_tokens":N,"n_ctx":M,...}}`
 * (`tools/server/server-task.cpp`), and can emit the same object as an in-stream
 * `error` chunk. Nelle's proxy relays it verbatim, so by the time it reaches here
 * it is embedded in whatever text Pi or the fallback path threw. The `type`
 * string is unique to this condition, which is what makes matching on it safe.
 */
function mapContextOverflow(
  message: string,
): {code: string; message: string; detail?: string; retryable: boolean} | null {
  if (!message.includes('exceed_context_size_error')) {
    return null;
  }
  const promptTokens = readNumberField(message, 'n_prompt_tokens');
  const contextSize = readNumberField(message, 'n_ctx');
  const counts =
    promptTokens != null && contextSize != null
      ? `The prompt is ${promptTokens.toLocaleString()} tokens and the context window is ${contextSize.toLocaleString()}.`
      : null;
  return {
    code: NELLE_ERROR_CODES.contextOverflow,
    message: [
      'This prompt is longer than the model’s context window.',
      counts,
      'Compact the conversation with /compact, or raise the context size in Settings > Models.',
    ]
      .filter(Boolean)
      .join(' '),
    detail: counts ?? undefined,
    retryable: false,
  };
}

function readNumberField(text: string, field: string): number | null {
  const match = text.match(new RegExp(`"${field}"\\s*:\\s*(\\d+)`));
  const value = match?.[1] == null ? Number.NaN : Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

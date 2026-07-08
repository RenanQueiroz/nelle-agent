import type {NelleError} from '../../../packages/shared/src/contracts.ts';
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
): {code: string; message?: string; retryable?: boolean} | null {
  if (message === 'conversation_busy') {
    return {
      code: 'conversation_busy',
      message: 'This conversation already has an active run.',
      retryable: true,
    };
  }
  if (message.startsWith('Invalid conversation status transition:')) {
    return {
      code: 'invalid_conversation_transition',
      retryable: false,
    };
  }
  if (name === 'SessionUnavailableError') {
    return {
      code: 'session_unavailable',
      retryable: false,
    };
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

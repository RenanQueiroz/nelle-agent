import {
  contextUsageRatio,
  contextUsageStatus,
  positiveTokenCount,
} from '../../../../packages/shared/src/context.ts';
import type {ConversationContextUsage} from '../api';

export {contextUsageRatio, positiveTokenCount};

/**
 * The server stamps `status` on every payload it sends. A payload that predates
 * the field still renders, by falling back to the same shared thresholds.
 */
function statusOf(context: ConversationContextUsage) {
  return context.status ?? contextUsageStatus(context);
}

export function getContextOverflowMessage(context: ConversationContextUsage): string | null {
  return statusOf(context) === 'overflow' ? 'The selected model context window is full.' : null;
}

export function getContextWarningMessage(context: ConversationContextUsage): string | null {
  if (statusOf(context) !== 'warning') {
    return null;
  }
  const ratio = contextUsageRatio(context);
  return ratio == null ? null : `Context is ${Math.round(ratio * 100)}% full.`;
}

export function contextProgressVariant(
  context: ConversationContextUsage,
): 'accent' | 'warning' | 'error' {
  switch (statusOf(context)) {
    case 'overflow':
      return 'error';
    case 'warning':
      return 'warning';
    default:
      return 'accent';
  }
}

export function formatInteger(value: number): string {
  return value.toLocaleString();
}

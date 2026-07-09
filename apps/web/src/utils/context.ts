import type {ConversationContextUsage} from '../api';

export function getContextOverflowMessage(context: ConversationContextUsage): string | null {
  const ratio = contextUsageRatio(context);
  if (ratio == null || ratio < 1) {
    return null;
  }
  return 'The selected model context window is full.';
}

export function getContextWarningMessage(context: ConversationContextUsage): string | null {
  const ratio = contextUsageRatio(context);
  if (ratio == null || ratio < 0.8 || ratio >= 1) {
    return null;
  }
  return `Context is ${Math.round(ratio * 100)}% full.`;
}

export function contextProgressVariant(
  context: ConversationContextUsage,
): 'accent' | 'warning' | 'error' {
  const ratio = contextUsageRatio(context);
  if (ratio == null || ratio < 0.8) {
    return 'accent';
  }
  return ratio >= 1 ? 'error' : 'warning';
}

export function contextUsageRatio(context: ConversationContextUsage): number | null {
  const usedTokens = positiveTokenCount(context.usedTokens);
  const totalTokens = positiveTokenCount(context.totalTokens);
  if (usedTokens == null || totalTokens == null) {
    return null;
  }
  return usedTokens / totalTokens;
}

export function positiveTokenCount(value: number | undefined): number | undefined {
  return value != null && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

export function formatInteger(value: number): string {
  return value.toLocaleString();
}

import {MAX_REASONING_BUDGET, type ReasoningBudgets} from '../api';

/**
 * Parses the Settings drafts, rejecting anything llama.cpp would not accept as
 * a `thinking_budget_tokens` value. Returns `null` when any field is invalid.
 */
export function parseReasoningBudgets(
  inputs: Record<keyof ReasoningBudgets, string>,
): ReasoningBudgets | null {
  const parsed = {} as ReasoningBudgets;
  for (const level of ['low', 'medium', 'high'] as const) {
    const raw = inputs[level].trim();
    if (!/^\d+$/.test(raw)) {
      return null;
    }
    const tokens = Number(raw);
    if (!Number.isSafeInteger(tokens) || tokens > MAX_REASONING_BUDGET) {
      return null;
    }
    parsed[level] = tokens;
  }
  return parsed;
}

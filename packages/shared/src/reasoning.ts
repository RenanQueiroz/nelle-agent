import {z} from 'zod';

/**
 * Nelle's reasoning levels, matching llama.cpp's UI: three capped tiers plus an
 * uncapped one. `max` has no budget by definition, so only the capped tiers are
 * configurable.
 *
 * Pi's `ThinkingLevel` also knows `minimal` and `xhigh`; neither maps onto
 * anything llama.cpp does differently, because the only lever an
 * OpenAI-completions provider has is `enable_thinking` plus a token budget.
 */
export const reasoningLevelSchema = z.enum(['off', 'low', 'medium', 'high', 'max']);

export type ReasoningLevel = z.infer<typeof reasoningLevelSchema>;
export type BudgetedReasoningLevel = Exclude<ReasoningLevel, 'off' | 'max'>;

export const REASONING_LEVELS = reasoningLevelSchema.options;

/** Fallback for a stored value that is not a level Nelle knows. */
export const DEFAULT_REASONING_LEVEL: ReasoningLevel = 'off';

/**
 * New conversations think as hard as the model allows. On a model whose chat
 * template has no thinking mode this is inert -- `enable_thinking` is just an
 * unused kwarg, and `max` sends no budget -- so it needs no per-model default.
 * Conversations that predate this setting keep the `off` migration 4 gave them.
 */
export const DEFAULT_NEW_CONVERSATION_REASONING_LEVEL: ReasoningLevel = 'max';

/** Pi clamps an unsupported level to the nearest one the model advertises. */
export function piThinkingLevel(level: ReasoningLevel): string {
  return level === 'max' ? 'xhigh' : level;
}

/**
 * Reasoning tokens allowed before llama.cpp forces the thinking block closed.
 * `0` means unlimited: llama.cpp spells that `-1`, but a budget of zero would
 * otherwise read as "no thinking at all", which is what `off` is for.
 */
export const UNLIMITED_REASONING_BUDGET = 0;
export const MAX_REASONING_BUDGET = 65_536;

export const reasoningBudgetsSchema = z.object({
  low: z.number().int().min(0).max(MAX_REASONING_BUDGET),
  medium: z.number().int().min(0).max(MAX_REASONING_BUDGET),
  high: z.number().int().min(0).max(MAX_REASONING_BUDGET),
});

export type ReasoningBudgets = z.infer<typeof reasoningBudgetsSchema>;

/** The same tiers llama.cpp's built-in UI ships with. */
export const DEFAULT_REASONING_BUDGETS: ReasoningBudgets = {
  low: 512,
  medium: 2048,
  high: 8192,
};

export const reasoningSettingsSchema = z.object({
  budgets: reasoningBudgetsSchema,
});

export type ReasoningSettings = z.infer<typeof reasoningSettingsSchema>;

export const DEFAULT_REASONING_SETTINGS: ReasoningSettings = {
  budgets: DEFAULT_REASONING_BUDGETS,
};

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return reasoningLevelSchema.safeParse(value).success;
}

export function normalizeReasoningLevel(value: unknown): ReasoningLevel {
  return isReasoningLevel(value) ? value : DEFAULT_REASONING_LEVEL;
}

export function normalizeReasoningBudgets(value: unknown): ReasoningBudgets {
  const parsed = reasoningBudgetsSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const partial = (value ?? {}) as Partial<Record<BudgetedReasoningLevel, unknown>>;
  const clamp = (input: unknown, fallback: number): number => {
    const numeric = typeof input === 'number' ? input : Number(input);
    if (!Number.isFinite(numeric) || numeric < 0) {
      return fallback;
    }
    return Math.min(Math.floor(numeric), MAX_REASONING_BUDGET);
  };
  return {
    low: clamp(partial.low, DEFAULT_REASONING_BUDGETS.low),
    medium: clamp(partial.medium, DEFAULT_REASONING_BUDGETS.medium),
    high: clamp(partial.high, DEFAULT_REASONING_BUDGETS.high),
  };
}

export function isReasoningEnabled(level: ReasoningLevel): boolean {
  return level !== 'off';
}

/**
 * Tokens to allow inside the thinking block, or `null` when the model should
 * think without a cap. llama.cpp reads this from `thinking_budget_tokens`;
 * neither `reasoning_budget` nor `chat_template_kwargs.thinking_budget` has any
 * effect on a per-request basis.
 */
export function reasoningBudgetTokens(
  level: ReasoningLevel,
  budgets: ReasoningBudgets,
): number | null {
  if (level === 'off' || level === 'max') {
    return null;
  }
  const budget = budgets[level];
  return budget > UNLIMITED_REASONING_BUDGET ? budget : null;
}

const THINKING_END_TAGS = [
  '</think>',
  '</thinking>',
  '</thought>',
  '</reasoning>',
  '<channel|>',
] as const;
const LONGEST_THINKING_END_TAG = Math.max(...THINKING_END_TAGS.map(tag => tag.length));

/**
 * llama-server splits thinking from the answer for us: thinking arrives as
 * `delta.reasoning_content`, the answer as `delta.content`. Nelle never parses
 * thinking tags, and neither does llama.cpp's own UI.
 *
 * The one case the server leaves to the client: when a budget forces the block
 * closed, llama.cpp feeds the model its own end tag and then moves the sampler
 * to `REASONING_BUDGET_DONE`, which passes everything through as content. The
 * model, having just been handed `</think>`, frequently emits another one —
 * three of four truncated Qwen turns did. Drop that echo; it is never an answer.
 */
export function stripLeadingThinkingEndTag(text: string): string {
  const leadingWhitespace = text.length - text.trimStart().length;
  const trimmed = text.slice(leadingWhitespace);
  const tag = THINKING_END_TAGS.find(candidate => trimmed.startsWith(candidate));
  return tag == null ? text : trimmed.slice(tag.length).trimStart();
}

/** Bounds how long a run of leading whitespace can keep the decision open. */
const MAX_BUFFERED_PREFIX = LONGEST_THINKING_END_TAG + 8;

/** `true` while `text` could still grow into a leading end tag. */
function couldBecomeThinkingEndTag(text: string): boolean {
  if (text.length > MAX_BUFFERED_PREFIX) {
    return false;
  }
  const trimmed = text.trimStart();
  if (trimmed.length > LONGEST_THINKING_END_TAG) {
    return false;
  }
  return THINKING_END_TAGS.some(tag => tag.startsWith(trimmed));
}

export type ThinkingEndTagFilter = {
  /** Text safe to emit now; empty while the opening bytes are still ambiguous. */
  push(delta: string): string;
  /** Any text held back when the stream ended mid-decision. */
  flush(): string;
};

/**
 * Holds back the first few answer bytes until they are known not to be a stray
 * thinking end tag. Costs at most one token of latency, and only on the first
 * delta of a turn.
 */
export function createThinkingEndTagFilter(): ThinkingEndTagFilter {
  let buffer = '';
  let decided = false;

  return {
    push(delta) {
      if (decided) {
        return delta;
      }
      buffer += delta;
      if (couldBecomeThinkingEndTag(buffer)) {
        return '';
      }
      decided = true;
      const emitted = stripLeadingThinkingEndTag(buffer);
      buffer = '';
      return emitted;
    },
    flush() {
      if (decided) {
        return '';
      }
      decided = true;
      const emitted = stripLeadingThinkingEndTag(buffer);
      buffer = '';
      return emitted;
    },
  };
}

/**
 * Kwargs a chat template reads to turn thinking on or off, mirroring llama.cpp's
 * own `chat-template-thinking-detector`. Qwen3 and Gemma 4 both declare
 * `enable_thinking`; a template that declares none of these cannot think.
 */
const THINKING_KWARG_VARS = ['enable_thinking', 'reasoning_effort', 'thinking_budget'] as const;

/** Templates that carry no kwarg but still emit a thinking block. */
const THINKING_TAG_PAIRS = [
  ['<think>', '</think>'],
  ['<thinking>', '</thinking>'],
  ['<|channel>thought', '<channel|>'],
] as const;

/**
 * Whether a model can think is a property of its chat template, not its name.
 *
 * llama.cpp reports the template on `/props`, and only for a model it has loaded
 * at least once. The server runs this once and ships the answer, so no client has
 * to carry llama.cpp's detector.
 */
export function templateSupportsThinking(chatTemplate: string | null | undefined): boolean {
  if (!chatTemplate) {
    return false;
  }
  if (THINKING_KWARG_VARS.some(variable => chatTemplate.includes(variable))) {
    return true;
  }
  return THINKING_TAG_PAIRS.some(
    ([open, close]) => chatTemplate.includes(open) && chatTemplate.includes(close),
  );
}

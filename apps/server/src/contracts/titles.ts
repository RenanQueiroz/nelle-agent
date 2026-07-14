/**
 * How a conversation earns its title.
 *
 * Everything here is pure, so the same word cap applies whether a title came
 * from the model, from the user's first line, or from a client that wants to
 * preview one. The settings that drive it live in `SETTINGS_REGISTRY`.
 *
 * Zod-free: `settings.ts` imports these constants to build its fields, and a
 * cycle back through zod would be the only thing standing in the way.
 */

export const TITLE_MODES = ['llm', 'first-line', 'off'] as const;

export type TitleMode = (typeof TITLE_MODES)[number];

export type TitleSettings = {
  /** How a conversation earns its title. */
  mode: TitleMode;
  /** `{{USER}}`, `{{ASSISTANT}}` and `{{MAX_WORDS}}` are substituted. `llm` only. */
  prompt: string;
  maxWords: number;
};

/**
 * A backstop, not the limit. `maxWords` is what shortens a title; this only
 * stops one very long "word" -- a URL, a stack frame -- from becoming the row.
 * It matches the 200-character cap `patchConversationSchema` puts on a title the
 * user types.
 */
export const TITLE_MAX_CHARACTERS = 200;

export const DEFAULT_TITLE_MAX_WORDS = 6;

/**
 * The user-editable half of the title request. The system message is not
 * editable: it states the output format Nelle then parses, and a user who broke
 * it would get quotes and preamble stored as the conversation's name.
 */
export const DEFAULT_TITLE_PROMPT = [
  'Create a concise title for this conversation.',
  'Limit it to {{MAX_WORDS}} words.',
  '',
  'User: {{USER}}',
  'Assistant: {{ASSISTANT}}',
].join('\n');

export const TITLE_SYSTEM_PROMPT =
  'Create concise conversation titles. Return only the title, with no quotes, markdown, punctuation suffix, or explanation.';

export const DEFAULT_TITLE_SETTINGS: TitleSettings = {
  mode: 'llm',
  prompt: DEFAULT_TITLE_PROMPT,
  maxWords: DEFAULT_TITLE_MAX_WORDS,
};

const TITLE_PLACEHOLDER = /\{\{(USER|ASSISTANT|MAX_WORDS)\}\}/g;

/**
 * Substitutes the placeholders in one pass.
 *
 * One pass is the point: a user message that itself contains the literal text
 * `{{ASSISTANT}}` must reach the model as that text, not as the assistant's
 * reply spliced into the user's turn.
 */
export function renderTitlePrompt(
  template: string,
  input: {user: string; assistant: string; maxWords: number},
): string {
  return template.replace(TITLE_PLACEHOLDER, placeholder => {
    switch (placeholder) {
      case '{{USER}}':
        return input.user;
      case '{{ASSISTANT}}':
        return input.assistant;
      default:
        return String(input.maxWords);
    }
  });
}

/** Whitespace-separated words, capped. The text is assumed already collapsed. */
export function limitTitleWords(value: string, maxWords: number): string {
  const words = value.split(' ').filter(Boolean);
  const limited = maxWords > 0 ? words.slice(0, maxWords) : words;
  return limited.join(' ').slice(0, TITLE_MAX_CHARACTERS);
}

/**
 * A title without a model: the first line of the user's message that has
 * anything on it.
 */
export function firstLineTitle(message: string, maxWords: number): string | null {
  for (const line of message.split(/\r?\n/)) {
    const title = limitTitleWords(collapseTitleWhitespace(line), maxWords);
    if (title) {
      return title;
    }
  }
  return null;
}

/**
 * What the model returned, made into a title: its first line, stripped of the
 * quotes and markdown it wraps things in however firmly it was asked not to,
 * and cut to `maxWords`.
 */
export function sanitizeGeneratedTitle(value: string, maxWords: number): string | null {
  const firstLine = value.split(/\r?\n/)[0] ?? '';
  const cleaned = collapseTitleWhitespace(
    firstLine.replace(/^["'`*_#\s]+|["'`*_\s]+$/g, '').replace(/[.!?:;,]+$/, ''),
  );
  return limitTitleWords(cleaned, maxWords) || null;
}

function collapseTitleWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Narrows a settings row to `TitleSettings`. The repository has already coerced
 * each field against the registry, so this only re-states the shape in types.
 */
export function readTitleSettings(values: Record<string, unknown> | undefined): TitleSettings {
  if (!values) {
    return DEFAULT_TITLE_SETTINGS;
  }
  const mode = values.mode;
  return {
    mode: isTitleMode(mode) ? mode : DEFAULT_TITLE_SETTINGS.mode,
    prompt: typeof values.prompt === 'string' ? values.prompt : DEFAULT_TITLE_SETTINGS.prompt,
    maxWords:
      typeof values.maxWords === 'number' &&
      Number.isInteger(values.maxWords) &&
      values.maxWords > 0
        ? values.maxWords
        : DEFAULT_TITLE_SETTINGS.maxWords,
  };
}

function isTitleMode(value: unknown): value is TitleMode {
  return typeof value === 'string' && (TITLE_MODES as readonly string[]).includes(value);
}

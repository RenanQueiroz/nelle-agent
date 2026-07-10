/**
 * Preferences the *client* applies, stored on the server so they follow the user
 * to their phone.
 *
 * Only the storage moves. Whether a thinking block starts open is a rendering
 * decision, and rendering stays in the client -- that is rule 4 of
 * `plans/nelle-thin-client-plan.md`, not an exception to it.
 *
 * Every default is what Nelle did before these existed, so turning them on
 * changes nothing. Zod-free: the web bundle imports this directly.
 */

export type DisplayPreferences = {
  /** Render the Reading/Generation stats widget beneath an assistant turn. */
  showGenerationStats: boolean;
  /** Expand a reasoning block while the model is still thinking. */
  showThinkingInProgress: boolean;
  /** Expand the tool-call group while a call is still running. */
  showToolCallsInProgress: boolean;
  /** Render a user's own message as markdown rather than as the text they typed. */
  renderUserContentAsMarkdown: boolean;
  /** Render reasoning as markdown. Models emit it, so it is on. */
  renderThinkingAsMarkdown: boolean;
  /** Stop pinning the transcript to the bottom when a conversation opens. */
  disableAutoScroll: boolean;
};

export const DEFAULT_DISPLAY_PREFERENCES: DisplayPreferences = {
  showGenerationStats: true,
  showThinkingInProgress: true,
  showToolCallsInProgress: true,
  // The user typed plain text; rendering their own asterisks as emphasis back at
  // them is surprising. llama.cpp's web UI defaults this off too.
  renderUserContentAsMarkdown: false,
  renderThinkingAsMarkdown: true,
  disableAutoScroll: false,
};

export const DISPLAY_PREFERENCE_KEYS = Object.keys(DEFAULT_DISPLAY_PREFERENCES) as Array<
  keyof DisplayPreferences
>;

/**
 * Labels for the toggles, beside the values they describe.
 *
 * These are not `SETTINGS_REGISTRY` fields: they live under the `preferences`
 * key, which also holds `favoriteModelIds` -- not a rendered control. Keeping the
 * copy here rather than in `apps/web` means the next client imports it instead of
 * retyping six sentences.
 */
export const DISPLAY_PREFERENCE_FIELDS: ReadonlyArray<{
  key: keyof DisplayPreferences;
  label: string;
  help: string;
}> = [
  {
    key: 'showGenerationStats',
    label: 'Show generation statistics',
    help: 'The Reading and Generation widget beneath an assistant reply.',
  },
  {
    key: 'showThinkingInProgress',
    label: 'Expand reasoning while thinking',
    help: 'Open the reasoning block until the answer starts. Clicking it always wins.',
  },
  {
    key: 'showToolCallsInProgress',
    label: 'Expand tool calls while running',
    help: 'Open the tool-call group while a call is still running.',
  },
  {
    key: 'renderUserContentAsMarkdown',
    label: 'Render my messages as markdown',
    help: 'Off by default: you typed plain text, so asterisks stay asterisks.',
  },
  {
    key: 'renderThinkingAsMarkdown',
    label: 'Render reasoning as markdown',
    help: 'Models emit markdown in their reasoning, so this is on.',
  },
  {
    key: 'disableAutoScroll',
    label: 'Do not scroll to the newest message',
    help: 'Opening a conversation leaves the transcript where it was.',
  },
];

/**
 * Narrows a stored row, field by field.
 *
 * A value that is not a boolean -- a row written by a newer server, a key that
 * changed type -- falls back to its own default and takes no sibling with it.
 */
export function readDisplayPreferences(stored: unknown): DisplayPreferences {
  const values = {...DEFAULT_DISPLAY_PREFERENCES};
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return values;
  }
  const record = stored as Record<string, unknown>;
  for (const key of DISPLAY_PREFERENCE_KEYS) {
    if (typeof record[key] === 'boolean') {
      values[key] = record[key];
    }
  }
  return values;
}
